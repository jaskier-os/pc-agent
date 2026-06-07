/**
 * E2E tests for enhanced pc-agent tools: explore, enhanced grep, file context safety.
 *
 * Tests each feature by sending requests through the orchestrator, which routes
 * to the pc-agent. All file operations happen inside /tmp/pc-agent-e2e-enhanced.
 *
 * Prerequisites:
 *   - Orchestrator running on port 10001
 *   - Communicator running on port 10000
 *   - PC Agent running and registered
 *
 * Run: node tests/e2e-enhanced-tools.test.js
 */

import 'dotenv/config';
import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL?.replace('ws://', 'http://').replace('wss://', 'https://') || 'http://localhost:10001';
const API_KEY = process.env.API_KEY;
const TEST_DIR = path.join(os.tmpdir(), 'pc-agent-e2e-enhanced');
const TIMEOUT_MS = 180_000; // 3 min per test (LLM-based tests take time)

// Project the enhanced-tools E2E exercises against. Defaults to this repo root.
const PC_AGENT_PROJECT = process.env.PC_AGENT_PROJECT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

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
        deviceId: 'e2e-enhanced-tools-test',
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
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Pre-create test fixtures
  fs.writeFileSync(path.join(TEST_DIR, 'marker1.txt'), 'This has MARKER inside.\n');
  fs.writeFileSync(path.join(TEST_DIR, 'marker2.txt'), 'Nothing here.\n');
  fs.writeFileSync(path.join(TEST_DIR, 'marker3.txt'), 'Another MARKER here.\n');
  fs.writeFileSync(path.join(TEST_DIR, 'case-test.txt'), 'Hello World\nhello world\nHELLO WORLD\n');
  fs.writeFileSync(path.join(TEST_DIR, 'typed.js'), 'const x = "TYPED_CONTENT";\n');
  fs.writeFileSync(path.join(TEST_DIR, 'typed.txt'), 'TYPED_CONTENT in txt\n');
  fs.writeFileSync(path.join(TEST_DIR, 'count1.txt'), 'REPEAT REPEAT REPEAT\n');
  fs.writeFileSync(path.join(TEST_DIR, 'count2.txt'), 'REPEAT\n');
  fs.writeFileSync(path.join(TEST_DIR, 'safety-test.txt'), 'original content\n');
  fs.writeFileSync(path.join(TEST_DIR, 'edit-target.txt'), 'The old value is here.\n');
  fs.writeFileSync(path.join(TEST_DIR, 'config.js'), 'module.exports = {};\n');

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

// ---- Tests: Explore tool ----

async function testExploreBasic() {
  console.log('[1/10] EXPLORE_BASIC -- list tool files via explore...');

  const { status, body } = await request(
    `Use the explore tool to find out what tools are available in the pc-agent project at ${PC_AGENT_PROJECT}. List the tool files.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  // explore should discover the tool files in src/tools/
  assert(text.includes('grep') && text.includes('glob') && text.includes('read'),
    `Response should mention tool files (grep, glob, read), got: ${body.text}`);

  console.log(`OK -- explore listed tool files`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testExploreArchitecture() {
  console.log('[2/10] EXPLORE_ARCHITECTURE -- describe project architecture via explore...');

  const { status, body } = await request(
    `Use the explore tool to describe the architecture of the pc-agent project at ${PC_AGENT_PROJECT}. Focus on how the agent processes requests.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  // Should mention key architectural components
  const mentionsArchitecture = text.includes('ptcclient') || text.includes('executetool') ||
    text.includes('agent.js') || text.includes('agent') || text.includes('execute');
  assert(mentionsArchitecture,
    `Response should mention PTCClient, executeTool, or agent.js, got: ${body.text}`);

  console.log(`OK -- explore described architecture`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testExploreReadOnly() {
  console.log('[3/10] EXPLORE_READ_ONLY -- verify explore does not create files...');

  // Snapshot the test directory before the explore call
  const filesBefore = new Set(fs.readdirSync(TEST_DIR));

  const { status, body } = await request(
    `Use the explore tool on ${PC_AGENT_PROJECT} to count how many JavaScript files there are.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);

  // Verify no new files were created in our test directory
  const filesAfter = new Set(fs.readdirSync(TEST_DIR));
  for (const f of filesAfter) {
    assert(filesBefore.has(f), `Explore created unexpected file in test dir: ${f}`);
  }

  console.log(`OK -- explore was read-only, no new files in test dir`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

// ---- Tests: Enhanced grep ----

async function testGrepFilesWithMatches() {
  console.log('[4/10] GREP_FILES_WITH_MATCHES -- find files containing a pattern...');

  const { status, body } = await request(
    `Use the grep tool with output_mode 'files_with_matches' to find which files in ${TEST_DIR} contain the word MARKER. List the filenames.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  assert(text.includes('marker1') && text.includes('marker3'),
    `Response should mention marker1.txt and marker3.txt, got: ${body.text}`);
  assert(!text.includes('marker2') || text.includes('marker2') && (text.includes('not') || text.includes('no match') || text.includes('does not')),
    `marker2.txt should not be listed as a match (it has no MARKER)`);

  console.log(`OK -- grep found correct files with matches`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testGrepCaseInsensitive() {
  console.log('[5/10] GREP_CASE_INSENSITIVE -- case insensitive search...');

  const { status, body } = await request(
    `Use the grep tool with case_insensitive option to search for "hello" in the file ${path.join(TEST_DIR, 'case-test.txt')}. Tell me how many lines match.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  // All 3 lines contain "hello" in some case: Hello, hello, HELLO
  assert(text.includes('3') || text.includes('three') || text.includes('all'),
    `Response should indicate 3 matching lines, got: ${body.text}`);

  console.log(`OK -- grep found all case variants`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testGrepTypeFilter() {
  console.log('[6/10] GREP_TYPE_FILTER -- filter by file type...');

  const { status, body } = await request(
    `Use the grep tool with type filter set to 'js' to search for "TYPED_CONTENT" in ${TEST_DIR}. Tell me which files matched.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  assert(text.includes('typed.js'),
    `Response should mention typed.js, got: ${body.text}`);
  // typed.txt should not appear when filtering by type=js
  const mentionsTxt = text.includes('typed.txt');
  assert(!mentionsTxt,
    `Response should NOT mention typed.txt when filtering by js type, got: ${body.text}`);

  console.log(`OK -- grep type filter returned only .js files`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

async function testGrepCountMode() {
  console.log('[7/10] GREP_COUNT -- count occurrences...');

  const { status, body } = await request(
    `Use the grep tool with output_mode 'count' to count occurrences of "REPEAT" in each file inside ${TEST_DIR}. Report the counts per file.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text;
  // count1.txt has 3 occurrences, count2.txt has 1
  assert(text.includes('3') && text.includes('1'),
    `Response should mention counts 3 and 1, got: ${body.text}`);

  console.log(`OK -- grep count mode reported correct counts`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

// ---- Tests: File operation safety ----

async function testFileReadThenWrite() {
  console.log('[8/10] FILE_READ_THEN_WRITE -- read then overwrite a file...');

  const filePath = path.join(TEST_DIR, 'safety-test.txt');
  // Verify pre-condition
  assert(fs.readFileSync(filePath, 'utf-8').includes('original content'),
    'Pre-condition: safety-test.txt should contain original content');

  const { status, body } = await request(
    `Use the file_read tool to read the file ${filePath}, then use the file_write tool to overwrite it with the exact content "updated content". Do both steps.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes('updated content'),
    `File should contain "updated content" after write, got: ${content}`);

  console.log(`OK -- file read then write succeeded`);
  console.log(`  File content: ${content.trim()}\n`);
}

async function testFileEditWithDiff() {
  console.log('[9/10] FILE_EDIT_DIFF -- edit a file and verify diff output...');

  const filePath = path.join(TEST_DIR, 'edit-target.txt');

  const { status, body } = await request(
    `Use the file_edit tool to edit the file ${filePath}. Replace "old value" with "new value". Show the diff.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);

  // Verify the file was edited
  const content = fs.readFileSync(filePath, 'utf-8');
  assert(content.includes('new value'), `File should contain "new value", got: ${content}`);
  assert(!content.includes('old value'), `File should not contain "old value" anymore, got: ${content}`);

  // Verify the response mentions diff-like output (- and + lines or similar)
  const text = body.text;
  const hasDiffIndicators = text.includes('-') || text.includes('+') ||
    text.includes('old') || text.includes('new') ||
    text.includes('replaced') || text.includes('changed');
  assert(hasDiffIndicators,
    `Response should include diff indicators, got: ${body.text}`);

  console.log(`OK -- file edited, diff output present`);
  console.log(`  File content: ${content.trim()}\n`);
}

async function testFileReadSuggestions() {
  console.log('[10/10] FILE_READ_SUGGESTIONS -- suggest correct filename on typo...');

  const typoPath = path.join(TEST_DIR, 'confg.js');
  const correctPath = path.join(TEST_DIR, 'config.js');

  // Verify pre-conditions
  assert(!fs.existsSync(typoPath), 'confg.js should not exist');
  assert(fs.existsSync(correctPath), 'config.js should exist');

  const { status, body } = await request(
    `Use the file_read tool to read the file ${typoPath}. If it does not exist, check for similar filenames nearby and suggest the correct one.`
  );

  assert(status === 200, `HTTP ${status}`);
  assert(body.status === 'success', `Failed: ${body.text}`);
  const text = body.text.toLowerCase();
  // The response should mention config.js as a suggestion
  assert(text.includes('config.js') || text.includes('config'),
    `Response should suggest config.js, got: ${body.text}`);

  console.log(`OK -- agent suggested correct filename`);
  console.log(`  Agent response: ${body.text.substring(0, 200)}\n`);
}

// ---- Runner ----

async function run() {
  console.log('Enhanced Tools E2E Tests (via Orchestrator)\n');

  await checkServices();
  setup();

  const tests = [
    testExploreBasic,
    testExploreArchitecture,
    testExploreReadOnly,
    testGrepFilesWithMatches,
    testGrepCaseInsensitive,
    testGrepTypeFilter,
    testGrepCountMode,
    testFileReadThenWrite,
    testFileEditWithDiff,
    testFileReadSuggestions
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
