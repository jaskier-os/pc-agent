/**
 * End-to-end test for Remote Control conversation pipeline.
 *
 * Tests the FULL RC pipeline with real AI tool execution:
 *
 *   1. Connect to /ws/remote-control as "desktop" (simulates claude CLI)
 *   2. Connect to /ws/device as "phone" (simulates Android app)
 *   3. Phone sends rc_user_message -> orchestrator -> desktop (NDJSON)
 *   4. Desktop calls Anthropic API for real AI reasoning with tools
 *   5. Desktop executes tools locally (Bash, Read, Write, Edit, Glob)
 *   6. Desktop sends NDJSON responses back through orchestrator
 *   7. Verify via REST transcript that orchestrator processed all events
 *   8. Verify local filesystem for actual changes made by tools
 *
 * The phone-to-desktop relay is verified (phone sends, desktop receives).
 * The desktop-to-phone relay is verified via transcript (orchestrator persists
 * all messages it processes). The real phone app may steal WS messages from
 * a test phone, so we verify delivery via the transcript API instead.
 *
 * Usage:
 *   node tests/test-rc-conversations.js [--timeout 120]
 *
 * All file operations target /tmp/rc-e2e-test/ (harmless).
 */

import WebSocket from 'ws';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ORCH_HOST = process.env.ORCH_HOST || 'localhost';
const ORCH_PORT = process.env.ORCH_PORT || '8443';
const ORCH_HTTPS = `https://${ORCH_HOST}:${ORCH_PORT}`;
const ORCH_WSS = `wss://${ORCH_HOST}:${ORCH_PORT}`;
const API_KEY = process.env.API_KEY || '';
const WORK_DIR = '/tmp/rc-e2e-test';
const DEVICE_ID = 'e2e-test-phone-' + Date.now();

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const CREDENTIALS_PATH = path.join(process.env.HOME || '', '.claude', '.credentials.json');

const args = process.argv.slice(2);
const timeoutIdx = args.indexOf('--timeout');
const PER_TEST_TIMEOUT_S = timeoutIdx !== -1 ? parseInt(args[timeoutIdx + 1], 10) : 120;
const TOTAL_TIMEOUT_S = PER_TEST_TIMEOUT_S * 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString().substring(11, 23);
  console.log(`[${ts}] ${msg}`);
}

function logSection(title) {
  console.log('');
  console.log('='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function loadOAuthToken() {
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const creds = JSON.parse(raw);
  const token = creds?.claudeAiOauth?.accessToken;
  if (!token) throw new Error('No OAuth access token in credentials');
  return token;
}

function httpRequest(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      rejectUnauthorized: false,
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Local tool execution
// ---------------------------------------------------------------------------

function executeTool(name, input) {
  try {
    switch (name) {
      case 'Bash': {
        log(`  [tool] Bash: ${input.command}`);
        try {
          const stdout = execSync(input.command, {
            cwd: WORK_DIR, timeout: 30000, encoding: 'utf-8', maxBuffer: 50 * 1024,
          });
          return stdout || '(no output)';
        } catch (err) {
          return `Exit ${err.status || 1}: ${err.stderr || err.message}`;
        }
      }
      case 'Read': {
        log(`  [tool] Read: ${input.file_path}`);
        if (!fs.existsSync(input.file_path)) return `Error: file not found: ${input.file_path}`;
        const content = fs.readFileSync(input.file_path, 'utf-8');
        return content.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
      }
      case 'Write': {
        log(`  [tool] Write: ${input.file_path}`);
        const dir = path.dirname(input.file_path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(input.file_path, input.content, 'utf-8');
        return `File written: ${input.file_path}`;
      }
      case 'Edit': {
        log(`  [tool] Edit: ${input.file_path}`);
        if (!fs.existsSync(input.file_path)) return `Error: file not found: ${input.file_path}`;
        let content = fs.readFileSync(input.file_path, 'utf-8');
        if (!content.includes(input.old_string)) return 'Error: old_string not found in file';
        content = content.replace(input.old_string, input.new_string);
        fs.writeFileSync(input.file_path, content, 'utf-8');
        return `File edited: ${input.file_path}`;
      }
      case 'Glob': {
        log(`  [tool] Glob: ${input.pattern} in ${input.path || WORK_DIR}`);
        try {
          const result = execSync(
            `find "${input.path || WORK_DIR}" -name "${input.pattern}" -type f 2>/dev/null || true`,
            { encoding: 'utf-8', timeout: 10000 }
          );
          return result.trim() || 'No matches found';
        } catch (err) {
          return `Error: ${err.message}`;
        }
      }
      case 'Grep': {
        log(`  [tool] Grep: ${input.pattern} in ${input.path || WORK_DIR}`);
        try {
          const result = execSync(
            `grep -rn "${input.pattern}" "${input.path || WORK_DIR}" 2>/dev/null || true`,
            { encoding: 'utf-8', timeout: 10000 }
          );
          return result.trim() || 'No matches found';
        } catch (err) {
          return `Error: ${err.message}`;
        }
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Anthropic API
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    name: 'Bash',
    description: 'Execute a shell command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Shell command to execute' } },
      required: ['command'],
    },
  },
  {
    name: 'Read',
    description: 'Read a file from the filesystem.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Absolute path to file' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file (creates parent dirs).',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace a string in a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to file' },
        old_string: { type: 'string', description: 'Exact text to find' },
        new_string: { type: 'string', description: 'Replacement text' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files by name pattern in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Filename pattern (e.g. *.txt)' },
        path: { type: 'string', description: 'Directory to search' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with regex.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        path: { type: 'string', description: 'Directory to search' },
      },
      required: ['pattern'],
    },
  },
];

/**
 * AI conversation loop: call Anthropic, execute tools, repeat.
 * Sends all NDJSON events to the desktop WS as they happen.
 * Returns { text, toolsUsed }.
 */
async function runAIWithNDJSON(userText, oauthToken, conversationHistory, desktopSend) {
  conversationHistory.push({ role: 'user', content: userText });

  const toolsUsed = [];
  const maxTurns = 10;

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await httpRequest('POST', ANTHROPIC_API_URL, {
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: `You are an AI assistant with file operation tools. Work directory: ${WORK_DIR}. Be concise. Never use emojis.`,
      messages: conversationHistory,
      tools: TOOL_DEFS,
    }, {
      'Authorization': `Bearer ${oauthToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    });

    if (resp.status !== 200) {
      throw new Error(`Anthropic API ${resp.status}: ${JSON.stringify(resp.body)}`);
    }

    const msg = resp.body;
    const contentBlocks = msg.content || [];
    conversationHistory.push({ role: 'assistant', content: contentBlocks });

    let assistantText = '';
    const toolUseBlocks = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        assistantText += block.text;
        desktopSend({ type: 'assistant', content: [{ type: 'text', text: block.text }] });
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
        toolsUsed.push(block.name);
        desktopSend({ type: 'tool_use', name: block.name, input: block.input });
      }
    }

    if (toolUseBlocks.length === 0 || msg.stop_reason === 'end_turn') {
      desktopSend({ type: 'result', result: assistantText || 'Done.' });
      return { text: assistantText, toolsUsed };
    }

    // Execute tools
    const toolResults = [];
    for (const tb of toolUseBlocks) {
      const result = executeTool(tb.name, tb.input);
      const truncated = result.length > 5000 ? result.substring(0, 5000) + '...(truncated)' : result;
      desktopSend({ type: 'tool_result', tool_name: tb.name, name: tb.name, content: truncated.substring(0, 500) });
      toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: truncated });
    }
    conversationHistory.push({ role: 'user', content: toolResults });
  }

  desktopSend({ type: 'result', result: 'Max turns reached.' });
  return { text: 'Max turns reached', toolsUsed };
}

// ---------------------------------------------------------------------------
// WebSocket clients
// ---------------------------------------------------------------------------

class DesktopClient {
  constructor() { this.ws = null; this._connected = false; this._onUser = null; this.ndjsonLog = []; }

  connect(sessionId) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${ORCH_WSS}/ws/remote-control?session=${sessionId}`, {
        headers: { 'x-api-key': API_KEY }, rejectUnauthorized: false,
      });
      this.ws.on('open', () => { this._connected = true; log('Desktop WS connected'); resolve(); });
      this.ws.on('message', (raw) => {
        for (const line of raw.toString().split('\n')) {
          const t = line.trim(); if (!t) continue;
          try {
            const msg = JSON.parse(t);
            if (msg.type === 'keep_alive') { this.send({ type: 'keep_alive' }); return; }
            if (msg.type === 'user' && this._onUser) {
              const text = msg.message?.content?.[0]?.text || '';
              log(`Desktop <- user: "${text.substring(0, 60)}"`);
              this._onUser(text); this._onUser = null;
            }
          } catch {}
        }
      });
      this.ws.on('error', (e) => { log(`Desktop err: ${e.message}`); if (!this._connected) reject(e); });
      this.ws.on('close', (c) => { log(`Desktop closed: ${c}`); this._connected = false; });
    });
  }

  send(obj) {
    if (this.ws?.readyState === 1) {
      const payload = JSON.stringify(obj) + '\n';
      this.ndjsonLog.push(obj.type);
      this.ws.send(payload);
    }
  }

  waitForUser(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._onUser = null; reject(new Error('No user msg')); }, timeoutMs);
      this._onUser = (text) => { clearTimeout(t); resolve(text); };
    });
  }

  close() { if (this.ws) { try { this.ws.close(1000); } catch {} this.ws = null; } }
}

class PhoneClient {
  constructor() { this.ws = null; this._connected = false; }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${ORCH_WSS}/ws/device`, {
        headers: { 'x-api-key': API_KEY }, rejectUnauthorized: false,
      });
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'identify', deviceId: DEVICE_ID, deviceType: 'phone', appVersion: 'e2e-test' }));
        this._connected = true; log('Phone WS connected'); resolve();
      });
      this.ws.on('message', () => {}); // We verify via transcript, not phone WS
      this.ws.on('error', (e) => { if (!this._connected) reject(e); });
      this.ws.on('close', () => { this._connected = false; });
    });
  }

  sendRcMessage(sessionId, text) {
    log(`Phone -> rc_user_message: "${text.substring(0, 60)}"`);
    this.ws.send(JSON.stringify({ type: 'rc_user_message', sessionId, text }));
  }

  close() { if (this.ws) { try { this.ws.close(1000); } catch {} this.ws = null; } }
}

// ---------------------------------------------------------------------------
// Transcript verification
// ---------------------------------------------------------------------------

async function getTranscript(sessionId) {
  const resp = await httpRequest(
    'GET', `${ORCH_HTTPS}/api/v1/remote-control/sessions/${sessionId}/transcript`,
    null, { 'x-api-key': API_KEY }
  );
  if (resp.status !== 200) throw new Error(`Transcript fetch failed: ${resp.status}`);
  return resp.body.transcript || [];
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const testResults = [];

async function runTest(name, fn) {
  logSection(`TEST: ${name}`);
  const start = Date.now();
  try {
    await fn();
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`PASS (${elapsed}s)`);
    testResults.push({ name, status: 'PASS', elapsed });
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`FAIL (${elapsed}s): ${err.message}`);
    testResults.push({ name, status: 'FAIL', elapsed, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('RC E2E Conversation Tests -- full pipeline with real AI');
  log(`Orchestrator: ${ORCH_HTTPS}`);
  log(`Anthropic model: ${ANTHROPIC_MODEL}`);
  log(`Work dir: ${WORK_DIR}`);
  log(`Per-test timeout: ${PER_TEST_TIMEOUT_S}s`);

  const globalTimer = setTimeout(() => {
    console.error(`\nGLOBAL TIMEOUT (${TOTAL_TIMEOUT_S}s)`);
    printSummary();
    process.exit(2);
  }, TOTAL_TIMEOUT_S * 1000);

  let oauthToken;
  try {
    oauthToken = loadOAuthToken();
    log(`OAuth token loaded (${oauthToken.substring(0, 15)}...)`);
  } catch (err) {
    console.error(`Cannot load OAuth token: ${err.message}`);
    process.exit(1);
  }

  if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

  let phone = null;
  let desktop = null;
  let sessionId = null;
  const conversationHistory = [];

  try {
    // ----- Health check -----
    logSection('SETUP: Health check');
    const health = await httpRequest('GET', `${ORCH_HTTPS}/api/v1/health`, null, { 'x-api-key': API_KEY });
    log(`Health: ${health.status}`);
    assert(health.status === 200, `Health check failed: ${health.status}`);

    // ----- Create session -----
    logSection('SETUP: Create RC session');
    const cr = await httpRequest('POST', `${ORCH_HTTPS}/api/v1/remote-control/sessions`, { workDir: WORK_DIR }, { 'x-api-key': API_KEY });
    log(`Create: ${cr.status} ${JSON.stringify(cr.body)}`);
    assert(cr.status === 200, `Create failed: ${cr.status}`);
    sessionId = cr.body.sessionId;
    log(`Session: ${sessionId}`);

    // ----- Connect desktop -----
    logSection('SETUP: Connect desktop');
    desktop = new DesktopClient();
    await desktop.connect(sessionId);

    // ----- Connect phone -----
    logSection('SETUP: Connect phone');
    phone = new PhoneClient();
    await phone.connect();

    await new Promise(r => setTimeout(r, 2000));
    log('Setup complete. Starting tests.');

    // ============================================================
    // Helper: send from phone -> desktop processes -> verify
    // ============================================================
    async function sendAndProcess(prompt) {
      // Phone sends
      phone.sendRcMessage(sessionId, prompt);

      // Desktop receives
      const userText = await desktop.waitForUser(15000);
      assert(userText.length > 0, 'Empty user message');

      // AI + tools
      const result = await runAIWithNDJSON(userText, oauthToken, conversationHistory, (obj) => desktop.send(obj));
      log(`AI tools: [${result.toolsUsed.join(', ')}] text: ${result.text.substring(0, 120)}`);

      // Give orchestrator time to persist transcript
      await new Promise(r => setTimeout(r, 1000));

      // Verify transcript
      const transcript = await getTranscript(sessionId);
      log(`Transcript entries: ${transcript.length}`);

      return { ...result, transcript };
    }

    // ============================================================
    // Test 1: Create directory and list files
    // ============================================================
    await runTest('Create /tmp/rc-e2e-test/ and list files (Bash tool)', async () => {
      const { toolsUsed, transcript } = await sendAndProcess(
        'What files are in /tmp/rc-e2e-test/? Create the directory if needed using mkdir -p.'
      );
      assert(toolsUsed.length > 0, 'AI should have used tools');
      log(`Transcript types: [${transcript.map(e => e.type).join(', ')}]`);
      // Transcript should have at least: user_message, rc_message/rc_tool_status entries
      assert(transcript.length >= 2, `Expected >= 2 transcript entries, got ${transcript.length}`);
    });

    // ============================================================
    // Test 2: Create file (Write tool)
    // ============================================================
    await runTest('Create hello.txt via Write tool', async () => {
      const { toolsUsed } = await sendAndProcess(
        'Create a file at /tmp/rc-e2e-test/hello.txt with the exact content: Hello from RC e2e test'
      );
      const hasWriteOrBash = toolsUsed.some(t => t === 'Write' || t === 'Bash');
      assert(hasWriteOrBash, `Expected Write or Bash, got: [${toolsUsed}]`);

      // Verify on disk
      assert(fs.existsSync('/tmp/rc-e2e-test/hello.txt'), 'File not created on disk');
      const content = fs.readFileSync('/tmp/rc-e2e-test/hello.txt', 'utf-8');
      log(`Disk: "${content}"`);
      assert(content.includes('Hello'), `Should contain "Hello", got: "${content}"`);
    });

    // ============================================================
    // Test 3: Read file (Read tool)
    // ============================================================
    await runTest('Read hello.txt via Read tool', async () => {
      const { text, toolsUsed } = await sendAndProcess(
        'Read /tmp/rc-e2e-test/hello.txt and tell me what it contains.'
      );
      assert(toolsUsed.length > 0, 'Should have used tools');
      assert(
        text.toLowerCase().includes('hello') || text.toLowerCase().includes('e2e'),
        `Response should mention content. Got: "${text.substring(0, 200)}"`
      );
    });

    // ============================================================
    // Test 4: Edit file (Edit tool)
    // ============================================================
    await runTest('Edit hello.txt -- change Hello to Updated', async () => {
      const { toolsUsed } = await sendAndProcess(
        'Edit /tmp/rc-e2e-test/hello.txt: replace "Hello" with "Updated". Use the Edit tool.'
      );
      assert(toolsUsed.length > 0, 'Should have used tools');

      const content = fs.readFileSync('/tmp/rc-e2e-test/hello.txt', 'utf-8');
      log(`Disk after edit: "${content}"`);
      assert(content.includes('Updated'), `Should contain "Updated", got: "${content}"`);
      assert(!content.includes('Hello'), `Should NOT contain "Hello", got: "${content}"`);
    });

    // ============================================================
    // Test 5: Verify edit (Read)
    // ============================================================
    await runTest('Verify edit -- read confirms Updated', async () => {
      const { text } = await sendAndProcess(
        'Read /tmp/rc-e2e-test/hello.txt and tell me what it says now.'
      );
      assert(
        text.toLowerCase().includes('updated'),
        `Should mention "Updated". Got: "${text.substring(0, 200)}"`
      );
    });

    // ============================================================
    // Test 6: Explore directory (Bash ls)
    // ============================================================
    await runTest('Explore /tmp/rc-e2e-test/ structure', async () => {
      const { toolsUsed, text } = await sendAndProcess(
        'List all files in /tmp/rc-e2e-test/ using ls -la.'
      );
      assert(toolsUsed.length > 0, 'Should have used tools');
      assert(
        text.toLowerCase().includes('hello') || text.toLowerCase().includes('.txt'),
        `Should mention hello.txt. Got: "${text.substring(0, 200)}"`
      );
    });

    // ============================================================
    // Final: Verify full transcript
    // ============================================================
    await runTest('Verify full session transcript', async () => {
      const transcript = await getTranscript(sessionId);
      log(`Final transcript: ${transcript.length} entries`);

      const types = transcript.map(e => e.type);
      log(`Types: [${types.join(', ')}]`);

      // Should have user_message entries (from phone)
      const userMsgs = transcript.filter(e => e.type === 'user_message');
      log(`User messages in transcript: ${userMsgs.length}`);
      assert(userMsgs.length >= 6, `Expected >= 6 user_message entries, got ${userMsgs.length}`);

      // Should have rc_message entries (responses sent to phone)
      const rcMsgs = transcript.filter(e => e.type === 'rc_message');
      log(`RC messages in transcript: ${rcMsgs.length}`);
      assert(rcMsgs.length >= 1, `Expected rc_message entries, got ${rcMsgs.length}`);

      // Should have rc_tool_status entries
      const toolStatuses = transcript.filter(e => e.type === 'rc_tool_status');
      log(`Tool status entries: ${toolStatuses.length}`);
      assert(toolStatuses.length >= 1, `Expected rc_tool_status entries, got ${toolStatuses.length}`);

      // Desktop NDJSON log
      log(`Desktop NDJSON events sent: [${desktop.ndjsonLog.join(', ')}]`);
      assert(desktop.ndjsonLog.length >= 10, `Expected >= 10 NDJSON events, got ${desktop.ndjsonLog.length}`);
    });

  } catch (err) {
    log(`SETUP ERROR: ${err.message}`);
    if (err.stack) log(err.stack);
    testResults.push({ name: 'Infrastructure', status: 'FAIL', error: err.message });
  } finally {
    logSection('CLEANUP');
    if (desktop) { desktop.close(); log('Desktop disconnected'); }
    if (phone) { phone.close(); log('Phone disconnected'); }
    if (sessionId) {
      try {
        await httpRequest('DELETE', `${ORCH_HTTPS}/api/v1/remote-control/sessions/${sessionId}`, null, { 'x-api-key': API_KEY });
        log('Session ended');
      } catch {}
    }
    try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); log(`Cleaned ${WORK_DIR}`); } catch {}
    clearTimeout(globalTimer);
    printSummary();
    process.exit(testResults.filter(t => t.status === 'FAIL').length > 0 ? 1 : 0);
  }
}

function printSummary() {
  logSection('TEST RESULTS SUMMARY');
  const passed = testResults.filter(t => t.status === 'PASS').length;
  const failed = testResults.filter(t => t.status === 'FAIL').length;
  for (const t of testResults) {
    const err = t.error ? ` -- ${t.error.substring(0, 120)}` : '';
    console.log(`  [${t.status}] ${t.name} (${t.elapsed || '?'}s)${err}`);
  }
  console.log(`\n  Total: ${testResults.length}  Passed: ${passed}  Failed: ${failed}\n`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(2); });
