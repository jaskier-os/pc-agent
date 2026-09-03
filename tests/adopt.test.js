/**
 * Unit tests for adopt-only chat-open reconciliation.
 *
 * The gap being closed: opening a phone chat that already has an interactive
 * CLI running on the PC did not attach, because listSessions() only saw
 * pc-agent-spawned sessions and adoptSession did not exist. These tests pin the
 * two invariants that matter:
 *   - a terminal-started CLI (registry-only) surfaces in listSessions() as
 *     adoptable, without duplicating one pc-agent already owns.
 *   - adoptSession NEVER spawns: when no live CLI matches, it returns
 *     { adopted: false } and starts no process.
 *
 * Run: node tests/adopt.test.js
 */
import assert from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProcessStartTicks } from '../src/session-registry.js';
import { RemoteSessionManager } from '../src/remote-sessions.js';

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

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// Build a temp HOME containing ~/.claude/sessions/<pid>.json for a process that
// is genuinely alive (this test process), so listLiveSessions() accepts it.
// cwd must be a real dir so findLiveSession's cwd check can be satisfied when a
// test needs it. startTicks matches /proc so the recycled-pid guard passes.
function withFakeRegistry(entryOverrides, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-home-'));
  const sessDir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-cwd-'));
  const entry = {
    sessionId: SID,
    kind: 'interactive',
    cwd: workDir,
    startedAt: new Date().toISOString(),
    startTicks: readProcessStartTicks(process.pid),
    ...entryOverrides,
  };
  fs.writeFileSync(path.join(sessDir, `${process.pid}.json`), JSON.stringify(entry));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn({ workDir, entry });
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// listSessions() must surface a registry-only interactive CLI as adoptable.
test('listSessions surfaces a terminal-started CLI as adoptable', async () => {
  withFakeRegistry({}, ({ workDir }) => {
    const mgr = new RemoteSessionManager([], null, '');
    const list = mgr.listSessions();
    const row = list.find(s => s.sessionId === SID);
    assert.ok(row, 'registry session should appear in listSessions()');
    assert.strictEqual(row.adoptable, true, 'should be marked adoptable');
    assert.strictEqual(row.attached, false, 'a not-yet-attached CLI is not attached');
    assert.strictEqual(row.alive, true);
    assert.strictEqual(row.workDir, workDir);
  });
});

// A session pc-agent already tracks must not be double-reported from the
// registry: the in-memory entry (keyed by the same pid) wins.
test('listSessions does not duplicate a session pc-agent already owns', async () => {
  withFakeRegistry({}, () => {
    const mgr = new RemoteSessionManager([], null, '');
    mgr.sessions.set(process.pid, {
      workDir: '/some/dir', sessionId: SID, startedAt: new Date().toISOString(),
      alive: true, kind: 'attached',
    });
    const rows = mgr.listSessions().filter(s => s.sessionId === SID);
    assert.strictEqual(rows.length, 1, 'exactly one row for the session');
    assert.strictEqual(rows[0].adoptable, false, 'the owned row is not adoptable');
    assert.strictEqual(rows[0].attached, true);
  });
});

// The core safety invariant: adopt must never spawn. With no matching live CLI,
// findLiveSession returns null and adoptSession returns { adopted: false }
// without touching the spawn path.
test('adoptSession returns adopted:false and does not spawn when nothing is live', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-empty-'));
  fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-empty-cwd-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mgr = new RemoteSessionManager([], null, '');
    // Tripwire: fail loudly if any spawn path is entered.
    mgr._startSessionInner = () => { throw new Error('adopt must not spawn'); };
    const res = await mgr.adoptSession(workDir, SID, 'wss://x/ws', 'key', 'bypassPermissions');
    assert.deepStrictEqual(res, { adopted: false });
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// A session pc-agent already drives is reported adopted without any attach dial.
test('adoptSession reports an already-owned live session as adopted', async () => {
  const mgr = new RemoteSessionManager([], null, '');
  mgr._attachToLiveSession = () => { throw new Error('should not attach an owned session'); };
  mgr.sessions.set(4242, {
    workDir: '/w', sessionId: SID, startedAt: 't', alive: true, kind: 'attached',
  });
  const res = await mgr.adoptSession('/w', SID, 'wss://x/ws', 'key', 'bypassPermissions');
  assert.strictEqual(res.adopted, true);
  assert.strictEqual(res.attached, true);
});

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}, 100);
