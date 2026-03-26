#!/usr/bin/env bash
set -euo pipefail

: "${REGRESSION_HEALTH_SINCE:?REGRESSION_HEALTH_SINCE is required}"
HEALTH_EXIT=0
npm run analyze-language-health -- --since "$REGRESSION_HEALTH_SINCE" || HEALTH_EXIT=$?

if [ "$HEALTH_EXIT" -ne 0 ]; then
  BISECT_OUT=$(npm run blame-mode-bisect 2>&1 || true)
  echo "$BISECT_OUT"
  BLAME_SHA="$(
    BISECT_OUT="$BISECT_OUT" node -e '
      const out = process.env.BISECT_OUT || "";
      const m = out.match(/"blame_sha"\s*:\s*"([^"]+)"/);
      if (m) process.stdout.write(m[1]);
    '
  )"
  BLAME_MSG="$(
    BISECT_OUT="$BISECT_OUT" node -e '
      const out = process.env.BISECT_OUT || "";
      const m = out.match(/"blame_message"\s*:\s*"([^"]+)"/);
      if (m) process.stdout.write(m[1]);
    '
  )"
  ACTIONS_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
  REPORT_ARGS=(npm run report-to-pm -- --priority CRITICAL --stop-factory --actions-url "$ACTIONS_URL")
  if [ -n "$BLAME_SHA" ]; then
    REPORT_ARGS+=(--blame-sha "$BLAME_SHA")
  fi
  if [ -n "$BLAME_MSG" ]; then
    REPORT_ARGS+=(--blame-message "$BLAME_MSG")
  fi
  "${REPORT_ARGS[@]}"
fi

exit "$HEALTH_EXIT"
