# pc-agent

A PC command agent that connects to an orchestrator over WebSocket and executes
work on the host machine on the orchestrator's behalf. It exposes a guarded set
of tools: shell command execution (allow/deny listed), file read/write/edit,
glob and grep search, a code-exploration tool backed by an LLM gateway, and
long-running "code task" sessions driven by the Claude Code CLI. It also runs a
small HTTP server (health check plus an `/api/v1/tg-upload` route that bounces
files such as test recordings to a Telegram chat).

The agent is built on the shared `@orchestrator/sdk` (vendored into `./sdk`,
see below).

## Prerequisites

- Node.js 20+ (the project uses ES modules and `node --watch`).
- A reachable orchestrator (WebSocket) and communicator/LLM gateway (HTTP).
- Telegram API credentials (`api_id` / `api_hash`) from
  https://my.telegram.org/apps, used for the file-bounce feature.
- Optional: the Claude Code CLI (`claude`) on `PATH` or pointed to via `CLAUDE_BIN`,
  required only for the remote code-session feature.
- `node-pty` and `sharp` build against native toolchains; on Linux ensure
  `build-essential`/`python3` are present for `npm install`.

## Setup

1. Copy the example environment file and fill in the values:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env`. The required variables are `API_KEY`, `TELEGRAM_API_ID`, and
   `TELEGRAM_API_HASH`. Every variable is documented inline in `.env.example`.
   Leave `TELEGRAM_SESSION` empty on the first run; the agent prints a QR code to
   log in and then writes the generated session string back into `.env`.

## Build

No compile step. Install dependencies (this also links the vendored SDK):

```bash
npm install
```

## Run

```bash
npm start
# or with auto-reload during development:
npm run dev
# or the convenience wrapper (installs deps then starts):
bash run.sh
```

On start the agent connects to `ORCHESTRATOR_URL`, registers itself, and begins
serving the health/upload HTTP server on `HEALTH_PORT`.

### Tests

```bash
npm test            # unit tests for the tool layer (no network)
npm run test:e2e    # end-to-end against a running orchestrator
```

The end-to-end tests require a running orchestrator and a populated `.env`
(`API_KEY`, `ORCHESTRATOR_URL`). They honour the optional `TEST_PROJECT_PATH`,
`PC_AGENT_PROJECT`, and `ORCH_HOST` environment variables; sensible
temp-directory and `localhost` defaults apply otherwise.

## Docker

```bash
docker build -t pc-agent .
docker run --env-file .env -p 10004:10004 pc-agent
```

The Dockerfile copies the vendored `sdk/` into the image and repoints the SDK
dependency automatically.

## Optional TLS / secure connectivity

The agent runs with **no certificate and no VPN by default**. To talk to an
orchestrator over plain WebSocket, set `ORCHESTRATOR_URL=ws://host:port` and you
are done.

To enable TLS:

- Set `ORCHESTRATOR_URL=wss://host:port`.
- Optionally set `NODE_EXTRA_CA_CERTS` to the absolute path of a CA certificate.
  When set (and the file exists), it is used to validate the orchestrator's
  certificate. When unset or missing, the connection still proceeds using the
  system trust store -- TLS is never *required* and a missing cert file never
  crashes the agent.

No certificate, key, or VPN file is bundled with this repo and none is needed to
run it.

## The vendored Orchestrator SDK (`./sdk`)

This repo depends on `@orchestrator/sdk`, referenced as `file:./sdk`. The `sdk/`
directory is a **point-in-time vendored snapshot** so the project builds and runs
standalone. The canonical source of truth is the `orchestrator` repository
(GitLab group `jaskier-os`, repo `orchestrator`, path `sdk/`). To update the
vendored copy, re-copy the SDK from there and re-run `npm install`.

## Notes on host configuration

All environment-specific values (hosts, ports, allowed directories, the Claude
Code binary path) are configurable via environment variables; nothing is
hardcoded to a particular machine. See `.env.example` for the full list.
