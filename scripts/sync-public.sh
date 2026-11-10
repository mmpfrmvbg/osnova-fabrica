#!/bin/sh
# Синхронизация публичной витрины из приватного дерева.
#
# Витрина — не копия приватного репозитория. Публичный набор файлов задан
# манифестом самого публичного репозитория: скрипт обновляет только те пути,
# которые уже опубликованы. Новые исходники, тесты, внутренние документы и
# инструменты в публичный репозиторий этим скриптом не добавляются.
#
# Режимы:
#   sh scripts/sync-public.sh              показать diff, ничего не запускать
#   sh scripts/sync-public.sh --check      собрать копию и прогнать npm run gate
#   sh scripts/sync-public.sh --push       то же и запушить в public master
#
# PUBLIC_DIR по умолчанию — ../osnova-public.
set -eu

MODE=dry
case "${1:-}" in
  '') ;;
  --check) MODE=check ;;
  --push) MODE=push ;;
  -h|--help)
    sed -n '2,18p' "$0"
    exit 0
    ;;
  *)
    echo "sync-public: неизвестный аргумент: $1" >&2
    exit 2
    ;;
esac

PRIVATE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PUBLIC_DIR=${PUBLIC_DIR:-$PRIVATE_DIR/../osnova-public}
PUBLIC_DIR=$(CDPATH= cd -- "$PUBLIC_DIR" && pwd)
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/osnova-public-sync.XXXXXX")
CHANGED="$STAGE/.changed"
SKIPPED="$STAGE/.skipped"

cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT INT TERM

fail() {
  echo "sync-public: $*" >&2
  exit 1
}

[ -d "$PRIVATE_DIR/.git" ] || fail "нет git-репозитория: $PRIVATE_DIR"
[ -d "$PUBLIC_DIR/.git" ] || fail "нет git-репозитория: $PUBLIC_DIR"
[ -z "$(git -C "$PUBLIC_DIR" status --porcelain)" ] ||
  fail "публичное дерево грязное; сначала закоммитьте или уберите изменения"

git -C "$PUBLIC_DIR" fetch --quiet origin master
BRANCH=$(git -C "$PUBLIC_DIR" branch --show-current)
[ "$BRANCH" = master ] || fail "публичное дерево на ветке '$BRANCH', нужен master"
LOCAL_HEAD=$(git -C "$PUBLIC_DIR" rev-parse HEAD)
REMOTE_HEAD=$(git -C "$PUBLIC_DIR" rev-parse origin/master)
[ "$LOCAL_HEAD" = "$REMOTE_HEAD" ] ||
  fail "локальный master не совпадает с origin/master; сначала синхронизируйте"

REMOTE_URL=$(git -C "$PUBLIC_DIR" remote get-url origin)
git clone --quiet --branch master "$REMOTE_URL" "$STAGE/public"
STAGE_REPO="$STAGE/public"

: > "$CHANGED"
: > "$SKIPPED"

# Только уже опубликованные исходники: публичный манифест — граница витрины.
git -C "$STAGE_REPO" ls-files 'src' | while IFS= read -r rel; do
  case "$rel" in
    *.test.ts|*.test.tsx|*.spec.ts) continue ;;
    *.ts) ;;
    *) continue ;;
  esac
  src="$PRIVATE_DIR/$rel"
  if [ ! -f "$src" ]; then
    printf '%s\n' "$rel" >> "$SKIPPED"
    continue
  fi
  if ! cmp -s "$src" "$STAGE_REPO/$rel"; then
    cp "$src" "$STAGE_REPO/$rel"
    printf '%s\n' "$rel" >> "$CHANGED"
  fi
done

# Примеры обновляются только там, где публичный файл уже есть. expected.sha256
# не пересчитывается: расхождение хешей обязан остановить gate.
git -C "$STAGE_REPO" ls-files 'examples/*.osnova' | while IFS= read -r rel; do
  src="$PRIVATE_DIR/$rel"
  [ -f "$src" ] || continue
  if ! cmp -s "$src" "$STAGE_REPO/$rel"; then
    cp "$src" "$STAGE_REPO/$rel"
    printf '%s\n' "$rel" >> "$CHANGED"
  fi
done

CHANGED_COUNT=$(wc -l < "$CHANGED" | tr -d ' ')
SKIPPED_COUNT=$(wc -l < "$SKIPPED" | tr -d ' ')

echo "sync-public: приватное дерево $PRIVATE_DIR"
echo "sync-public: витрина $PUBLIC_DIR"
echo "sync-public: изменено $CHANGED_COUNT, публичных файлов без пары в приватном $SKIPPED_COUNT"

if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo "sync-public: публичные файлы без пары (не копируются):"
  sed 's/^/  /' "$SKIPPED"
fi

if [ "$CHANGED_COUNT" -eq 0 ]; then
  echo "sync-public: изменений нет"
  exit 0
fi

git -C "$STAGE_REPO" diff --stat
if ! git -C "$STAGE_REPO" diff --check; then
  echo "sync-public: предупреждение: в скопированных файлах есть пробельные замечания" >&2
fi

if [ "$MODE" = dry ]; then
  echo "sync-public: режим проверки diff; сборка не запускалась"
  echo "sync-public: для сборки: sh scripts/sync-public.sh --check"
  exit 0
fi

echo "sync-public: npm ci"
if ! (cd "$STAGE_REPO" && npm ci --no-audit --no-fund); then
  fail "npm ci в публичной копии не прошёл"
fi
echo "sync-public: npm run gate"
if ! (cd "$STAGE_REPO" && npm run gate); then
  fail "gate публичной копии красный: исходники несовместимы с публичным портом, push отменён"
fi

if [ "$MODE" = check ]; then
  echo "sync-public: gate зелёный, публикация не выполнялась"
  exit 0
fi

git -C "$STAGE_REPO" add -- src examples
git -C "$STAGE_REPO" commit -m "sync: исходники из приватного репозитория $(date -u +%Y-%m-%d)"
git -C "$STAGE_REPO" push origin HEAD:master
echo "sync-public: опубликовано $(git -C "$STAGE_REPO" rev-parse --short HEAD) в $REMOTE_URL"
