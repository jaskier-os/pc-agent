# pc-agent

> **Docs & wiki:** [github.com/jaskier-os/docs/wiki](https://github.com/jaskier-os/docs/wiki)

A PC-side agent that turns natural-language requests into shell commands and runs
them on the local host. It registers with the orchestrator over WebSocket and
exposes guarded tools: shell execution (allow/deny listed), file read/write/edit,
glob/grep, an LLM-backed explore tool, and long-running Claude Code "code task"
sessions. It also runs a small HTTP server (health plus an `/api/v1/tg-upload`
route that bounces files like test recordings to Telegram). Runs locally, not in
the cluster.

## Build / run

No compile step. Install deps and start:

```bash
npm install
cp .env.example .env   # then edit it
node src/index.js      # or: npm start, or: npm run dev (--watch)
```

`./run.sh` installs deps then starts. Tests:

```bash
npm test               # unit tests for the tool layer (no network)
npm run test:e2e       # against a running orchestrator
```

Docker (exposes port 10004 for health + tg-upload):

```bash
docker build -t pc-agent .
docker run --env-file .env -p 10004:10004 pc-agent
```

## Configuration

Config lives in environment variables. `.env.example` is the source of truth -
copy it to `.env` and edit; every var is documented inline.

Required: `API_KEY`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`. Leave
`TELEGRAM_SESSION` empty on first run - the agent prints a QR code to log in, then
writes the session string back into `.env`. `ORCHESTRATOR_URL` and
`COMMUNICATOR_URL` default to local plain connections. `REMOTE_SESSION_DIRS` and
`CLAUDE_BIN` control remote code sessions; `ALLOWED_COMMANDS` / `BLOCKED_PATTERNS`
are the execution guardrails.

## Dependencies

Node 20 (Docker uses `node:20-alpine`). `node-pty` and `sharp` build native
bindings, so a C/C++ toolchain + `python3` must be present for `npm install`.

`@orchestrator/sdk` is vendored under `./sdk` (referenced as `file:./sdk`) - a
point-in-time copy from the `orchestrator` repo (group `jaskier-os`, path `sdk/`).
To update, re-copy the SDK from there and re-run `npm install`.
