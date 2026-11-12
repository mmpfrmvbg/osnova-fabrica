#!/bin/bash
# Пробы системной модели e2k: что она ДЕЛАЕТ и на чём встаёт — на ДВУХ сборках рядом
# (без правок и с правкой окна). Ничего не доказывает сверх напечатанного: каждая строка — замер.
#
# Запуск (в WSL-дистрибутиве e2k, от root):
#   bash tools/qemu-e2k/system/probe-system.sh
set -u

W=/root/qemu-sys/probe
REPO=/mnt/d/PROJECTS/OSNOVA-FABRIKA
BIN=$REPO/tools/e2k-hardware/bin
PASSPORT=$REPO/src/e2k/qemuModelPassport.ts
ELF=$BIN/11-минимум-массива.elf

mkdir -p "$W"; cd "$W"
[ -e "$ELF" ] || { echo "НЕТ ФАЙЛА: $ELF"; exit 1; }

echo "=== 1. что это за сборки ==="
for Q in /root/qemu-sys/qemu-system-e2k /root/qemu-sys/qemu-system-e2k-window; do
  if [ -x "$Q" ]; then
    printf '%-28s %s  sha256=%s\n' "$(basename "$Q")" "$("$Q" --version | head -1)" "$(sha256sum "$Q" | awk '{print $1}')"
  else
    printf '%-28s НЕТ (собрать: build-system.sh%s)\n' "$(basename "$Q")" "$([ "${Q##*-}" = window ] && echo ' --window')"
  fi
done

echo
echo "=== 2. машины и прошивка ==="
if [ -x /root/qemu-sys/qemu-system-e2k ]; then
  /root/qemu-sys/qemu-system-e2k -M help 2>&1 | head -4
  /root/qemu-sys/qemu-system-e2k -M e2k -m 256M -display none -serial null -monitor none 2>&1 | head -2
fi

echo
echo "=== 3. один и тот же ELF корпуса на двух сборках ==="
echo "    ELF: $(basename "$ELF") — эталон возврата 2, entry 0x100000"
for Q in /root/qemu-sys/qemu-system-e2k /root/qemu-sys/qemu-system-e2k-window; do
  [ -x "$Q" ] || continue
  TAG=$(basename "$Q")
  timeout 20 "$Q" -M e2k -m 256M -kernel "$ELF" -display none -serial null \
    -monitor none -no-reboot -d in_asm,unimp,cpu -D "$W/$TAG.log" >/dev/null 2>&1
  echo "--- $TAG: rc=$?  блоков=$(grep -c '^IN:' "$W/$TAG.log")  команд=$(grep -c '^0x' "$W/$TAG.log")"
  echo "    исключение:  $(grep -o 'not implemented [0-9]* at [0-9]*' "$W/$TAG.log" | tail -1)"
  # Окно меняется на `call`: максимум по трассе — окно вызывающего, последнее — окно вызываемой.
  MAXW=$(grep -o 'wsz=[0-9]*' "$W/$TAG.log" | sed 's/wsz=//' | sort -n | tail -1)
  LASTW=$(grep -o 'wsz=[0-9]*' "$W/$TAG.log" | tail -1 | sed 's/wsz=//')
  echo "    окно:        вызывающего wsz=$MAXW, вызываемой wsz=$LASTW"
  echo "    окно вызова: $(grep -E '^  r0 <' "$W/$TAG.log" | tail -1)"
done

echo
echo "=== 4. user-mode модель-паспорт не тронута ==="
EXPECTED=$(grep -oE "'[0-9a-f]{64}'" "$PASSPORT" | head -1 | tr -d "'")
if [ -x /root/qemu-build/qemu-e2k ]; then
  ACTUAL=$(sha256sum /root/qemu-build/qemu-e2k | awk '{print $1}')
  echo "паспорт:  $EXPECTED"
  echo "на диске: $ACTUAL"
  [ "$EXPECTED" = "$ACTUAL" ] && echo "ВЕРДИКТ: совпал — сборка системной модели паспорт не тронула" \
                              || echo "ВЕРДИКТ: РАСХОЖДЕНИЕ — модель-паспорт изменилась"
else
  echo "нет /root/qemu-build/qemu-e2k — проверить нечего"
fi
