import { ToolCallingClient } from '@orchestrator/sdk';
import * as glob_tool from './glob.js';
import * as grep_tool from './grep.js';
import * as read_tool from './read.js';
import * as bash_tool from './bash.js';

export const name = 'explore';
export const description = 'Explore a codebase to answer a question. Runs an autonomous read-only search loop using glob, grep, read, and bash (ls/find only). Returns a comprehensive answer. Use for questions about how things work, where things are defined, or codebase architecture.';
export const parameters = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'The question or exploration task about the codebase' },
    project_path: { type: 'string', description: 'Absolute path to the project root to explore' }
  },
  required: ['task', 'project_path']
};

const SAFE_COMMANDS = new Set(['ls', 'find', 'cat', 'head', 'tail', 'wc', 'file', 'stat']);

const EXPLORE_SYSTEM = `You are a codebase exploration specialist. You excel at thoroughly navigating and exploring codebases to answer questions.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no file creation of any kind)
- Modifying existing files (no edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Using redirect operators (>, >>, |) to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use glob to find files by name patterns (e.g., "**/*.js", "src/**/*.ts"). Returns matching file paths sorted by modification time.
- Use grep to search file contents with regex. Supports output modes: "content" (matching lines), "files_with_matches" (file paths only), "count" (match counts). Use case_insensitive flag and context lines when helpful.
- Use read when you know the specific file path you need to examine.
- Use bash ONLY for read-only operations: ls, find, cat, head, tail, wc, file, stat.
- NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification.
- Start broad: use glob to understand project structure, grep to find relevant patterns.
- Then narrow: read specific files that are most relevant.
- Check imports, exports, function signatures, class hierarchies.
- Check test files for usage examples.
- Read configuration files for project setup.
- Be thorough but efficient. Do not read entire large files when a targeted search suffices.
- Wherever possible, spawn multiple parallel tool calls for grepping and reading files to maximize speed.
- Return a structured, comprehensive answer with file paths and relevant code snippets.
- Never use emojis.`;

const EXPLORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'Find files matching a glob pattern. Returns matching file paths sorted by modification time.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.js", "src/**/*.ts")' },
          path: { type: 'string', description: 'Base directory to search from (default: project root)' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Search file contents with regex. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search in (default: project root)' },
          include: { type: 'string', description: 'Glob to filter files (e.g., "*.js")' },
          output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode (default: content)' },
          case_insensitive: { type: 'boolean', description: 'Case insensitive search' },
          context: { type: 'number', description: 'Lines of context around matches' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file. Returns content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          offset: { type: 'number', description: 'Start line (1-based)' },
          limit: { type: 'number', description: 'Max lines to read' }
        },
        required: ['file_path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run read-only bash command (ls, find, cat, head, tail, wc, file, stat ONLY)',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run' }
        },
        required: ['command']
      }
    }
  }
];

export async function run(params, context = {}) {
  const { task, project_path } = params;
  const { communicatorUrl, apiKey, model } = context;

  if (!task) return { success: false, error: 'Missing "task" argument' };
  if (!project_path) return { success: false, error: 'Missing "project_path" argument' };
  if (!communicatorUrl) return { success: false, error: 'Missing communicator configuration' };

  const client = new ToolCallingClient({ communicatorUrl, apiKey, model });

  const toolExecutor = async (toolName, input) => {
    switch (toolName) {
      case 'glob': {
        const result = await glob_tool.run({ pattern: input.pattern, path: input.path || project_path });
        if (!result.success) return `Error: ${result.error}`;
        if (result.files.length === 0) return 'No files matched.';
        let output = result.files.join('\n');
        if (result.truncated) output += `\n[${result.count - result.files.length} more files truncated]`;
        return output;
      }
      case 'grep': {
        const result = await grep_tool.run({
          pattern: input.pattern,
          path: input.path || project_path,
          include: input.include,
          output_mode: input.output_mode,
          case_insensitive: input.case_insensitive,
          context: input.context
        });
        if (!result.success) return `Error: ${result.error}`;
        if (input.output_mode === 'files_with_matches') {
          if (result.files.length === 0) return 'No matches found.';
          return result.files.join('\n');
        }
        if (input.output_mode === 'count') {
          if (!result.counts || result.counts.length === 0) return 'No matches found.';
          return result.counts.map(c => `${c.file}: ${c.count}`).join('\n');
        }
        // Default: content mode
        if (result.results.length === 0) return 'No matches found.';
        const lines = result.results.map(r => `${r.file}:${r.line}:${r.content}`);
        if (result.truncated) lines.push(`[${result.total_matches - result.results.length} more truncated]`);
        return lines.join('\n');
      }
      case 'read': {
        const result = await read_tool.run({ file_path: input.file_path, offset: input.offset, limit: input.limit });
        if (!result.success) return `Error: ${result.error}`;
        return result.content;
      }
      case 'bash': {
        const cmd = input.command.trim();
        const firstWord = cmd.split(/\s/)[0];
        if (!SAFE_COMMANDS.has(firstWord)) {
          return `Error: only read-only commands allowed: ${[...SAFE_COMMANDS].join(', ')}`;
        }
        // Reject shell chaining/injection attempts
        if (/[;|&`]|\$\(/.test(cmd) || /\b(rm|mv|cp|mkdir|touch|chmod|chown|tee)\b/.test(cmd)) {
          return 'Error: command contains disallowed operators or commands. Only simple read-only commands are allowed.';
        }
        const result = await bash_tool.run({ command: input.command, timeout: 15000 });
        if (!result.success) return `Error: ${result.stderr || result.error}`;
        return result.stdout || '(no output)';
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  };

  const messages = [
    { role: 'system', content: EXPLORE_SYSTEM },
    { role: 'user', content: `Project path: ${project_path}\n\nTask: ${task}` }
  ];

  try {
    const result = await client.execute({
      messages,
      tools: EXPLORE_TOOLS,
      toolExecutor,
      maxRounds: 15,
      maxTokens: 8192
    });

    return {
      success: true,
      answer: result.text,
      rounds: result.rounds,
      tool_calls: result.toolCallCount
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
