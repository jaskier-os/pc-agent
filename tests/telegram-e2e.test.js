/**
 * Focused Telegram E2E test -- validates all operations glasses need.
 * ONLY sends messages to Saved Messages (chat='me').
 *
 * Run: node tests/telegram-e2e.test.js
 */

import 'dotenv/config';
import assert from 'assert';
import { config } from '../src/config.js';
import * as telegram from '../src/telegram.js';

const TEST_MARKER = `[tg-e2e-${Date.now()}]`;

async function setup() {
  console.log('--- Telegram E2E Test ---\n');
  console.log('Connecting to Telegram...');
  await telegram.initialize({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    session: config.telegramSession
  });
  assert(telegram.isReady(), `Telegram not ready: ${telegram.getStatus()}`);
  console.log('Connected\n');
}

async function testListChats() {
  console.log('[1/6] listChats...');
  const chats = await telegram.listChats(5);
  assert(Array.isArray(chats), 'Should return array');
  assert(chats.length > 0, 'Should have chats');
  console.log(`  OK -- ${chats.length} chats: ${chats.map(c => c.title || c.name).join(', ')}\n`);
}

async function testListChatsDetailed() {
  console.log('[2/6] listChatsDetailed (glasses format)...');
  const chats = await telegram.listChatsDetailed(20);
  assert(Array.isArray(chats), 'Should return array');
  assert(chats.length > 0, 'Should have chats');

  // Validate structure matches what glasses expect
  const first = chats[0];
  assert(first.id, `First chat missing id: ${JSON.stringify(first)}`);
  assert(first.title, `First chat missing title: ${JSON.stringify(first)}`);
  assert('unreadCount' in first, 'Missing unreadCount');
  assert('lastMessage' in first, 'Missing lastMessage');
  assert('chatType' in first, 'Missing chatType');

  // Find Saved Messages (should be titled after user's name)
  const saved = chats.find(c => c.chatType === 'user' && c.id);
  console.log(`  OK -- ${chats.length} chats, first: "${first.title}" (id=${first.id}, type=${first.chatType})`);
  console.log(`  Fields: id, title, unreadCount, lastMessage, lastMessageDate, lastMessageSender, chatType\n`);
  return chats;
}

async function testReadMessages() {
  console.log('[3/6] readMessages(me, 10)...');
  const msgs = await telegram.readMessages('me', 10);
  assert(Array.isArray(msgs), 'Should return array');
  assert(msgs.length > 0, 'Saved Messages should have messages');

  const first = msgs[0];
  assert('id' in first, 'Missing id');
  assert('sender' in first, 'Missing sender');
  assert('text' in first, 'Missing text');
  assert('date' in first, 'Missing date');

  console.log(`  OK -- ${msgs.length} messages from Saved Messages`);
  console.log(`  Latest: "${msgs[0].text.substring(0, 80)}" (${msgs[0].date})\n`);
  return msgs;
}

async function testSendMessage() {
  console.log('[4/6] sendMessage(me, test)...');
  const text = `${TEST_MARKER} automated test`;
  const result = await telegram.sendMessage('me', text);
  assert(result.id, `Send should return message id, got: ${JSON.stringify(result)}`);
  assert(result.date, 'Send should return date');
  console.log(`  OK -- sent msgId=${result.id} date=${result.date}\n`);
  return result;
}

async function testReadSentMessage() {
  console.log('[5/6] readMessages(me) -- verify sent message...');
  const msgs = await telegram.readMessages('me', 5);
  const found = msgs.find(m => m.text.includes(TEST_MARKER));
  assert(found, `Test message not found in recent messages. Got: ${msgs.map(m => m.text.substring(0, 40)).join(' | ')}`);
  console.log(`  OK -- found test message: "${found.text}"\n`);
}

async function testSubscribeUnsubscribe() {
  console.log('[6/6] subscribe/unsubscribe...');
  let received = false;
  telegram.subscribeNewMessages((msg) => { received = true; });
  // Just verify subscribe/unsubscribe doesn't throw
  telegram.unsubscribeNewMessages();
  console.log('  OK -- subscribe/unsubscribe cycle completed\n');
}

async function main() {
  try {
    await setup();
    await testListChats();
    const chats = await testListChatsDetailed();
    await testReadMessages();
    const sent = await testSendMessage();
    await testReadSentMessage();
    await testSubscribeUnsubscribe();

    console.log('--- ALL TESTS PASSED ---');
    process.exit(0);
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
