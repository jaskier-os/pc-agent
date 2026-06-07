import { exec } from 'child_process';

export const name = 'bash';
export const description = 'Execute a shell command on the system. Returns stdout, stderr, and exit code. Use for system operations, running scripts, installing packages, etc.';
export const parameters = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The bash command to execute' },
    timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000, max: 300000)' }
  },
  required: ['command']
};

const MAX_OUTPUT = 100 * 1024;

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + '\n[output truncated]';
}

export async function run(params) {
  const { command } = params;
  const timeout = Math.min(params.timeout || 30000, 300000);

  return new Promise((resolve) => {
    exec(command, { shell: '/bin/bash', timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const timed_out = error?.killed || false;
      const exit_code = error ? error.code || 1 : 0;
      resolve({
        success: exit_code === 0,
        stdout: truncate(stdout, MAX_OUTPUT) || '',
        stderr: truncate(stderr, MAX_OUTPUT) || '',
        exit_code,
        timed_out
      });
    });
  });
}
