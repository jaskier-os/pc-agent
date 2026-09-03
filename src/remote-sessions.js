import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { access } from 'fs/promises';
import { randomUUID } from 'crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AttachClient } from './attach-client.js';
import { findLiveSession, listLiveSessions, waitForLiveSession } from './session-registry.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// VS Code recent-projects reader -- shells out to proj-list.py (the same
// script the terminal `proj` picker uses). Each output line is
// "<abs_path>\t<label>"; we only need the path column.
// ---------------------------------------------------------------------------
const PROJ_LIST_SCRIPT = path.join(os.homedir(), '.local', 'bin', 'proj-list.py');

function getVscodeProjectDirs() {
  if (!fs.existsSync(PROJ_LIST_SCRIPT)) return [];
  try {
    const stdout = execFileSync('python3', [PROJ_LIST_SCRIPT], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map(line => line.split('\t')[0]);
  } catch (err) {
    console.error(`[remote-sessions] Failed to read vscode projects: ${err.message}`);
    return [];
  }
}

// Returns true iff Claude Code already has a transcript on disk for this
// sessionId+workDir pair. Used to switch the spawn args from "fresh session"
// (--session-id) to "resume" (--resume) so that respawned CLIs reload the
// prior conversation context instead of starting blank with the same id.
/**
 * Mirror of the CLI's sanitizePath (sessionStoragePortable.ts): EVERY
 * non-alphanumeric character becomes '-'.
 *
 * A near-miss here is silent and expensive. Replacing only '/' left dotted
 * paths (~/.cache/foo) pointing at a directory that does not exist, so an
 * existing conversation looked brand new, recovery passed --session-id instead
 * of --resume, and the CLI exited with "Session ID is already in use" --
 * leaving the phone with no reply at all.
 *
 * Paths beyond MAX_SANITIZED_LENGTH get a hash suffix we deliberately do NOT
 * reimplement: the CLI hashes with Bun.hash under bun and djb2 under node, so
 * any copy here would be wrong half the time. Those are matched by prefix
 * instead (see hasExistingTranscript).
 */
const MAX_SANITIZED_LENGTH = 200;

export function sanitizeProjectPath(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '-');
}

export function hasExistingTranscript(workDir, sessionId) {
  if (!sessionId || !workDir) return false;
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const sanitized = sanitizeProjectPath(workDir);

  const direct = path.join(projectsRoot, sanitized, `${sessionId}.jsonl`);
  try { if (fs.statSync(direct).size > 0) return true; } catch { /* try prefix */ }

  // Over-long paths carry a hash suffix we cannot recompute (see
  // sanitizeProjectPath), so match on the truncated prefix instead. Guessing
  // wrong here means --session-id on a live transcript, which kills the CLI.
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return false;
  const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH);
  let entries;
  try { entries = fs.readdirSync(projectsRoot); } catch { return false; }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      if (fs.statSync(path.join(projectsRoot, entry, `${sessionId}.jsonl`)).size > 0) return true;
    } catch { /* keep looking */ }
  }
  return false;
}

const SPAWN_TIMEOUT_MS = 60000;
// How long a freshly spawned interactive CLI gets to publish its attach socket.
// Measured at ~2.5s on this host; the margin covers a cold bun start and the
// terminal emulator's own startup.
const ATTACH_AFTER_SPAWN_TIMEOUT_MS = 60000;
const CLI_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

// Rewrite the wsUrl host to the one this machine actually reaches the
// orchestrator on. The gateway advertises a public-facing host/port to
// clients, but pc-agent dials its own configured ORCHESTRATOR_URL.
//
// Pure by design so both the spawn and attach paths can call it. Deliberately
// NOT hoisted above the access(workDir) check in startSession: hoisting would
// reorder observable behaviour -- today a nonexistent workDir throws before
// any URL parsing and before the rewrite log line, and this function's
// swallow-on-error would silently alter spawn argv on a path that used to fail
// fast.
// Returns the rewritten URL, or null if it could not be parsed. Callers keep
// the original URL on null -- same as the inline code this replaced.
export function rewriteWsUrl(wsUrl, orchestratorUrl) {
  if (!orchestratorUrl || !wsUrl) return null;
  try {
    const orcUrl = new URL(orchestratorUrl.replace('wss://', 'https://').replace('ws://', 'http://'));
    const sdkUrl = new URL(wsUrl.replace('wss://', 'https://').replace('ws://', 'http://'));
    sdkUrl.hostname = orcUrl.hostname;
    sdkUrl.port = orcUrl.port;
    return sdkUrl.toString().replace('https://', 'wss://').replace('http://', 'ws://');
  } catch (e) {
    console.error(`[remote-sessions] Failed to rewrite wsUrl: ${e.message}`);
    return null;
  }
}

/**
 * Build the argv for an INTERACTIVE remote-session CLI.
 *
 * There is exactly one kind of session: a real interactive TUI the user can see
 * and type into. The phone always works by attaching to one of these. Headless
 * `--print` is deliberately NOT used -- a `--print` process cannot be attached
 * to, renders nothing on the PC, and is a different code path from a real turn,
 * so it can never satisfy "both sides in sync".
 *
 * No --model / --effort: the TUI restores the user's last-used model itself.
 * Pinning one here would silently override the model the user chose.
 */
export function buildSpawnArgs(childSessionId, permissionMode, resuming) {
  const permissionArgs = permissionMode === 'bypassPermissions'
    ? ['--dangerously-skip-permissions']
    : ['--permission-mode', permissionMode];
  const sessionArgs = resuming
    ? ['--resume', childSessionId]
    : ['--session-id', childSessionId];
  return [
    ...sessionArgs,
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    ...permissionArgs,
  ];
}

/**
 * Wrap an interactive CLI invocation in a real terminal window so the PC user
 * can SEE and drive the session the phone is attached to. A bare pty.spawn is
 * invisible -- the user reported never seeing any of the sessions it created,
 * which defeats the point of attaching to "the CLI you already have open".
 *
 * Returns [command, args] for pty.spawn. Falls back to running the CLI directly
 * (invisible, but functional) when no terminal emulator or display is present,
 * e.g. a headless host.
 */
/**
 * The DISPLAY / WAYLAND_DISPLAY of the user's graphical session.
 *
 * pc-agent runs under `systemd --user`, which does NOT inherit DISPLAY from the
 * graphical session. Reading process.env directly therefore found nothing,
 * buildTerminalCommand took its headless fallback, and the CLI ran bare inside
 * pc-agent's own pty: the session worked and the phone attached, but no terminal
 * tab ever appeared -- the user could not see or type into the session they were
 * supposedly sharing.
 *
 * Recovered from a live process the same way terminalAttachEnv recovers the
 * gnome-terminal window ids. Returns {} on a genuinely headless host, where
 * running the CLI directly IS correct.
 */
function* scanProcessEnvirons() {
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return; // /proc unreadable
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      yield fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    } catch {
      continue; // not ours / gone
    }
  }
}

// An X display is local when its socket exists. Used to reject a forwarded
// `ssh -X` display (localhost:10.0) in favour of the seat the user is sitting
// at -- /proc order is arbitrary, so without this the wrong one can win.
function hasLocalX11Socket(display) {
  const m = /^:(\d+)(\.\d+)?$/.exec(display);
  if (!m) return false;
  return fs.existsSync(`/tmp/.X11-unix/X${m[1]}`);
}

/**
 * The DISPLAY / WAYLAND_DISPLAY of the user's graphical session, plus the
 * variables an emulator needs to actually use it.
 *
 * pc-agent runs under `systemd --user`, which does NOT inherit DISPLAY from the
 * graphical session. Reading process.env directly therefore found nothing,
 * buildTerminalCommand took its headless fallback, and the CLI ran bare inside
 * pc-agent's own pty: the session worked and the phone attached, but no terminal
 * tab ever appeared -- the user could not see or type into the session they were
 * supposedly sharing.
 *
 * Recovered from a live process the same way terminalAttachEnv recovers the
 * gnome-terminal window ids. Reading another user's environ fails closed (mode
 * 0400), so this stays within the user's own session as long as pc-agent is not
 * running as root. Returns {} on a genuinely headless host, where running the
 * CLI directly IS correct.
 *
 * The seams exist so the headless and multi-display branches are testable on
 * any host; production calls take the defaults.
 */
export function resolveDisplayEnv({
  processEnv = process.env,
  scanProcesses = scanProcessEnvirons,
  hasLocalDisplaySocket = hasLocalX11Socket,
} = {}) {
  if (processEnv.DISPLAY) {
    const env = { DISPLAY: processEnv.DISPLAY };
    if (processEnv.XAUTHORITY) env.XAUTHORITY = processEnv.XAUTHORITY;
    return env;
  }
  if (processEnv.WAYLAND_DISPLAY) {
    return { WAYLAND_DISPLAY: processEnv.WAYLAND_DISPLAY };
  }

  const read = (vars, key) => {
    const hit = vars.find(v => v.startsWith(`${key}=`));
    return hit ? hit.slice(key.length + 1) : undefined;
  };

  let fallback = null;
  for (const vars of scanProcesses()) {
    const env = {};
    const display = read(vars, 'DISPLAY');
    const wayland = read(vars, 'WAYLAND_DISPLAY');
    if (display) env.DISPLAY = display;
    if (wayland) env.WAYLAND_DISPLAY = wayland;
    if (!display && !wayland) continue;
    // XAUTHORITY travels with DISPLAY: without it the emulator cannot
    // authenticate to the X server and dies instead of opening a tab.
    const xauth = display ? read(vars, 'XAUTHORITY') : undefined;
    if (xauth) env.XAUTHORITY = xauth;
    // gnome-terminal is a D-Bus client. If DISPLAY was not inherited, the bus
    // address cannot be assumed to have been either.
    const bus = read(vars, 'DBUS_SESSION_BUS_ADDRESS');
    if (bus) env.DBUS_SESSION_BUS_ADDRESS = bus;

    if (wayland || hasLocalDisplaySocket(display)) return env;
    // A display we cannot confirm as local (forwarded ssh -X, stale Xvfb) is
    // better than nothing, but only if no local one turns up.
    fallback ??= env;
  }
  return fallback ?? {};
}

export function buildTerminalCommand(sessionPath, cliArgs, title) {
  const hasDisplay = Object.keys(resolveDisplayEnv()).length > 0;
  if (!hasDisplay) return [sessionPath, cliArgs];

  for (const term of TERMINAL_EMULATORS) {
    const bin = findOnPath(term.bin);
    if (!bin) continue;
    return [bin, [...term.args(title), sessionPath, ...cliArgs]];
  }
  return [sessionPath, cliArgs];
}

/**
 * Env additions that make a new session open as a TAB in the terminal window the
 * user already has open, rather than as a separate window they must dock.
 *
 * gnome-terminal's `--tab` only joins an existing window when the caller looks
 * like a child of that window's shell. BOTH variables are required:
 *   - GNOME_TERMINAL_SERVICE identifies the server process
 *   - GNOME_TERMINAL_SCREEN identifies WHICH window to put the tab in
 * With only the first, --tab silently opens a new window -- verified by counting
 * toplevel windows before/after. A child of the user's shell inherits both;
 * pc-agent is a daemon and inherits neither, so it must recover them from a live
 * process (a shell running inside the user's terminal).
 *
 * Returns {} when nothing is found -- the caller then simply gets a new window,
 * which still works.
 */
export function terminalAttachEnv() {
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let raw;
      try {
        raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      } catch {
        continue; // not ours / gone
      }
      const vars = raw.split('\0');
      const service = vars.find(v => v.startsWith('GNOME_TERMINAL_SERVICE='));
      const screen = vars.find(v => v.startsWith('GNOME_TERMINAL_SCREEN='));
      if (service && screen) {
        return {
          GNOME_TERMINAL_SERVICE: service.slice('GNOME_TERMINAL_SERVICE='.length),
          GNOME_TERMINAL_SCREEN: screen.slice('GNOME_TERMINAL_SCREEN='.length),
        };
      }
    }
  } catch { /* /proc unreadable -- fall through */ }
  return {};
}

// Ordered by preference: the terminal the user actually works in comes first,
// so a session opens somewhere they will notice it. The command-separator flag
// (`-e` / `--`) must come last in each arg list -- everything after it is the
// command to run.
//
// gnome-terminal needs --wait: without it the launcher hands the window to
// gnome-terminal-server and exits IMMEDIATELY, so pc-agent's pty would see the
// session die the instant it started.
// `--tab` (gnome-terminal) / `--new-tab` (konsole) attach the session to the
// window the user already has open instead of spawning a second one they would
// have to dock and manage by hand.
const TERMINAL_EMULATORS = [
  { bin: 'gnome-terminal', args: title => ['--tab', '--wait', '--title', title, '--'] },
  { bin: 'konsole', args: title => ['--new-tab', '-p', `tabtitle=${title}`, '-e'] },
  { bin: 'kitty', args: title => ['--title', title, '-e'] },
  { bin: 'xterm', args: title => ['-title', title, '-e'] },
];

function findOnPath(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return null;
}

// Resolve the remote-session CLI binary. This is the standalone `remote-session`
// app (jaskier-os/remote-session-cli), kept independent of any general-purpose
// `claude` command the host may also have installed. Resolution order:
//   1. explicit absolute path (constructor arg or REMOTE_SESSION_BIN)
//   2. the sibling remote-session-cli checkout (this monorepo's default layout)
//   3. `remote-session` looked up on the system PATH
// Returns the path or throws a clear error.
function findSessionBinary(sessionBin) {
  if (sessionBin && fs.existsSync(sessionBin)) return sessionBin;
  if (sessionBin) {
    throw new Error(`remote-session binary not found at REMOTE_SESSION_BIN=${sessionBin}`);
  }
  // Default: the sibling remote-session-cli checkout in the AI/ monorepo
  // (this agent lives at AI/agents/pc/pc-agent -> ../../../remote-session-cli).
  const sibling = path.resolve(import.meta.dirname, '../../../../remote-session-cli/bin/remote-session');
  if (fs.existsSync(sibling)) return sibling;
  // Fall back to PATH lookup for the dedicated command (NOT `claude`).
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'remote-session');
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  throw new Error('remote-session binary not found. Set REMOTE_SESSION_BIN to its absolute path or install `remote-session` on PATH (see jaskier-os/remote-session-cli).');
}

export class RemoteSessionManager {
  constructor(dirs, orchestratorUrl, sessionBin = '') {
    this.dirs = dirs;
    this.orchestratorUrl = orchestratorUrl;
    this.sessionBin = sessionBin || process.env.REMOTE_SESSION_BIN || '';
    this.sessions = new Map(); // pid -> { workDir, sessionId, startedAt, process, alive }
    // sessionId -> in-flight startSession promise. Inserted SYNCHRONOUSLY, so
    // concurrent callers share one attempt. The this.sessions dedup below
    // cannot do this on its own: its entry is only set after `await
    // access(workDir)` and the spawn, and the attach branch's await widens
    // that window further. Mirrors the orchestrator's inFlightRespawns.
    this._starting = new Map();
    this.startReaper();
  }

  async startSession(workDir, sessionId, wsUrl, apiKey, permissionMode) {
    if (!CLI_MODES.includes(permissionMode)) {
      throw new Error('invalid_permission_mode: ' + permissionMode);
    }

    if (!sessionId) {
      return this._startSessionInner(workDir, sessionId, wsUrl, apiKey, permissionMode);
    }
    // Keyed on sessionId AND workDir: sharing across different workDirs would
    // hand the second caller a result for a directory it never asked for, and
    // would skip its own access(workDir) validation.
    const key = `${sessionId}\u0000${workDir}`;
    const inFlight = this._starting.get(key);
    if (inFlight) {
      console.log(`[remote-sessions] Session ${sessionId} start already in flight, sharing result`);
      return inFlight;
    }
    const promise = this._startSessionInner(workDir, sessionId, wsUrl, apiKey, permissionMode)
      .finally(() => {
        this._starting.delete(key);
      });
    this._starting.set(key, promise);
    return promise;
  }

  async _startSessionInner(workDir, sessionId, wsUrl, apiKey, permissionMode) {
    // Dedup: if a CLI for this sessionId is already alive, return it instead
    // of spawning a duplicate. This prevents the race where the phone's retry
    // loop triggers multiple spawns before the first CLI's WS connects.
    if (sessionId) {
      for (const [pid, s] of this.sessions) {
        if (s.sessionId === sessionId && s.alive) {
          console.log(`[remote-sessions] Session ${sessionId} already alive (pid=${pid}), returning existing`);
          return { pid, sessionId: s.sessionId, workDir: s.workDir, startedAt: s.startedAt, attached: s.kind === 'attached' };
        }
      }
    }

    // Validate directory exists
    try {
      await access(workDir);
    } catch {
      throw new Error(`Directory does not exist: ${workDir}`);
    }

    // If the user already has an interactive CLI open on exactly this
    // conversation and directory, hand the phone to that live process instead
    // of spawning a second headless one for the same transcript. The attached
    // CLI opens the orchestrator WS itself, so it simply becomes the desktop
    // and every orchestrator-side state machine sees what it sees today.
    const live = sessionId ? findLiveSession(sessionId, workDir) : null;
    if (live) {
      try {
        const attached = await this._attachToLiveSession(live, {
          sessionId,
          workDir,
          wsUrl: rewriteWsUrl(wsUrl, this.orchestratorUrl) ?? wsUrl,
          apiKey,
          permissionMode,
        });
        return attached;
      } catch (err) {
        // already_attached means a control peer is ALREADY driving that CLI as
        // this session's desktop -- the desired end state. Spawning here would
        // create a second desktop competing for the same sessionId, which is
        // precisely the flap the one-WS-per-session invariant forbids. Report
        // success against the live pid instead.
        if (err.code === 'already_attached') {
          console.log(`[remote-sessions] Session ${sessionId} already attached to pid=${live.pid}; reporting existing`);
          return { pid: live.pid, sessionId, workDir, startedAt: new Date().toISOString(), attached: true };
        }
        // consent_denied means the PC user explicitly revoked attach for this
        // session; every other failure is transient. Both fall through to
        // spawn, which is the correct degradation in either case.
        console.log(`[remote-sessions] Attach to pid=${live.pid} failed (${err.message}); falling back to spawn`);
      }
    }

    // Rewrite wsUrl host to match our local orchestrator connection.
    // The gateway may advertise a public-facing host/port to clients, but this
    // machine reaches the orchestrator via its own configured ORCHESTRATOR_URL,
    // so rewrite the host/port of the SDK websocket URL accordingly.
    // Kept at this call site (not hoisted) so a nonexistent workDir still
    // throws before any URL parsing and before the rewrite log line.
    if (this.orchestratorUrl && wsUrl) {
      const rewritten = rewriteWsUrl(wsUrl, this.orchestratorUrl);
      if (rewritten) {
        wsUrl = rewritten;
        console.log(`[remote-sessions] Rewrote sdk-url to: ${wsUrl}`);
      }
    }

    return new Promise((resolve, reject) => {
      let resolved = false;

      // Strip Claude Code env vars to prevent nested session detection
      const env = { ...process.env, TERM: 'xterm-256color' };
      delete env.CLAUDECODE;
      for (const key of Object.keys(env)) {
        if (key.startsWith('CLAUDE_CODE_')) delete env[key];
      }

      // No bridge/RemoteIO env vars and no NODE_TLS_REJECT_UNAUTHORIZED here:
      // this is a plain interactive TUI, exactly like one the user starts by
      // hand. It never dials the orchestrator itself -- the attach that follows
      // hands it the WS URL and a scoped CA pin over the attach socket, so TLS
      // verification stays on for everything else in that process.

      // Ensure ~/.local/bin is in PATH (for the remote-session binary)
      const home = process.env.HOME || '';
      if (home && env.PATH) {
        const extraDirs = [`${home}/.local/bin`, `${home}/.bun/bin`];
        const missing = extraDirs.filter(d => !env.PATH.includes(d));
        if (missing.length) {
          env.PATH = `${missing.join(':')}:${env.PATH}`;
        }
      }

      const sessionPath = findSessionBinary(this.sessionBin);
      const childSessionId = sessionId || randomUUID();
      // If a transcript already exists for this session id + workDir, the
      // CLI process is being respawned (previous PID died -- crash, idle
      // exit, or our orchestrator-driven kill). Use --resume so the new
      // process loads the prior conversation context; --session-id alone
      // would create a fresh session that happens to share the id, and the
      // model would have zero memory of previous turns.
      const resuming = hasExistingTranscript(workDir, childSessionId);
      if (resuming) {
        console.log(`[remote-sessions] Resuming existing session ${childSessionId}`);
      }
      // buildSpawnArgs also isolates MCP servers (--strict-mcp-config with an
      // empty set): inheriting the user's interactive ~/.claude.json mcpServers
      // lets a stale entry whose backing service is down hang the CLI forever,
      // since MCP init is awaited before the session becomes responsive.
      const cliArgs = buildSpawnArgs(childSessionId, permissionMode, resuming);
      const [spawnCmd, spawnArgs] = buildTerminalCommand(
        sessionPath, cliArgs, `remote-session ${childSessionId.slice(0, 8)}`,
      );
      // Hand the emulator the graphical session it must draw on -- systemd
      // --user gave pc-agent no DISPLAY of its own (see resolveDisplayEnv) --
      // then join the user's existing terminal window as a tab (see
      // terminalAttachEnv).
      Object.assign(env, resolveDisplayEnv(), terminalAttachEnv());
      const child = pty.spawn(spawnCmd, spawnArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: workDir,
        env
      });

      const pid = child.pid;
      const startedAt = new Date().toISOString();

      this.sessions.set(pid, {
        workDir,
        sessionId,
        startedAt,
        process: child,
        alive: true,
        bytesThisSecond: 0,
        lastResetMs: Date.now(),
        throttleKilled: false
      });

      // Log early pty output for debugging (first 30s)
      let logLines = 0;
      const maxLogLines = 50;
      const logCutoff = setTimeout(() => { logLines = maxLogLines; }, 30000);

      const THROUGHPUT_LIMIT_BYTES_PER_SEC = 5_000_000;
      const SINGLE_CHUNK_LIMIT_BYTES = 1_000_000;

      child.onData((data) => {
        const session = this.sessions.get(pid);
        if (!session || session.throttleKilled) return;

        // Single-chunk clamp: truncate oversized blobs but don't kill
        let chunk = data;
        if (chunk.length > SINGLE_CHUNK_LIMIT_BYTES) {
          console.warn(`[remote-sessions] [pid=${pid}] Single chunk ${chunk.length} bytes exceeds ${SINGLE_CHUNK_LIMIT_BYTES}; truncating`);
          chunk = chunk.substring(0, SINGLE_CHUNK_LIMIT_BYTES);
        }

        // Per-second throughput accounting
        const now = Date.now();
        if (now - session.lastResetMs > 1000) {
          session.lastResetMs = now;
          session.bytesThisSecond = chunk.length;
        } else {
          session.bytesThisSecond += chunk.length;
        }

        if (session.bytesThisSecond > THROUGHPUT_LIMIT_BYTES_PER_SEC && !session.throughputWarned) {
          session.throughputWarned = true;
          console.warn(`[remote-sessions] [pid=${pid}] High output throughput (${session.bytesThisSecond} bytes in <1s); not killing -- per-chunk truncation at ${SINGLE_CHUNK_LIMIT_BYTES} still active`);
        }

        if (logLines < maxLogLines) {
          const lines = chunk.toString().split('\n').filter(l => l.trim());
          for (const line of lines) {
            if (logLines < maxLogLines) {
              console.log(`[remote-sessions] [pid=${pid}] ${line.substring(0, 200)}`);
              logLines++;
            }
          }
        }
      });

      console.log(`[remote-sessions] Session spawned: pid=${pid}, sessionId=${childSessionId}, dir=${workDir}, bin=${sessionPath}`);

      // The CLI we just started is an ordinary interactive TUI -- it does NOT
      // dial the orchestrator on its own (no --sdk-url). Wait for it to publish
      // its attach socket, then attach exactly as we would to a session the user
      // had already opened. One code path serves both cases.
      //
      // The pid we attach to is the CLI's, not the terminal wrapper's, so it is
      // resolved from the session registry by sessionId rather than assumed.
      waitForLiveSession(childSessionId, workDir, ATTACH_AFTER_SPAWN_TIMEOUT_MS)
        .then(live => this._attachToLiveSession(live, {
          sessionId: childSessionId,
          workDir,
          wsUrl,
          apiKey,
          permissionMode,
        }))
        .then(attached => {
          resolved = true;
          resolve(attached);
        })
        .catch(err => {
          if (resolved) return;
          resolved = true;
          try { child.kill(); } catch { /* already gone */ }
          reject(new Error(`Spawned CLI never became attachable: ${err.message}`));
        });

      const timeout = setTimeout(() => {
        const session = this.sessions.get(pid);
        if (session && session.alive) {
          console.log(`[remote-sessions] Session ${pid} still alive after spawn timeout -- OK`);
        }
      }, SPAWN_TIMEOUT_MS);

      child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        clearTimeout(logCutoff);
        console.log(`[remote-sessions] Process exited: pid=${pid}, code=${exitCode}`);
        const session = this.sessions.get(pid);
        if (session) {
          session.alive = false;
          session.process = null;
          // Keep dead sessions for 1h for history
          setTimeout(() => this.sessions.delete(pid), 3600000);
        }
        if (!resolved) {
          resolved = true;
          reject(new Error(`Process exited with code ${exitCode} before session was ready`));
        }
      });
    });
  }

  /**
   * The orchestrator's CA in PEM form, handed to the attached CLI so it can
   * verify the self-signed certificate on that one socket.
   *
   * Deliberately NOT NODE_TLS_REJECT_UNAUTHORIZED=0 (which the spawn path uses
   * for a throwaway headless process): the attached CLI is the user's own
   * interactive session, and that variable is process-global -- it would
   * disable certificate verification for every TLS client in it, Anthropic API
   * calls included. Read lazily and cached; a missing CA just means no pin.
   */
  _getCaPem() {
    if (this._caPem !== undefined) return this._caPem;
    const caPath = process.env.NODE_EXTRA_CA_CERTS;
    if (!caPath) {
      this._caPem = null;
      return null;
    }
    try {
      this._caPem = fs.readFileSync(caPath, 'utf8');
    } catch (err) {
      console.warn(`[remote-sessions] Could not read CA from NODE_EXTRA_CA_CERTS: ${err.message}`);
      this._caPem = null;
    }
    return this._caPem;
  }

  /**
   * Attach to a live interactive CLI. Resolves only once the CLI's own
   * orchestrator WebSocket is up (the AttachClient gates on attach_ok), so the
   * map entry below is never recorded for an attach that produced no desktop.
   */
  async _attachToLiveSession(live, opts) {
    const client = await AttachClient.attach(live, {
      sessionId: opts.sessionId,
      workDir: opts.workDir,
      wsUrl: opts.wsUrl,
      apiKey: opts.apiKey,
      caPem: this._getCaPem(),
      permissionMode: opts.permissionMode,
    });

    const startedAt = new Date().toISOString();
    this.sessions.set(live.pid, {
      kind: 'attached',
      client,
      workDir: opts.workDir,
      sessionId: opts.sessionId,
      startedAt,
      process: null,
      alive: true,
    });

    // Synchronous teardown of the map entry. The 60s reaper is far too slow:
    // until the entry is gone, every phone message for up to a minute resolves
    // to a dead session while the orchestrator's respawn guard never clears and
    // pending messages expire at 60s.
    client.once('detached', reason => {
      console.log(`[remote-sessions] Attached session pid=${live.pid} detached: ${reason}`);
      this.sessions.delete(live.pid);
    });

    console.log(`[remote-sessions] Attached to live session: pid=${live.pid}, sessionId=${opts.sessionId}, dir=${opts.workDir}`);
    return { pid: live.pid, sessionId: opts.sessionId, workDir: opts.workDir, startedAt, attached: true };
  }

  /**
   * Return the merged directory list: VS Code recent projects first, then
   * static dirs from the config (deduped). Mirrors the terminal `proj`
   * picker behaviour.
   */
  getDirs() {
    const vscodeDirs = getVscodeProjectDirs();
    const seen = new Set(vscodeDirs);
    const merged = [...vscodeDirs];
    for (const d of this.dirs) {
      if (!seen.has(d)) {
        seen.add(d);
        merged.push(d);
      }
    }
    return merged;
  }

  listSessions() {
    const result = [];
    const seenPids = new Set();
    for (const [pid, session] of this.sessions) {
      seenPids.add(pid);
      result.push({
        pid,
        workDir: session.workDir,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        alive: session.alive,
        attached: session.kind === 'attached',
        adoptable: false
      });
    }
    // Also surface interactive CLIs the user started at the terminal that
    // pc-agent has never spawned or attached to. They live only in the on-disk
    // registry (~/.claude/sessions/*.json), so the phone would otherwise never
    // see that a live PC-side session exists for a conversation. They are
    // reported as adoptable so chat-open can attach to them instead of doing
    // nothing until the user sends a message.
    for (const entry of listLiveSessions()) {
      if (seenPids.has(entry.pid)) continue;
      if (entry.kind !== 'interactive') continue;
      if (!entry.sessionId) continue;
      result.push({
        pid: entry.pid,
        workDir: entry.cwd,
        sessionId: entry.sessionId,
        startedAt: entry.startedAt || null,
        alive: true,
        attached: false,
        adoptable: true
      });
    }
    return result;
  }

  /**
   * Adopt-only counterpart to startSession: attach to a live interactive CLI
   * for this conversation if one exists, and otherwise do NOTHING. Never
   * spawns. This is what chat-open reconciliation calls -- opening an old chat
   * must not start a terminal, it must only rejoin a session the user already
   * has open.
   *
   * Returns { adopted: true, ...session } on success, { adopted: false } when
   * there is no live attachable CLI (not an error).
   */
  async adoptSession(workDir, sessionId, wsUrl, apiKey, permissionMode) {
    if (!sessionId) return { adopted: false };

    // Already driving this session -- report the existing desktop.
    for (const [pid, s] of this.sessions) {
      if (s.sessionId === sessionId && s.alive) {
        return { adopted: true, pid, sessionId: s.sessionId, workDir: s.workDir, startedAt: s.startedAt, attached: s.kind === 'attached' };
      }
    }

    // The orchestrator has no workDir for a terminal-started session (it never
    // saw it). Resolve the CLI's real cwd from its own registry entry so
    // findLiveSession's mandatory cwd === workDir check can pass.
    let effectiveWorkDir = workDir;
    if (!effectiveWorkDir) {
      const entry = listLiveSessions().find(
        e => e.sessionId === sessionId && e.kind === 'interactive' && e.cwd
      );
      if (!entry) return { adopted: false };
      effectiveWorkDir = entry.cwd;
    }

    const live = findLiveSession(sessionId, effectiveWorkDir);
    if (!live) return { adopted: false };
    workDir = effectiveWorkDir;

    try {
      const attached = await this._attachToLiveSession(live, {
        sessionId,
        workDir,
        wsUrl: rewriteWsUrl(wsUrl, this.orchestratorUrl) ?? wsUrl,
        apiKey,
        permissionMode,
      });
      return { adopted: true, ...attached };
    } catch (err) {
      // already_attached is the desired end state: a control peer is already
      // this session's desktop. Report success instead of spawning a rival.
      if (err.code === 'already_attached') {
        return { adopted: true, pid: live.pid, sessionId, workDir, startedAt: new Date().toISOString(), attached: true };
      }
      // Every other failure (consent_denied, transient) is non-fatal for
      // adopt: unlike startSession we do NOT fall back to spawn.
      console.log(`[remote-sessions] Adopt of pid=${live.pid} failed (${err.message}); not spawning`);
      return { adopted: false };
    }
  }

  // Enumerate resumable conversations on disk for a directory by shelling out
  // to the remote-session CLI's `list-sessions --json` subcommand. The CLI is
  // the authority on which conversations exist (it owns the ~/.claude/projects
  // transcript layout), so we reuse it instead of re-implementing the scan.
  async listConversations(workDir, limit, offset) {
    if (!workDir) throw new Error('Missing workDir');
    const sessionPath = findSessionBinary(this.sessionBin);
    const args = ['list-sessions', '--dir', workDir, '--json'];
    if (limit != null) args.push('--limit', String(limit));
    if (offset != null) args.push('--offset', String(offset));
    const { stdout } = await execFileAsync(sessionPath, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse list-sessions output: ${err.message}`);
    }
  }

  // Reconstruct a session's transcript from its on-disk JSONL by shelling out
  // to the remote-session CLI's export-transcript subcommand. Used so the
  // orchestrator can serve history for conversations started directly on the PC
  // (which have no server-side transcript).
  //
  // Without opts.limit this returns the whole transcript as a bare array of
  // phone RC entries ({ ts, type, data, uid }). With opts.limit it returns a
  // page envelope { entries, nextCursor, hasMore } -- the CLI switches shape on
  // the same flag, so the two stay in step.
  async exportTranscript(workDir, sessionId, opts = {}) {
    if (!workDir) throw new Error('Missing workDir');
    if (!sessionId) throw new Error('Missing sessionId');
    const sessionPath = findSessionBinary(this.sessionBin);
    const args = ['export-transcript', '--session-id', sessionId, '--dir', workDir, '--json'];
    const paged = opts.limit != null;
    if (paged) {
      args.push('--limit', String(opts.limit));
      if (opts.before) args.push('--before', String(opts.before));
    }
    const { stdout } = await execFileAsync(sessionPath, args, {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return paged ? { entries: [], nextCursor: null, hasMore: false } : [];
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse export-transcript output: ${err.message}`);
    }
  }

  setPermissionMode(sessionId, mode) {
    if (!CLI_MODES.includes(mode)) {
      console.warn(`[remote-sessions] Dropping set_permission_mode with unknown CLI mode: ${mode}`);
      return false;
    }
    for (const [pid, session] of this.sessions) {
      if (session.sessionId === sessionId) {
        // Attached entries are checked FIRST: they have no `process`, so the
        // spawn-path guard below would silently refuse them.
        if (session.kind === 'attached') {
          if (!session.alive || !session.client) {
            console.warn(`[remote-sessions] Cannot set_permission_mode: attached session ${sessionId} not alive`);
            return false;
          }
          const sent = session.client.setPermissionMode(mode);
          console.log(`[remote-sessions] Forwarded set_permission_mode mode=${mode} to attached pid=${pid}`);
          return sent;
        }
        if (!session.alive || !session.process) {
          console.warn(`[remote-sessions] Cannot set_permission_mode: session ${sessionId} not alive`);
          return false;
        }
        if (mode === 'bypassPermissions') {
          console.warn(`[remote-sessions] Mid-session bypassPermissions for pid=${pid} cannot engage --dangerously-skip-permissions; restart the session to lift the bash sandbox. Forwarding tier change anyway.`);
        }
        const payload = JSON.stringify({ type: 'control_request', request: { subtype: 'set_permission_mode', mode } }) + '\n';
        session.process.write(payload);
        console.log(`[remote-sessions] Forwarded set_permission_mode mode=${mode} to pid=${pid}`);
        return true;
      }
    }
    console.warn(`[remote-sessions] set_permission_mode: session ${sessionId} not found`);
    return false;
  }

  async stopSession(pid) {
    const session = this.sessions.get(pid);
    if (!session) return false;
    // An attached entry is the user's own interactive shell. Detach it --
    // NEVER kill it.
    if (session.kind === 'attached') {
      console.log(`[remote-sessions] Detaching from live session pid=${pid}`);
      session.client?.detach('session_stopped');
      this.sessions.delete(pid);
      return true;
    }
    if (!session.alive || !session.process) {
      this.sessions.delete(pid);
      return true;
    }
    // Send SIGTERM first
    console.log(`[remote-sessions] Stopping session pid=${pid}, sending SIGTERM`);
    session.process.kill();
    // Wait up to 5s for graceful exit, then SIGKILL
    await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        try {
          process.kill(pid, 0); // Check if still alive
        } catch {
          clearInterval(checkInterval);
          resolve();
          return;
        }
      }, 500);
      setTimeout(() => {
        clearInterval(checkInterval);
        try {
          process.kill(pid, 'SIGKILL');
          console.log(`[remote-sessions] SIGKILL sent to pid=${pid}`);
        } catch {} // Already dead
        resolve();
      }, 5000);
    });
    this.sessions.delete(pid);
    console.log(`[remote-sessions] Session pid=${pid} stopped and cleaned up`);
    return true;
  }

  async stopBySessionId(sessionId) {
    for (const [pid, session] of this.sessions) {
      if (session.sessionId === sessionId) {
        return this.stopSession(pid);
      }
    }
    return false;
  }

  startReaper(intervalMs = 60000) {
    this._reaperInterval = setInterval(() => {
      for (const [pid, session] of this.sessions) {
        if (!session.alive) continue;
        try {
          process.kill(pid, 0);
        } catch {
          console.log(`[remote-sessions] Reaping orphaned session pid=${pid}`);
          session.alive = false;
          session.process = null;
          // For an attached entry the pid is the user's interactive CLI: its
          // death is a detach, so drop the control client without killing
          // anything.
          if (session.kind === 'attached') session.client?.destroy();
          this.sessions.delete(pid);
        }
      }
    }, intervalMs);
  }

  stopReaper() {
    if (this._reaperInterval) {
      clearInterval(this._reaperInterval);
      this._reaperInterval = null;
    }
  }

  async shutdownAll() {
    this.stopReaper();
    const pids = [...this.sessions.keys()];
    await Promise.all(pids.map(pid => this.stopSession(pid)));
    console.log('[remote-sessions] All sessions shut down');
  }
}
