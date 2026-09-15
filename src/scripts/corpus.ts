/**
 * Корпус программ для gate'ов VLIW: перестановка и упаковка.
 *
 * Список вынесен из `reorder-gate.ts` отдельным модулем по двум причинам:
 * 1. два gate'а обязаны мерить на **одном** корпусе — иначе «эквивалентность
 *    доказана на 18 программах» будет означать разные 18 программ;
 * 2. импортировать сам скрипт gate нельзя: он завершается вызовом `main()`.
 *
 * Проверялись 18 завершающихся программ; `todo.osnova` исключён явно, с причиной
 * (оконный цикл, чистого входа-оракула нет).
 */

import * as fs from "fs";
import * as path from "path";
import { regModuleOf } from "../vliw/regOracle";
import type { GateCase } from "../vliw/reorderGate";
import type { StackValue } from "../runtime/vm/interpreter";

const ROOT = path.resolve(__dirname, "..", "..");
export const FIXTURES = path.join(ROOT, "src", "runtime", "fixtures");

/** Программы, которые завершаются сами. */
export const TERMINATING_FILES = [
  "hello.osnova",
  "func_params.osnova",
  "task_stats.osnova",
  "storage_demo.osnova",
  "блокнот.osnova",
];

/**
 * Корпус **циклических мультипроцедурных** программ.
 *
 * Он отвечает на вопрос, которого не задаёт ни одна другая фикстура: даёт ли
 * перестановка выигрыш НА ПРОГРАММЕ, а не на отдельной процедуре. Планирование
 * всех процедур сделано (см. `applyReorderToWholeModule`), но до появления этого
 * корпуса измерять его было не на чем: вызываемые процедуры прежних приложений —
 * линейный код без циклов.
 *
 * Измеренный выигрыш (0.0%–2.4%) — честный: выигрыш VLIW растёт с числом
 * НЕЗАВИСИМЫХ цепочек в цикле, и в программе такие цепочки составляют лишь часть
 * модуля, поэтому эффект разбавляется. Выигрыш здесь — статическая длина
 * расписания, а не скорость исполнения.
 */
export const CYCLIC_FILES = [
  "cycle-multi.osnova",
  "cycle-nested.osnova",
  "cycle-array.osnova",
  "cycle-chains.osnova",
];

/**
 * Корпус с ЯВНО заданным уровнем ILP (низкий / средний / высокий).
 *
 * Служит для калибровки: показывает, что выигрыш зависит от числа независимых
 * цепочек, а не от наличия цикла как такового. Уровни заданы в комментариях
 * фикстур. Измерения — `docs/vliw-ilp-calibration.md`.
 */
export const ILP_FILES = ["ilp-low.osnova", "ilp-mid.osnova", "ilp-high.osnova"];

/** Корпус конструкций: независимое ожидание, все завершаются. */
export const PARITY_FILES = ["while.osnova", "foreach.osnova", "tuple.osnova", "try.osnova"];

/**
 * Приложения с чистым входом `run_golden` (указан в их `.osapp.yaml`).
 *
 * Оконный цикл живёт в отдельной процедуре `запуск()`; `run_golden` — чистая
 * завершающаяся процедура, поэтому приложение МОЖЕТ участвовать в gate.
 */
export const GOLDEN_APPS: Array<{ file: string; entry: string; args: StackValue[] }> = [
  {
    file: "game_rounds.osnova",
    entry: "run_golden",
    // Три раунда из game_rounds.osapp.yaml.
    args: [
      [
        { результат: "победа", очки: 15 },
        { результат: "поражение", очки: 5 },
        { результат: "победа", очки: 10 },
      ],
    ] as StackValue[],
  },
  {
    file: "micro_crm.osnova",
    entry: "run_golden",
    args: [[{ имя: "А" }]] as StackValue[],
  },
];

/**
 * Программы с известным незавершением — исключены ЯВНО, с причиной.
 *
 * `todo.osnova`: `запуск()` — оконный цикл, `handle_event`/`handle_add` требуют
 * внешнего события; чистой процедуры-оракула нет, и манифест указывает на цикл.
 */
export const NON_TERMINATING = ["todo.osnova"];

/** Сколько программ корпуса завершается (без явно исключённых). */
export const TERMINATING_COUNT =
  TERMINATING_FILES.length + CYCLIC_FILES.length + ILP_FILES.length + PARITY_FILES.length + GOLDEN_APPS.length;

/** Собрать случай корпуса: скомпилировать исходник в регистровый модуль. */
export function loadCase(file: string, entry?: string, args?: StackValue[]): GateCase {
  const full = path.join(FIXTURES, file);
  const built = regModuleOf(fs.readFileSync(full, "utf-8"));
  if (!built) {
    throw new Error(`gate: ${file} не компилируется`);
  }
  return {
    name: file,
    module: built.module,
    ...(entry !== undefined ? { entryProcedure: entry } : {}),
    ...(args !== undefined ? { args } : {}),
  };
}

/** Весь корпус: завершающиеся программы, приложения и явно исключённые. */
export function collectCases(): GateCase[] {
  const cases: GateCase[] = [];
  for (const f of TERMINATING_FILES) cases.push(loadCase(f));
  for (const f of CYCLIC_FILES) cases.push(loadCase(f));
  for (const f of ILP_FILES) cases.push(loadCase(f));
  for (const f of PARITY_FILES) cases.push(loadCase(path.join("reg-parity", f)));
  for (const app of GOLDEN_APPS) cases.push(loadCase(app.file, app.entry, app.args));
  for (const f of NON_TERMINATING) cases.push({ ...loadCase(f), expectNonTerminating: true });
  return cases;
}
