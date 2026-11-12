#!/bin/sh
# A4-5ж, задача 23 — ОДИН ЗАХОД НА ЖИВОЙ МАШИНЕ: корпус 38/38 И пробы восьмой лжи.
#
#   sh run-all.sh
#
# Порядок жёсткий: СНАЧАЛА сверка sha256 ВСЕГО (корпус + пробы), и только если сошлось — прогон.
#
# ЛОВУШКИ 5е, УЧТЁННЫЕ ЗДЕСЬ (все три уже стоили замеров):
#   1. coreutils на этой машине ЛОКАЛИЗОВАН: `sha256sum -c` печатает «ЦЕЛ»/«НЕ СОВПАЛО», а не
#      «OK»/«FAILED». Разбор локализованного текста и остановил бы успех, и пропустил бы провал.
#      Лечится `LC_ALL=C`; главный судья — КОД ВОЗВРАТА (от локали не зависит).
#   2. КИРИЛЛИЧЕСКИЕ ИМЕНА ПЕРЕМЕННЫХ этот sh НЕ ПОНИМАЕТ: `код=$?` разбирается как КОМАНДА
#      `код=132`, оболочка печатает «команда не найдена», и в отчёт попадают литералы `$код`.
#      Имена переменных здесь ТОЛЬКО ASCII.
#   3. Отчёт обязан нести строку «хост»: без неё нельзя отличить железо от WSL1.
set -u
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR" || exit 1

# ---- 1. СВЕРКА sha256 ДО ПРОГОНА -------------------------------------------------
# Имя манифеста С СУФФИКСОМ среза: имя `manifest.sha256` носят ТРИ чужих отчёта, а `buildBareIndex`
# считает имена БЕЗ пути — уникальное имя обязательно (правило AGENTS.md, A4-5г/1).
LC_ALL=C sha256sum -c a5zh-manifest.sha256 > verify.txt 2>&1
rc=$?
ok=$(grep -c ': OK$' verify.txt)
bad=$(grep -c ': FAILED$' verify.txt)
n=$(wc -l < a5zh-manifest.sha256)
{
  echo ""
  echo "язык вывода принудительно C (LC_ALL=C), иначе coreutils печатает «ЦЕЛ»/«НЕ СОВПАЛО»"
  echo "код возврата sha256sum -c: $rc   <- главный судья, от локали не зависит"
  echo "файлов в манифесте: $n; строк OK: $ok; строк FAILED: $bad"
} >> verify.txt
echo "=== 1. СВЕРКА sha256 (verify.txt) ==="
cat verify.txt
echo ""

if [ "$rc" != "0" ] || [ "$bad" != "0" ] || [ "$ok" != "$n" ]; then
  echo "СТОП: sha256 НЕ СОШЁЛСЯ (OK $ok из $n, провалов $bad, код $rc) — ПРОГОН НЕ ДЕЛАЮ."
  echo "СТОП: прогон не делался; сверка не прошла (OK $ok из $n, провалов $bad, код $rc)." > kit-report.txt
  exit 2
fi
echo "сверка прошла: $ok из $n, провалов 0, код 0 — ПРОГОН РАЗРЕШЁН."
echo ""

# ---- 2. ПОДПИСЬ МАШИНЫ -----------------------------------------------------------
sh kit/machine.sh > machine.txt 2>&1
echo "=== 2. ПОДПИСЬ МАШИНЫ (machine.txt): $(wc -l < machine.txt) строк ==="

# ---- 3. КОРПУС: канонический run.sh ----------------------------------------------
sh kit/run.sh > kit-report.txt 2>&1
rc_kit=$?
echo ""
echo "=== 3. КОРПУС (kit-report.txt), код возврата run.sh: $rc_kit ==="
grep -E '^(хост|дата):' kit-report.txt
grep -E '^итог:' kit-report.txt
echo ""

# ---- 4. ПРОБЫ ВОСЬМОЙ ЛЖИ: 3 прогона на пробу, ожидание — ЭТАЛОН ------------------
run_elf() {
  chmod +x "$1" 2>/dev/null
  if command -v timeout >/dev/null 2>&1; then
    timeout 30 "$1"
  else
    "$1"
  fi
}

{
  echo "=== ПРОБЫ ВОСЬМОЙ ЛЖИ НА ЖЕЛЕЗЕ (печать внутри вызываемой) ==="
  echo "хост: $(uname -m) / $(uname -sr)"
  echo "дата: $(date)"
  echo "ожидание: ЭТАЛОН каждой пробы (критерий владельца: 42, а не 45)"
  echo ""
} > lie-report.txt

mismatch=0
total=0
while read -r elf etalon; do
  [ -z "$elf" ] && continue
  total=$((total + 1))
  codes=""
  first=""
  i=1
  while [ "$i" -le 3 ]; do
    run_elf "lie/$elf" >/dev/null 2>&1
    c=$?
    [ -z "$first" ] && first="$c"
    codes="$codes $c"
    i=$((i + 1))
  done
  if [ "$first" = "$etalon" ]; then
    verdict="СОВПАЛО С ЭТАЛОНОМ"
  else
    verdict="!!! РАСХОЖДЕНИЕ — СТОП-ДОКЛАД !!!"
    mismatch=$((mismatch + 1))
  fi
  echo "$elf: коды за 3 прогона:$codes | первый $first, эталон $etalon — $verdict" >> lie-report.txt
done < lie/plan.txt

echo "=== 4. ПРОБЫ ВОСЬМОЙ ЛЖИ (lie-report.txt) ==="
cat lie-report.txt
echo ""
echo "итог проб: всего $total, расхождений с эталоном $mismatch"

# ---- 5. СТРОКИ ХОСТ — ЧИТАТЬ ПРЕЖДЕ, ЧЕМ ССЫЛАТЬСЯ НА ЧИСЛА ----------------------
echo ""
echo "=== 5. СТРОКА ХОСТ (обе части) ==="
grep '^хост:' kit-report.txt || echo "СТРОКИ хост: В kit-report.txt НЕТ!"
grep '^хост:' lie-report.txt || echo "СТРОКИ хост: В lie-report.txt НЕТ!"
echo ""
echo "=== 6. ИТОГ КОРПУСА (для доклада дословно) ==="
grep '^итог:' kit-report.txt || echo "СТРОКИ итог: В kit-report.txt НЕТ!"
grep '^дата:' kit-report.txt || echo "СТРОКИ дата: В kit-report.txt НЕТ!"
