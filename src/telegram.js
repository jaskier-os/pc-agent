/**
 * Telegram MTProto client for PC Agent.
 * Ported from Recon/reid-analytics/backend/services/telegramService.js (CommonJS -> ESM).
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { NewMessage, Raw } from 'telegram/events/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import sharp from 'sharp';
import readline from 'readline';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '../.env');

let client = null;
let ready = false;
let statusMessage = 'Telegram not initialized yet';
let retryTimer = null;

function promptInput(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

function persistSession(sessionString) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  if (content.includes('TELEGRAM_SESSION=')) {
    content = content.replace(/TELEGRAM_SESSION=.*/, `TELEGRAM_SESSION=${sessionString}`);
  } else {
    content += `\nTELEGRAM_SESSION=${sessionString}`;
  }
  fs.writeFileSync(ENV_PATH, content);
}

/**
 * Initialize the Telegram client. Connects with existing StringSession
 * or starts QR code login if no session is saved.
 * @param {Object} options
 * @param {number} options.apiId
 * @param {string} options.apiHash
 * @param {string} options.session
 */
export async function initialize({ apiId, apiHash, session, socksProxy }) {
  // Clean up previous client on retry
  if (client) {
    try { await client.disconnect(); } catch { /* ignore */ }
    client = null;
    ready = false;
  }
  statusMessage = 'Telegram connecting...';

  const stringSession = new StringSession(session);

  const opts = { connectionRetries: 5 };
  if (socksProxy) {
    opts.proxy = {
      socksType: 5,
      ip: socksProxy.host,
      port: socksProxy.port,
    };
    console.log(`[telegram] Using SOCKS5 proxy: ${socksProxy.host}:${socksProxy.port}`);
  }

  client = new TelegramClient(stringSession, apiId, apiHash, opts);

  const connectWithTimeout = (timeoutMs = 30000) => {
    return Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram connect timed out')), timeoutMs))
    ]);
  };

  if (session) {
    await connectWithTimeout();
  } else {
    await connectWithTimeout();
    // Dynamic import for optional QR code dependency
    let qrcode;
    try {
      qrcode = (await import('qrcode-terminal')).default;
    } catch {
      console.log('[telegram] qrcode-terminal not installed, printing raw URL');
    }

    console.log('[telegram] No session found. Scan the QR code with Telegram: Settings -> Devices -> Link Desktop Device');
    await client.signInUserWithQrCode(
      { apiId, apiHash },
      {
        qrCode: async (code) => {
          const url = `tg://login?token=${code.token.toString('base64url')}`;
          if (qrcode) {
            qrcode.generate(url, { small: true });
          } else {
            console.log(`[telegram] QR login URL: ${url}`);
          }
          console.log('[telegram] QR refreshes every 30s, scan quickly');
        },
        password: () => promptInput('[telegram] 2FA password: '),
        onError: (err) => {
          console.error('[telegram] QR auth error:', err.message);
          return false;
        },
      }
    );
  }

  const saved = client.session.save();
  if (saved !== session) {
    persistSession(saved);
    console.log('[telegram] Session saved to .env');
  }

  ready = true;
  statusMessage = 'connected';
  console.log('[telegram] Connected');
}

/**
 * Check if the Telegram client is connected and ready.
 * Also detects mid-session disconnects (VPN toggle, network change).
 * @returns {boolean}
 */
export function isReady() {
  if (ready && client && !client.connected) {
    ready = false;
    statusMessage = 'Telegram disconnected (network change), waiting for reconnect';
    console.error(`[telegram] ${statusMessage}`);
  }
  return ready;
}

/**
 * Get human-readable status for error messages.
 * @returns {string}
 */
export function getStatus() {
  return statusMessage;
}

/**
 * Resolve a chat identifier to an entity the client can use.
 * Supports: 'me'/'saved' -> Saved Messages, '@username', title match, numeric ID.
 * @param {string|number} chat
 * @returns {Promise<any>}
 */
async function resolveChat(chat) {
  if (typeof chat === 'string') {
    const lower = chat.toLowerCase().trim();
    if (lower === 'me' || lower === 'saved' || lower === 'saved messages') {
      return 'me';
    }
    if (lower.startsWith('@')) {
      return chat.trim();
    }
    // Try numeric ID
    const asNumber = Number(chat);
    if (!isNaN(asNumber) && String(asNumber) === chat.trim()) {
      return asNumber;
    }
    // Try matching by dialog title
    const dialogs = await client.getDialogs({ limit: 100 });
    const match = dialogs.find(d => d.title?.toLowerCase().includes(lower));
    if (match) {
      return match.entity;
    }
    throw new Error(`Could not resolve chat: "${chat}". Try using @username or exact chat title.`);
  }
  return chat;
}

/**
 * Check if a dialog is writable (DM, group, or supergroup -- not a broadcast channel).
 * @param {object} dialog
 * @returns {boolean}
 */
function isWritable(dialog) {
  const entity = dialog.entity;
  if (!entity) return false;
  // Broadcast channels (not supergroups) are read-only
  if (entity.broadcast && !entity.megagroup) return false;
  return true;
}

/**
 * List recent writable Telegram chats (DMs and groups, no broadcast channels).
 * @param {number} [limit=20]
 * @returns {Promise<Array<{id: string, title: string, unreadCount: number, lastMessage: string}>>}
 */
export async function listChats(limit = 20) {
  // Fetch more than requested to compensate for filtered-out channels
  const dialogs = await client.getDialogs({ limit: limit * 3 });
  return dialogs
    .filter(isWritable)
    .slice(0, limit)
    .map(d => ({
      id: d.id?.toString() || '',
      title: d.title || '',
      unreadCount: d.unreadCount || 0,
      lastMessage: d.message?.message || '',
    }));
}

/**
 * List recent broadcast channels (read-only, not groups or DMs).
 * @param {number} [limit=20]
 * @returns {Promise<Array<{id: string, title: string, unreadCount: number, lastMessage: string}>>}
 */
export async function listChannels(limit = 20) {
  const dialogs = await client.getDialogs({ limit: limit * 3 });
  return dialogs
    .filter(d => d.entity?.broadcast && !d.entity?.megagroup)
    .slice(0, limit)
    .map(d => ({
      id: d.id?.toString() || '',
      title: d.title || '',
      unreadCount: d.unreadCount || 0,
      lastMessage: d.message?.message || '',
    }));
}

/**
 * Extract display text from a message, generating labels for media/actions.
 * @param {object} m - GramJS message object
 * @returns {string}
 */
function getMediaLabel(m) {
  // Service messages (calls, user actions)
  if (m.action) {
    const cls = m.action.className;
    if (cls === 'MessageActionPhoneCall') {
      const duration = m.action.duration;
      if (duration) {
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        return `[Call ${mins}m ${secs}s]`;
      }
      return '[Missed call]';
    }
    return `[${cls.replace('MessageAction', '')}]`;
  }

  const text = m.message || '';
  const media = m.media;
  if (!media) return text;

  const cls = media.className;
  if (cls === 'MessageMediaPhoto') return text || '[Photo]';
  if (cls === 'MessageMediaGeo' || cls === 'MessageMediaGeoLive') return text || '[Location]';
  if (cls === 'MessageMediaContact') return text || '[Contact]';
  if (cls === 'MessageMediaPoll') return text || `[Poll: ${media.poll?.question || ''}]`;
  if (cls === 'MessageMediaWebPage') return text || '[Link]';
  if (cls === 'MessageMediaDice') return text || `[${media.emoticon || 'Dice'}]`;
  if (cls === 'MessageMediaVenue') return text || '[Venue]';
  if (cls === 'MessageMediaGame') return text || `[Game: ${media.game?.title || ''}]`;

  if (cls === 'MessageMediaDocument') {
    const doc = media.document;
    if (!doc) return text || '[Document]';
    const attrs = doc.attributes || [];

    for (const attr of attrs) {
      if (attr.className === 'DocumentAttributeAudio') {
        if (attr.voice) {
          const dur = attr.duration || 0;
          return text || `[Voice message ${dur}s]`;
        }
        const audioName = attr.title || attr.performer || '';
        return text || (audioName ? `[Audio: ${audioName}]` : '[Audio]');
      }
      if (attr.className === 'DocumentAttributeVideo') {
        if (attr.roundMessage) return text || '[Video message]';
        return text || '[Video]';
      }
      if (attr.className === 'DocumentAttributeSticker') {
        return text || (attr.alt ? `[Sticker ${attr.alt}]` : '[Sticker]');
      }
      if (attr.className === 'DocumentAttributeAnimated') {
        return text || '[GIF]';
      }
    }

    const fileName = attrs.find(a => a.className === 'DocumentAttributeFilename')?.fileName;
    return text || (fileName ? `[Document: ${fileName}]` : '[Document]');
  }

  return text || `[${cls?.replace('MessageMedia', '') || 'Media'}]`;
}

/**
 * Read last N messages from a chat.
 * @param {string|number} chat - Chat identifier (username, title, 'me', or numeric ID)
 * @param {number} [limit=10]
 * @returns {Promise<Array<{id: number, sender: string, text: string, date: string, isOutgoing: boolean, isRead: boolean|undefined, imageBase64: string|undefined}>>}
 */
export async function readMessages(chat, limit = 10, topicId = null, offsetId = null) {
  const entity = await resolveChat(chat);
  const opts = { limit };
  if (topicId) opts.replyTo = topicId;
  if (offsetId) opts.offsetId = offsetId;
  const messages = await client.getMessages(entity, opts);

  // Get dialog read state for outgoing message status
  let readOutboxMaxId = 0;
  const isSavedMessages = entity === 'me';
  if (isSavedMessages) {
    // Saved Messages: all outgoing messages are inherently "read"
    readOutboxMaxId = Infinity;
  } else {
    try {
      const inputPeer = await client.getInputEntity(entity);
      const result = await client.invoke(new Api.messages.GetPeerDialogs({
        peers: [new Api.InputDialogPeer({ peer: inputPeer })]
      }));
      readOutboxMaxId = result.dialogs[0]?.readOutboxMaxId || 0;
    } catch (err) { console.warn(`[telegram] GetPeerDialogs failed: ${err.message}`); }
  }

  // Download photo thumbnails in parallel
  const photoPromises = messages.map(async (m) => {
    if (m.media?.className !== 'MessageMediaPhoto') return null;
    try {
      const photo = m.media.photo;
      if (!photo?.sizes) return null;
      const sizes = photo.sizes.filter(s => s.className === 'PhotoSize');
      const target = sizes.find(s => s.type === 'm') || sizes.find(s => s.type === 's') || sizes[0];
      if (!target) return null;
      const buffer = await client.downloadMedia(m, { thumb: target });
      if (buffer?.length > 0) return buffer.toString('base64');
    } catch { /* ignore download failures */ }
    return null;
  });
  const photos = await Promise.all(photoPromises);

  // Sort ascending by date (API returns newest first)
  const indexed = messages.map((m, i) => ({ m, photo: photos[i] }));
  indexed.sort((a, b) => (a.m.date || 0) - (b.m.date || 0));

  return indexed.map(({ m, photo }) => ({
    id: m.id,
    sender: m.sender?.firstName || m.sender?.title || m.sender?.username || String(m.senderId || 'unknown'),
    text: getMediaLabel(m),
    date: m.date ? new Date(m.date * 1000).toISOString() : '',
    isOutgoing: !!m.out,
    isRead: m.out ? m.id <= readOutboxMaxId : undefined,
    imageBase64: photo || undefined,
  }));
}

/**
 * Send a message to a chat.
 * @param {string|number} chat - Chat identifier
 * @param {string} text - Message text
 * @returns {Promise<{id: number, date: string}>}
 */
export async function sendMessage(chat, text, topicId = null) {
  const entity = await resolveChat(chat);
  const opts = { message: text };
  if (topicId) opts.replyTo = topicId;
  const result = await client.sendMessage(entity, opts);
  return {
    id: result.id,
    date: result.date ? new Date(result.date * 1000).toISOString() : '',
  };
}

/**
 * List recent writable Telegram chats with detailed info for glasses display.
 * @param {number} [limit=20]
 * @returns {Promise<Array<{id: string, title: string, unreadCount: number, lastMessage: string, lastMessageDate: string, lastMessageSender: string, chatType: string}>>}
 */
/**
 * Parse a Telegram user status object into isOnline + lastSeen.
 * @param {object|undefined} status - GramJS user status
 * @returns {{isOnline: boolean, lastSeen: string|null}}
 */
function parseUserStatus(status) {
  if (!status) return { isOnline: false, lastSeen: null };
  if (status.className === 'UserStatusOnline') return { isOnline: true, lastSeen: null };
  if (status.className === 'UserStatusOffline') {
    return { isOnline: false, lastSeen: status.wasOnline ? new Date(status.wasOnline * 1000).toISOString() : null };
  }
  if (status.className === 'UserStatusRecently') return { isOnline: false, lastSeen: 'recently' };
  if (status.className === 'UserStatusLastWeek') return { isOnline: false, lastSeen: 'within a week' };
  if (status.className === 'UserStatusLastMonth') return { isOnline: false, lastSeen: 'within a month' };
  return { isOnline: false, lastSeen: null };
}

export async function listChatsDetailed(limit = 20) {
  const dialogs = await client.getDialogs({ limit: limit * 3 });
  const writable = dialogs.filter(isWritable).slice(0, limit);

  // Download avatars, resize to 24x24 (~500 bytes each), 8s total timeout
  const avatarTimeout = new Promise(r => setTimeout(() => r('TIMEOUT'), 8000));
  const avatarWork = Promise.all(writable.map(async (d) => {
    try {
      if (!d.entity?.photo) return null;
      const buffer = await client.downloadProfilePhoto(d.entity, { isBig: false });
      if (!buffer || buffer.length === 0) return null;
      const tiny = await sharp(buffer).resize(24, 24).jpeg({ quality: 60 }).toBuffer();
      return tiny.toString('base64');
    } catch { /* no avatar */ }
    return null;
  }));
  const avatarResult = await Promise.race([avatarWork, avatarTimeout]);
  const avatars = avatarResult === 'TIMEOUT' ? writable.map(() => null) : avatarResult;
  console.log(`[telegram] Avatars: ${avatars.filter(Boolean).length}/${writable.length} (${avatarResult === 'TIMEOUT' ? 'TIMED OUT' : 'ok'})`);

  return writable.map((d, i) => {
    const entity = d.entity;
    let chatType = 'user';
    if (entity?.megagroup || entity?.gigagroup) chatType = 'group';
    else if (entity?.broadcast) chatType = 'channel';
    else if (entity?.className === 'Chat') chatType = 'group';

    const msg = d.message;

    const { isOnline, lastSeen } = chatType === 'user' ? parseUserStatus(entity?.status) : { isOnline: false, lastSeen: null };

    return {
      chatId: d.id?.toString() || '',
      title: d.title || '',
      unreadCount: d.unreadCount || 0,
      lastMessage: msg ? getMediaLabel(msg) : '',
      lastMessageDate: msg?.date ? new Date(msg.date * 1000).toISOString() : '',
      lastMessageSender: msg?.sender?.firstName || msg?.sender?.title || msg?.sender?.username || '',
      chatType,
      isForum: !!entity?.forum,
      readOutboxMaxId: d.dialog?.readOutboxMaxId || 0,
      isOnline,
      lastSeen,
      avatar: avatars[i],
    };
  });
}

/**
 * List topics in a forum group.
 * @param {string|number} chat - Chat identifier
 * @param {number} [limit=20]
 * @returns {Promise<Array<{id: number, title: string, unreadCount: number, lastMessage: string, lastMessageDate: string}>>}
 */
export async function listTopics(chat, limit = 20) {
  const entity = await resolveChat(chat);
  const fullEntity = typeof entity === 'number' ? await client.getEntity(entity) : entity;
  const result = await client.invoke(new Api.channels.GetForumTopics({
    channel: fullEntity,
    limit,
    offsetDate: 0,
    offsetId: 0,
    offsetTopic: 0,
  }));
  return result.topics.map(t => ({
    id: t.id,
    title: t.title || (t.id === 1 ? 'General' : `Topic ${t.id}`),
    unreadCount: t.unreadCount || 0,
    lastMessage: '',
    lastMessageDate: t.date ? new Date(t.date * 1000).toISOString() : '',
  }));
}

/**
 * Get user presence (online status).
 * @param {string|number} userId - User identifier
 * @returns {Promise<{isOnline: boolean, lastSeen: string|null}>}
 */
export async function getUserPresence(userId) {
  try {
    const entity = await resolveChat(userId);
    const fullUser = await client.invoke(new Api.users.GetFullUser({
      id: await client.getInputEntity(entity)
    }));
    return parseUserStatus(fullUser.users?.[0]?.status);
  } catch (err) {
    console.error(`[telegram] getUserPresence error: ${err.message}`);
    return { isOnline: false, lastSeen: null };
  }
}

/**
 * Download a profile photo for any entity (user, group, channel).
 * @param {string|number} entityId - Entity identifier
 * @returns {Promise<string|null>} Base64-encoded JPEG or null
 */
export async function downloadEntityPhoto(entityId) {
  try {
    const resolved = await resolveChat(entityId);
    // Fully resolve entity (numeric IDs need getEntity to populate photo)
    const entity = typeof resolved === 'number' ? await client.getEntity(resolved) : resolved;
    const buffer = await client.downloadProfilePhoto(entity, { isBig: false });
    if (buffer && buffer.length > 0) {
      console.log(`[telegram] Avatar for ${entityId}: ${buffer.length} bytes`);
      return buffer.toString('base64');
    }
    console.log(`[telegram] No avatar for ${entityId}`);
  } catch (err) {
    console.error(`[telegram] downloadEntityPhoto error for ${entityId}: ${err.message}`);
  }
  return null;
}

// Active subscription handler refs (for cleanup)
let _newMessageHandler = null;
let _newMessageFilter = null;
let _statusHandler = null;
let _statusFilter = null;

/**
 * Subscribe to all new incoming messages + user status changes.
 * @param {function} messageCallback - Called with {chatId, chatTitle, messageId, sender, text, date, isOutgoing}
 * @param {function} [statusCallback] - Called with {userId, isOnline, lastSeen}
 */
export function subscribeNewMessages(messageCallback, statusCallback) {
  // Clean up previous subscription if any
  unsubscribeNewMessages();

  _newMessageFilter = new NewMessage({});
  _newMessageHandler = async (event) => {
    const msg = event.message;
    let chatId = '';
    let chatTitle = '';
    try {
      const chat = await msg.getChat();
      chatId = chat?.id?.toString() || '';
      chatTitle = chat?.title || chat?.firstName || chat?.username || '';
    } catch {
      chatId = msg.chatId?.toString() || '';
    }

    messageCallback({
      chatId,
      chatTitle,
      messageId: msg.id,
      sender: msg.sender?.firstName || msg.sender?.title || msg.sender?.username || String(msg.senderId || 'unknown'),
      text: getMediaLabel(msg),
      date: msg.date ? new Date(msg.date * 1000).toISOString() : '',
      isOutgoing: !!msg.out,
    });
  };

  client.addEventHandler(_newMessageHandler, _newMessageFilter);
  console.log('[telegram] Subscribed to new messages');

  // Subscribe to user status updates (online/offline)
  if (statusCallback) {
    _statusFilter = new Raw({ types: [Api.UpdateUserStatus] });
    _statusHandler = (update) => {
      const userId = update.userId?.toString() || '';
      const { isOnline, lastSeen } = parseUserStatus(update.status);
      statusCallback({ userId, isOnline, lastSeen });
    };
    client.addEventHandler(_statusHandler, _statusFilter);
    console.log('[telegram] Subscribed to user status updates');
  }
}

/**
 * Unsubscribe from new message and status events.
 */
export function unsubscribeNewMessages() {
  if (_newMessageHandler && _newMessageFilter) {
    client.removeEventHandler(_newMessageHandler, _newMessageFilter);
    console.log('[telegram] Unsubscribed from new messages');
  }
  if (_statusHandler && _statusFilter) {
    client.removeEventHandler(_statusHandler, _statusFilter);
    console.log('[telegram] Unsubscribed from status updates');
  }
  _newMessageHandler = null;
  _newMessageFilter = null;
  _statusHandler = null;
  _statusFilter = null;
}

/**
 * Get the raw Telegram client.
 * @returns {TelegramClient|null}
 */
export function getClient() {
  return client;
}

// ---------------------------------------------------------------------------
// Bot interaction helpers (ported from reid-analytics botHelper.js -> ESM)
// ---------------------------------------------------------------------------

const REPLY_TIMEOUT_MS = 600000;
const DEFAULT_SILENCE_WINDOW_MS = 3000;

/**
 * Convert a GramJS message to a serializable object (no raw Message refs).
 * @param {object} msg - GramJS message object
 * @returns {object}
 */
function extractEntry(msg) {
  const entry = {
    text: msg.message || msg.text || '',
    messageId: msg.id,
    entities: undefined,
    buttons: undefined,
    edited: false,
    hasMedia: !!msg.media,
    mediaType: msg.media?.className || null,
  };

  if (msg.entities && msg.entities.length > 0) {
    entry.entities = msg.entities.map(e => {
      const info = { type: e.className, offset: e.offset, length: e.length };
      if (e.url) info.url = e.url;
      if (e.userId) info.userId = e.userId.toString();
      return info;
    });
  }

  if (msg.replyMarkup && msg.replyMarkup.rows) {
    entry.buttons = msg.replyMarkup.rows
      .flatMap(row => row.buttons.map(btn => btn.url ? { text: btn.text, url: btn.url } : btn.text));
  }

  return entry;
}

/**
 * Listen for new and edited messages from a bot until silence threshold is reached.
 * @param {string} botUsername - Bot username (e.g. '@SomeBot')
 * @param {number} [silenceMs=3000] - Silence window in ms before resolving
 * @returns {Promise<Array<object>>} Array of extractEntry results
 */
export function collectReplies(botUsername, silenceMs = DEFAULT_SILENCE_WINDOW_MS) {
  return new Promise((resolve) => {
    const messages = [];
    const seenIds = new Set();
    let silenceTimer = null;

    const finish = () => {
      clearTimeout(maxTimer);
      clearTimeout(silenceTimer);
      client.removeEventHandler(newMsgHandler, newMsgFilter);
      client.removeEventHandler(editHandler, editFilter);
      resolve(messages);
    };

    const resetSilenceTimer = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, silenceMs);
    };

    const maxTimer = setTimeout(finish, REPLY_TIMEOUT_MS);

    // New messages from bot
    const newMsgFilter = new NewMessage({ fromUsers: [botUsername] });
    const newMsgHandler = async (event) => {
      clearTimeout(maxTimer);
      const msg = event.message;
      if (seenIds.has(msg.id)) return;
      seenIds.add(msg.id);
      messages.push(extractEntry(msg));
      resetSilenceTimer();
    };

    // Edited messages (bots often edit "searching..." into actual results)
    const editFilter = new Raw({ types: [Api.UpdateEditMessage, Api.UpdateEditChannelMessage] });
    const editHandler = async (update) => {
      const msg = update.message;
      if (!msg) return;
      if (msg.out) return;
      clearTimeout(maxTimer);
      const entry = extractEntry(msg);
      entry.edited = true;
      const existing = messages.find(m => m.messageId === msg.id);
      if (existing) {
        existing.text = entry.text;
        existing.buttons = entry.buttons;
        existing.entities = entry.entities;
        existing.edited = true;
        console.log(`[telegram] message ${msg.id} edited -> ${(entry.text || '').substring(0, 80)}...`);
      } else {
        seenIds.add(msg.id);
        messages.push(entry);
        console.log(`[telegram] message ${msg.id} new (via edit event)`);
      }
      resetSilenceTimer();
    };

    client.addEventHandler(newMsgHandler, newMsgFilter);
    client.addEventHandler(editHandler, editFilter);

    // Start silence timer immediately
    resetSilenceTimer();
  });
}

/**
 * Send a text message to a bot and wait for all replies.
 * @param {string} botUsername
 * @param {string} text
 * @param {number} [silenceMs=3000]
 * @returns {Promise<Array<object>>}
 */
export async function sendAndWait(botUsername, text, silenceMs = DEFAULT_SILENCE_WINDOW_MS) {
  const repliesPromise = collectReplies(botUsername, silenceMs);
  await client.sendMessage(botUsername, { message: text });
  console.log(`[telegram] -> ${botUsername}: ${text}`);
  const replies = await repliesPromise;
  console.log(`[telegram] <- ${botUsername}: ${replies.length} replies`);
  return replies;
}

/**
 * Send a photo (as base64) to a bot and wait for all replies.
 * @param {string} botUsername
 * @param {string} photoBase64 - Base64-encoded image data
 * @param {number} [silenceMs=3000]
 * @returns {Promise<Array<object>>}
 */
export async function sendPhotoAndWait(botUsername, photoBase64, silenceMs = DEFAULT_SILENCE_WINDOW_MS) {
  const repliesPromise = collectReplies(botUsername, silenceMs);
  const photoBuffer = Buffer.from(photoBase64, 'base64');
  const entity = await client.getInputEntity(botUsername);
  const file = new CustomFile('photo.jpg', photoBuffer.length, '', photoBuffer);
  await client.sendFile(entity, { file, forceDocument: false });
  console.log(`[telegram] -> ${botUsername}: [photo] ${photoBuffer.length} bytes`);
  const replies = await repliesPromise;
  console.log(`[telegram] <- ${botUsername}: ${replies.length} replies`);
  return replies;
}

/**
 * Upload a file from disk to the user's Saved Messages ('me') with a caption.
 * Used by the /api/v1/tg-upload route for the test-recording bounce flow:
 * caller hands us an absolute path on disk (e.g. an mp4 from adb screenrecord
 * or scrcpy) and we forward it to the user's own chat. forceDocument:false
 * lets Telegram render videos with a player thumbnail; non-video formats
 * upload as documents transparently.
 *
 * For video uploads, pass a populated `videoAttrs` so Telegram recognises
 * the file as a real video (with seek bar + duration) instead of inlining
 * it as a silent GIF/animation. Pair this with adding a silent audio track
 * to soundless screen recordings before calling -- gramJS still emits a
 * GIF if no audio stream is present even with VideoAttribute set.
 *
 * @param {string} filePath absolute path to a local file
 * @param {string} [caption=''] optional caption text (max 1024 chars per Telegram)
 * @param {{duration: number, w: number, h: number, supportsStreaming?: boolean}} [videoAttrs]
 * @returns {Promise<number>} the resulting message id in Saved Messages
 */
export async function sendDocumentToSelf(filePath, caption = '', videoAttrs = null) {
  if (!ready || !client) throw new Error('Telegram client not ready');
  const sendOpts = {
    file: filePath,
    caption,
    forceDocument: false,
  };
  if (videoAttrs && Number.isFinite(videoAttrs.duration) && videoAttrs.w && videoAttrs.h) {
    sendOpts.attributes = [
      new Api.DocumentAttributeVideo({
        duration: Math.max(1, Math.round(videoAttrs.duration)),
        w: videoAttrs.w,
        h: videoAttrs.h,
        supportsStreaming: videoAttrs.supportsStreaming !== false,
      }),
    ];
  }
  const result = await client.sendFile('me', sendOpts);
  return result?.id;
}

/**
 * Click an inline button on an existing message and wait for replies.
 * @param {string} botUsername
 * @param {number} messageId - ID of the message containing the button
 * @param {string} buttonText - Text of the button to click
 * @param {number} [silenceMs=3000]
 * @returns {Promise<Array<object>>}
 */
export async function clickButtonAndWait(botUsername, messageId, buttonText, silenceMs = DEFAULT_SILENCE_WINDOW_MS) {
  const repliesPromise = collectReplies(botUsername, silenceMs);
  const msgs = await client.getMessages(botUsername, { ids: [messageId] });
  const msg = msgs[0];
  if (!msg) throw new Error(`Message ${messageId} not found in chat with ${botUsername}`);
  await msg.click({ text: buttonText });
  console.log(`[telegram] -> ${botUsername}: [click] "${buttonText}" on message ${messageId}`);
  const replies = await repliesPromise;
  console.log(`[telegram] <- ${botUsername}: ${replies.length} replies`);
  return replies;
}

/**
 * Get entity info for a username.
 * @param {string} username
 * @returns {Promise<{id: string, username: string|null, bot: boolean, firstName: string|null, title: string|null}>}
 */
export async function getEntityInfo(username) {
  const entity = await client.getEntity(username);
  return {
    id: entity.id?.toString() || '',
    username: entity.username || null,
    bot: !!entity.bot,
    firstName: entity.firstName || null,
    title: entity.title || null,
  };
}

/**
 * Mute a chat by setting notification settings with mute_until far in the future.
 * @param {string} username
 */
export async function muteChat(username) {
  const peer = await client.getInputEntity(username);
  await client.invoke(new Api.account.UpdateNotifySettings({
    peer: new Api.InputNotifyPeer({ peer }),
    settings: new Api.InputPeerNotifySettings({
      muteUntil: 2147483647,
    }),
  }));
  console.log(`[telegram] Muted chat: ${username}`);
}

/**
 * Unblock a user.
 * @param {string} username
 */
export async function unblockUser(username) {
  const inputUser = await client.getInputEntity(username);
  await client.invoke(new Api.contacts.Unblock({
    id: inputUser,
  }));
  console.log(`[telegram] Unblocked user: ${username}`);
}

/**
 * Find a redirect bot by scanning recent dialogs for messages about the dead bot moving.
 * @param {string} deadBotUsername - The bot username that stopped working
 * @param {string[]} [triedBots=[]] - Already tried bot usernames to skip
 * @param {string} [redirectText=''] - Specific redirect text to look for
 * @returns {Promise<string|null>} New bot username or null
 */
export async function findRedirectBot(deadBotUsername, triedBots = [], redirectText = '') {
  const dialogs = await client.getDialogs({ limit: 100 });
  const skipSet = new Set(triedBots.map(b => b.toLowerCase().replace(/^@/, '')));
  skipSet.add(deadBotUsername.toLowerCase().replace(/^@/, ''));

  const redirectPatterns = [/moved?\s+to\s+@(\w+)/i, /redirect.*?@(\w+)/i, /new\s+bot.*?@(\w+)/i, /use\s+@(\w+)/i];

  for (const dialog of dialogs) {
    const messages = await client.getMessages(dialog.entity, { limit: 20 });
    for (const msg of messages) {
      const text = msg.message || '';

      // Check for specific redirect text
      if (redirectText && text.toLowerCase().includes(redirectText.toLowerCase())) {
        const mentionMatch = text.match(/@(\w{5,})/);
        if (mentionMatch && !skipSet.has(mentionMatch[1].toLowerCase())) {
          console.log(`[telegram] Found redirect bot via custom text: @${mentionMatch[1]}`);
          return `@${mentionMatch[1]}`;
        }
      }

      // Check common redirect patterns
      for (const pattern of redirectPatterns) {
        const match = text.match(pattern);
        if (match && !skipSet.has(match[1].toLowerCase())) {
          console.log(`[telegram] Found redirect bot via pattern: @${match[1]}`);
          return `@${match[1]}`;
        }
      }
    }
  }

  console.log(`[telegram] No redirect bot found for ${deadBotUsername}`);
  return null;
}
