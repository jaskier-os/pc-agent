# CLAUDE.md -- pc-agent

This file provides guidance to Claude Code when working in this repository.

IMPORTANT: NEVER USE EMOJIS ANYWHERE IN LOGGING, CODE OR OTHER TEXT!

IMPORTANT: Treat this codebase as work in progress. Never do backwards-compatibility or legacy support unless explicitly asked to. Remove code that becomes redundant.

## What this is

A PC-side agent that turns natural-language requests into shell commands and runs them on the local host. It registers with the orchestrator over WebSocket and exposes guarded tools: shell execution (allow/deny listed), file read/write/edit, glob/grep, an LLM-backed explore tool, and long-running Claude Code "code task" sessions. It also runs a small HTTP server (health plus an `/api/v1/tg-upload` route that bounces files like test recordings to Telegram). Health endpoint on port 10004.

IMPORTANT: this agent runs LOCALLY on a PC, NOT in the Kubernetes cluster. It connects OUTBOUND to the orchestrator over WebSocket (the orchestrator pushes tasks back). There is no Flux/CI deploy for it; you start it by hand on the machine that should run the commands.

It is one of several agents behind the orchestrator. For the whole-system map -- architecture, the agent protocol, full port allocation, and every service -- see the `jaskier-os/orchestrator` repo's CLAUDE.md / docs. Don't duplicate that here.

## Key files

- `src/index.js` -- entry point (starts the agent + the health/tg-upload HTTP server)
- `src/agent.js` -- PCAgent (extends BaseAgent from the vendored SDK)
- `src/executor.js` -- CommandExecutor: validation against `ALLOWED_COMMANDS` / `BLOCKED_PATTERNS` then execution
- `src/code_task.js`, `src/remote-sessions.js` -- long-running Claude Code sessions
- `src/telegram.js` -- Telegram integration (tg-upload)
- `src/tools/` -- tool implementations
- `sdk/` -- vendored `@orchestrator/sdk`

## Build / run

No compile step. `npm install` then `node src/index.js` (or `npm start` / `npm run dev`). `./run.sh` installs deps then starts. Tests: `npm test` (unit, no network), `npm run test:e2e` (against a running orchestrator).

Config is env vars; `.env.example` is the source of truth. Required: `API_KEY`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`. Leave `TELEGRAM_SESSION` empty on first run (the agent prints a QR code, then writes the session string back into `.env`). `ORCHESTRATOR_URL` / `COMMUNICATOR_URL` default to local. `ALLOWED_COMMANDS` / `BLOCKED_PATTERNS` are the execution guardrails -- be careful loosening them.

Node 20. `node-pty` and `sharp` build native bindings, so a C/C++ toolchain + `python3` must be present for `npm install`.

## Vendored SDK

`@orchestrator/sdk` is vendored under `./sdk` (referenced as `file:./sdk`) -- a point-in-time copy from the `jaskier-os/orchestrator` repo (`sdk/` path). To update: re-copy the SDK from there and re-run `npm install`. Do not edit the vendored copy as a fork.

## Rules

- `main` is protected; normal (non-force) commits by Maintainers are fine. NEVER force-push.
