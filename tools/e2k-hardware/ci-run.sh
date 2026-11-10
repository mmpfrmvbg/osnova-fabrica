#!/bin/sh
# CI-прогон кита на живой E8C2.
#
# Отличие от run.sh: run.sh исполняется на самой машине и всегда завершается 0,
# даже когда есть расхождения. Этот скрипт готовит копию кита, запускает её по
# SSH и делает расхождение красным.
#
# Переменные:
#   E2K_HOST       хост E8C2 (обязательно)
#   E2K_USER       пользователь (обязательно)
#   E2K_PORT       порт SSH, по умолчанию 22
#   SSH_KEY_PATH   приватный ключ, по умолчанию ~/.ssh/id_ed25519
#
# Прогон: SSH_KEY_PATH="$HOME/.ssh/id_ed25519" sh tools/e2k-hardware/ci-run.sh
set -eu

HOST=${E2K_HOST:-}
USER=${E2K_USER:-}
PORT=${E2K_PORT:-22}
KEY=${SSH_KEY_PATH:-${E2K_SSH_KEY_PATH:-$HOME/.ssh/id_ed25519}}
HOST_KEY_POLICY=${E2K_HOST_KEY_POLICY:-accept-new}
KNOWN_HOSTS=${E2K_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}

KIT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOG_DIR="$KIT_DIR/logs"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$LOG_DIR/ci-e8c2-$STAMP.log"
REPORT="$LOG_DIR/ci-report-$STAMP.txt"
TMP_LOCAL=$(mktemp -d "${TMPDIR:-/tmp}/osnova-ci.XXXXXX")
REMOTE_DIR=

fail() {
  echo "ci-run: $*" >&2
  exit 1
}

cleanup() {
  set +e
  if [ -n "$REMOTE_DIR" ]; then
    ssh_cmd "rm -rf '$REMOTE_DIR'" >/dev/null 2>&1
  fi
  rm -rf "$TMP_LOCAL"
  set -e
}
trap cleanup EXIT INT TERM

ssh_cmd() {
  ssh -o BatchMode=yes \
    -o StrictHostKeyChecking="$HOST_KEY_POLICY" \
    -o UserKnownHostsFile="$KNOWN_HOSTS" \
    -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=4 \
    -i "$KEY" -p "$PORT" "$USER@$HOST" "$@"
}

scp_cmd() {
  scp -P "$PORT" -i "$KEY" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking="$HOST_KEY_POLICY" \
    -o UserKnownHostsFile="$KNOWN_HOSTS" \
    "$@"
}

[ -n "$HOST" ] || fail "E2K_HOST не задан"
[ -n "$USER" ] || fail "E2K_USER не задан"
case "$HOST" in
  *[!A-Za-z0-9._:-]*) fail "E2K_HOST содержит недопустимые символы" ;;
esac
case "$USER" in
  *[!A-Za-z0-9._-]*) fail "E2K_USER содержит недопустимые символы" ;;
esac
case "$PORT" in
  ''|*[!0-9]*) fail "E2K_PORT должен быть числом" ;;
esac
[ -r "$KEY" ] || fail "ключ не найден или не читается: $KEY"
[ -f "$KIT_DIR/run.sh" ] || fail "нет $KIT_DIR/run.sh"
[ -f "$KIT_DIR/expected.tsv" ] || fail "нет $KIT_DIR/expected.tsv"
[ -d "$KIT_DIR/bin" ] || fail "нет $KIT_DIR/bin"

mkdir -p "$LOG_DIR" "$(dirname "$KNOWN_HOSTS")"

# Проверка цели до копирования: чужой Linux с теми же путями не должен
# выглядеть как успешный прогон E8C2.
ARCH=$(ssh_cmd 'uname -m') || fail "SSH к $HOST не работает"
case "$ARCH" in
  e2k*) ;;
  *) fail "цель вернула uname -m='$ARCH', ожидался e2k*" ;;
esac

REMOTE_DIR=$(ssh_cmd 'mktemp -d /tmp/osnova-hw.XXXXXX') || fail "не удалось создать каталог на $HOST"
case "$REMOTE_DIR" in
  /tmp/osnova-hw.*) ;;
  *) fail "неожиданный удалённый каталог: $REMOTE_DIR" ;;
esac

cp "$KIT_DIR/run.sh" "$KIT_DIR/expected.tsv" "$TMP_LOCAL/"
cp -R "$KIT_DIR/bin" "$TMP_LOCAL/bin"

scp_cmd "$TMP_LOCAL/run.sh" "$TMP_LOCAL/expected.tsv" "$USER@$HOST:$REMOTE_DIR/" ||
  fail "scp файлов кита не удался"
scp_cmd -r "$TMP_LOCAL/bin" "$USER@$HOST:$REMOTE_DIR/" ||
  fail "scp bin/ не удался"

ssh_cmd "chmod +x '$REMOTE_DIR/run.sh'" || fail "chmod на $HOST не удался"

# run.sh всегда завершается 0, поэтому итог разбирается отдельно. Строка
# «итог: совпало N, расхождений M, файлов нет K» — единственный контракт,
# который связывает прогон на машине с кодом возврата CI.
set +e
ssh_cmd "sh '$REMOTE_DIR/run.sh'" >"$LOG" 2>&1
RC=$?
set -e
cat "$LOG"

if [ "$RC" -ne 0 ]; then
  fail "run.sh на $HOST завершился кодом $RC"
fi

set +e
SUMMARY=$(grep '^итог:' "$LOG" | tail -n 1)
set -e
[ -n "$SUMMARY" ] || fail "в выводе нет строки итога; отчёт: $LOG"

COUNTS=$(printf '%s\n' "$SUMMARY" | sed -n 's/.*совпало \([0-9][0-9]*\), расхождений \([0-9][0-9]*\), файлов нет \([0-9][0-9]*\).*/\1 \2 \3/p')
[ -n "$COUNTS" ] || fail "строка итога не разобрана: $SUMMARY"
set -- $COUNTS
OK=$1
BAD=$2
MISS=$3
EXPECTED=$(awk 'NF { n++ } END { print n + 0 }' "$KIT_DIR/expected.tsv")

[ "$BAD" -eq 0 ] || fail "расхождений $BAD; отчёт: $LOG"
[ "$MISS" -eq 0 ] || fail "файлов нет $MISS; отчёт: $LOG"
[ "$OK" -eq "$EXPECTED" ] || fail "совпало $OK из $EXPECTED; отчёт: $LOG"
if grep -qE 'РАСХОЖДЕНИЕ|ФАЙЛА НЕТ' "$LOG"; then
  fail "в выводе есть расхождение; отчёт: $LOG"
fi

scp_cmd "$USER@$HOST:$REMOTE_DIR/report.txt" "$REPORT" ||
  fail "report.txt не забран с $HOST"
[ -s "$REPORT" ] || fail "report.txt пуст"

echo "ci-run: E8C2 $HOST: совпало $OK, расхождений $BAD, файлов нет $MISS"
echo "ci-run: журнал $LOG"
echo "ci-run: отчёт $REPORT"
