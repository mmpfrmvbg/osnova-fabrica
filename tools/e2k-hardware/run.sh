#!/bin/sh
# ПРОГОН КИТА НА ЖИВОЙ МАШИНЕ. POSIX sh.
#
#   sh run.sh            # отчёт на экран и в report.txt
#   LOCAL=1 sh run.sh    # тот же прогон под qemu-e2k (проверка самого кита, не машины)
#
# Что делает: запускает каждый бинарь из bin/, печатает код возврата и сверяет с expected.tsv.
# Ничего не пересобирает: на машине нет ни Node, ни нашего компилятора — это принципиально.
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$DIR/bin"
EXPECTED="$DIR/expected.tsv"
OUT="$DIR/report.txt"
RUNNER="${RUNNER:-}"

: > "$OUT"
say() { echo "$1" | tee -a "$OUT"; }

say "=== кит Основы: прогон на машине ==="
say "дата: $(date 2>/dev/null || echo '?')"
say "хост: $(uname -m 2>/dev/null || echo '?') / $(uname -sr 2>/dev/null || echo '?')"
say ""

ok=0
bad=0
miss=0

while IFS="$(printf '\t')" read -r elf expected; do
  [ -n "${elf:-}" ] || continue
  path="$DIR/$elf"
  if [ ! -f "$path" ]; then
    say "$elf: ФАЙЛА НЕТ"
    miss=$((miss + 1))
    continue
  fi
  if [ -n "$RUNNER" ]; then
    "$RUNNER" "$path" >/dev/null 2>&1
  elif [ -n "${LOCAL:-}" ] && command -v qemu-e2k >/dev/null 2>&1; then
    qemu-e2k "$path" >/dev/null 2>&1
  else
    chmod +x "$path" 2>/dev/null
    if command -v timeout >/dev/null 2>&1; then
      timeout 30 "$path" >/dev/null 2>&1
    else
      "$path" >/dev/null 2>&1
    fi
  fi
  code=$?
  if [ "$code" = "$expected" ]; then
    say "$elf: код $code — совпал с эталоном"
    ok=$((ok + 1))
  else
    say "$elf: код $code, эталон $expected — РАСХОЖДЕНИЕ"
    bad=$((bad + 1))
  fi
done < "$EXPECTED"

say ""
say "итог: совпало $ok, расхождений $bad, файлов нет $miss"
say ""
say "Отчёт целиком — $OUT. Рядом с ним положите machine.txt из machine.sh:"
say "без модели процессора и версий тулчейна результат нечем подписать."
