/**
 * Command executor with safety checks.
 */

import { exec as execCb } from 'child_process';

/**
 * Check if a command's base command is git (stripping env vars and sudo).
 * @param {string} command
 * @returns {boolean}
 */
export function isGitCommand(command) {
  let base = command.trim();
  while (/^\w+=\S*\s/.test(base)) {
    base = base.replace(/^\w+=\S*\s+/, '');
  }
  if (base.startsWith('sudo ')) {
    base = base.substring(5).trim();
  }
  return base.split(/\s/)[0] === 'git';
}

export class CommandExecutor {
  /**
   * @param {Object} options
   * @param {string[]} options.allowedCommands - Allowed command prefixes
   * @param {string[]} options.blockedPatterns - Blocked dangerous patterns
   * @param {number} options.maxOutputLength - Max output length before truncation
   * @param {number} options.commandTimeoutMs - Command execution timeout in ms
   */
  constructor(options) {
    this.allowedCommands = options.allowedCommands;
    this.blockedPatterns = options.blockedPatterns;
    this.maxOutputLength = options.maxOutputLength;
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  /**
   * Validate a command against safety rules.
   * @param {string} command
   * @returns {{ valid: boolean, reason?: string }}
   */
  validate(command) {
    const trimmed = command.trim();

    // Check blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (trimmed.includes(pattern)) {
        return { valid: false, reason: `Command matches blocked pattern: "${pattern}"` };
      }
    }

    // Extract the base command (first word, ignoring env vars and sudo)
    let baseCommand = trimmed;

    // Strip leading env assignments (e.g. VAR=value command)
    while (/^\w+=\S*\s/.test(baseCommand)) {
      baseCommand = baseCommand.replace(/^\w+=\S*\s+/, '');
    }

    // Strip sudo prefix
    if (baseCommand.startsWith('sudo ')) {
      baseCommand = baseCommand.substring(5).trim();
    }

    const firstWord = baseCommand.split(/\s/)[0];

    // Check if the command starts with an allowed prefix
    const allowed = this.allowedCommands.some(prefix => firstWord === prefix);
    if (!allowed) {
      return { valid: false, reason: `Command "${firstWord}" is not in the allowed list` };
    }

    return { valid: true };
  }

  /**
   * Execute a shell command.
   * @param {string} command
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
   */
  async exec(command) {
    const validation = this.validate(command);
    if (!validation.valid) {
      return {
        stdout: '',
        stderr: `Rejected: ${validation.reason}`,
        exitCode: 1
      };
    }

    return new Promise((resolve) => {
      execCb(command, {
        timeout: this.commandTimeoutMs,
        maxBuffer: this.maxOutputLength * 2,
        shell: '/bin/bash'
      }, (error, stdout, stderr) => {
        let out = stdout || '';
        let err = stderr || '';

        // Truncate if needed
        if (out.length > this.maxOutputLength) {
          out = out.substring(0, this.maxOutputLength) + '\n... [output truncated]';
        }
        if (err.length > this.maxOutputLength) {
          err = err.substring(0, this.maxOutputLength) + '\n... [output truncated]';
        }

        resolve({
          stdout: out,
          stderr: err,
          exitCode: error ? (error.code || 1) : 0
        });
      });
    });
  }
}
