/**
 * PC Agent configuration with Joi validation.
 */

import Joi from 'joi';
import os from 'node:os';

const schema = Joi.object({
  ORCHESTRATOR_URL: Joi.string().uri().default('ws://localhost:10001'),
  COMMUNICATOR_URL: Joi.string().uri().default('http://localhost:10000'),
  API_KEY: Joi.string().required(),
  MODEL: Joi.string().default('sonnet'),
  ALLOWED_COMMANDS: Joi.string().default(
    'ls,dir,cat,head,tail,find,grep,echo,pwd,whoami,date,uname,df,free,top,ps,which,file,wc,sort,uniq,code,open,xdg-open,npm,node,python,python3,mkdir,curl,wget,cp,mv,touch,tee'
  ),
  BLOCKED_PATTERNS: Joi.string().default(
    'rm -rf /,rm -rf /*,mkfs,dd if=,:(){ :|:& };:,> /dev/sd,chmod -R 777 /,shutdown,reboot,halt,poweroff'
  ),
  MAX_OUTPUT_LENGTH: Joi.number().integer().positive().default(10000),
  COMMAND_TIMEOUT_MS: Joi.number().integer().positive().default(30000),
  HEALTH_PORT: Joi.number().integer().min(0).default(10004),
  TELEGRAM_API_ID: Joi.number().integer().required(),
  TELEGRAM_API_HASH: Joi.string().required(),
  TELEGRAM_SESSION: Joi.string().allow('').default(''),
  CODE_TASK_MAX_TURNS: Joi.number().integer().positive().default(50),
  CODE_TASK_PERMISSION_MODE: Joi.string().default('acceptEdits'),
  EXPLORE_MODEL: Joi.string().allow('').default(''),
  // Comma-separated list of directories the agent is allowed to open remote
  // code sessions in. Defaults to the current user's home directory.
  REMOTE_SESSION_DIRS: Joi.string().allow('').default(os.homedir()),
  // Absolute path to the Claude Code CLI binary used for remote code sessions.
  // If unset, the agent looks the binary up on PATH (`claude`).
  CLAUDE_BIN: Joi.string().allow('').default('')
}).unknown(true);

const { error, value } = schema.validate(process.env);

if (error) {
  console.error('[pc-agent] Configuration error:', error.message);
  process.exit(1);
}

export const config = {
  orchestratorUrl: value.ORCHESTRATOR_URL,
  communicatorUrl: value.COMMUNICATOR_URL,
  apiKey: value.API_KEY,
  model: value.MODEL,
  allowedCommands: value.ALLOWED_COMMANDS.split(',').map(s => s.trim()),
  blockedPatterns: value.BLOCKED_PATTERNS.split(',').map(s => s.trim()),
  maxOutputLength: value.MAX_OUTPUT_LENGTH,
  commandTimeoutMs: value.COMMAND_TIMEOUT_MS,
  healthPort: value.HEALTH_PORT,
  telegramApiId: value.TELEGRAM_API_ID,
  telegramApiHash: value.TELEGRAM_API_HASH,
  telegramSession: value.TELEGRAM_SESSION,
  codeTaskMaxTurns: value.CODE_TASK_MAX_TURNS,
  codeTaskPermissionMode: value.CODE_TASK_PERMISSION_MODE,
  exploreModel: value.EXPLORE_MODEL || value.MODEL,
  remoteSessionDirs: (value.REMOTE_SESSION_DIRS.trim() ? value.REMOTE_SESSION_DIRS : os.homedir())
    .split(',').map(s => s.trim()).filter(Boolean),
  claudeBin: value.CLAUDE_BIN
};
