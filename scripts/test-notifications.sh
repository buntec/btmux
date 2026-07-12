#!/usr/bin/env bash
set -euo pipefail

# Sends one notification per hook event type btmux knows about, so the
# toast/dot design can be eyeballed for every level (info/attention/success/error)
# without waiting for a real Claude Code run to hit each one.
#
# Usage: scripts/test-notifications.sh [pane_id]
#   Uses $BTMUX_PANE_ID / $BTMUX_API_URL if set (already true inside a btmux
#   pane), otherwise pass a pane_id explicitly and it falls back to
#   http://127.0.0.1:8004 for the API URL.

PANE_ID="${1:-${BTMUX_PANE_ID:-}}"
API_URL="${BTMUX_API_URL:-http://127.0.0.1:8004}"

if [ -z "$PANE_ID" ]; then
  echo "error: no pane id. Run this from inside a btmux pane, or pass one: $0 <pane_id>" >&2
  exit 1
fi

send() {
  local desc="$1" payload="$2"
  echo "-> $desc"
  curl -sf -X POST "$API_URL/api/panes/$PANE_ID/notify" \
    -H 'Content-Type: application/json' \
    --data-binary "$payload" >/dev/null
  sleep 2
}

# level: attention
send "Stop" '{
  "hook_event_name": "Stop",
  "last_assistant_message": "Refactored the auth middleware and added tests for the token refresh path."
}'

# level: info
send "SubagentStop" '{
  "hook_event_name": "SubagentStop",
  "agent_type": "code-reviewer",
  "last_assistant_message": "Reviewed the diff, found two nit-level issues and one real bug in error handling."
}'

# level: error
send "StopFailure" '{
  "hook_event_name": "StopFailure",
  "error": "test failure",
  "last_assistant_message": "Ran the test suite after the change; 3 tests failed in the session module."
}'

# level: attention
send "PermissionRequest" '{
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {"command": "rm -rf node_modules && npm install"}
}'

# level: success
send "TaskCompleted" '{
  "hook_event_name": "TaskCompleted",
  "task_subject": "Add dark mode toggle",
  "task_description": "Added a theme switcher to the settings panel and persisted the choice to localStorage."
}'

# level: attention
send "Notification" '{
  "hook_event_name": "Notification",
  "title": "Waiting for input",
  "message": "Claude is waiting for your response to continue."
}'

echo "done: 6 notifications sent to pane $PANE_ID"
