/**
 * E2E test for code_task: Orchestrator -> PC Agent -> coding agent loop.
 *
 * Tests each coding tool (write, read, edit, bash, glob, grep) and plan mode
 * by sending requests through the orchestrator. All file operations happen
 * inside shareitt-be-new/test/code-task-e2e/.
 *
 * Prerequisites:
 *   - Orchestrator running on port 10001
 *   - Communicator running on port 10000
 *   - PC Agent running and registered
 *
 * Run: node tests/e2e-code-task.test.js
 */

import 'dotenv/config';
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL?.replace('ws://', 'http://').replace('wss://', 'https://') || 'http://localhost:10001';
const API_KEY = process.env.API_KEY;
const PROJECT_PATH = process.env.TEST_PROJECT_PATH || path.join(os.tmpdir(), 'pc-agent-code-task-project');
const TEST_DIR = path.join(PROJECT_PATH, 'test', 'code-task-e2e');
const TIMEOUT_MS = 180_000; // 3 min per test (coding agent loop takes time)

async function request(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/v1/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        text,
        model: 'sonnet',
        deviceId: 'e2e-code-task-test',
        deviceType: 'pc'
      }),
      signal: controller.signal
    });
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Setup / teardown ----

function setup() {
  // Clean and recreate test directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  console.log(`Test directory: ${TEST_DIR}\n`);
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  console.log('Cleaned up test directory.');
}

// ---- Pre-flight ----

async function checkServices() {
  console.log('--- Pre-flight checks ---\n');

  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/v1/health`);
    const data = await res.json();
    assert(data.status === 'ok');
    console.log(`Orchestrator: OK`);
  } catch {
    console.error('Orchestrator not reachable. Start: cd AI/orchestrator && npm start');
    process.exit(1);
  }

  try {
    const res = await fetch('http://localhost:10000/api/health');
    const data = await res.json();
    assert(data.status === 'ok');
    console.log(`Communicator: OK`);
  } catch {
    console.error('Communicator not reachable. Start: cd AI/infrastructure/communicator && npm run dev');
    process.exit(1);
  }

  console.log();
}

// ---- Tests ----

async function testWrite() {
  console.log('[1/7] WRITE -- create a file via code_task...');

  const { status, body } = await request(
    `In the shareitt-be-new project, use code_task to create a file at test/code-task-e2e/hello.txt with the exact content "hello from code_task". The project is at ${PROJECT_PATH}. Just create that one file and finish.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);

  // Verify the file was actually created
  const filePath = path.join(TEST_DIR, 'hello.txt');
  assert(fs.existsSync(filePath), `File not created at ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes('hello from code_task'), `Wrong content: ${content}`);

  console.log(`OK -- file created, content verified`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testRead() {
  console.log('[2/7] READ -- read a file via code_task...');

  // Create a file for the agent to read
  const filePath = path.join(TEST_DIR, 'read-me.txt');
  fs.writeFileSync(filePath, 'line1: alpha\nline2: bravo\nline3: charlie\n');

  const { status, body } = await request(
    `In the shareitt-be-new project at ${PROJECT_PATH}, use code_task with this task: "Read the file test/code-task-e2e/read-me.txt and tell me what is on line 2". Just read it and report.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  assert(text.includes('bravo'), `Response should mention "bravo" from line 2, got: ${body.text}`);

  console.log(`OK -- agent read file and found line 2 content`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testEdit() {
  console.log('[3/7] EDIT -- edit a file via code_task...');

  // Create a file for the agent to edit
  const filePath = path.join(TEST_DIR, 'edit-me.txt');
  fs.writeFileSync(filePath, 'The quick brown fox jumps over the lazy dog.\n');

  const { status, body } = await request(
    `In the shareitt-be-new project at ${PROJECT_PATH}, use code_task with this task: "In the file test/code-task-e2e/edit-me.txt, replace the word 'lazy' with 'energetic'". Just do that one edit.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes('energetic'), `File should contain "energetic", got: ${content}`);
  assert(!content.includes('lazy'), `File should not contain "lazy" anymore, got: ${content}`);

  console.log(`OK -- file edited, "lazy" -> "energetic"`);
  console.log(`  File content: ${content.trim()}\n`);
}

async function testBash() {
  console.log('[4/7] BASH -- run a shell command via code_task...');

  const { status, body } = await request(
    `In the shareitt-be-new project at ${PROJECT_PATH}, use code_task with this task: "Run 'node --version' using bash and report the Node.js version number".`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  // Node version looks like v18.x.x or v20.x.x etc
  assert(/v\d+/.test(body.text), `Response should contain node version, got: ${body.text}`);

  console.log(`OK -- bash command executed, node version reported`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testGlob() {
  console.log('[5/7] GLOB -- find files via code_task...');

  // Create a few files for the agent to find
  fs.writeFileSync(path.join(TEST_DIR, 'a.json'), '{}');
  fs.writeFileSync(path.join(TEST_DIR, 'b.json'), '{}');
  fs.writeFileSync(path.join(TEST_DIR, 'c.txt'), 'not json');

  const { status, body } = await request(
    `In the shareitt-be-new project at ${PROJECT_PATH}, use code_task with this task: "Use glob to find all .json files inside the test/code-task-e2e/ directory and tell me how many there are".`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  assert(body.text.includes('2'), `Response should mention 2 json files, got: ${body.text}`);

  console.log(`OK -- glob found the json files`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testGrep() {
  console.log('[6/7] GREP -- search file contents via code_task...');

  // Create files with searchable content
  fs.writeFileSync(path.join(TEST_DIR, 'search1.txt'), 'This has the SECRET_MARKER inside.\n');
  fs.writeFileSync(path.join(TEST_DIR, 'search2.txt'), 'Nothing interesting here.\n');
  fs.writeFileSync(path.join(TEST_DIR, 'search3.txt'), 'Also has SECRET_MARKER here too.\n');

  const { status, body } = await request(
    `In the shareitt-be-new project at ${PROJECT_PATH}, use code_task with this task: "Use grep to search for 'SECRET_MARKER' in the test/code-task-e2e/ directory and tell me which files contain it".`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  assert(text.includes('search1') && text.includes('search3'),
    `Response should mention search1 and search3, got: ${body.text}`);

  console.log(`OK -- grep found the right files`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testPlanMode() {
  console.log('[7/7] PLAN MODE -- read-only exploration via code_task...');

  // Create a small "project" to analyze
  fs.writeFileSync(path.join(TEST_DIR, 'app.js'), 'const express = require("express");\nconst app = express();\napp.listen(3000);\n');
  fs.writeFileSync(path.join(TEST_DIR, 'package.json'), '{"name": "test-app", "dependencies": {"express": "^4.18.0"}}');

  // This test requires plan mode to be set. Since we go through orchestrator,
  // the pc-agent uses whatever CODE_TASK_PERMISSION_MODE is configured.
  // We test that the agent can at least explore and summarize without writing.
  // Even in acceptEdits mode, a "describe the structure" task should only use read tools.
  const { status, body } = await request(
    `In the shareitt-be-new project at ${PROJECT_PATH}, use code_task with this task: "Read test/code-task-e2e/app.js and test/code-task-e2e/package.json, then describe what this mini-project does. Do NOT create or modify any files."`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  assert(text.includes('express') || text.includes('server') || text.includes('app'),
    `Response should describe the express app, got: ${body.text}`);

  // Verify no extra files were created
  const files = fs.readdirSync(TEST_DIR);
  const expected = new Set(['hello.txt', 'read-me.txt', 'edit-me.txt', 'a.json', 'b.json', 'c.txt', 'search1.txt', 'search2.txt', 'search3.txt', 'app.js', 'package.json']);
  for (const f of files) {
    assert(expected.has(f), `Unexpected file created: ${f}`);
  }

  console.log(`OK -- agent explored without modifying anything`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

// ---- Runner ----

async function run() {
  console.log('Code Task E2E Tests (via Orchestrator)\n');

  await checkServices();
  setup();

  const tests = [
    testWrite,
    testRead,
    testEdit,
    testBash,
    testGlob,
    testGrep,
    testPlanMode
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      failed++;
      console.error(`FAILED: ${err.message}\n`);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${tests.length}`);

  if (process.argv.includes('--no-cleanup')) {
    console.log('Skipping cleanup (--no-cleanup).');
  } else {
    cleanup();
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
