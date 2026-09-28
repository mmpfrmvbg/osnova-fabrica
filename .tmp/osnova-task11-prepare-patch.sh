#!/bin/bash
# Подготовка патча окна — ВСЁ НА КОПИЯХ, живой источник и сборка не трогаются (task-11).
set -e
SRC=/root/qemu-src/qemu/linux-user/e2k/cpu_loop.c
REPO=/mnt/d/PROJECTS/OSNOVA-FABRIKA
PATCH=$REPO/.tmp/osnova-task11-cpu_loop.patch

cp "$SRC" /root/task11-live-before.c
awk '
  /WD, size_q , 8\);/ {
    print "    /* OSNOVA-LOCAL-PATCH 2 (окно): size_q = 12 квадрослов — вызываемая получает";
    print "       2 * (12 - psize_q=4) = 16 регистров вместо восьми (docs/hardware-debt.md §3.36, §3.44).";
    print "       Поле size_q — семь бит, MAXSR_Q = 112, поэтому 12 выразимо. */";
    print "    env->sregs.wd = FIELD_DP64_E2K(env->sregs.wd, WD, size_q , 12);";
    next
  }
  /WD, size_d , 8 \* 2\);/ {
    print "    env->sregs.wd = FIELD_DP64_E2K(env->sregs.wd, WD, size_d , 12 * 2);";
    next
  }
  { print }
' /root/task11-live-before.c > /root/task11-live-after.c

diff -u --label a/linux-user/e2k/cpu_loop.c --label b/linux-user/e2k/cpu_loop.c \
  /root/backup-cpu_loop.c /root/task11-live-after.c > "$PATCH" || true

rm -rf /root/task11-check && mkdir -p /root/task11-check/linux-user/e2k
cp /root/backup-cpu_loop.c /root/task11-check/linux-user/e2k/cpu_loop.c
cd /root/task11-check && patch -p1 --dry-run < "$PATCH"
cd /root/task11-check && patch -p1 < "$PATCH"

echo "--- равенство: патч на чистом дереве против имитации правки на копии ---"
sha256sum /root/task11-check/linux-user/e2k/cpu_loop.c /root/task11-live-after.c
echo "--- sha256 патча, живого источника и текущего патча в репо ---"
sha256sum "$PATCH" "$SRC" "$REPO/tools/qemu-e2k/osnova-local-cpu_loop.patch"
echo "--- живой источник не тронут? ---"
diff -q /root/task11-live-before.c "$SRC" && echo "живой cpu_loop.c байт-в-байт тот же"
echo "--- бинарь не тронут? ---"
sha256sum /root/qemu-build/qemu-e2k
