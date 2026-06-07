/**
 * Self-contained coding agent that reuses the Communicator LLM API.
 * Provides 6 tools (bash, read, write, edit, glob, grep) and runs an
 * autonomous loop until the task is done or max turns reached.
 * Auto-compacts conversation when prompt tokens exceed threshold.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isGitCommand } from './executor.js';
import * as glob_tool from './tools/glob.js';
import * as grep_tool from './tools/grep.js';
import * as read_tool from './tools/read.js';
import * as write_tool from './tools/write.js';
import * as edit_tool from './tools/edit.js';
import * as bash_tool from './tools/bash.js';
/**
 * Extract a JSON object from an LLM response that may contain surrounding text.
 */
function extractJSON(raw) {
  const stripped = raw.trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }
  const fenceMatch = stripped.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }
  const start = stripped.indexOf('{');
  if (start !== -1) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < stripped.length; i++) {
      const ch = stripped[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth === 0) return JSON.parse(stripped.slice(start, i + 1));
    }
  }
  throw new Error('No valid JSON object found in response');
}

const BASH_TIMEOUT_MS = 120_000;
const BASH_MAX_BUFFER = 50 * 1024;
const COMPACTION_THRESHOLD = 100_000;

function buildSystemPrompt(projectPath, permissionMode, fileCache) {
  const readOnlyTools = `- read: Read a file. Args: { "path": "relative/or/absolute", "offset": 0, "limit": 200 }
  offset/limit are optional (line numbers, 1-based). Without them reads the whole file.
  File content appears in the "Open Files" section below, not in the tool result.
- glob: Find files by pattern. Args: { "pattern": "**/*.js", "path": "optional/subdir" }
- grep: Search file contents. Args: { "pattern": "regex", "path": "optional/subdir", "glob": "*.js" }
  path and glob are optional. Returns matching file paths by default.`;

  const writeTools = `- bash: Execute a shell command. Args: { "command": "npm test" }
  Runs in project root. 120s timeout.
- write: Create or overwrite a file. Args: { "path": "relative/path", "content": "file content" }
  Creates parent directories automatically.
- edit: Replace a unique string in a file. Args: { "path": "relative/path", "old_string": "exact text to find", "new_string": "replacement text" }
  old_string must appear exactly once in the file.`;

  const tools = permissionMode === 'plan'
    ? readOnlyTools
    : `${writeTools}\n${readOnlyTools}`;

  const modeNote = permissionMode === 'plan'
    ? '\nYou are in PLAN mode: only read/glob/grep are available. Explore the codebase and return a plan.'
    : '';

  let openFilesSection = '';
  if (fileCache && fileCache.size > 0) {
    const entries = [];
    for (const [filePath, cached] of fileCache) {
      entries.push(`### ${filePath} (${cached.lineCount} lines)\n\`\`\`\n${cached.displayContent}\n\`\`\``);
    }
    openFilesSection = `\n\n## Open Files\n\n${entries.join('\n\n')}`;
  }

  return `You are an autonomous coding agent working in project at ${projectPath}.
Return ONLY valid JSON. No explanation, no markdown fences, just a JSON object.

To call a tool: { "tool": "tool_name", "arguments": {...} }
When done: { "done": true, "summary": "what you accomplished" }

Available tools:
${tools}
${modeNote}
Rules:
- Never use emojis anywhere in code, comments, or output.
- For multi-step tasks, return one tool call at a time.
- File contents from read are provided in the "Open Files" section below. Re-reading a file updates that section.
- You MUST read a file before editing or overwriting it.
- Use relative paths from the project root when possible.

# Coding guidelines
- Do not propose changes to code you haven't read. Read and understand existing code before modifying it.
- Do not create files unless absolutely necessary. Prefer editing existing files to creating new ones.
- Avoid over-engineering. Only make changes that are directly requested or clearly necessary.
  - Don't add features, refactor code, or make "improvements" beyond what was asked.
  - Don't add docstrings, comments, or type annotations to code you didn't change. Only add comments where the logic isn't self-evident.
  - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries.
  - Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. Three similar lines of code is better than a premature abstraction.
- Never create documentation files (README, CHANGELOG, etc.) unless the task explicitly asks for them.
- Be careful about security: no hardcoded secrets, no eval() with user input, sanitize user input in web contexts, avoid command injection. If you notice insecure code, fix it immediately.
- Avoid backwards-compatibility hacks. If something is unused, delete it completely.
- For directed searches (specific file, specific pattern), use grep/glob directly. Use read for understanding code in context.
- If your approach fails, diagnose why before switching tactics. Read the error, check assumptions, try a focused fix. Don't retry the identical action blindly.${openFilesSection}`;
}

/**
 * Resolve a tool path argument against the project root.
 * Absolute paths are returned as-is; relative paths are joined with projectPath.
 */
function resolvePath(projectPath, filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(projectPath, filePath);
}

async function executeCodingTool(tool, args, projectPath, fileCache) {
  switch (tool) {
    case 'bash': {
      if (!args.command) return 'Error: missing "command" argument';
      if (isGitCommand(args.command)) return 'Error: git commands are not allowed in code tasks.';
      const result = await bash_tool.run({ command: args.command, timeout: BASH_TIMEOUT_MS });
      const parts = [
        `Exit code: ${result.exit_code}`,
        result.stdout ? `Output:\n${result.stdout}` : null,
        result.stderr ? `Stderr:\n${result.stderr}` : null,
      ].filter(Boolean);
      let output = parts.join('\n');
      if (output.length > BASH_MAX_BUFFER) {
        output = output.substring(0, BASH_MAX_BUFFER) + '\n... (truncated)';
      }
      return output;
    }

    case 'read': {
      if (!args.path) return 'Error: missing "path" argument';
      const fullPath = resolvePath(projectPath, args.path);
      const result = await read_tool.run({ file_path: fullPath, offset: args.offset, limit: args.limit });
      if (!result.success) return `Error reading file: ${result.error}`;
      // Populate file cache for the Open Files section
      const rawContent = await fs.readFile(fullPath, 'utf-8').catch(() => null);
      if (rawContent !== null) {
        fileCache.set(fullPath, { rawContent, displayContent: result.content, lineCount: result.total_lines });
      }
      return `File cached: ${args.path} (${result.total_lines} lines). Content is in the Open Files context section.`;
    }

    case 'write': {
      if (!args.path) return 'Error: missing "path" argument';
      if (args.content === undefined) return 'Error: missing "content" argument';
      const fullPath = resolvePath(projectPath, args.path);

      // Check file cache for read-before-write safety
      let fileExists = false;
      try {
        await fs.access(fullPath);
        fileExists = true;
      } catch { /* does not exist */ }

      if (fileExists && !fileCache.has(fullPath)) {
        return 'Error: you must read the file before overwriting it.';
      }

      if (fileExists && fileCache.has(fullPath)) {
        const diskContent = await fs.readFile(fullPath, 'utf-8');
        if (diskContent !== fileCache.get(fullPath).rawContent) {
          return 'Error: file was modified externally since last read. Read the file again to get the latest version.';
        }
      }

      const result = await write_tool.run({ file_path: fullPath, content: args.content });
      if (!result.success) return `Error writing file: ${result.error}`;

      // Update cache
      const newLines = args.content.split('\n');
      const displayContent = newLines.map((line, i) => `${i + 1}\t${line}`).join('\n');
      fileCache.set(fullPath, { rawContent: args.content, displayContent, lineCount: newLines.length });
      return `File written: ${args.path}`;
    }

    case 'edit': {
      if (!args.path) return 'Error: missing "path" argument';
      if (!args.old_string) return 'Error: missing "old_string" argument';
      if (args.new_string === undefined) return 'Error: missing "new_string" argument';
      const fullPath = resolvePath(projectPath, args.path);

      if (!fileCache.has(fullPath)) {
        return 'Error: you must read the file before editing it.';
      }

      const diskContent = await fs.readFile(fullPath, 'utf-8');
      if (diskContent !== fileCache.get(fullPath).rawContent) {
        return 'Error: file was modified externally since last read. Read the file again to get the latest version.';
      }

      const result = await edit_tool.run({ file_path: fullPath, old_string: args.old_string, new_string: args.new_string });
      if (!result.success) return `Error editing file: ${result.error}`;

      // Re-read and update cache
      const written = await fs.readFile(fullPath, 'utf-8');
      const newLines = written.split('\n');
      const displayContent = newLines.map((line, i) => `${i + 1}\t${line}`).join('\n');
      fileCache.set(fullPath, { rawContent: written, displayContent, lineCount: newLines.length });
      return `File edited: ${args.path}`;
    }

    case 'glob': {
      if (!args.pattern) return 'Error: missing "pattern" argument';
      const searchDir = args.path ? resolvePath(projectPath, args.path) : projectPath;
      const result = await glob_tool.run({ pattern: args.pattern, path: searchDir });
      if (!result.success) return `Error: ${result.error}`;
      if (result.files.length === 0) return 'No matches found';
      let output = result.files.join('\n');
      if (result.truncated) output += `\n[${result.count - result.files.length} more truncated]`;
      return output;
    }

    case 'grep': {
      if (!args.pattern) return 'Error: missing "pattern" argument';
      const searchDir = args.path ? resolvePath(projectPath, args.path) : projectPath;
      const result = await grep_tool.run({
        pattern: args.pattern,
        path: searchDir,
        include: args.glob || args.include
      });
      if (!result.success) return `Error: ${result.error}`;
      if (result.results.length === 0) return 'No matches found';
      const lines = result.results.map(r => `${r.file}:${r.line}:${r.content}`);
      if (result.truncated) lines.push(`[${result.total_matches - result.results.length} more truncated]`);
      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${tool}`;
  }
}

const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep']);

/**
 * Compact conversation history by asking the LLM to summarize it.
 * Preserves the system prompt and replaces all other messages with a summary.
 * @param {Array} messages - Current message array (mutated in place)
 * @param {Function} callLLM - LLM call function
 */
async function compactMessages(messages, callLLM) {
  // messages[0] is always the system prompt -- keep it
  const systemMsg = messages[0];
  const conversationMsgs = messages.slice(1);

  console.log(`[code-task] Compacting ${conversationMsgs.length} messages...`);

  const compactionMessages = [
    {
      role: 'system',
      content: `You are performing conversation compaction for an autonomous coding agent.
Produce a structured summary in plain text (not JSON).

## What was done
(Brief description of accomplished work: files read, created, edited, commands run, results)

## Current state
(What the agent was most recently working on, enough context to continue)

## Key findings
(Important paths, file contents, error messages, patterns discovered)

RULES:
- Preserve all file paths, variable names, error messages exactly
- Be concise but preserve all actionable context needed to continue the task
- Do NOT include raw file contents -- just summarize what was found`,
    },
    {
      role: 'user',
      content: `Here is the conversation to compact:\n\n${JSON.stringify(conversationMsgs)}`,
    },
  ];

  const { content: summary } = await callLLM(compactionMessages);

  // Replace all messages with: system prompt + compacted summary + continuation prompt
  messages.length = 0;
  messages.push(systemMsg);
  messages.push({
    role: 'user',
    content: `[Previous conversation summary]\n\n${summary}\n\nContinue with the task. Return the next tool call, or { "done": true, "summary": "..." } if complete.`,
  });

  console.log(`[code-task] Compaction complete (${summary.length} chars)`);
}

/**
 * Execute an autonomous coding task using the Communicator LLM API.
 * Auto-compacts conversation when prompt tokens exceed threshold.
 * @param {Object} options
 * @param {string} options.task - Detailed task description
 * @param {string} options.projectPath - Absolute path to project root
 * @param {Object} options.config - Code task configuration
 * @param {number} [options.config.codeTaskMaxTurns] - Max iterations (default 50)
 * @param {string} [options.config.codeTaskPermissionMode] - 'acceptEdits' or 'plan'
 * @param {Function} options.callLLM - LLM call function from PCAgent
 * @returns {Promise<string>} Summary of what was done
 */
export async function executeCodeTask({ task, projectPath, config, callLLM }) {
  const maxTurns = config.codeTaskMaxTurns || 50;
  const permissionMode = config.codeTaskPermissionMode || 'acceptEdits';
  const startTime = Date.now();

  console.log(`[code-task] Starting task at ${projectPath} (mode: ${permissionMode}, max turns: ${maxTurns})`);
  console.log(`[code-task] Task: ${task.substring(0, 200)}${task.length > 200 ? '...' : ''}`);

  const fileCache = new Map(); // path -> { rawContent, displayContent, lineCount }

  const messages = [
    { role: 'system', content: buildSystemPrompt(projectPath, permissionMode, fileCache) },
    { role: 'user', content: task },
  ];

  let finalSummary = '';
  let lastPromptTokens = 0;

  for (let i = 0; i < maxTurns; i++) {
    // Auto-compact if prompt tokens exceed threshold
    if (lastPromptTokens >= COMPACTION_THRESHOLD) {
      console.log(`[code-task] Prompt tokens (${lastPromptTokens}) exceeded threshold (${COMPACTION_THRESHOLD}), compacting...`);
      try {
        await compactMessages(messages, callLLM);
      } catch (err) {
        console.error(`[code-task] Compaction failed: ${err.message}, continuing with full history`);
      }
      lastPromptTokens = 0;
    }

    console.log(`[code-task] Turn ${i + 1}/${maxTurns}`);

    // Rebuild system prompt with current file cache
    messages[0] = { role: 'system', content: buildSystemPrompt(projectPath, permissionMode, fileCache) };

    const { content: llmResponse, usage } = await callLLM(messages);
    lastPromptTokens = usage?.prompt_tokens || lastPromptTokens;

    let parsed;
    try {
      parsed = extractJSON(llmResponse);
    } catch (err) {
      console.error(`[code-task] Failed to parse JSON from LLM response: ${llmResponse.substring(0, 500)}`);
      finalSummary = `Agent returned non-JSON response: ${llmResponse.substring(0, 1000)}`;
      break;
    }

    if (parsed.done) {
      finalSummary = parsed.summary || 'Done.';
      break;
    }

    if (!parsed.tool) {
      console.error('[code-task] LLM response missing tool field:', parsed);
      finalSummary = `Agent returned invalid response (no tool field): ${JSON.stringify(parsed).substring(0, 500)}`;
      break;
    }

    // Enforce plan mode restrictions
    if (permissionMode === 'plan' && !READ_ONLY_TOOLS.has(parsed.tool)) {
      messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
      messages.push({
        role: 'user',
        content: `Error: tool "${parsed.tool}" is not available in plan mode. Only read, glob, and grep are allowed. Explore the codebase and return your plan with { "done": true, "summary": "..." }.`,
      });
      continue;
    }

    console.log(`[code-task] Tool: ${parsed.tool}`, parsed.arguments || {});
    const toolResult = await executeCodingTool(parsed.tool, parsed.arguments || {}, projectPath, fileCache);

    // Truncate very large results
    const truncated = toolResult.length > 30000
      ? toolResult.substring(0, 30000) + '\n... (truncated)'
      : toolResult;

    messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
    messages.push({
      role: 'user',
      content: `Tool "${parsed.tool}" returned:\n${truncated}\n\nContinue with the next step, or return { "done": true, "summary": "..." } if the task is complete.`,
    });

    if (i === maxTurns - 1) {
      finalSummary = `Reached max turns (${maxTurns}). Last tool: ${parsed.tool}`;
    }
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[code-task] Completed in ${durationSec}s`);

  return finalSummary;
}
