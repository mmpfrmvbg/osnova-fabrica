/**
 * ЦЕЛЬ КОМПИЛЯЦИИ: ФЛАГ `--target e2k` — «а соберётся ли это НА ЦЕЛИ».
 *
 * # Пропасть, которую он закрывает
 *
 * `osnova compile` на программе с неподнятой конструкцией говорит «Скомпилировано» и выходит
 * **нулём**: конвейер цели собирает образ, выбрасывая носитель, которому нет формы понижения
 * (`src/e2k/programImage.ts` → `refused: string[]`). Замер (коммит `c915668`): тело `вернуть 17 % 5`
 * — образ **112 байт**, **1 отказ** (`IR.rem`), а человек видит одну строку «Скомпилировано».
 * Это худший из трёх классов расхождений — не отказ, а **тихая ложь**: программа «собралась»,
 * а число на цели будет неверным.
 *
 * # Почему ФЛАГ, а не подкоманда
 *
 * 1. **Работа команды не меняется:** `compile` компилирует ровно то же и пишет тот же артефакт;
 *    флаг добавляет ПРОВЕРКУ цели и код возврата. Подкоманда (`compile-e2k`) завела бы второй
 *    путь сборки с теми же ключами (`-o`, `--diagnostics`) — а в дереве уже записано, что
 *    «флаг, понятный только другой точке входа, — ровно тот разъезд реализаций», от которого
 *    заводили общий модуль вывода (`src/compiler/cliCompile.ts`). Здесь тот же выбор: один разбор
 *    аргументов, три точки входа.
 * 2. **Совместимость по построению:** без флага не меняется ни строка вывода, ни код возврата.
 * 3. **Флаг уже есть образцом:** `--diagnostics=json` разбирается всеми точками входа и живёт
 *    рядом с `-o`; цель встаёт в тот же разбор.
 *
 * # Форма вывода — НЕ своя
 *
 * Человеческий вид печатает наблюдатель `src/scripts/e2kLoweringDiagnostics.ts` (его точка входа
 * `runLoweringDiagnosticsCli`): `[класс] #NN МНЕМОНИКА: причина`, строка «образ N байт, регистров M,
 * отказов K» и предупреждение «ВНИМАНИЕ: образ собран, но носители выброшены — на цели число будет
 * неверным». Здесь **не изобретается второй формат**: человеческий режим вызывает наблюдателя,
 * машинный (`--diagnostics=json`) печатает его же JSONL-записи (`formatLoweringDiagnosticJson`),
 * чтобы stdout оставался чистым JSONL.
 *
 * # Код возврата
 *
 * `0` — на цели собирается без отказов; `1` — есть отказы понижения (или образ не собран);
 * `1` — цель не поддержана (названный отказ, не молчание). Без флага разбор цели не влияет ни на что.
 */
import * as fs from "fs";
import * as path from "path";
import type { DiagnosticsFormat } from "../compiler/compileDiagnostics";
import {
  formatLoweringDiagnosticJson,
  loweringDiagnosticsOf,
  runLoweringDiagnosticsCli,
} from "../scripts/e2kLoweringDiagnostics";

/** Известные цели компиляции. Пока одна — и это названо, а не умолчано. */
export const COMPILE_TARGETS: readonly string[] = ["e2k"];

/** Цель компиляции. */
export type CompileTarget = "e2k";

/** Стоки вывода: те же два, что у отказа канала (`src/compiler/cliCompile.ts`). */
export interface TargetIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Разбор `--target`: что названо, чем отказано и какие слова флаг «съел». */
export interface TargetArgument {
  /** Названная цель; `undefined` — флага нет, поведение команды не меняется. */
  readonly target?: CompileTarget;
  /** Причина отказа разбора (неизвестная цель, пустое значение) — печатается как есть. */
  readonly problem?: string;
  /**
   * Индексы аргументов, занятых флагом (сам флаг и его значение).
   *
   * Нужны вызывающему: без них значение `e2k` попадает в поиск входного файла и команда
   * отвечает «Файл не найден: …\e2k» — то есть флаг ломает разбор молча (замер до правки:
   * `compile проба.osnova --target e2k` искал файл с именем `e2k`).
   */
  readonly consumed: readonly number[];
}

/**
 * Разобрать `--target <цель>` (и форму `--target=<цель>`).
 *
 * Неизвестная цель — **названный отказ**, а не умолчание: молчаливое «понял как e2k» здесь
 * опаснее ошибки, потому что человек считал бы, что проверил другую цель.
 */
export function parseTargetArgument(argv: readonly string[]): TargetArgument {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const inline = /^--target=(.*)$/s.exec(arg);
    if (inline !== null) {
      const value = inline[1]!.trim();
      if (value === "") return { problem: targetProblem(""), consumed: [i] };
      if (!COMPILE_TARGETS.includes(value)) return { problem: targetProblem(value), consumed: [i] };
      return { target: value as CompileTarget, consumed: [i] };
    }
    if (arg !== "--target") continue;
    const value = (argv[i + 1] ?? "").trim();
    if (value === "" || value.startsWith("-")) return { problem: targetProblem(value), consumed: [i] };
    if (!COMPILE_TARGETS.includes(value)) return { problem: targetProblem(value), consumed: [i, i + 1] };
    return { target: value as CompileTarget, consumed: [i, i + 1] };
  }
  return { consumed: [] };
}

/** Отказ разбора цели: названы и то, что не поддержано, и то, что поддержано. */
function targetProblem(value: string): string {
  const named = value === "" ? "пустое значение" : `«${value}»`;
  return (
    `Цель ${named} не поддержана. Известные цели: ${COMPILE_TARGETS.join(", ")} ` +
    "(проверка понижения конвейера цели: соберётся ли программа на e2k без выброшенных носителей). " +
    "Использование: osnova compile <файл.osnova> [--target e2k]"
  );
}

/**
 * Проверка цели по уже прочитанному исходнику: печатает отказы и возвращает код возврата.
 *
 * Человеческий режим отдаётся наблюдателю целиком (один формат на дерево), машинный — его же
 * JSONL-записями в `out`: смешивать человеческие строки с JSONL нельзя, иначе `--diagnostics=json`
 * перестаёт быть машинным каналом.
 */
export function checkCompileTarget(options: {
  readonly file: string;
  readonly format: DiagnosticsFormat;
  readonly io: TargetIo;
}): number {
  if (options.format !== "json") return runLoweringDiagnosticsCli([options.file]);
  const source = fs.readFileSync(options.file, "utf-8");
  const report = loweringDiagnosticsOf(source, path.basename(options.file));
  for (const diagnostic of report.diagnostics) options.io.out(formatLoweringDiagnosticJson(diagnostic));
  return report.built && report.refusedTotal === 0 ? 0 : 1;
}

/**
 * Строка справки для `--help`: флаг обязан быть виден там, где его ищет человек.
 */
export const TARGET_USAGE =
  "  --target e2k                      Проверить цель: напечатать отказы понижения и выйти кодом 1,\n" +
  "                                    если на e2k часть носителей выброшена (иначе поведение прежнее)";
