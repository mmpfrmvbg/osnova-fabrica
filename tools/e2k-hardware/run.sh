#!/bin/sh
# ПРОГОН КИТА НА ЖИВОЙ МАШИНЕ. POSIX sh.
#
#   sh run.sh            # отчёт на экран и в report.txt
#   LOCAL=1 sh run.sh    # тот же прогон под qemu-e2k (проверка самого кита, не машины)
#
# Что делает: запускает каждый бинарь из bin/ и сверяет результат с expected.tsv ПО КАНАЛУ:
#
#   * канал `возврат` — сверяется КОД возврата процесса (как было);
#   * канал `вывод`   — сверяются БАЙТЫ stdout (`cmp`): так отдают результат печатающие записи
#     `39`–`44` (`система.лог.вывести`). Без этого кит объявлял бы расхождение там, где всё верно:
#     эталон «10» против кода возврата 0 (docs/hardware-debt.md §3.43). У этих записей код обязан
#     быть 0 — это второе утверждение, и оно проверяется тоже.
#
# Ничего не пересобирает: на машине нет ни Node, ни нашего компилятора — это принципиально.
set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$DIR/bin"
EXPECTED="$DIR/expected.tsv"
OUT="$DIR/report.txt"
RUNNER="${RUNNER:-}"
WANT="$DIR/.want.$$"
GOT="$DIR/.got.$$"

: > "$OUT"
say() { echo "$1" | tee -a "$OUT"; }
cleanup() { rm -f "$WANT" "$GOT"; }
trap cleanup EXIT INT TERM

# Прогон одного бинаря; stdout — как есть (его читает вызывающий).
run_binary() {
  if [ -n "$RUNNER" ]; then
    "$RUNNER" "$1"
  elif [ -n "${LOCAL:-}" ] && command -v qemu-e2k >/dev/null 2>&1; then
    qemu-e2k "$1"
  else
    chmod +x "$1" 2>/dev/null
    if command -v timeout >/dev/null 2>&1; then
      timeout "$TMO" "$1"
    else
      "$1"
    fi
  fi
}

say "=== кит Основы: прогон на машине ==="
say "дата: $(date 2>/dev/null || echo '?')"
say "хост: $(uname -m 2>/dev/null || echo '?') / $(uname -sr 2>/dev/null || echo '?')"
say ""

# ЛЕНТА ДЛЯ ФАЙЛОВОГО ВХОДА (L2 §42/§44). Программа читает СТАТИЧЕСКИЙ путь, который задан носителем
# (`src/e2k/fileCallRuntime.ts#FILE_PATH_TEXT`), а не аргументом: `argv[1]` у языка ещё нет. Поэтому
# лента кладётся ПЕРЕД КАЖДЫМ таким бинарём, а не один раз: путь у всех один, а лента — своя.
#
#   bin/b2b-file.elf — лента 54 форм, 39 216 байт (4 902 ячейки).
#
# Отсутствие файла — названная строка отчёта, а не тихий пропуск: без ленты программа напечатает пусто
# и выглядела бы как дефект разбора.
place_tape() {
  tape="$1"
  if [ ! -f "$tape" ]; then
    say "лента: $tape НЕТ — файловый прогон проверять нечем"
    return 1
  fi
  if cp "$tape" /tmp/input.osnova 2>/dev/null; then
    return 0
  fi
  say "лента: НЕ УДАЛОСЬ положить /tmp/input.osnova из $tape — расхождение будет по причине стенда"
  return 1
}

say ""

ok=0
bad=0
miss=0

while IFS="$(printf '\t')" read -r elf via expected; do
  [ -n "${elf:-}" ] || continue
  via=${via:-возврат}
  path="$DIR/$elf"
  if [ ! -f "$path" ]; then
    say "$elf: ФАЙЛА НЕТ"
    miss=$((miss + 1))
    continue
  fi
  # ЛЕНТА — ПЕРЕД КАЖДЫМ БИНАРЁМ (путь у программы статический, а прогонов с файлом может быть
  # больше одного). Без ленты прогон файловой программы не имеет смысла: она напечатает пусто, и это
  # была бы причина стенда, а не дефект.
  case "$elf" in
    *b2b-file*)
      TMO=120
      place_tape "$BIN/input.osnova" || true
      ;;
    *) TMO=30 ;;
  esac
  if [ "$via" = "вывод" ]; then
    # Байты: `\n` из таблицы разворачивается `printf %b`, сверка — `cmp` (а не `=`): перевод
    # строки в конце эталона тоже часть эталона (docs/hardware-debt.md §3.42.1).
    printf '%b' "$expected" > "$WANT"
    run_binary "$path" > "$GOT" 2>/dev/null
    code=$?
    if [ "$code" = "0" ] && cmp -s "$GOT" "$WANT"; then
      say "$elf: вывод совпал с эталоном байт в байт, код 0"
      ok=$((ok + 1))
    else
      say "$elf: канал вывод — код $code (нужен 0), вывод $(wc -c < "$GOT" 2>/dev/null || echo '?') байт против эталона $(wc -c < "$WANT" 2>/dev/null || echo '?') — РАСХОЖДЕНИЕ"
      bad=$((bad + 1))
    fi
    continue
  fi
  run_binary "$path" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    say "$elf: код $code — совпал с эталоном"
    ok=$((ok + 1))
  else
    say "$elf: код $code, эталон $expected — РАСХОЖДЕНИЕ"
    bad=$((bad + 1))
  fi
done < "$EXPECTED"

say ""
say "итог: совпало $ok, расхождений $bad, файлов нет $miss"
say ""
say "Отчёт целиком — $OUT. Рядом с ним положите machine.txt из machine.sh:"
say "без модели процессора и версий тулчейна результат нечем подписать."
