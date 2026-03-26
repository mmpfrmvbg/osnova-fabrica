#!/usr/bin/env bash
set -euo pipefail

npm --prefix apps/osiris ci --no-audit

npm run typecheck
npm test
npm run lint
npx tsx src/scripts/check-yaml-drift.ts
OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run golden
npm run validate:spec
OSNOVA_STORAGE_ROOT=/tmp/osnova-storage-ci npm run coverage
