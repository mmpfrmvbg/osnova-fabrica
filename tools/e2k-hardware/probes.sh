#!/bin/sh
# ЗОНДЫ НА ЖИВОЙ МАШИНЕ. POSIX sh.
#
#   sh probes.sh
#
# Отличие от `run.sh` принципиальное, и его стоит держать в голове:
#
#   run.sh    — бинари КОРПУСА: у каждого есть эталон, машина обязана его повторить;
#   probes.sh — ЗОНДЫ: эталона нет, есть ВОПРОС. Машина даёт ответ, а не оценку.
#
# Поэтому зонды не попадают в `expected.tsv` (иначе сторож «кит не отстал от корпуса»
# сравнивал бы несравнимое) и не судят код возврата: печатается факт, разбор — человеком.
#
# Таблица `probes.tsv` — три колонки:
#   зонд <TAB> sha256 либо причина негодности <TAB> что означает код возврата
# Бинарь ищется как `bin/<имя без .osnova>.elf`.
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TABLE="$DIR/probes.tsv"
OUT="$DIR/probes-report.txt"

: > "$OUT"
say() { echo "$1" | tee -a "$OUT"; }

say "=== зонды Основы: вопросы к машине ==="
say "дата: $(date 2>/dev/null || echo '?')"
say "хост: $(uname -m 2>/dev/null || echo '?') / $(uname -sr 2>/dev/null || echo '?')"
say ""

if [ ! -f "$TABLE" ]; then
  say "нет $TABLE — кит собран без зондов (npx tsx src/scripts/e2kHardwareProbes.ts)"
  exit 0
fi

# Первая строка таблицы — шапка.
first=1
while IFS="$(printf '\t')" read -r probe digest_or_reason meaning; do
  if [ "$first" = 1 ]; then first=0; continue; fi
  [ -n "${probe:-}" ] || continue
  binary="$DIR/bin/$(basename "$probe" .osnova).elf"
  say "--- $probe"
  case "$digest_or_reason" in
    *НЕ\ СОБИРАЕТСЯ*|*не\ собирается*)
      say "    бинаря нет: $digest_or_reason"
      say ""
      continue
      ;;
    *) say "    sha256 ожидаемого бинаря: $digest_or_reason" ;;
  esac
  say "    что означает ответ:       ${meaning:-не названо}"
  if [ ! -f "$binary" ]; then
    say "    ответ:                    БИНАРЬ НЕ СОБРАН ($binary)"
    say ""
    continue
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    say "    sha256 на машине:         $(sha256sum "$binary" | cut -d' ' -f1)"
  fi
  chmod +x "$binary" 2>/dev/null
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 "$binary" >/dev/null 2>&1
  else
    "$binary" >/dev/null 2>&1
  fi
  say "    ответ:                    код возврата $?"
  say ""
done < "$TABLE"

say "Отчёт целиком — $OUT. Рядом положите machine.txt: без модели процессора и версий"
say "тулчейна ответ зонда нечем подписать."
