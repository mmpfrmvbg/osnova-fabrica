#!/bin/sh
# D12: прямой зонд блока рантайма в точке входа — что переживает системный вызов write.
# Проба: setwd/setbn, %b[12]=0, %b[13]=1, %b[14]=8, %b[15]=0x11, холостой write(1,NULL,0),
# затем exit(%b[N]). Код возврата = уцелевшее значение клетки.
set -u
cd "$(dirname "$0")" || exit 1
say() { printf '%s\n' "$*"; }
say "host: $(uname -n) / $(uname -m) / $(uname -r)"
say "date: $(date)"
for n in b12 b13 b14 b15 b14-nowrite; do
  as "probe-$n.s" -o "probe-$n.o" || { say "$n: AS FAIL"; continue; }
  ld -o "probe-$n" "probe-$n.o" || { say "$n: LD FAIL"; continue; }
  ./"probe-$n"
  say "exit($n) = $?"
done
# Контроль: тот же зонд БЕЗ системного вызова — значения обязаны быть исходными.
say "--- контроль без write (берём probe-b14) ---"
