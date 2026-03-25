#!/usr/bin/env bash
set -euo pipefail

: "${DATASET_EXPORT_SINCE:?DATASET_EXPORT_SINCE is required}"
if [ ! -f runs/traces.jsonl ]; then
  echo "runs/traces.jsonl not found; dataset health check skipped."
  exit 0
fi

npm run export-dataset-v2 -- --since "$DATASET_EXPORT_SINCE"

set +e
npm run dataset-stats
STATS_EXIT=$?
set -e

if [ "$STATS_EXIT" -ne 0 ]; then
  npm run report-to-pm -- \
    --priority WARN \
    --metric "dataset-health=WARN (category < 10% or total < 200)" \
    --actions-url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" || true
fi

exit 0
