#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "[pc-agent] Installing dependencies..."
npm install --silent

echo "[pc-agent] Starting agent (connects to orchestrator)..."
exec node src/index.js
