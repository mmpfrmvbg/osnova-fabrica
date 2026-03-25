#!/usr/bin/env bash
set -euo pipefail

npm --prefix apps/osiris ci

if ! command -v shellcheck >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y shellcheck
fi

shellcheck .github/workflow-scripts/*.sh

npm run typecheck
npm test
npm run lint
npx tsx src/scripts/check-yaml-drift.ts
OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run golden
npm run validate:spec
OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run coverage
