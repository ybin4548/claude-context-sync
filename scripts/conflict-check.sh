#!/bin/sh
TOUCHED_DIR="$HOME/.claude/context-sync/touched"
REPORTED_FILE="$HOME/.claude/context-sync/reported-conflicts.json"
PROJECT_DIR="$(pwd)"

[ -d "$TOUCHED_DIR" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

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

[ -z "$CURRENT" ] && exit 0
[ "$CURRENT" = "[]" ] && exit 0

REPORTED="[]"
[ -f "$REPORTED_FILE" ] && REPORTED=$(cat "$REPORTED_FILE" 2>/dev/null || echo "[]")

NEW=$(echo "$CURRENT" | jq -r --argjson reported "$REPORTED" '
  [.[] | select(. as $f | $reported | index($f) | not)]
')

[ -z "$NEW" ] && exit 0
[ "$NEW" = "[]" ] && exit 0

echo "$CURRENT" > "$REPORTED_FILE"

echo "⚠️ 충돌 감지:"
echo "$NEW" | jq -r '.[]' | while IFS= read -r file; do
  echo "  - $file"
done
