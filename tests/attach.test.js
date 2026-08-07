/**
 * Unit tests for live attach: session discovery, the spawn-argv regression
 * tripwire, and the pure wsUrl rewrite.
 *
 * Run: node tests/attach.test.js
 */
import assert from 'assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnArgs, buildTerminalCommand, hasExistingTranscript, resolveDisplayEnv, rewriteWsUrl, sanitizeProjectPath, terminalAttachEnv } from '../src/remote-sessions.js';
import { AttachClient } from '../src/attach-client.js';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${name}\n      ${err.message}`);
    fail++;
  }
}

// Whether a graphical session exists, decided WITHOUT calling the code under
// test -- a guard that asks resolveDisplayEnv() would let a stub returning {}
// skip itself, and the bug would sail through green.
//
// XDG_RUNTIME_DIR is captured now: a later test reassigns it while faking HOME.
const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
function graphicalSessionExists() {
  try {
    if (fs.readdirSync('/tmp/.X11-unix').length > 0) return true;
  } catch { /* no X sockets */ }
  if (!xdgRuntimeDir) return false;
  try {
    return fs.readdirSync(xdgRuntimeDir).some(n => /^wayland-\d+$/.test(n));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// buildSpawnArgs -- must produce an INTERACTIVE CLI, never a headless one.
//
// A `--print` process cannot be attached to and renders nothing on the PC, so
// it can never satisfy "the phone and the PC TUI stay in sync". These tests
// exist to stop `--print` (or a pinned model) creeping back in.
// ---------------------------------------------------------------------------
const SID = '11111111-2222-3333-4444-555555555555';
// Still used by the attach tests below: the WS URL is no longer a spawn arg,
// but it IS handed to the live CLI over the attach socket.
const WS = 'wss://orc.example:8443/ws/remote-control?session=abc';

const SNAPSHOT_FRESH = [
  '--session-id', SID,
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--permission-mode', 'default',
];

const SNAPSHOT_RESUME_BYPASS = [
  '--resume', SID,
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
  '--dangerously-skip-permissions',
];

await test('buildSpawnArgs snapshot: fresh --session-id branch', () => {
  assert.deepStrictEqual(buildSpawnArgs(SID, 'default', false), SNAPSHOT_FRESH);
});

await test('buildSpawnArgs snapshot: --resume + bypassPermissions branch', () => {
  assert.deepStrictEqual(buildSpawnArgs(SID, 'bypassPermissions', true), SNAPSHOT_RESUME_BYPASS);
});

await test('buildSpawnArgs: acceptEdits and plan use --permission-mode', () => {
  assert.ok(buildSpawnArgs(SID, 'acceptEdits', false).includes('acceptEdits'));
  assert.ok(buildSpawnArgs(SID, 'plan', false).includes('plan'));
});

await test('buildSpawnArgs never spawns a headless or model-pinned session', () => {
  for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions']) {
    for (const resuming of [false, true]) {
      const args = buildSpawnArgs(SID, mode, resuming);
      for (const banned of ['--print', '--sdk-url', '--model', '--effort', '--input-format', '--output-format']) {
        assert.ok(!args.includes(banned), `${banned} must not appear (mode=${mode}, resuming=${resuming})`);
      }
    }
  }
});

// The terminal wrapper is what makes the session visible to the PC user. A bare
// pty is invisible, which defeats attaching to "the CLI you already have open".
await test('buildTerminalCommand wraps the CLI in a terminal when a display exists', () => {
  const prevDisplay = process.env.DISPLAY;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  process.env.DISPLAY = ':0';
  delete process.env.WAYLAND_DISPLAY;
  try {
    const [cmd, args] = buildTerminalCommand('/bin/remote-session', ['--session-id', SID], 'title');
    // Either a terminal emulator was found (cmd is the emulator, CLI is inside
    // args) or none is installed on this host (documented fallback).
    if (cmd !== '/bin/remote-session') {
      assert.ok(args.includes('/bin/remote-session'), 'CLI must be the wrapped command');
      assert.ok(args.includes('--session-id'), 'CLI args must be preserved after the terminal args');
    }
  } finally {
    if (prevDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = prevDisplay;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
  }
});

await test('buildTerminalCommand runs the CLI directly when headless', () => {
  // "Headless" means NO graphical session on the host -- not merely an unset
  // DISPLAY. pc-agent runs under `systemd --user` and never inherits DISPLAY
  // even on a desktop, so treating unset-env as headless is precisely the bug
  // that stopped sessions opening a terminal tab (see resolveDisplayEnv).
  if (graphicalSessionExists()) return;
  const prevDisplay = process.env.DISPLAY;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    const [cmd, args] = buildTerminalCommand('/bin/remote-session', ['--session-id', SID], 'title');
    assert.strictEqual(cmd, '/bin/remote-session');
    assert.deepStrictEqual(args, ['--session-id', SID]);
  } finally {
    if (prevDisplay !== undefined) process.env.DISPLAY = prevDisplay;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
  }
});

// ---------------------------------------------------------------------------
// rewriteWsUrl -- pure, and null (not a mangled URL) on unparseable input, so
// the caller keeps the original exactly as the old inline code did.
// ---------------------------------------------------------------------------
await test('rewriteWsUrl swaps host and port', () => {
  assert.strictEqual(
    rewriteWsUrl('wss://public.example/ws/remote-control?session=x', 'wss://10.0.0.1:8444/ws'),
    'wss://10.0.0.1:8444/ws/remote-control?session=x',
  );
});

await test('rewriteWsUrl returns null when inputs are missing or unparseable', () => {
  assert.strictEqual(rewriteWsUrl('wss://a/b', ''), null);
  assert.strictEqual(rewriteWsUrl('', 'wss://a'), null);
  assert.strictEqual(rewriteWsUrl('::: not a url', 'wss://a'), null);
});

// ---------------------------------------------------------------------------
// findLiveSession -- runs against a scratch registry dir. The module reads
// ~/.claude/sessions at import time via a module constant, so the tests drive
// it through a temporary HOME.
// ---------------------------------------------------------------------------
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
const sessionsDir = path.join(tmpHome, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const realHome = os.homedir();
process.env.HOME = tmpHome;
// Re-import with HOME pointed at the scratch dir.
const { findLiveSession, listLiveSessions, readProcessStartTicks } =
  await import('../src/session-registry.js');

const WORKDIR = tmpHome;

// findLiveSession only trusts a socket at exactly
// $XDG_RUNTIME_DIR/remote-session/attach-<pid>.sock, owned by us and
// owner-private. Stand up a real one so the happy-path cases can pass.
const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-xdg-'));
const prevXdg = process.env.XDG_RUNTIME_DIR;
process.env.XDG_RUNTIME_DIR = xdgDir;
fs.mkdirSync(path.join(xdgDir, 'remote-session'), { recursive: true, mode: 0o700 });
const realSocketPath = path.join(xdgDir, 'remote-session', `attach-${process.pid}.sock`);
const registrySocketServer = net.createServer();
await new Promise(r => registrySocketServer.listen(realSocketPath, r));
fs.chmodSync(realSocketPath, 0o600);

function writeEntry(pid, overrides = {}) {
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: SID,
    cwd: WORKDIR,
    kind: 'interactive',
    attachSocketPath: path.join(xdgDir, 'remote-session', `attach-${pid}.sock`),
    startTicks: readProcessStartTicks(pid),
    ...overrides,
  }));
}

await test('findLiveSession finds a matching live interactive session', () => {
  writeEntry(process.pid);
  const found = findLiveSession(SID, WORKDIR);
  assert.ok(found, 'expected a match');
  assert.strictEqual(found.pid, process.pid);
});

await test('findLiveSession rejects a non-UUID sessionId', () => {
  assert.strictEqual(findLiveSession('../../etc/passwd', WORKDIR), null);
  assert.strictEqual(findLiveSession('not-a-uuid', WORKDIR), null);
});

await test('findLiveSession rejects cwd !== workDir', () => {
  assert.strictEqual(findLiveSession(SID, '/some/other/dir'), null);
});

await test('findLiveSession rejects kind !== interactive', () => {
  writeEntry(process.pid, { kind: 'bg' });
  assert.strictEqual(findLiveSession(SID, WORKDIR), null);
  writeEntry(process.pid);
});

await test('findLiveSession rejects entries lacking attachSocketPath', () => {
  writeEntry(process.pid, { attachSocketPath: undefined });
  assert.strictEqual(findLiveSession(SID, WORKDIR), null);
  writeEntry(process.pid);
});

// The registry file is attacker-writable data: any process running as this
// user can create one. If pc-agent trusted its attachSocketPath verbatim it
// would connect to a socket the attacker controls and hand over the
// orchestrator API key. The path must therefore be exactly the one the CLI at
// that pid would have published.
await test('findLiveSession rejects an attachSocketPath outside XDG_RUNTIME_DIR', () => {
  writeEntry(process.pid, { attachSocketPath: '/tmp/evil.sock' });
  assert.strictEqual(findLiveSession(SID, WORKDIR), null);
  writeEntry(process.pid);
});

await test('findLiveSession rejects a socket path naming a different pid', () => {
  writeEntry(process.pid, {
    attachSocketPath: path.join(xdgDir, 'remote-session', 'attach-1.sock'),
  });
  assert.strictEqual(findLiveSession(SID, WORKDIR), null);
  writeEntry(process.pid);
});

await test('findLiveSession rejects a group/world-accessible socket', () => {
  fs.chmodSync(realSocketPath, 0o666);
  assert.strictEqual(findLiveSession(SID, WORKDIR), null);
  fs.chmodSync(realSocketPath, 0o600);
  assert.ok(findLiveSession(SID, WORKDIR), 'must match again once tightened');
});

await test('findLiveSession rejects a regular file posing as the socket', () => {
  const otherPid = process.pid + 1;
  const fake = path.join(xdgDir, 'remote-session', `attach-${otherPid}.sock`);
  fs.writeFileSync(fake, '', { mode: 0o600 });
  // Uses this process's pid (alive) but points at a non-socket path, which is
  // the shape of the impersonation attack.
  writeEntry(process.pid, { attachSocketPath: fake });
  assert.strictEqual(findLiveSession(SID, WORKDIR), null);
  fs.unlinkSync(fake);
  writeEntry(process.pid);
});

await test('findLiveSession rejects a startTicks mismatch (recycled pid)', () => {
  writeEntry(process.pid, { startTicks: 999999999 });
  assert.strictEqual(findLiveSession(SID, WORKDIR), null);
  writeEntry(process.pid);
});

await test('listLiveSessions skips malformed JSON and dead pids', () => {
  fs.writeFileSync(path.join(sessionsDir, '999999.json'), '{ not json');
  // pid 1 is init: alive but definitely not one of ours, and it has no file.
  const live = listLiveSessions();
  assert.ok(live.every(e => e.pid !== 999999), 'malformed entry must be skipped');
  assert.ok(live.some(e => e.pid === process.pid), 'valid entry must survive');
  fs.unlinkSync(path.join(sessionsDir, '999999.json'));
});

await test('listLiveSessions ignores non-<pid>.json filenames', () => {
  const decoy = path.join(sessionsDir, '2026-03-14_notes.md');
  fs.writeFileSync(decoy, 'user data');
  listLiveSessions();
  assert.ok(fs.existsSync(decoy), 'must never sweep a non-pid file');
  fs.unlinkSync(decoy);
});

// ---------------------------------------------------------------------------
// AttachClient against a fake CLI control socket.
// ---------------------------------------------------------------------------
function startFakeCli(dir, behavior) {
  const sock = path.join(dir, 'attach-fake.sock');
  fs.writeFileSync(path.join(dir, 'attach-fake.secret'), 'secret-token');
  const server = net.createServer(conn => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', chunk => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        behavior(JSON.parse(line), f => conn.write(JSON.stringify(f) + '\n'), conn);
      }
    });
    conn.on('error', () => {});
  });
  return new Promise(resolve => server.listen(sock, () => resolve({ server, sock })));
}

const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-sock-'));

await test('AttachClient completes hello + attach and resolves on attach_ok', async () => {
  const { server, sock } = await startFakeCli(sockDir, (frame, send) => {
    if (frame.type === 'hello') {
      assert.strictEqual(frame.secret, 'secret-token');
      send({ v: 1, type: 'hello_ok', pid: 1, sessionId: SID, cwd: WORKDIR, protocol: 1, attached: false, permissionMode: 'default' });
    } else if (frame.type === 'attach') {
      // Credentials must arrive over the socket, never through argv.
      assert.strictEqual(frame.authToken, 'the-api-key');
      send({ v: 1, type: 'attach_ok', attachId: frame.attachId });
    }
  });
  try {
    const client = await AttachClient.attach(
      { pid: 1, attachSocketPath: sock },
      { sessionId: SID, workDir: WORKDIR, wsUrl: WS, apiKey: 'the-api-key', permissionMode: 'default' },
    );
    assert.ok(client.attachId, 'expected an attachId');
    client.destroy();
  } finally {
    server.close();
  }
});

await test('AttachClient aborts when hello_ok reports a different sessionId', async () => {
  const sock2 = path.join(sockDir, 'b');
  fs.mkdirSync(sock2, { recursive: true });
  const { server, sock } = await startFakeCli(sock2, (frame, send) => {
    if (frame.type === 'hello') {
      send({ v: 1, type: 'hello_ok', pid: 1, sessionId: '99999999-9999-9999-9999-999999999999', cwd: WORKDIR, protocol: 1, attached: false, permissionMode: 'default' });
    }
  });
  try {
    await assert.rejects(
      AttachClient.attach({ pid: 1, attachSocketPath: sock }, { sessionId: SID, workDir: WORKDIR, wsUrl: WS, apiKey: 'k' }),
      /session mismatch/,
    );
  } finally {
    server.close();
  }
});

await test('AttachClient surfaces attach_error codes to the caller', async () => {
  const dir3 = path.join(sockDir, 'c');
  fs.mkdirSync(dir3, { recursive: true });
  const { server, sock } = await startFakeCli(dir3, (frame, send) => {
    if (frame.type === 'hello') {
      send({ v: 1, type: 'hello_ok', pid: 1, sessionId: SID, cwd: WORKDIR, protocol: 1, attached: false, permissionMode: 'default' });
    } else if (frame.type === 'attach') {
      send({ v: 1, type: 'attach_error', code: 'mode_unsafe', message: 'bypassPermissions' });
    }
  });
  try {
    await assert.rejects(
      AttachClient.attach({ pid: 1, attachSocketPath: sock }, { sessionId: SID, workDir: WORKDIR, wsUrl: WS, apiKey: 'k' }),
      /mode_unsafe/,
    );
  } finally {
    server.close();
  }
});

await test('AttachClient emits detached synchronously when the socket dies', async () => {
  const dir4 = path.join(sockDir, 'd');
  fs.mkdirSync(dir4, { recursive: true });
  let liveConn = null;
  const { server, sock } = await startFakeCli(dir4, (frame, send, conn) => {
    liveConn = conn;
    if (frame.type === 'hello') {
      send({ v: 1, type: 'hello_ok', pid: 1, sessionId: SID, cwd: WORKDIR, protocol: 1, attached: false, permissionMode: 'default' });
    } else if (frame.type === 'attach') {
      send({ v: 1, type: 'attach_ok', attachId: frame.attachId });
    }
  });
  try {
    const client = await AttachClient.attach(
      { pid: 1, attachSocketPath: sock },
      { sessionId: SID, workDir: WORKDIR, wsUrl: WS, apiKey: 'k' },
    );
    const detached = new Promise(resolve => client.once('detached', resolve));
    liveConn.destroy();
    const reason = await Promise.race([
      detached,
      new Promise((_, rej) => setTimeout(() => rej(new Error('no detached event within 2s')), 2000)),
    ]);
    assert.ok(typeof reason === 'string' && reason.length > 0);
  } finally {
    server.close();
  }
});

// An already_attached refusal means some control peer is ALREADY driving that
// CLI as this session's desktop -- the desired end state. It must surface with
// a machine-readable code so startSession reports success instead of spawning
// a second, competing desktop for the same sessionId.
await test('already_attached surfaces as a typed error code, not a generic failure', async () => {
  const dir5 = path.join(sockDir, 'e');
  fs.mkdirSync(dir5, { recursive: true });
  const { server, sock } = await startFakeCli(dir5, (frame, send) => {
    if (frame.type === 'hello') {
      send({ v: 1, type: 'hello_ok', pid: 1, sessionId: SID, cwd: WORKDIR, protocol: 1, attached: true, permissionMode: 'default' });
    } else if (frame.type === 'attach') {
      send({ v: 1, type: 'attach_error', code: 'already_attached', message: 'busy' });
    }
  });
  try {
    let caught = null;
    try {
      await AttachClient.attach({ pid: 1, attachSocketPath: sock }, { sessionId: SID, workDir: WORKDIR, wsUrl: WS, apiKey: 'k' });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected a rejection');
    assert.strictEqual(caught.code, 'already_attached');
  } finally {
    server.close();
  }
});

process.env.HOME = realHome;
if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
else process.env.XDG_RUNTIME_DIR = prevXdg;
await test('terminalAttachEnv finds a GNOME_TERMINAL_SERVICE when one exists', () => {
  // pc-agent is a daemon and does not inherit GNOME_TERMINAL_SERVICE, so
  // gnome-terminal's --tab would silently open a NEW WINDOW instead of a tab in
  // the window the user already has open. It must recover the value from a live
  // process. On a headless box there is none, and {} is the correct answer.
  const env = terminalAttachEnv();
  assert.ok(typeof env === 'object' && env !== null);
  if (env.GNOME_TERMINAL_SERVICE !== undefined) {
    assert.ok(env.GNOME_TERMINAL_SERVICE.length > 0);
  }
});

// ---------------------------------------------------------------------------
// resolveDisplayEnv
//
// pc-agent is started by `systemd --user`, which does NOT inherit DISPLAY from
// the graphical session. buildTerminalCommand read process.env.DISPLAY
// directly, saw nothing, took its headless fallback, and ran the CLI bare
// inside pc-agent's own pty: the session worked and the phone attached, but no
// terminal tab ever appeared on the PC -- the user could not see or type into
// the session they were supposedly sharing.
// ---------------------------------------------------------------------------
// A fake /proc: each entry is one process's environ. Injecting this is what
// makes the headless and multi-display cases testable on ANY host -- a test
// that skips itself when the real host disagrees reports PASS while covering
// nothing.
function fakeProc(...envs) {
  return () => envs; // each entry is one process's environ, already split
}

await test('resolveDisplayEnv recovers DISPLAY when the daemon did not inherit one', () => {
  const env = resolveDisplayEnv({
    processEnv: {},
    scanProcesses: fakeProc(['HOME=/home/u'], ['DISPLAY=:0', 'XAUTHORITY=/run/xauth']),
  });
  assert.strictEqual(env.DISPLAY, ':0');
  assert.strictEqual(env.XAUTHORITY, '/run/xauth');
});

await test('resolveDisplayEnv prefers an inherited DISPLAY over scanning', () => {
  const env = resolveDisplayEnv({
    processEnv: { DISPLAY: ':99' },
    scanProcesses: fakeProc(['DISPLAY=:0']),
  });
  assert.strictEqual(env.DISPLAY, ':99');
});

await test('resolveDisplayEnv returns nothing on a genuinely headless host', () => {
  // The direct-exec fallback is CORRECT here; this is the branch the old
  // "delete process.env.DISPLAY" test could no longer reach on a desktop.
  const env = resolveDisplayEnv({
    processEnv: {},
    scanProcesses: fakeProc(['HOME=/home/u'], ['TERM=xterm']),
  });
  assert.deepStrictEqual(env, {});
});

await test('resolveDisplayEnv skips a forwarded ssh -X display for the local one', () => {
  // /proc enumeration order is arbitrary, so a same-user `ssh -X` session
  // (DISPLAY=localhost:10.0) or a stale Xvfb can win the race against the real
  // seat and the tab opens somewhere the user is not looking -- or not at all.
  const env = resolveDisplayEnv({
    processEnv: {},
    scanProcesses: fakeProc(
      ['DISPLAY=localhost:10.0', 'XAUTHORITY=/home/u/.Xauthority'],
      ['DISPLAY=:0', 'XAUTHORITY=/run/xauth'],
    ),
    hasLocalDisplaySocket: d => d === ':0',
  });
  assert.strictEqual(env.DISPLAY, ':0');
});

await test('resolveDisplayEnv carries the session bus gnome-terminal needs', () => {
  const env = resolveDisplayEnv({
    processEnv: {},
    scanProcesses: fakeProc([
      'DISPLAY=:0',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
    ]),
  });
  assert.strictEqual(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
});

await test('buildTerminalCommand still wraps the CLI when DISPLAY was not inherited', () => {
  const prevDisplay = process.env.DISPLAY;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    // Only meaningful where an emulator is installed AND a display is
    // recoverable; otherwise direct exec is the documented correct answer.
    if (!graphicalSessionExists()) return;
    const [cmd, args] = buildTerminalCommand('/bin/remote-session', ['--session-id', SID], 'title');
    assert.notStrictEqual(cmd, '/bin/remote-session', 'must not silently run the CLI bare');
    assert.ok(args.includes('/bin/remote-session'), 'CLI must be the wrapped command');
    assert.ok(args.includes('--session-id'), 'CLI args must be preserved');
  } finally {
    if (prevDisplay !== undefined) process.env.DISPLAY = prevDisplay;
    if (prevWayland !== undefined) process.env.WAYLAND_DISPLAY = prevWayland;
  }
});

await test('gnome-terminal is preferred and opens a tab, not a window', () => {
  const [cmd, args] = buildTerminalCommand('/bin/remote-session', ['--session-id', SID], 'T');
  if (!cmd.includes('gnome-terminal')) return; // not installed on this host
  assert.ok(args.includes('--tab'), '--tab keeps the session in the existing window');
  assert.ok(args.includes('--wait'), '--wait is required or the launcher exits instantly');
  // The CLI must come after the `--` separator.
  assert.ok(args.indexOf('--') < args.indexOf('/bin/remote-session'));
});

// ---------------------------------------------------------------------------
// sanitizeProjectPath / hasExistingTranscript
//
// The CLI stores transcripts under a project dir whose name is the cwd with
// EVERY non-alphanumeric char replaced by '-'. pc-agent previously replaced
// only '/', so any dotted path (~/.cache/foo) resolved to a directory that
// does not exist: an existing conversation looked brand new, recovery spawned
// with --session-id instead of --resume, and the CLI exited immediately with
// "Session ID is already in use" -- the phone got no reply at all.
// ---------------------------------------------------------------------------
await test('sanitizeProjectPath replaces dots, not just slashes', () => {
  assert.strictEqual(
    sanitizeProjectPath('/media/varingait/Lobotomite/.cache/rc-live-attach-test'),
    '-media-varingait-Lobotomite--cache-rc-live-attach-test',
  );
});

await test('sanitizeProjectPath replaces every non-alphanumeric character', () => {
  assert.strictEqual(sanitizeProjectPath('/a b:c_d.e@f'), '-a-b-c-d-e-f');
});

await test('hasExistingTranscript finds a transcript under a dotted path', () => {
  const sid = '99999999-8888-7777-6666-555555555555';
  const workDir = path.join(os.tmpdir(), `.dotted-${process.pid}`, 'proj');
  const dir = path.join(os.homedir(), '.claude', 'projects', sanitizeProjectPath(workDir));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, '{"type":"user"}\n');
  try {
    assert.strictEqual(hasExistingTranscript(workDir, sid), true);
    assert.strictEqual(hasExistingTranscript(workDir, '11111111-0000-0000-0000-000000000000'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


registrySocketServer.close();
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.rmSync(sockDir, { recursive: true, force: true });
fs.rmSync(xdgDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
