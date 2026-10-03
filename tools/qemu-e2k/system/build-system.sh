#!/bin/bash
# Сборка СИСТЕМНОЙ модели e2k: qemu-system-e2k (не путать с user-mode моделью qemu-e2k,
# у которой свой паспорт — src/e2k/qemuModelPassport.ts и tools/qemu-e2k/README.md).
#
# Источник: OpenE2K/qemu-e2k (зеркало git.mentality.rip/OpenE2K/qemu-e2k), ветка e2k-softmmu —
# единственный ПУБЛИЧНЫЙ источник системного режима e2k. Ветка заморожена 2021-08-26.
#
# Запуск (в WSL-дистрибутиве e2k, от root):
#   bash tools/qemu-e2k/system/build-system.sh            # как есть: sha256 5ace3dae…
#   bash tools/qemu-e2k/system/build-system.sh --window   # + наша правка окна: sha256 1a321ebf…
#
# Почему chroot Alpine 3.14, а не сборка «как есть» на современном Alpine 3.24: QEMU 6.0.91
# с gcc 15 не собирается (замер 2026-10-03: configure проходит, ninja падает —
#   hw/vfio/pci.c:2833: implicit declaration of function 'basename';
#   fpu/softfloat.c + fpu/softfloat-parts.c.inc:1294: conflicting types for 'parts128_compare').
# Alpine 3.14 — ровесник ветки: gcc 10.3.1, python 3.9.17, meson 0.58.1, glib 2.68.3.
set -u

MODE=${1:-}
case "$MODE" in
  ""|--window) ;;
  *) echo "неизвестный ключ: $MODE (ожидается пусто или --window)"; exit 1 ;;
esac

REPO_GIT=https://github.com/OpenE2K/qemu-e2k.git
BRANCH=e2k-softmmu
COMMIT=e3304f721947f91deb3855dcdfc8243f948ee158   # «e2k: working (???) console», 2021-08-26
QEMU_VERSION=6.0.91
SHA_PRISTINE=5ace3daeeb03158306387943f08d33bfc8ed1e573218c8762dfcdd2b7a576188
SHA_WINDOW=1a321ebfe7fae4a61732cb282bf90906640049078371fc29c061a1ed7c59f28d
PATCH_SHA=68c45cbb0670bb301515bdd2237b294706b082015ede740959976dc752176a40

WORK=/root/qemu-sys
SRC=$WORK/src
CHROOT=/root/alpine314
ALPINE_REL=v3.14
ALPINE_VER=3.14.9
REPO=/mnt/d/PROJECTS/OSNOVA-FABRIKA
PATCH=$REPO/tools/qemu-e2k/system/osnova-local-system-window.patch

LOG=$WORK/build-system.log
exec > >(tee "$LOG") 2>&1
echo "=== сборка системной модели, режим: ${MODE:-без правок}, старт $(date -u +%FT%TZ) ==="

# --- 1. источник -------------------------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$WORK"
  git clone --branch "$BRANCH" "$REPO_GIT" "$SRC" || exit 1
fi
( cd "$SRC" && git fetch --depth 1 origin "$COMMIT" 2>/dev/null; git checkout -q "$COMMIT" ) || exit 1
echo "--- источник: $(git -C "$SRC" log -1 --format='%H %ad %s' --date=short)"
echo "--- VERSION: $(cat "$SRC/VERSION")"
[ "$(cat "$SRC/VERSION")" = "$QEMU_VERSION" ] || echo "ВНИМАНИЕ: версия не $QEMU_VERSION"

# --- 2. окружение-ровесник (chroot) ------------------------------------------------------------
if [ ! -x "$CHROOT/bin/sh" ]; then
  mkdir -p "$CHROOT"
  TARBALL=alpine-minirootfs-$ALPINE_VER-x86_64.tar.gz
  URL="https://dl-cdn.alpinelinux.org/alpine/$ALPINE_REL/releases/x86_64/$TARBALL"
  echo "--- качаю $URL"
  wget -q -O "$WORK/$TARBALL" "$URL" || { echo "НЕТ ФАЙЛА $URL"; exit 1; }
  tar -xzf "$WORK/$TARBALL" -C "$CHROOT" || exit 1
  cat > "$CHROOT/etc/apk/repositories" <<EOF
http://dl-cdn.alpinelinux.org/alpine/$ALPINE_REL/main
http://dl-cdn.alpinelinux.org/alpine/$ALPINE_REL/community
EOF
  cp /etc/resolv.conf "$CHROOT/etc/resolv.conf" 2>/dev/null || true
fi

echo "--- пакеты сборки"
chroot "$CHROOT" /bin/sh -c "apk update >/dev/null && apk add --no-cache build-base python3 py3-setuptools glib-dev pixman-dev zlib-dev linux-headers bash perl meson ninja pkgconf" || exit 1
chroot "$CHROOT" /bin/sh -c "gcc --version | head -1; python3 --version; meson --version; pkg-config --modversion glib-2.0"

if [ ! -d "$CHROOT/root/src" ]; then
  cp -a "$SRC" "$CHROOT/root/src" || exit 1
fi

# --- 3. правка (только в режиме --window; перед этим файл ВОССТАНАВЛИВАЕТСЯ) -------------------
CSRC=$CHROOT/root/src/target/e2k/cpu.c
PRISTINE=$CSRC.orig
if [ ! -f "$PRISTINE" ]; then
  cp "$SRC/target/e2k/cpu.c" "$PRISTINE" || exit 1   # клон — на закреплённом коммите, без правок
fi
cp -f "$PRISTINE" "$CSRC" || exit 1
if [ "$MODE" = "--window" ]; then
  echo "--- правка окна: $(sha256sum "$PATCH" | awk '{print $1}') (ожидается $PATCH_SHA)"
  [ "$(sha256sum "$PATCH" | awk '{print $1}')" = "$PATCH_SHA" ] || { echo "патч разошёлся с записанным"; exit 1; }
  cp "$PATCH" "$CHROOT/tmp/window.patch"
  chroot "$CHROOT" /bin/sh -c "cd /root/src && patch -p1 < /tmp/window.patch" || exit 1
fi

# --- 4. configure + сборка ---------------------------------------------------------------------
echo "--- configure + ninja (цель e2k-softmmu)"
chroot "$CHROOT" /bin/bash -c '
set -e
cd /root/src
if [ ! -f build/build.ninja ]; then rm -rf build && mkdir build && cd build
../configure \
  --target-list=e2k-softmmu \
  --with-git-submodules=ignore \
  --disable-werror --disable-docs --disable-guest-agent --disable-tools \
  --disable-capstone --disable-vnc --disable-gtk --disable-sdl --disable-spice \
  --disable-curl --disable-curses --disable-opengl --disable-libssh --disable-brlapi \
  --disable-usb-redir --disable-vhost-user --disable-rdma --disable-linux-aio \
  --disable-glusterfs --disable-libiscsi --disable-rbd --disable-smartcard \
  --disable-seccomp --disable-numa
else cd build
fi
ninja -j"$(nproc)" qemu-system-e2k
' || { echo "=== СБОРКА УПАЛА, хвост лога ==="; grep -n -m 20 -E "error:|FAILED" "$LOG" | head -20; exit 1; }

# --- 5. результат и сверка ---------------------------------------------------------------------
if [ "$MODE" = "--window" ]; then
  DEST=$WORK/qemu-system-e2k-window; EXPECTED=$SHA_WINDOW; WHAT="с правкой окна"
else
  DEST=$WORK/qemu-system-e2k;        EXPECTED=$SHA_PRISTINE; WHAT="без правок"
fi
cp "$CHROOT/root/src/build/qemu-system-e2k" "$DEST"
chmod +x "$DEST"
ACTUAL=$(sha256sum "$DEST" | awk '{print $1}')
echo "--- бинарь ($WHAT): $DEST ($(stat -c%s "$DEST") байт)"
"$DEST" --version | head -1
echo "--- sha256: $ACTUAL (ожидался $EXPECTED)"
if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "=== ВЕРДИКТ: sha256 СОВПАЛ с записанным в доке (docs/e2k-qemu-system.md §2) ==="
else
  echo "=== ВЕРДИКТ: sha256 РАЗОШЁЛСЯ — числа дока требуют перемера ==="
  exit 2
fi
echo "=== готово $(date -u +%FT%TZ) ==="
