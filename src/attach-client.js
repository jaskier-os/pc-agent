import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

// Wire constants, mirrored from the CLI's src/remoteAttach/attachProtocol.ts.
const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const ATTACH_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

/**
 * Control connection to a live interactive remote-session CLI.
 *
 * Carries discovery and control only: the CLI opens the orchestrator
 * WebSocket itself, so no conversation data crosses this socket. The auth
 * token travels only over this PC-local 0600 unix socket -- never in argv
 * (ps-visible), never into the session registry file, never into a log line.
 *
 * Emits: 'detached' (reason), 'ws_state' ({state, closeCode}), 'error'.
 */
export class AttachClient extends EventEmitter {
  constructor(live) {
    super();
    this.live = live;
    this.socket = null;
    this.buffered = '';
    this.attachId = null;
    this.closed = false;
    this._pingTimer = null;
    this._waiters = new Map(); // frame type -> {resolve, reject, timer}
  }

  /**
   * Connect, authenticate, verify identity, and attach. Resolves only after
   * the CLI reports its orchestrator WebSocket is up: pc-agent must not record
   * a successful attach before a desktop WS exists, or the orchestrator's
   * respawn guard stays wedged for its full 120s ceiling while the phone's
   * pending messages expire at 60s.
   *
   * Any failure rejects; the caller falls back to spawning.
   */
  static async attach(live, opts) {
    const client = new AttachClient(live);
    try {
      await client._connect();
      const hello = await client._hello();
      // Authoritative identity check. The CLI's own view of which conversation
      // it is on wins over anything the registry file said, which closes the
      // registry TOCTOU completely.
      if (hello.sessionId !== opts.sessionId) {
        throw new Error(`session mismatch: CLI is on ${hello.sessionId}`);
      }
      if (hello.cwd !== opts.workDir) {
        throw new Error(`workDir mismatch: CLI cwd is ${hello.cwd}`);
      }
      await client._attach(opts);
      client._startPing();
      return client;
    } catch (err) {
      client.destroy();
      throw err;
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.live.attachSocketPath);
      socket.setEncoding('utf8');
      const onError = err => {
        // Destroy explicitly: this.socket is not assigned yet, so the
        // destroy() in _fail would be a no-op and each failed attach would
        // leak a half-open unix socket plus its listeners.
        socket.destroy();
        reject(new Error(`attach socket connect failed: ${err.message}`));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        socket.on('data', chunk => this._onData(String(chunk)));
        socket.on('error', err => this._fail(`socket error: ${err.message}`));
        socket.on('close', () => this._fail('control socket closed'));
        resolve();
      });
    });
  }

  _onData(chunk) {
    this.buffered += chunk;
    for (;;) {
      const nl = this.buffered.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffered.slice(0, nl);
      this.buffered = this.buffered.slice(nl + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        this._fail('malformed frame from CLI');
        return;
      }
      this._onFrame(frame);
    }
    if (Buffer.byteLength(this.buffered, 'utf8') > MAX_FRAME_BYTES) {
      this._fail('unterminated frame too large');
    }
  }

  _onFrame(frame) {
    if (frame.type === 'ws_state') {
      this.emit('ws_state', { state: frame.state, closeCode: frame.closeCode });
      if (frame.state === 'closed') {
        this._fail(`orchestrator websocket closed (${frame.closeCode ?? 'unknown'})`);
      }
      return;
    }
    if (frame.type === 'detached') {
      this._settle('attach_ok', null, new Error(`detached: ${frame.reason}`));
      this._fail(`detached: ${frame.reason}`);
      return;
    }
    if (frame.type === 'attach_error') {
      this._settle('attach_ok', null, Object.assign(
        new Error(`attach_error ${frame.code}: ${frame.message}`),
        { code: frame.code },
      ));
      return;
    }
    if (frame.type === 'pong') return;
    this._settle(frame.type, frame, null);
  }

  _wait(type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(type);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      this._waiters.set(type, { resolve, reject, timer });
    });
  }

  _settle(type, value, err) {
    const waiter = this._waiters.get(type);
    if (!waiter) return;
    this._waiters.delete(type);
    clearTimeout(waiter.timer);
    if (err) waiter.reject(err); else waiter.resolve(value);
  }

  _send(frame) {
    if (!this.socket || this.socket.destroyed) return false;
    this.socket.write(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }) + '\n');
    return true;
  }

  async _hello() {
    // The secret sits beside the socket in the CLI's 0700 runtime dir. It
    // proves we are a deliberate peer rather than any random process that
    // merely happens to run as the same uid -- a VS Code task, an npm
    // postinstall hook or an MCP server could otherwise inject prompts into a
    // live agent that has shell access.
    const secretPath = this.live.attachSocketPath.replace(/\.sock$/, '.secret');
    const secret = fs.readFileSync(secretPath, 'utf8').trim();
    const waiter = this._wait('hello_ok', HELLO_TIMEOUT_MS);
    this._send({ type: 'hello', secret });
    return waiter;
  }

  async _attach(opts) {
    this.attachId = randomUUID();
    const waiter = this._wait('attach_ok', ATTACH_TIMEOUT_MS + 2000);
    this._send({
      type: 'attach',
      attachId: this.attachId,
      sessionId: opts.sessionId,
      workDir: opts.workDir,
      wsUrl: opts.wsUrl,
      authToken: opts.apiKey,
      caPem: opts.caPem,
      permissionMode: opts.permissionMode,
    });
    await waiter;
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (!this._send({ type: 'ping' })) this._fail('ping write failed');
    }, PING_INTERVAL_MS);
    this._pingTimer.unref?.();
  }

  _fail(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
    for (const [type] of this._waiters) {
      this._settle(type, null, new Error(reason));
    }
    try { this.socket?.destroy(); } catch { /* already gone */ }
    // Synchronous: the caller deletes its map entry here. Waiting for the 60s
    // reaper instead would leave every phone message for up to a minute
    // resolving to a dead session while the respawn guard never clears.
    this.emit('detached', reason);
  }

  setPermissionMode(mode) {
    return this._send({ type: 'set_permission_mode', mode });
  }

  detach(reason = 'pc_agent_detach') {
    if (this.closed) return;
    this._send({ type: 'detach', attachId: this.attachId, reason });
    this._fail(`local detach: ${reason}`);
  }

  destroy() {
    this._fail('destroyed');
  }
}
