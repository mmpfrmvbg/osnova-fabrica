#!/usr/bin/env bash
# Паспорт модели: бинарь, версия, наш патч. Запуск из WSL:
#   wsl -d e2k -- bash /mnt/d/PROJECTS/OSNOVA-FABRIKA/tools/qemu-e2k/probe-port.sh
#
# Зачем: все закреплённые числа машинной плоскости измерены на одной сборке. Этот скрипт
# показывает, на какой именно, и сверяет её с `src/e2k/qemuModelPassport.ts`.
set -u

echo "--- бинарь qemu-e2k ---"
for p in /root/qemu-build/qemu-e2k /root/qemu-build-x86/qemu-e2k /usr/local/bin/qemu-e2k /usr/bin/qemu-e2k; do
  if [ -x "$p" ]; then
    echo "$p  sha256=$(sha256sum "$p" | cut -d' ' -f1)  $(stat -c '%y' "$p" | cut -c1-19)"
  fi
done

echo "--- другие сборки ---"
find /root -maxdepth 4 -name 'qemu-e2k' -type f 2>/dev/null | head -6

echo "--- версия ---"
/root/qemu-build/qemu-e2k --version 2>&1 | head -2 || true

echo "--- наш патч (бэкап -> текущий) ---"
diff -u /root/backup-cpu_loop.c /root/qemu-src/qemu/linux-user/e2k/cpu_loop.c 2>/dev/null | head -40
