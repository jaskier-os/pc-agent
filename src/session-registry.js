import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The remote-session CLI writes one JSON file per live session here (mode 0700
// dir). We read it to discover an interactive CLI the user already has open on
// the conversation the phone just asked for, so we can attach to it instead of
// spawning a second headless process for the same transcript.
//
// Resolved per call, not at module load: a load-time constant freezes whatever
// HOME happened to be at first import, which is wrong for anything that runs
// with a different HOME.
function sessionsDir() {
  return path.join(process.env.HOME || os.homedir(), '.claude', 'sessions');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PID files this old whose process is gone are swept even if they somehow
// survived the liveness check path.
const MAX_PID_FILE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user -- alive, but not
    // ours, so it is not an attach candidate either way.
    return err.code === 'EPERM';
  }
}

/**
 * Process start time in clock ticks since boot (/proc/<pid>/stat field 22).
 * Compared against the value the CLI recorded when it wrote its PID file, so a
 * recycled pid cannot be mistaken for the original session.
 */
export function readProcessStartTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesised and may contain spaces and parens, so
    // split after the LAST ')'.
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const rest = stat.slice(close + 2).split(' ');
    const ticks = Number(rest[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/**
 * Validate that an advertised attach socket really is the one the CLI at this
 * pid would have published, and that it is owner-private.
 *
 * This is the counterpart to the CLI's secret check: that direction stops a
 * random process from talking to a live agent, this direction stops a random
 * process from being handed the orchestrator API key. Without it, any process
 * running as this user could drop a `<its-own-pid>.json` into the registry
 * carrying a sessionId/cwd copied from a genuine neighbouring entry and an
 * attachSocketPath pointing at a socket it controls, then answer hello_ok with
 * the expected values and receive the credential. The registry file is
 * attacker-writable data; the socket path is therefore not taken on trust.
 *
 * The path is required to be exactly $XDG_RUNTIME_DIR/remote-session/attach-<pid>.sock
 * for the SAME pid the registry filename names, and the socket must be a
 * socket owned by us with no group/other bits.
 */
function isTrustworthyAttachSocket(socketPath, pid) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir) return false;
  const expected = path.join(runtimeDir, 'remote-session', `attach-${pid}.sock`);
  if (path.resolve(socketPath) !== expected) {
    console.warn(`[session-registry] attachSocketPath for pid ${pid} is not the expected path; ignoring`);
    return false;
  }
  try {
    const st = fs.lstatSync(expected);
    if (!st.isSocket()) return false;
    if (st.uid !== process.getuid()) return false;
    if ((st.mode & 0o077) !== 0) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Enumerate live CLI sessions from the registry, reaping stale entries.
 * Malformed files are skipped, never thrown on -- a corrupt registry must
 * degrade to "no attach candidate", not break session start.
 */
export function listLiveSessions() {
  const dir = sessionsDir();
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const live = [];
  for (const file of files) {
    // Strict filename guard: only `<pid>.json`. Lenient parseInt would read
    // `2026-03-14_notes.md` as pid 2026 and sweep a user's file.
    if (!/^\d+\.json$/.test(file)) continue;
    const full = path.join(dir, file);
    const pid = parseInt(file.slice(0, -5), 10);

    if (!isAlive(pid)) {
      let age = 0;
      try { age = Date.now() - fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      if (age > MAX_PID_FILE_AGE_MS) unlinkQuiet(full);
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    live.push({ ...entry, pid });
  }
  return live;
}

/**
 * Find a live interactive CLI that is attachable for this conversation.
 *
 * Every condition is mandatory:
 *  - sessionId matches and is a real UUID. maybeRespawnCli reaches
 *    startSession from rcStore, bypassing the gateway's UUID validation, so it
 *    is re-checked here.
 *  - kind === 'interactive'. Print-mode/bg/daemon sessions are not attachable.
 *  - attachSocketPath present. Absent means the CLI could not publish a
 *    control socket (no XDG_RUNTIME_DIR, unsafe permissions) -- spawn instead.
 *  - startTicks matches /proc, so a recycled pid is not mistaken for the
 *    original process.
 *  - cwd === workDir. Attach hands a phone-side actor prompt injection into a
 *    live TUI in whatever directory it has; the caller must be talking about
 *    the directory it thinks it is.
 *
 * The socket handshake re-verifies sessionId authoritatively, which closes the
 * registry TOCTOU even if every check here were fooled.
 */
export function findLiveSession(sessionId, workDir) {
  if (!sessionId || !UUID_RE.test(sessionId)) return null;
  if (!workDir) return null;

  for (const entry of listLiveSessions()) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.kind !== 'interactive') continue;
    if (!entry.attachSocketPath) continue;
    if (entry.cwd !== workDir) continue;
    if (!isTrustworthyAttachSocket(entry.attachSocketPath, entry.pid)) continue;
    if (entry.startTicks != null) {
      const actual = readProcessStartTicks(entry.pid);
      if (actual != null && actual !== entry.startTicks) {
        console.warn(`[session-registry] pid ${entry.pid} start-time mismatch; treating as recycled pid`);
        continue;
      }
    }
    return {
      pid: entry.pid,
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      attachSocketPath: entry.attachSocketPath,
      startTicks: entry.startTicks ?? null,
    };
  }
  return null;
}

/**
 * Poll findLiveSession until the CLI for this conversation has published its
 * attach socket, or the timeout expires.
 *
 * Needed because a freshly spawned interactive CLI is not attachable the
 * instant pty.spawn returns: it registers itself only once the REPL has
 * mounted. Every acceptance check in findLiveSession still applies, so a
 * session that appears is a session we are willing to attach to.
 */
export async function waitForLiveSession(sessionId, workDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live = findLiveSession(sessionId, workDir);
    if (live) return live;
    if (Date.now() >= deadline) {
      throw new Error(
        `no attachable session ${sessionId} in ${workDir} after ${timeoutMs}ms`,
      );
    }
    await new Promise(r => setTimeout(r, 250));
  }
}
