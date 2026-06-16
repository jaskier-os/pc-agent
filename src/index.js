import 'dotenv/config';
import { setupProxy } from '@orchestrator/sdk/proxy';

import { config } from './config.js';
import { CommandExecutor } from './executor.js';
import { PCAgent } from './agent.js';
import * as telegram from './telegram.js';

// Swallow spurious gramjs TIMEOUT rejections. The Telegram client's
// internal update loop routinely throws Error: TIMEOUT as a normal
// idle event; when left unhandled, the rejection metadata accumulates
// and eventually OOMs the V8 heap (observed: ~4GB over days of uptime,
// triggering SIGABRT and a systemd restart loop).
let lastRejectionLogAt = 0;
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg === 'TIMEOUT' || (typeof msg === 'string' && msg.includes('TIMEOUT'))) {
    return;
  }
  const now = Date.now();
  if (now - lastRejectionLogAt > 60000) {
    lastRejectionLogAt = now;
    console.error('[pc-agent] unhandledRejection:', msg);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[pc-agent] uncaughtException:', err?.stack || err?.message || err);
  process.exit(1);
});

console.log('[pc-agent] Starting');

const proxyResult = await setupProxy('pc-agent');
const socksProxy = proxyResult?.socksProxy || null;

console.log(`[pc-agent] Orchestrator: ${config.orchestratorUrl}`);
console.log(`[pc-agent] Communicator: ${config.communicatorUrl}`);
console.log(`[pc-agent] Allowed commands: ${config.allowedCommands.join(', ')}`);

const executor = new CommandExecutor({
  allowedCommands: config.allowedCommands,
  blockedPatterns: config.blockedPatterns,
  maxOutputLength: config.maxOutputLength,
  commandTimeoutMs: config.commandTimeoutMs
});

const agent = new PCAgent({
  orchestratorUrl: config.orchestratorUrl,
  communicatorUrl: config.communicatorUrl,
  apiKey: config.apiKey,
  model: config.model,
  healthPort: config.healthPort,
  executor,
  telegram,
  remoteSessionDirs: config.remoteSessionDirs,
  remoteSessionBin: config.remoteSessionBin,
  exploreModel: config.exploreModel,
  codeTaskConfig: {
    claudeCodeExecutable: config.claudeCodeExecutable,
    codeTaskMaxTurns: config.codeTaskMaxTurns,
    codeTaskMaxBudgetUsd: config.codeTaskMaxBudgetUsd,
    codeTaskPermissionMode: config.codeTaskPermissionMode,
  }
});

await agent.start();

// Hook remote session cleanup into graceful shutdown
const origSigint = process.listeners('SIGINT').slice(-1)[0];
const origSigterm = process.listeners('SIGTERM').slice(-1)[0];

function shutdownRemoteSessions() {
  agent.remoteSessionManager.shutdownAll();
}

process.removeAllListeners('SIGINT');
process.removeAllListeners('SIGTERM');

process.on('SIGINT', () => {
  shutdownRemoteSessions();
  if (origSigint) origSigint();
});
process.on('SIGTERM', () => {
  shutdownRemoteSessions();
  if (origSigterm) origSigterm();
});

console.log('[pc-agent] Agent started and connected to orchestrator');
console.log(`[pc-agent] Remote session dirs: ${config.remoteSessionDirs.join(', ')}`);

// Manage Telegram lifecycle: init with retry + monitor for mid-session disconnects
const TELEGRAM_RETRY_MS = 5 * 60 * 1000;
const TELEGRAM_CHECK_MS = 30 * 1000;

(async function manageTelegram() {
  const telegramOpts = {
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    session: config.telegramSession,
    socksProxy,
  };
  while (true) {
    if (!telegram.isReady()) {
      try {
        await telegram.initialize(telegramOpts);
        console.log('[pc-agent] Telegram ready');
      } catch (err) {
        console.error('[pc-agent] Telegram init failed:', err.message);
      }
    }
    await new Promise(r => setTimeout(r, telegram.isReady() ? TELEGRAM_CHECK_MS : TELEGRAM_RETRY_MS));
  }
})();
