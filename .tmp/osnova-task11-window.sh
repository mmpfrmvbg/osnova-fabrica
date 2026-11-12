#!/bin/bash
# ОКНО НА МОДЕЛЬ (task-11): фаза выбирается аргументом. Живой источник и патч в репо НЕ трогаются —
# правка вносится в копию источника и в живой файл патчем, восстановление — из копии ДО правки.
#
#   A — внести правку и пересобрать (модель мутирована)
#   B — восстановить копию ДО правки и пересобрать (модель обязана вернуться к паспортной)
#
# То же, чем снята лестница §3.36: пересборка инкрементальная, `make -j"$(nproc)" qemu-e2k`.
set -e
MODE=${1:?укажите A или B}
SRC=/root/qemu-src/qemu/linux-user/e2k/cpu_loop.c
BEFORE=/root/task11-cpu_loop.before.c
REPO=/mnt/d/PROJECTS/OSNOVA-FABRIKA

if [ "$MODE" = "A" ]; then
  cp "$SRC" "$BEFORE"
  echo "--- копия ДО правки: $BEFORE (sha256 ниже) ---"
  sha256sum "$BEFORE"
  # Патч в репозитории — диф против ЧИСТОГО дерева (`/root/backup-cpu_loop.c`), поэтому на живой
  # источник (он уже = чистое + правка 1) он не ложится и НЕ должен: здесь кладётся ровно тот файл,
  # который патч даёт на чистом дереве, и это сверяется sha256 ниже.
  cp /root/task11-live-after.c "$SRC"
  echo "--- источник ПОСЛЕ правки (должен совпасть с /root/task11-check/linux-user/e2k/cpu_loop.c) ---"
  sha256sum "$SRC" /root/task11-check/linux-user/e2k/cpu_loop.c
  grep -n 'size_q , \|size_d , ' "$SRC"
elif [ "$MODE" = "B" ]; then
  cp "$BEFORE" "$SRC"
  echo "--- источник восстановлен из копии ДО правки ---"
  grep -n 'size_q , \|size_d , ' "$SRC"
  diff -q "$BEFORE" "$SRC" && echo "восстановление байт-в-байт"
else
  echo "режим: A либо B" >&2
  exit 2
fi

cd /root/qemu-build
make -j"$(nproc)" qemu-e2k
echo "--- сборка сделана ---"
sha256sum /root/qemu-build/qemu-e2k
stat -c '%y' /root/qemu-build/qemu-e2k
/root/qemu-build/qemu-e2k --version | head -1
