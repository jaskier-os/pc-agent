/**
 * PC Agent - translates natural language to shell commands, Telegram operations,
 * screenshots, and coding tasks via PTC (Programmatic Tool Calling).
 */

import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BaseAgent, PTCClient } from '@orchestrator/sdk';

const execFileP = promisify(execFile);

/**
 * Probe a file with ffprobe and return the streams + format JSON.
 * Returns null if ffprobe is missing or fails.
 */
async function ffprobeJson(filePath) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
    ], { maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Inspect a file and decide how Telegram should treat it. For video formats
 * (mp4/mov/webm/mkv/m4v) we extract duration/width/height for
 * DocumentAttributeVideo and detect whether an audio track is present --
 * Telegram (and gramJS) downgrade soundless videos to GIF/animation, which
 * loops without a seek bar and looks broken. The caller remuxes a silent
 * audio track in for files where hasAudio=false before sending.
 *
 * @returns {Promise<{kind:'video'|'other', duration?:number, w?:number, h?:number, hasAudio?:boolean}>}
 */
async function classifyMedia(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v']);
  if (!VIDEO_EXTS.has(ext)) return { kind: 'other' };
  const probe = await ffprobeJson(filePath);
  if (!probe) return { kind: 'other' };
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const v = streams.find(s => s.codec_type === 'video');
  if (!v) return { kind: 'other' };
  const hasAudio = streams.some(s => s.codec_type === 'audio');
  const duration = parseFloat(v.duration || probe.format?.duration || '0');
  return {
    kind: 'video',
    duration: Number.isFinite(duration) ? duration : 0,
    w: v.width || 0,
    h: v.height || 0,
    hasAudio,
    codec: v.codec_name,
  };
}

/**
 * Remux/transcode a soundless video file with a silent stereo AAC track.
 * Stream-copies the video when the source is already in an mp4-compatible
 * codec (h264/hevc); transcodes to h264 otherwise (vp8/vp9/av1 from
 * webm-recording tools like Playwright). Output is always .mp4 — Telegram
 * renders mp4+aac most reliably across clients.
 *
 * Caller cleans up the returned path.
 * @param {string} filePath
 * @param {string|undefined} videoCodec from ffprobe (e.g. 'h264', 'vp8')
 * @returns {Promise<string>} path to the remuxed file
 */
async function addSilentAudio(filePath, videoCodec) {
  const out = path.join(os.tmpdir(), `tg-bounce-${crypto.randomBytes(4).toString('hex')}.mp4`);
  const canCopy = videoCodec === 'h264' || videoCodec === 'hevc' || videoCodec === 'h265';
  const videoArgs = canCopy
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
  await execFileP('ffmpeg', [
    '-y',
    '-i', filePath,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-shortest',
    ...videoArgs,
    '-c:a', 'aac',
    '-movflags', '+faststart',
    out,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return out;
}

/**
 * Read a JSON request body off an http.IncomingMessage.
 * Rejects if total size exceeds 1MB or the body is not valid JSON.
 */
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
import { isGitCommand } from './executor.js';
import { executeCodeTask } from './code_task.js';
import { RemoteSessionManager } from './remote-sessions.js';
import * as bash_tool from './tools/bash.js';
import * as read_tool from './tools/read.js';
import * as write_tool from './tools/write.js';
import * as edit_tool from './tools/edit.js';
import * as grep_tool from './tools/grep.js';
import * as glob_tool from './tools/glob.js';
import * as explore_tool from './tools/explore.js';

const SYSTEM_PROMPT = `You are a PC agent that executes commands, manages communications, and performs coding tasks on a Linux desktop.

# Doing tasks
 - You help with shell commands, Telegram messaging, file operations, codebase exploration, and autonomous coding tasks.
 - In general, do not propose changes to code you haven't read. If you need to modify a file, read it first. Understand existing code before suggesting modifications.
 - Do not create files unless they're absolutely necessary for achieving your goal. Prefer editing an existing file to creating a new one.
 - If your approach is blocked, do not attempt to brute force your way to the outcome. Diagnose why before switching tactics -- read the error, check your assumptions, try a focused fix. Don't retry the identical action blindly, but don't abandon a viable approach after a single failure either.
 - Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection, and other OWASP top 10 vulnerabilities. If you notice that you wrote insecure code, immediately fix it.
 - Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.
   - Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability. Don't add docstrings, comments, or type annotations to code you didn't change. Only add comments where the logic isn't self-evident.
   - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).
   - Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. Three similar lines of code is better than a premature abstraction.
 - Avoid backwards-compatibility hacks like renaming unused _vars, re-exporting types, adding "removed" comments for removed code. If something is unused, delete it completely.

# Executing actions with care
 - Carefully consider the reversibility and blast radius of actions. You can freely take local, reversible actions like editing files or running read-only commands. But for actions that are hard to reverse, affect shared systems, or could be destructive, consider the risks.
 - Examples of risky actions that warrant caution:
   - Destructive operations: deleting files/branches, killing processes, rm -rf, overwriting uncommitted changes
   - Hard-to-reverse operations: force-pushing, git reset --hard, removing packages/dependencies
   - Actions visible to others: pushing code, sending messages, posting to external services
 - When you encounter an obstacle, do not use destructive actions as a shortcut. Investigate root causes. If you discover unexpected state like unfamiliar files or branches, investigate before deleting or overwriting -- it may represent in-progress work.

# Using your tools
 - Do NOT use bash to run commands when a relevant dedicated tool is provided. This is CRITICAL:
   - To read files use file_read instead of cat, head, tail, or sed
   - To edit files use file_edit instead of sed or awk
   - To create files use file_write instead of cat with heredoc or echo redirection
   - To search for files use file_glob instead of find or ls
   - To search the content of files use grep instead of grep or rg via bash
   - Reserve bash exclusively for system commands and terminal operations that require shell execution
 - Use explore for codebase questions (how things work, where things are defined, architecture). Use code_task only for actual modifications that require multi-step autonomous work.
 - Before calling code_task, you MUST first discover the project location using bash or file_glob. NEVER guess or assume a project path.
 - code_task runs for several minutes. Do not call it for trivial tasks that bash or file_edit can handle.
 - You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel.

# Telegram rules
 - When sending Telegram messages, ALWAYS write them in Russian unless the user explicitly asks for English.
 - NEVER send a Telegram message if anything is unclear: the recipient, the message content, or the intent. Instead, explain what you need clarification on.

# Git rules
 - NEVER use git commands (git add, git commit, git push, git status, etc.) unless the user's request explicitly asks for a git operation. If you need version control info, ask the user.

# Tone and style
 - Never use emojis anywhere in code, comments, logging, or output.
 - Be concise. Go straight to the point. Lead with the answer or action, not the reasoning.
 - Skip filler words, preamble, and unnecessary transitions. Do not restate what the user said.
 - If you can say it in one sentence, don't use three.`;

const TOOLS = [
  {
    name: 'bash',
    description: 'Execute a shell command on the Linux desktop. Returns stdout, stderr, and exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 300000)' }
      },
      required: ['command']
    }
  },
  {
    name: 'telegram_list_chats',
    description: 'List recent Telegram DMs and groups (writable chats only). Returns JSON array of chats.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of chats to return', default: 20 }
      }
    }
  },
  {
    name: 'telegram_list_channels',
    description: 'List subscribed Telegram broadcast channels (read-only). Returns JSON array.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of channels to return', default: 20 }
      }
    }
  },
  {
    name: 'telegram_read_messages',
    description: 'Read last N messages from a Telegram chat or channel. Returns JSON array of messages.',
    input_schema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Username, chat title, or "me" for Saved Messages' },
        limit: { type: 'number', description: 'Number of messages to read', default: 10 }
      },
      required: ['chat']
    }
  },
  {
    name: 'telegram_send_message',
    description: 'Send a message to a Telegram DM or group. ALWAYS write in Russian unless told otherwise.',
    input_schema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Username, chat title, or "me" for Saved Messages' },
        text: { type: 'string', description: 'Message text (write in Russian by default)' }
      },
      required: ['chat', 'text']
    }
  },
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot of the desktop. Returns the screenshot file path.',
    input_schema: {
      type: 'object',
      properties: {
        screen: { type: 'number', description: 'Screen number (0 = default, omit for all screens)' }
      }
    }
  },
  {
    name: 'code_task',
    description: 'Spawn an autonomous coding agent to perform a coding task in a project. Runs for several minutes. Use bash for simple tasks instead.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Detailed, self-contained task description with file names, function names, expected behavior' },
        project_path: { type: 'string', description: 'Absolute path to the project root (must be verified with exec_command first)' }
      },
      required: ['task', 'project_path']
    }
  },
  {
    name: 'explore',
    description: 'Explore a codebase to answer a question. Runs an autonomous read-only search loop using glob, grep, read, and bash. Returns a comprehensive answer. Use for questions about how things work, where things are defined, or codebase architecture.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The question or exploration task about the codebase' },
        project_path: { type: 'string', description: 'Absolute path to the project root to explore (must be verified first)' }
      },
      required: ['task', 'project_path']
    }
  },
  {
    name: 'file_read',
    description: 'Read a file from the filesystem. Returns content with line numbers. Supports offset and limit for reading specific sections.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (1-based, default: 1)' },
        limit: { type: 'number', description: 'Maximum number of lines to read (default: 2000)' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'file_write',
    description: 'Write content to a file. Creates parent directories automatically. Overwrites if exists.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'The content to write to the file' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'file_edit',
    description: 'Make precise text replacements in a file. Finds old_string and replaces with new_string. Requires old_string to be unique unless replace_all is set.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The text to replace it with' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  {
    name: 'grep',
    description: 'Search for a regex pattern across files. Supports content matching, file listing, and match counting.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'Directory or file to search in (default: current directory)' },
        include: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.js")' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode (default: content)' },
        case_insensitive: { type: 'boolean', description: 'Case insensitive search' },
        context: { type: 'number', description: 'Lines of context around matches' },
        type: { type: 'string', description: 'File type shorthand (e.g., "js", "py", "ts")' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'file_glob',
    description: 'Find files matching a glob pattern. Returns a list of matching file paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "**/*.js")' },
        path: { type: 'string', description: 'Base directory to search from (default: current directory)' }
      },
      required: ['pattern']
    }
  }
];

export class PCAgent extends BaseAgent {
  /**
   * @param {Object} options
   * @param {string} options.orchestratorUrl
   * @param {string} options.communicatorUrl
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {import('./executor.js').CommandExecutor} options.executor
   * @param {import('./telegram.js')} options.telegram
   * @param {Object} [options.codeTaskConfig] - Configuration for code_task tool
   * @param {string[]} [options.remoteSessionDirs] - Directories allowed for remote sessions
   * @param {number} [options.healthPort]
   */
  constructor(options) {
    super(
      {
        id: 'pc-agent',
        name: 'PC Command Agent',
        capabilities: [
          'run command',
          'open application',
          'execute shell',
          'run script',
          'list files',
          'system info',
          'manage processes',
          'send message',
          'write message',
          'read messages',
          'list chats',
          'telegram',
          'take screenshot',
          'screenshot',
          'code task',
          'fix bug',
          'implement feature',
          'refactor code',
          'write tests',
          'remote session'
        ],
        inputTypes: ['text'],
        healthEndpoint: '/health',
        remoteSessionDirs: options.remoteSessionDirs || []
      },
      {
        orchestratorUrl: options.orchestratorUrl,
        healthPort: options.healthPort || 0
      }
    );

    this.communicatorUrl = options.communicatorUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.executor = options.executor;
    this.telegram = options.telegram;
    this.codeTaskConfig = options.codeTaskConfig || {};
    this.exploreModel = options.exploreModel || options.model;
    this.remoteSessionManager = new RemoteSessionManager(options.remoteSessionDirs || [], options.orchestratorUrl, options.remoteSessionBin || '');

    this.ptcClient = new PTCClient({
      communicatorUrl: options.communicatorUrl,
      apiKey: options.apiKey,
      model: options.model
    });

    // Register the test-recording bounce endpoint. The AI's Bash tool POSTs
    // a local file path here; we forward the file to the user's Telegram
    // Saved Messages with a 6-char short id prepended to the caption.
    // See ~/.claude/CLAUDE.md "Sharing test recordings with the user".
    this.registerHttpRoute('POST', '/api/v1/tg-upload', async (req, res) => {
      const startedAt = Date.now();
      const body = await readJsonBody(req).catch(() => null);
      const filePath = body?.filePath;
      const caption = typeof body?.caption === 'string' ? body.caption : '';
      if (!filePath || typeof filePath !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'filePath (string) required in JSON body' }));
        return;
      }
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `file not found or unreadable: ${filePath}`, detail: err.message }));
        return;
      }
      const TWO_GB = 2 * 1024 * 1024 * 1024;
      if (stat.size > TWO_GB) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `file exceeds Telegram's 2GB document cap`, sizeBytes: stat.size }));
        return;
      }
      const shortId = crypto.randomBytes(3).toString('hex');
      const fullCaption = caption ? `[${shortId}] ${caption}` : `[${shortId}]`;

      // Probe + auto-remux silent audio for soundless videos. Without this
      // Telegram renders the file as a GIF (animation) -- looping, no
      // seek bar, no scrub -- which the user reports looks broken.
      let pathToSend = filePath;
      let remuxedPath = null;
      let videoAttrs = null;
      let remuxed = false;
      try {
        const media = await classifyMedia(filePath);
        if (media.kind === 'video') {
          if (!media.hasAudio) {
            try {
              remuxedPath = await addSilentAudio(filePath, media.codec);
              pathToSend = remuxedPath;
              remuxed = true;
            } catch (err) {
              console.error(`[pc-agent] tg-upload remux failed shortId=${shortId} err=${err?.message || err}`);
              // Fall through and send original; better a GIF than nothing.
            }
          }
          videoAttrs = {
            duration: media.duration,
            w: media.w,
            h: media.h,
            supportsStreaming: true,
          };
        }
      } catch (err) {
        console.error(`[pc-agent] tg-upload classify failed shortId=${shortId} err=${err?.message || err}`);
      }

      try {
        const messageId = await this.telegram.sendDocumentToSelf(pathToSend, fullCaption, videoAttrs);
        const durationMs = Date.now() - startedAt;
        console.log(`[pc-agent] tg-upload ok shortId=${shortId} msgId=${messageId} bytes=${stat.size} durMs=${durationMs} remuxed=${remuxed} video=${!!videoAttrs} file=${filePath}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ shortId, messageId, sizeBytes: stat.size, durationMs, remuxed, video: !!videoAttrs }));
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        console.error(`[pc-agent] tg-upload failed shortId=${shortId} durMs=${durationMs} err=${err?.message || err}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ shortId, error: err?.message || String(err), durationMs }));
      } finally {
        if (remuxedPath) {
          fsp.unlink(remuxedPath).catch(() => {});
        }
      }
    });
  }

  /**
   * Handle an incoming request from the orchestrator.
   * @param {import('../../../../orchestrator/sdk/types.js').AgentRequest} request
   * @returns {Promise<import('../../../../orchestrator/sdk/types.js').AgentResponse>}
   */
  async handle(request) {
    const { requestId, action } = request;

    // Direct action dispatch -- bypasses PTC/LLM
    if (action === 'remote_session_start') {
      try {
        const { workDir, sessionId, wsUrl, apiKey, permissionMode } = request;
        if (!workDir) {
          return { requestId, status: 'error', text: 'Missing workDir' };
        }
        if (!sessionId || !wsUrl || !apiKey) {
          return { requestId, status: 'error', text: 'Missing sessionId, wsUrl, or apiKey' };
        }
        const CLI_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
        if (!permissionMode || !CLI_MODES.includes(permissionMode)) {
          return { requestId, status: 'error', text: 'invalid_permission_mode' };
        }
        const session = await this.remoteSessionManager.startSession(workDir, sessionId, wsUrl, apiKey, permissionMode);
        return { requestId, status: 'success', data: { sessionId: session.sessionId, workDir: session.workDir, pid: session.pid } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'set_permission_mode') {
      const CLI_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
      const { sessionId, mode } = request;
      if (!CLI_MODES.includes(mode)) {
        console.warn(`[pc-agent] Dropping set_permission_mode with unknown CLI mode: ${mode}`);
        return { requestId, status: 'error', text: 'invalid_permission_mode' };
      }
      const ok = this.remoteSessionManager.setPermissionMode(sessionId, mode);
      if (!ok) {
        return { requestId, status: 'error', text: 'set_permission_mode failed' };
      }
      return { requestId, status: 'success', text: 'permission mode updated' };
    }

    if (action === 'remote_session_list') {
      const sessions = this.remoteSessionManager.listSessions();
      return { requestId, status: 'success', data: { sessions } };
    }

    if (action === 'remote_session_list_conversations') {
      try {
        const { workDir, limit, offset } = request;
        if (!workDir) {
          return { requestId, status: 'error', text: 'Missing workDir' };
        }
        const sessions = await this.remoteSessionManager.listConversations(workDir, limit, offset);
        return { requestId, status: 'success', data: { sessions } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'remote_session_export_transcript') {
      try {
        const { workDir, sessionId } = request;
        if (!workDir || !sessionId) {
          return { requestId, status: 'error', text: 'Missing workDir or sessionId' };
        }
        const transcript = await this.remoteSessionManager.exportTranscript(workDir, sessionId);
        return { requestId, status: 'success', data: { transcript } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_read_messages') {
      try {
        if (!this.telegram.isReady()) {
          return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        }
        const messages = await this.telegram.readMessages(request.chat || 'me', request.limit || 50, request.topicId || null, request.offsetId || null);
        return { requestId, status: 'success', data: { messages } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_list_topics') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const topics = await this.telegram.listTopics(request.chatId, request.limit || 20);
        return { requestId, status: 'success', data: { topics } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_send_message') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const result = await this.telegram.sendMessage(request.chat, request.text, request.topicId || null);
        return { requestId, status: 'success', data: result };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_bot_send') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const replies = await this.telegram.sendAndWait(request.botUsername, request.text, request.silenceMs || 3000);
        return { requestId, status: 'success', data: { replies } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_bot_send_photo') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const replies = await this.telegram.sendPhotoAndWait(request.botUsername, request.photoBase64, request.silenceMs || 3000);
        return { requestId, status: 'success', data: { replies } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_bot_click') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const replies = await this.telegram.clickButtonAndWait(request.botUsername, request.messageId, request.buttonText, request.silenceMs || 3000);
        return { requestId, status: 'success', data: { replies } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_get_entity') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const info = await this.telegram.getEntityInfo(request.username);
        return { requestId, status: 'success', data: info };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_mute_chat') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        await this.telegram.muteChat(request.username);
        return { requestId, status: 'success', text: 'Chat muted' };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_unblock_user') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        await this.telegram.unblockUser(request.username);
        return { requestId, status: 'success', text: 'User unblocked' };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_find_redirect_bot') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const newBot = await this.telegram.findRedirectBot(request.deadBotUsername, request.triedBots || [], request.redirectText || '');
        return { requestId, status: 'success', data: { botUsername: newBot } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_list_chats_detailed') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const chats = await this.telegram.listChatsDetailed(request.limit || 20);
        return { requestId, status: 'success', data: { chats } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_download_avatar') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        const avatar = await this.telegram.downloadEntityPhoto(request.chatId);
        return { requestId, status: 'success', data: { avatar } };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_subscribe') {
      try {
        if (!this.telegram.isReady()) return { requestId, status: 'error', text: `Telegram unavailable: ${this.telegram.getStatus()}` };
        this.telegram.subscribeNewMessages(
          (msg) => { this.send({ type: 'telegram_new_message', message: msg }); },
          (status) => { this.send({ type: 'telegram_user_status', ...status }); }
        );
        return { requestId, status: 'success', text: 'Subscribed to new messages' };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'telegram_unsubscribe') {
      try {
        this.telegram.unsubscribeNewMessages();
        return { requestId, status: 'success', text: 'Unsubscribed from new messages' };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'remote_session_stop') {
      try {
        this.remoteSessionManager.stopSession(request.pid);
        return { requestId, status: 'success', text: 'Session stopped' };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    if (action === 'remote_session_stop_by_session_id') {
      try {
        const stopped = await this.remoteSessionManager.stopBySessionId(request.sessionId);
        return { requestId, status: 'success', text: stopped ? 'Session stopped' : 'Session not found' };
      } catch (err) {
        return { requestId, status: 'error', text: err.message };
      }
    }

    // Reset file tracking context for this request
    this._fileContext = { readFiles: new Map() };

    // Standard PTC path
    const { text, context } = request;
    console.log(`[pc-agent] Handling request ${requestId}: ${text}`);

    this._gitAllowed = /\bgit\b/i.test(text);

    const messages = this.buildMessagesWithHistory(SYSTEM_PROMPT, text, context?.sessionHistory, context?.globalInstructions, context?.autonomousInstructions);
    const result = await this.ptcClient.execute({
      messages,
      tools: TOOLS,
      toolExecutor: (name, input) => this.executeTool(name, input),
      onToolCall: (name, input) => this.sendToolStatus(requestId, name, input)
    });

    return {
      requestId,
      status: 'success',
      text: result.text
    };
  }

  /**
   * Execute a tool by name.
   * @param {string} toolName
   * @param {Object} args
   * @returns {Promise<string>}
   */
  async executeTool(toolName, args) {
    try {
      switch (toolName) {
        case 'bash': {
          if (!args.command) return 'Error: missing "command" argument';
          if (isGitCommand(args.command) && !this._gitAllowed) {
            return 'Rejected: git commands are not allowed unless the user explicitly requested a git operation.';
          }
          if (isGitCommand(args.command) && this._gitAllowed) {
            this.executor.allowedCommands.push('git');
          }
          const result = await bash_tool.run(args);
          if (isGitCommand(args.command) && this._gitAllowed) {
            const idx = this.executor.allowedCommands.indexOf('git');
            if (idx !== -1) this.executor.allowedCommands.splice(idx, 1);
          }
          const parts = [
            `Exit code: ${result.exit_code}`,
            result.stdout ? `Output:\n${result.stdout}` : null,
            result.stderr ? `Errors:\n${result.stderr}` : null
          ].filter(Boolean);
          return parts.join('\n');
        }

        case 'telegram_list_chats': {
          if (!this.telegram.isReady()) return `Telegram unavailable: ${this.telegram.getStatus()}`;
          const chats = await this.telegram.listChats(args.limit || 20);
          return JSON.stringify(chats, null, 2);
        }

        case 'telegram_list_chats_detailed': {
          if (!this.telegram.isReady()) return `Telegram unavailable: ${this.telegram.getStatus()}`;
          const detailedChats = await this.telegram.listChatsDetailed(args.limit || 20);
          return JSON.stringify(detailedChats, null, 2);
        }

        case 'telegram_list_channels': {
          if (!this.telegram.isReady()) return `Telegram unavailable: ${this.telegram.getStatus()}`;
          const channels = await this.telegram.listChannels(args.limit || 20);
          return JSON.stringify(channels, null, 2);
        }

        case 'telegram_read_messages': {
          if (!this.telegram.isReady()) return `Telegram unavailable: ${this.telegram.getStatus()}`;
          if (!args.chat) return 'Error: missing "chat" argument';
          const messages = await this.telegram.readMessages(args.chat, args.limit || 10, args.topicId || null, args.offsetId || null);
          return JSON.stringify(messages, null, 2);
        }

        case 'telegram_send_message': {
          if (!this.telegram.isReady()) return `Telegram unavailable: ${this.telegram.getStatus()}`;
          if (!args.chat) return 'Error: missing "chat" argument';
          if (!args.text) return 'Error: missing "text" argument';
          const result = await this.telegram.sendMessage(args.chat, args.text);
          return `Message sent (id: ${result.id}, date: ${result.date})`;
        }

        case 'take_screenshot': {
          const scriptPath = path.resolve(import.meta.dirname, '../../../../clients/desktop/src/screenshot.py');
          const screenArg = args.screen !== undefined ? `--screen ${args.screen}` : '';
          const result = await this.executor.exec(`python3 ${scriptPath} ${screenArg}`.trim());
          if (result.exitCode !== 0) return `Screenshot failed: ${result.stderr}`;
          return result.stdout;
        }

        case 'code_task': {
          if (!args.task) return 'Error: missing "task" argument';
          if (!args.project_path) return 'Error: missing "project_path" argument';
          return await executeCodeTask({
            task: args.task,
            projectPath: args.project_path,
            config: this.codeTaskConfig,
            callLLM: (messages) => this.callLLMDirect(messages),
          });
        }

        case 'explore': {
          if (!args.task) return 'Error: missing "task" argument';
          if (!args.project_path) return 'Error: missing "project_path" argument';
          const result = await explore_tool.run(args, {
            communicatorUrl: this.communicatorUrl,
            apiKey: this.apiKey,
            model: this.exploreModel
          });
          if (!result.success) return `Error: ${result.error}`;
          return result.answer;
        }

        case 'file_read': {
          const result = await read_tool.run(args, this._fileContext);
          if (!result.success) return `Error: ${result.error}`;
          return result.content;
        }

        case 'file_write': {
          const result = await write_tool.run(args, this._fileContext);
          if (!result.success) return `Error: ${result.error}`;
          return `File written: ${result.file_path} (${result.bytes_written} bytes)`;
        }

        case 'file_edit': {
          const result = await edit_tool.run(args);
          if (!result.success) return `Error: ${result.error}`;
          let msg = `File edited: ${result.file_path} (${result.replacements_made} replacement(s))`;
          if (result.diff) msg += `\n${result.diff}`;
          return msg;
        }

        case 'grep': {
          const result = await grep_tool.run(args);
          if (!result.success) return `Error: ${result.error}`;
          const mode = args.output_mode || 'content';
          if (mode === 'files_with_matches') {
            if (result.files.length === 0) return 'No matches found.';
            let output = result.files.join('\n');
            if (result.truncated) output += `\n[${result.count - result.files.length} more truncated]`;
            return output;
          }
          if (mode === 'count') {
            if (!result.counts || result.counts.length === 0) return 'No matches found.';
            return result.counts.map(c => `${c.file}: ${c.count}`).join('\n') + `\nTotal: ${result.total}`;
          }
          if (result.results.length === 0) return 'No matches found.';
          const lines = result.results.map(r => `${r.file}:${r.line}:${r.content}`);
          if (result.truncated) lines.push(`[${result.total_matches - result.results.length} more matches truncated]`);
          return lines.join('\n');
        }

        case 'file_glob': {
          const result = await glob_tool.run(args);
          if (!result.success) return `Error: ${result.error}`;
          if (result.files.length === 0) return 'No files matched.';
          const output = result.files.join('\n');
          if (result.truncated) return output + `\n[${result.count - result.files.length} more files truncated]`;
          return output;
        }

        default:
          return `Unknown tool: ${toolName}`;
      }
    } catch (err) {
      return `Error executing ${toolName}: ${err.message}`;
    }
  }

  /**
   * Direct LLM call for code_task's internal agentic loop.
   * code_task has its own loop with file caching, compaction, etc.
   * that is separate from the main PTC flow.
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<{content: string, usage: {prompt_tokens?: number, completion_tokens?: number}}>}
   */
  async callLLMDirect(messages) {
    const response = await fetch(`${this.communicatorUrl}/api/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Communicator API error ${response.status}: ${body}`);
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      usage: data.usage || {},
    };
  }
}
