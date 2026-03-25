#!/usr/bin/env bash
set -euo pipefail

npm --prefix apps/osiris install --no-audit

if ! command -v shellcheck >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y shellcheck
fi

if ! command -v actionlint >/dev/null 2>&1; then
  if ! command -v go >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y golang-go
  fi
  export PATH="$PATH:$(go env GOPATH)/bin"
  go install github.com/rhysd/actionlint/cmd/actionlint@latest
fi

shellcheck .github/workflow-scripts/*.sh
actionlint -color

npm run typecheck
npm test
npm run lint
npx tsx src/scripts/check-yaml-drift.ts
OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run golden
npm run validate:spec
OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run coverage
