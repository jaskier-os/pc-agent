import * as pty from 'node-pty';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { access } from 'fs/promises';
import { randomUUID } from 'crypto';

// Returns true iff Claude Code already has a transcript on disk for this
// sessionId+workDir pair. Used to switch the spawn args from "fresh session"
// (--session-id) to "resume" (--resume) so that respawned CLIs reload the
// prior conversation context instead of starting blank with the same id.
function hasExistingTranscript(workDir, sessionId) {
  if (!sessionId || !workDir) return false;
  // Project dir naming: absolute cwd with '/' replaced by '-' (leading dash kept).
  const projectDir = workDir.replace(/\//g, '-');
  const jsonl = path.join(os.homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
  try { return fs.statSync(jsonl).size > 0; } catch { return false; }
}

const SPAWN_TIMEOUT_MS = 60000;
const CLI_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

// Resolve the Claude Code CLI binary. Preference order:
//   1. explicit path supplied via the CLAUDE_BIN env var / constructor option
//   2. `claude` looked up on the system PATH
// Returns null if neither is available so the caller can surface a clear error.
function findClaudeBinary(claudeBin) {
  if (claudeBin && fs.existsSync(claudeBin)) return claudeBin;
  if (claudeBin) {
    throw new Error(`Claude Code binary not found at CLAUDE_BIN=${claudeBin}`);
  }
  // Fall back to PATH lookup.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  throw new Error('Claude Code binary not found. Set CLAUDE_BIN to its absolute path or install `claude` on PATH.');
}

export class RemoteSessionManager {
  constructor(dirs, orchestratorUrl, claudeBin = '') {
    this.dirs = dirs;
    this.orchestratorUrl = orchestratorUrl;
    this.claudeBin = claudeBin || process.env.CLAUDE_BIN || '';
    this.sessions = new Map(); // pid -> { workDir, sessionId, startedAt, process, alive }
    this.startReaper();
  }

  async startSession(workDir, sessionId, wsUrl, apiKey, permissionMode) {
    if (!CLI_MODES.includes(permissionMode)) {
      throw new Error('invalid_permission_mode: ' + permissionMode);
    }

    // Dedup: if a CLI for this sessionId is already alive, return it instead
    // of spawning a duplicate. This prevents the race where the phone's retry
    // loop triggers multiple spawns before the first CLI's WS connects.
    if (sessionId) {
      for (const [pid, s] of this.sessions) {
        if (s.sessionId === sessionId && s.alive) {
          console.log(`[remote-sessions] Session ${sessionId} already alive (pid=${pid}), returning existing`);
          return { pid, sessionId: s.sessionId, workDir: s.workDir, startedAt: s.startedAt };
        }
      }
    }

    // Validate directory exists
    try {
      await access(workDir);
    } catch {
      throw new Error(`Directory does not exist: ${workDir}`);
    }

    // Rewrite wsUrl host to match our local orchestrator connection.
    // The gateway may advertise a public-facing host/port to clients, but this
    // machine reaches the orchestrator via its own configured ORCHESTRATOR_URL,
    // so rewrite the host/port of the SDK websocket URL accordingly.
    if (this.orchestratorUrl && wsUrl) {
      try {
        // Parse orchestrator URL (convert to http for URL parsing, preserve ws scheme)
        const orcUrl = new URL(this.orchestratorUrl.replace('wss://', 'https://').replace('ws://', 'http://'));
        const sdkUrl = new URL(wsUrl.replace('wss://', 'https://').replace('ws://', 'http://'));
        sdkUrl.hostname = orcUrl.hostname;
        sdkUrl.port = orcUrl.port;
        // Convert back to wss:// for WebSocket transport
        wsUrl = sdkUrl.toString().replace('https://', 'wss://').replace('http://', 'ws://');
        console.log(`[remote-sessions] Rewrote sdk-url to: ${wsUrl}`);
      } catch (e) {
        console.error(`[remote-sessions] Failed to rewrite wsUrl: ${e.message}`);
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

      // Set bridge env vars so claude's RemoteIO connects to our orchestrator WS
      env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = apiKey;
      env.CLAUDE_CODE_ENVIRONMENT_KIND = 'bridge';
      env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // orchestrator uses self-signed cert
      delete env.CLAUDE_CODE_OAUTH_TOKEN;

      // Bypass system proxy for the orchestrator WS host. claude inherits
      // HTTP(S)_PROXY from pc-agent (used to bypass DPI for Anthropic API),
      // but the SDK WS URL is a LAN address that must connect directly --
      // routing it through the upstream proxy times out silently and the
      // session never attaches.
      try {
        const sdkHost = new URL(wsUrl.replace('wss://', 'https://').replace('ws://', 'http://')).hostname;
        const existing = env.NO_PROXY || env.no_proxy || '';
        const parts = existing.split(',').map(s => s.trim()).filter(Boolean);
        if (sdkHost && !parts.includes(sdkHost)) {
          parts.push(sdkHost);
        }
        const noProxy = parts.join(',');
        env.NO_PROXY = noProxy;
        env.no_proxy = noProxy;
      } catch (e) {
        console.error(`[remote-sessions] Failed to update NO_PROXY: ${e.message}`);
      }

      // Ensure ~/.local/bin is in PATH (for claude binary)
      const home = process.env.HOME || '';
      if (home && env.PATH) {
        const extraDirs = [`${home}/.local/bin`, `${home}/.bun/bin`];
        const missing = extraDirs.filter(d => !env.PATH.includes(d));
        if (missing.length) {
          env.PATH = `${missing.join(':')}:${env.PATH}`;
        }
      }

      const claudePath = findClaudeBinary(this.claudeBin);
      const childSessionId = sessionId || randomUUID();
      const permissionArgs = permissionMode === 'bypassPermissions'
        ? ['--dangerously-skip-permissions']
        : ['--permission-mode', permissionMode];
      // If a transcript already exists for this session id + workDir, the
      // CLI process is being respawned (previous PID died -- crash, idle
      // exit, or our orchestrator-driven kill). Use --resume so the new
      // process loads the prior conversation context; --session-id alone
      // would create a fresh session that happens to share the id, and the
      // model would have zero memory of previous turns.
      const resuming = hasExistingTranscript(workDir, childSessionId);
      const sessionArgs = resuming
        ? ['--resume', childSessionId]
        : ['--session-id', childSessionId];
      if (resuming) {
        console.log(`[remote-sessions] Resuming existing session ${childSessionId}`);
      }
      // Isolate MCP servers: do not inherit user's interactive ~/.claude.json
      // mcpServers config. Stale entries (e.g. an MCP whose backing service is
      // down) hang the CLI indefinitely on startup, since MCP init is awaited
      // before the session becomes responsive. Remote sessions get a clean
      // empty MCP set; if a session needs MCPs, configure them explicitly.
      const child = pty.spawn(claudePath, [
        '--print',
        '--model', 'claude-opus-4-6[1m]',
        '--effort', 'max',
        '--sdk-url', wsUrl,
        ...sessionArgs,
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--verbose',
        '--strict-mcp-config',
        '--mcp-config', '{"mcpServers":{}}',
        ...permissionArgs,
        '--replay-user-messages',
      ], {
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

      // Resolve immediately -- the WS connection happens asynchronously
      resolved = true;
      console.log(`[remote-sessions] Session spawned: pid=${pid}, sessionId=${sessionId}, dir=${workDir}, claude=${claudePath}`);
      resolve({ pid, sessionId, workDir, startedAt });

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

  listSessions() {
    const result = [];
    for (const [pid, session] of this.sessions) {
      result.push({
        pid,
        workDir: session.workDir,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        alive: session.alive
      });
    }
    return result;
  }

  setPermissionMode(sessionId, mode) {
    if (!CLI_MODES.includes(mode)) {
      console.warn(`[remote-sessions] Dropping set_permission_mode with unknown CLI mode: ${mode}`);
      return false;
    }
    for (const [pid, session] of this.sessions) {
      if (session.sessionId === sessionId) {
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
