#!/bin/bash
# Пробы системной модели e2k: что она ДЕЛАЕТ и на чём встаёт.
# Ничего не доказывает сверх напечатанного: каждая строка — замер, а не обещание.
#
# Запуск (в WSL-дистрибутиве e2k, от root):
#   bash tools/qemu-e2k/system/probe-system.sh
set -u

Q=/root/qemu-sys/qemu-system-e2k
W=/root/qemu-sys/probe
REPO=/mnt/d/PROJECTS/OSNOVA-FABRIKA
BIN=$REPO/tools/e2k-hardware/bin
PASSPORT=$REPO/src/e2k/qemuModelPassport.ts

for f in "$Q" "$BIN/11-минимум-массива.elf"; do
  [ -e "$f" ] || { echo "НЕТ ФАЙЛА: $f (сначала build-system.sh)"; exit 1; }
done
mkdir -p "$W"; cd "$W"

echo "=== 1. что это за сборка ==="
"$Q" --version | head -1
echo "sha256: $(sha256sum "$Q" | awk '{print $1}')"
echo "--- машины:"
"$Q" -M help 2>&1 | head -5

echo
echo "=== 2. без ядра и без прошивки ==="
"$Q" -M e2k -m 256M -display none -serial null -monitor none 2>&1 | head -3

echo
echo "=== 3. наш ELF корпуса: «11-минимум-массива» (эталон возврата 2) ==="
timeout 20 "$Q" -M e2k -m 256M -kernel "$BIN/11-минимум-массива.elf" \
  -display none -serial null -monitor none -no-reboot \
  -d in_asm,unimp -D "$W/run.log" > "$W/run.out" 2>&1
echo "код возврата qemu: $?   (1 = модель сама завершилась на необработанном исключении)"
echo "исполненных блоков: $(grep -c '^IN:' "$W/run.log")"
echo "первая команда, которую исполнила модель:"
sed -n '/^IN:/,/^$/p' "$W/run.log" | head -6
echo "чем кончилось:"
grep -n "not implemented" "$W/run.log" | head -3
echo "(номер исключения называет причина: 9 = EXCP_WINDOW_BOUNDS, target/e2k/cpu.h)"

echo
echo "=== 4. user-mode модель-паспорт не тронута ==="
EXPECTED=$(grep -oE "'[0-9a-f]{64}'" "$PASSPORT" | head -1 | tr -d "'")
if [ -x /root/qemu-build/qemu-e2k ]; then
  ACTUAL=$(sha256sum /root/qemu-build/qemu-e2k | awk '{print $1}')
  echo "паспорт: $EXPECTED"
  echo "на диске: $ACTUAL"
  [ "$EXPECTED" = "$ACTUAL" ] && echo "ВЕРДИКТ: совпал — сборка системной модели паспорт не тронула" \
                              || echo "ВЕРДИКТ: РАСХОЖДЕНИЕ — модель-паспорт изменилась"
else
  echo "нет /root/qemu-build/qemu-e2k — проверить нечего"
fi
