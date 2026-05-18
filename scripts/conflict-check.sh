#!/bin/sh
SYNC_DIR="$HOME/.claude/context-sync"
TOUCHED_DIR="$SYNC_DIR/touched"
MESSAGES_DIR="$SYNC_DIR/messages"
REPORTED_FILE="$SYNC_DIR/reported-conflicts.json"
PROJECT_DIR="$(pwd)"

command -v jq >/dev/null 2>&1 || exit 0

OUTPUT=""

# --- Conflict detection ---
if [ -d "$TOUCHED_DIR" ]; then
  CURRENT=$(
    cat "$TOUCHED_DIR"/*.json 2>/dev/null \
    | jq -rs --arg project "$PROJECT_DIR" '
      [.[] | select(.project == $project)] |
      if length < 2 then [] else
        [ .[] | {sessionId, files: [.files[] | select(startswith($project + "/"))][]} ] |
        group_by(.files) |
        [ .[] | select(([.[].sessionId] | unique | length) >= 2) | .[0].files | sub($project + "/"; "") ]
      end
    ' 2>/dev/null
  )

  if [ -n "$CURRENT" ] && [ "$CURRENT" != "[]" ]; then
    REPORTED="[]"
    [ -f "$REPORTED_FILE" ] && REPORTED=$(cat "$REPORTED_FILE" 2>/dev/null || echo "[]")

    NEW=$(echo "$CURRENT" | jq -r --argjson reported "$REPORTED" '
      [.[] | select(. as $f | $reported | index($f) | not)]
    ')

    if [ -n "$NEW" ] && [ "$NEW" != "[]" ]; then
      echo "$CURRENT" > "$REPORTED_FILE"
      OUTPUT="⚠️ 충돌 감지:"
      CONFLICT_LIST=$(echo "$NEW" | jq -r '.[]')
      while IFS= read -r file; do
        OUTPUT="$OUTPUT
  - $file"
      done <<< "$CONFLICT_LIST"
    fi
  fi
fi

# --- Message detection ---
MY_SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
MY_MSG_DIR="$MESSAGES_DIR/$MY_SESSION_ID"

if [ -n "$MY_SESSION_ID" ] && [ -d "$MY_MSG_DIR" ]; then
  for msg_file in "$MY_MSG_DIR"/*.json; do
    [ -f "$msg_file" ] || continue
    IS_UNREAD=$(jq -r 'select(.read == false and .project == $project) | .message' --arg project "$PROJECT_DIR" "$msg_file" 2>/dev/null)
    if [ -n "$IS_UNREAD" ]; then
      FROM=$(jq -r '.from' "$msg_file" 2>/dev/null)
      SHORT_FROM=$(echo "$FROM" | cut -c1-8)
      if [ -z "$OUTPUT" ]; then
        OUTPUT="📨 새 메시지 (from: ${SHORT_FROM}...): $IS_UNREAD"
      else
        OUTPUT="$OUTPUT
📨 새 메시지 (from: ${SHORT_FROM}...): $IS_UNREAD"
      fi
      jq '.read = true' "$msg_file" > "$msg_file.tmp" && mv "$msg_file.tmp" "$msg_file"
    fi
  done
fi

if [ -n "$OUTPUT" ]; then
  echo "$OUTPUT"
fi
