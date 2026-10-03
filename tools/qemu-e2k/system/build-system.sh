#!/bin/bash
# Сборка СИСТЕМНОЙ модели e2k: qemu-system-e2k (не путать с user-mode моделью qemu-e2k,
# у которой свой паспорт — src/e2k/qemuModelPassport.ts и tools/qemu-e2k/README.md).
#
# Источник: OpenE2K/qemu-e2k (зеркало git.mentality.rip/OpenE2K/qemu-e2k), ветка e2k-softmmu —
# единственный ПУБЛИЧНЫЙ источник системного режима e2k. Ветка заморожена 2021-08-26.
#
# Почему chroot Alpine 3.14, а не сборка «как есть» на современном Alpine 3.24: QEMU 6.0.91
# с gcc 15 не собирается (замер 2026-10-03: configure проходит, ninja падает —
#   hw/vfio/pci.c:2833: implicit declaration of function 'basename';
#   fpu/softfloat.c + fpu/softfloat-parts.c.inc:1294: conflicting types for 'parts128_compare').
# Alpine 3.14 — ровесник ветки: gcc 10.3.1, python 3.9.17, meson 0.58.1, glib 2.68.3.
#
# Запуск (в WSL-дистрибутиве e2k, от root):
#   bash tools/qemu-e2k/system/build-system.sh
set -u

REPO=https://github.com/OpenE2K/qemu-e2k.git
BRANCH=e2k-softmmu
COMMIT=e3304f721947f91deb3855dcdfc8243f948ee158   # «e2k: working (???) console», 2021-08-26
QEMU_VERSION=6.0.91
EXPECTED_SHA256=5ace3daeeb03158306387943f08d33bfc8ed1e573218c8762dfcdd2b7a576188

WORK=/root/qemu-sys
SRC=$WORK/src
CHROOT=/root/alpine314
ALPINE_REL=v3.14
ALPINE_VER=3.14.9

LOG=$WORK/build-system.log
exec > >(tee "$LOG") 2>&1
echo "=== сборка системной модели, старт $(date -u +%FT%TZ) ==="

# --- 1. источник -------------------------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$WORK"
  git clone --branch "$BRANCH" "$REPO" "$SRC" || exit 1
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

# --- 3. configure + сборка ---------------------------------------------------------------------
echo "--- configure + ninja (цель e2k-softmmu)"
chroot "$CHROOT" /bin/bash -c '
set -e
cd /root/src
rm -rf build && mkdir build && cd build
../configure \
  --target-list=e2k-softmmu \
  --with-git-submodules=ignore \
  --disable-werror --disable-docs --disable-guest-agent --disable-tools \
  --disable-capstone --disable-vnc --disable-gtk --disable-sdl --disable-spice \
  --disable-curl --disable-curses --disable-opengl --disable-libssh --disable-brlapi \
  --disable-usb-redir --disable-vhost-user --disable-rdma --disable-linux-aio \
  --disable-glusterfs --disable-libiscsi --disable-rbd --disable-smartcard \
  --disable-seccomp --disable-numa
ninja -j"$(nproc)" qemu-system-e2k
' || { echo "=== СБОРКА УПАЛА, хвост лога ==="; grep -n -m 20 -E "error:|FAILED" "$LOG" | head -20; exit 1; }

# --- 4. результат и сверка ---------------------------------------------------------------------
cp "$CHROOT/root/src/build/qemu-system-e2k" "$WORK/qemu-system-e2k"
chmod +x "$WORK/qemu-system-e2k"
ACTUAL_SHA256=$(sha256sum "$WORK/qemu-system-e2k" | awk '{print $1}')
echo "--- бинарь: $WORK/qemu-system-e2k ($(stat -c%s "$WORK/qemu-system-e2k") байт)"
"$WORK/qemu-system-e2k" --version | head -1
echo "--- sha256: $ACTUAL_SHA256"
if [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ]; then
  echo "=== ВЕРДИКТ: sha256 СОВПАЛ с записанным в паспорт дока ==="
else
  echo "=== ВЕРДИКТ: sha256 РАЗОШЁЛСЯ (ожидался $EXPECTED_SHA256) — числа требуют перемера ==="
  exit 2
fi
echo "=== готово $(date -u +%FT%TZ) ==="
