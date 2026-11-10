#!/bin/sh
# Локальный прогон того же контура, что в GitVerse CI.
#
#   sh scripts/ci-local.sh              L1: lock, сторож CI, build, полный npm run ci
#   sh scripts/ci-local.sh --qemu       L1 + L2 QEMU (нужен Windows/WSL с qemu-e2k)
#   sh scripts/ci-local.sh --hardware   L1 + L3 E8C2 (нужны E2K_HOST/E2K_USER/SSH_KEY_PATH)
#   sh scripts/ci-local.sh --all        L1 + L2 + L3
#
# Скрипт ничего не скрывает: любой красный шаг останавливает прогон.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WITH_QEMU=0
WITH_HARDWARE=0

for arg in "$@"; do
  case "$arg" in
    --qemu) WITH_QEMU=1 ;;
    --hardware) WITH_HARDWARE=1 ;;
    --all) WITH_QEMU=1; WITH_HARDWARE=1 ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "ci-local: неизвестный аргумент: $arg" >&2
      exit 2
      ;;
  esac
done

cd "$ROOT"

echo "ci-local: npm ci"
npm ci --no-audit --no-fund

echo "ci-local: npm run check:ci"
npm run check:ci

echo "ci-local: npm run build"
npm run build

echo "ci-local: npm run ci"
npm run ci

if [ "$WITH_QEMU" -eq 1 ]; then
  echo "ci-local: npm run gate:qemu"
  npm run gate:qemu
fi

if [ "$WITH_HARDWARE" -eq 1 ]; then
  : "${E2K_HOST:?E2K_HOST не задан}"
  : "${E2K_USER:?E2K_USER не задан}"
  : "${SSH_KEY_PATH:?SSH_KEY_PATH не задан}"
  echo "ci-local: E8C2 $E2K_HOST"
  sh tools/e2k-hardware/ci-run.sh
fi

echo "ci-local: зелёный"
