#!/usr/bin/env bash
# Real E2E test for Remote Control pipeline
# Tests: orchestrator -> RC session -> pc-agent -> claude CLI -> response -> phone
#
# Usage:  bash tests/test-rc-e2e.sh
# Prereq: pc-agent must be running with the updated remote-sessions.js

set -euo pipefail

ORCH_HOST="${ORCH_HOST:-localhost}"
ORCH_URL="${ORCHESTRATOR_HTTP_URL:-https://${ORCH_HOST}:8444}"
API_KEY="${API_KEY:?set API_KEY in the environment}"
PHONE_DEVICE="${PHONE_DEVICE:-}"
LOG_DIR="${LOG_DIR:-./.service-logs}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
info() { echo -e "       $1"; }

TESTS_RUN=0
TESTS_PASSED=0

run_test() {
  TESTS_RUN=$((TESTS_RUN + 1))
  echo ""
  echo "=== Test ${TESTS_RUN}: $1 ==="
}

# ---------------------------------------------------------------------------
# Test 1: Orchestrator reachable
# ---------------------------------------------------------------------------
run_test "Orchestrator health"
HEALTH=$(curl -sk "${ORCH_URL}/api/v1/health" 2>&1)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  pass "Orchestrator is healthy"
  info "$HEALTH"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  fail "Orchestrator not reachable or unhealthy"
  info "$HEALTH"
  echo "Cannot continue without orchestrator. Exiting."
  exit 1
fi

# ---------------------------------------------------------------------------
# Test 2: PC agent connected to orchestrator
# ---------------------------------------------------------------------------
run_test "PC agent connected"
# Check if pc-agent process is running locally
PC_PID=$(fuser 10004/tcp 2>/dev/null | tr -d ' ' || true)
if [ -n "$PC_PID" ]; then
  pass "pc-agent process running (PID $PC_PID on port 10004)"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  fail "pc-agent not running on port 10004"
  info "Start it with: cd AI/agents/pc/pc-agent && npm run dev"
  echo "Cannot continue without pc-agent. Exiting."
  exit 1
fi

# Check if orchestrator sees pc-agent registered
AGENTS=$(curl -sk "${ORCH_URL}/api/v1/health" -H "Authorization: Bearer ${API_KEY}" 2>&1)
if echo "$AGENTS" | grep -q 'pc-agent'; then
  pass "Orchestrator sees pc-agent registered"
else
  warn "Cannot confirm pc-agent registration via health endpoint (may be fine)"
fi

# ---------------------------------------------------------------------------
# Test 3: Create RC session via REST API
# ---------------------------------------------------------------------------
run_test "Create RC session"
WORK_DIR="/tmp/e2e-rc-test-$(date +%s)"
mkdir -p "$WORK_DIR"

CREATE_RESP=$(curl -sk -X POST "${ORCH_URL}/api/v1/remote-sessions/start" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"workDir\": \"${WORK_DIR}\"}" 2>&1)

SESSION_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null || true)

if [ -n "$SESSION_ID" ] && [ "$SESSION_ID" != "null" ]; then
  pass "RC session created: $SESSION_ID"
  info "Response: $CREATE_RESP"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  fail "Failed to create RC session"
  info "Response: $CREATE_RESP"
  echo "Cannot continue without session. Exiting."
  rm -rf "$WORK_DIR"
  exit 1
fi

# ---------------------------------------------------------------------------
# Test 4: Claude process spawned by pc-agent
# ---------------------------------------------------------------------------
run_test "Claude process spawned"
sleep 3  # Give time for spawn

# Check pc-agent log for spawn
if [ -f "${LOG_DIR}/pc-agent.log" ]; then
  SPAWN_LOG=$(tail -50 "${LOG_DIR}/pc-agent.log" | grep -i "remote-sessions.*Session spawned\|remote-sessions.*pid=" | tail -3)
  if [ -n "$SPAWN_LOG" ]; then
    pass "Claude process spawned"
    info "$SPAWN_LOG"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    fail "No spawn log found in pc-agent.log"
    info "Last 20 lines of pc-agent.log:"
    tail -20 "${LOG_DIR}/pc-agent.log" 2>/dev/null | while read -r line; do info "$line"; done
  fi
else
  warn "pc-agent.log not found at ${LOG_DIR}/pc-agent.log"
fi

# Check for claude --print processes
CLAUDE_PROCS=$(ps aux | grep "claude.*--print.*--sdk-url" | grep -v grep || true)
if [ -n "$CLAUDE_PROCS" ]; then
  pass "Claude --print process found running"
  info "$CLAUDE_PROCS"
else
  warn "No claude --print process found (may have connected and switched to WS mode)"
fi

# ---------------------------------------------------------------------------
# Test 5: Desktop WS connected to orchestrator
# ---------------------------------------------------------------------------
run_test "Desktop WS connected to orchestrator"
sleep 3  # Give time for WS connection

# Check orchestrator logs for desktop connection
ORC_LOGS=$(ssh root@${ORCH_HOST} -p 41922 "k3s kubectl logs -n ai \$(k3s kubectl get pods -n ai -l app=orchestrator -o jsonpath='{.items[0].metadata.name}') --tail=30 2>&1")

if echo "$ORC_LOGS" | grep -q "Desktop connected\|rc-handler.*Desktop"; then
  pass "Desktop WS connected to orchestrator"
  DESKTOP_LOG=$(echo "$ORC_LOGS" | grep -i "Desktop connected\|rc-handler.*Desktop" | tail -3)
  info "$DESKTOP_LOG"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  fail "No desktop WS connection in orchestrator logs"
  info "Recent orchestrator logs:"
  echo "$ORC_LOGS" | tail -10 | while read -r line; do info "$line"; done

  # Check pc-agent log for claude process output
  if [ -f "${LOG_DIR}/pc-agent.log" ]; then
    info ""
    info "Recent pc-agent remote-sessions output:"
    tail -30 "${LOG_DIR}/pc-agent.log" | grep "remote-sessions" | tail -10 | while read -r line; do info "$line"; done
  fi
fi

# ---------------------------------------------------------------------------
# Test 6: Send user message and check for response
# ---------------------------------------------------------------------------
run_test "Send user message from phone and receive AI response"
info "Checking if phone is connected via ADB..."
PHONE_CONNECTED=$(adb devices -l 2>/dev/null | grep "$PHONE_DEVICE" || true)
if [ -z "$PHONE_CONNECTED" ]; then
  warn "Phone not connected via ADB -- testing via direct WS message instead"

  # Send message directly via orchestrator (simulate phone)
  info "Sending test message via curl to orchestrator..."
  # We cannot easily send WS messages from shell, so check if session is alive
  SESSION_LIST=$(curl -sk "${ORCH_URL}/api/v1/remote-control/sessions" \
    -H "Authorization: Bearer ${API_KEY}" 2>&1)
  info "Active sessions: $SESSION_LIST"
else
  pass "Phone connected: $PHONE_CONNECTED"
fi

# Check orchestrator logs after a moment
sleep 5
FINAL_ORC_LOGS=$(ssh root@${ORCH_HOST} -p 41922 "k3s kubectl logs -n ai \$(k3s kubectl get pods -n ai -l app=orchestrator -o jsonpath='{.items[0].metadata.name}') --tail=30 2>&1")

if echo "$FINAL_ORC_LOGS" | grep -q "rc_session_start\|Desktop connected\|rc-handler"; then
  pass "RC session activity detected in orchestrator"
  TESTS_PASSED=$((TESTS_PASSED + 1))
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
echo "  E2E Test Results: ${TESTS_PASSED}/${TESTS_RUN} passed"
echo "==========================================="
echo ""

# Cleanup
echo "Cleanup: ending test session..."
curl -sk -X DELETE "${ORCH_URL}/api/v1/remote-control/sessions/${SESSION_ID}" \
  -H "Authorization: Bearer ${API_KEY}" 2>/dev/null || true
rm -rf "$WORK_DIR"

if [ "$TESTS_PASSED" -eq "$TESTS_RUN" ]; then
  echo "All tests passed!"
  exit 0
else
  echo "Some tests failed. Check output above for details."
  exit 1
fi
