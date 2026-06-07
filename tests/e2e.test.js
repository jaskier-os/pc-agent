/**
 * E2E test for PC Agent Telegram tools + agentic loop.
 *
 * Prerequisites:
 *   - Valid TELEGRAM_SESSION in .env (already authenticated)
 *   - Communicator running on COMMUNICATOR_URL (for agentic loop tests)
 *
 * Run: node tests/e2e.test.js
 */

import 'dotenv/config';
import assert from 'assert';
import { config } from '../src/config.js';
import * as telegram from '../src/telegram.js';
import { CommandExecutor } from '../src/executor.js';
import { PCAgent } from '../src/agent.js';

const TEST_MARKER = `[e2e-test-${Date.now()}]`;

let agent;

async function setup() {
  console.log('--- Setup ---');
  console.log('Initializing Telegram client...');
  await telegram.initialize({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    session: config.telegramSession
  });
  console.log('Telegram client connected\n');

  const executor = new CommandExecutor({
    allowedCommands: config.allowedCommands,
    blockedPatterns: config.blockedPatterns,
    maxOutputLength: config.maxOutputLength,
    commandTimeoutMs: config.commandTimeoutMs
  });

  // PCAgent needs orchestratorUrl for BaseAgent, but we won't call start() --
  // we only use handle() and executeTool() directly.
  agent = new PCAgent({
    orchestratorUrl: config.orchestratorUrl,
    communicatorUrl: config.communicatorUrl,
    apiKey: config.apiKey,
    model: config.model,
    healthPort: 0,
    executor,
    telegram
  });
}

// ---- Telegram module direct tests ----

async function testListChats() {
  console.log('[1/6] telegram.listChats()...');
  const chats = await telegram.listChats(5);
  assert(Array.isArray(chats), 'listChats should return an array');
  assert(chats.length > 0, 'Should have at least 1 chat');
  for (const chat of chats) {
    assert(typeof chat.title === 'string', 'Chat should have a title string');
    assert(typeof chat.unreadCount === 'number', 'Chat should have unreadCount');
  }
  console.log(`OK -- ${chats.length} chats returned`);
  console.log(`  First chat: "${chats[0].title}" (unread: ${chats[0].unreadCount})\n`);
}

async function testSendMessage() {
  console.log('[2/6] telegram.sendMessage() -> Saved Messages...');
  const text = `${TEST_MARKER} test message`;
  const result = await telegram.sendMessage('me', text);
  assert(result.id, 'sendMessage should return message id');
  assert(result.date, 'sendMessage should return date');
  console.log(`OK -- sent message id=${result.id}, date=${result.date}\n`);
}

async function testReadMessages() {
  console.log('[3/6] telegram.readMessages() -> Saved Messages...');
  const messages = await telegram.readMessages('me', 5);
  assert(Array.isArray(messages), 'readMessages should return an array');
  assert(messages.length > 0, 'Should have at least 1 message');

  // Verify our test message is there
  const found = messages.find(m => m.text.includes(TEST_MARKER));
  assert(found, `Should find the test message with marker ${TEST_MARKER}`);
  console.log(`OK -- ${messages.length} messages, found test message: "${found.text}"\n`);
}

// ---- Agent tool dispatch tests (no LLM, calls executeTool directly) ----

async function testAgentExecCommand() {
  console.log('[4/6] agent.executeTool("exec_command")...');
  const result = await agent.executeTool('exec_command', { command: 'echo hello-pc-agent' });
  assert(result.includes('Exit code: 0'), 'Should succeed with exit code 0');
  assert(result.includes('hello-pc-agent'), 'Should contain echo output');
  console.log(`OK -- ${result.trim()}\n`);
}

async function testAgentTelegramTools() {
  console.log('[5/6] agent.executeTool("telegram_*")...');

  // list chats
  const listResult = await agent.executeTool('telegram_list_chats', { limit: 3 });
  const chats = JSON.parse(listResult);
  assert(Array.isArray(chats), 'telegram_list_chats should return JSON array');
  assert(chats.length > 0, 'Should have chats');
  console.log(`  telegram_list_chats OK -- ${chats.length} chats`);

  // send message
  const sendResult = await agent.executeTool('telegram_send_message', {
    chat: 'me',
    text: `${TEST_MARKER} via executeTool`
  });
  assert(sendResult.startsWith('Message sent'), 'Should confirm message sent');
  console.log(`  telegram_send_message OK -- ${sendResult}`);

  // read messages
  const readResult = await agent.executeTool('telegram_read_messages', {
    chat: 'me',
    limit: 5
  });
  const msgs = JSON.parse(readResult);
  assert(Array.isArray(msgs), 'telegram_read_messages should return JSON array');
  const found = msgs.find(m => m.text.includes(`${TEST_MARKER} via executeTool`));
  assert(found, 'Should find the executeTool test message');
  console.log(`  telegram_read_messages OK -- found test message\n`);
}

// ---- Full agentic loop test (requires Communicator) ----

async function testAgenticLoop() {
  console.log('[6/6] Full agentic loop: agent.handle() -> send message to Saved Messages...');

  let communicatorAvailable = true;
  try {
    const res = await fetch(`${config.communicatorUrl}/api/health`);
    if (!res.ok) communicatorAvailable = false;
  } catch {
    communicatorAvailable = false;
  }

  if (!communicatorAvailable) {
    console.log('SKIPPED -- Communicator not running at', config.communicatorUrl);
    console.log('  Start it to test the full agentic loop.\n');
    return;
  }

  const response = await agent.handle({
    requestId: 'e2e-test-001',
    text: `Send "${TEST_MARKER} agentic" to my saved messages in Telegram`
  });

  assert(response.requestId === 'e2e-test-001', 'Should return correct requestId');
  assert(response.status === 'success', `Should succeed, got: ${response.status}`);
  console.log(`OK -- agent response: ${response.text}`);

  // Verify the message was actually sent
  const messages = await telegram.readMessages('me', 5);
  const found = messages.find(m => m.text.includes(`${TEST_MARKER} agentic`));
  assert(found, 'Should find the agentic-loop test message in Saved Messages');
  console.log(`  Verified: message found in Saved Messages\n`);
}

// ---- Runner ----

async function run() {
  console.log('PC Agent E2E Tests\n');

  try {
    await setup();
    await testListChats();
    await testSendMessage();
    await testReadMessages();
    await testAgentExecCommand();
    await testAgentTelegramTools();
    await testAgenticLoop();
    console.log('All tests passed!');
  } catch (err) {
    console.error(`\nTEST FAILED: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  } finally {
    // GramJS keeps the connection alive; force exit after tests
    process.exit(0);
  }
}

run();
