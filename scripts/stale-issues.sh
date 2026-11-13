#!/usr/bin/env bash
set -euo pipefail

# Помечает stale issue, у которых updatedAt старше DAYS дней (по умолчанию 90).
# Повторный запуск не дублирует метку. DRY_RUN=1 — только показать номера.
# Требует: gh (авторизован), jq.

DAYS="${1:-90}"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh not found" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found" >&2
  exit 1
fi

numbers="$(
  gh issue list --state open --limit 1000 \
    --json number,updatedAt,labels \
  | jq -r --argjson days "$DAYS" '
      (now - ($days * 86400)) | strftime("%Y-%m-%dT%H:%M:%SZ") as $cutoff
      | .[]
      | select(.updatedAt < $cutoff)
      | select((.labels | map(.name) | index("stale")) | not)
      | .number
    '
)"

if [ "${DRY_RUN:-0}" = "1" ]; then
  printf '%s\n' "$numbers" | sed '/^$/d'
  exit 0
fi

count=0
while IFS= read -r n; do
  [ -z "$n" ] && continue
  gh issue edit "$n" --add-label stale
  count=$((count + 1))
done <<< "$numbers"

echo "stale: $count issue(s) older than ${DAYS} days"
