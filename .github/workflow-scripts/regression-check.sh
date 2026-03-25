#!/usr/bin/env bash
set +e

: "${REGRESSION_HEALTH_SINCE:?REGRESSION_HEALTH_SINCE is required}"
npm run analyze-language-health -- --since "$REGRESSION_HEALTH_SINCE"
HEALTH_EXIT=$?

if [ "$HEALTH_EXIT" -ne 0 ]; then
  BISECT_OUT=$(npm run blame-mode-bisect 2>&1 || true)
  echo "$BISECT_OUT"
  BLAME_SHA=$(echo "$BISECT_OUT" | grep -o '"blame_sha": "[^"]*"' | head -1 | sed 's/"blame_sha": "\([^"]*\)"/\1/' || true)
  BLAME_MSG=$(echo "$BISECT_OUT" | grep -o '"blame_message": "[^"]*"' | head -1 | sed 's/"blame_message": "\([^"]*\)"/\1/' || true)
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
