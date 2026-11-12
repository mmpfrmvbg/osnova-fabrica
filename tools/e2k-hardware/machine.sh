#!/bin/sh
# ОТЧЁТ О МАШИНЕ. POSIX sh: на контейнере Эльбруса может не быть ни bash-расширений, ни python.
#
#   sh machine.sh > machine.txt 2>&1
#
# Зачем: прежде чем мерить наш код, надо знать, на чём меряем — модель Эльбруса, версия ядра,
# версии штатного тулчейна. Без этого отчёта любой результат с железа нечем подписать.
set -u

echo "=== дата и хост ==="
date 2>/dev/null || echo "(date недоступен)"
uname -a 2>/dev/null || echo "(uname недоступен)"
[ -r /etc/os-release ] && cat /etc/os-release

echo
echo "=== процессор (модель Эльбруса) ==="
if [ -r /proc/cpuinfo ]; then head -20 /proc/cpuinfo; else echo "(нет /proc/cpuinfo)"; fi
echo "страница: $(getconf PAGESIZE 2>/dev/null || echo '?')"

echo
echo "=== тулчейн ==="
for tool in lcc cc gcc clang as objdump ld make python3 node; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "--- $tool: $(command -v "$tool")"
    "$tool" --version 2>&1 | head -2
  else
    echo "--- $tool: НЕТ"
  fi
done

echo
echo "=== утилиты, на которые опирается кит ==="
for tool in timeout sha256sum md5sum cksum awk cut od file; do
  if command -v "$tool" >/dev/null 2>&1; then echo "$tool: есть"; else echo "$tool: НЕТ"; fi
done

echo
echo "=== контейнер ==="
[ -r /proc/self/status ] && grep -E '^(Cap|Seccomp|NoNewPrivs)' /proc/self/status
echo "uid=$(id -u 2>/dev/null) gid=$(id -g 2>/dev/null)"
echo "свободно памяти:"; (free -m 2>/dev/null || echo '(free недоступен)') | head -3
echo "монтирования (первые 10):"; (mount 2>/dev/null || echo '(mount недоступен)') | head -10
