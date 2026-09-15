/**
 * Gate перестановки: двойной прогон корпуса.
 *
 * Запуск:
 *   npx tsx src/scripts/reorder-gate.ts
 *   npm run gate:reorder
 *
 * Что делает: собирает весь корпус регистрового кода (фикстуры проекта +
 * корпус `reg-parity` + приложения с чистым входом `run_golden`), прогоняет
 * каждую программу дважды — линейно и после перестановки — на одной `RegVM` с
 * одинаковым хостом, и сверяет значение, трассу вызовов и набор инструкций.
 *
 * Код возврата: 0 — gate зелёный, 1 — есть расхождение или ошибка.
 *
 * ## Почему это отдельный шаг, а не часть `npm test`
 *
 * `npm test` проверяет, что код работает. Этот gate отвечает на другой вопрос:
 * **можно ли включать перестановку**. Он должен запускаться после `golden` и
 * быть отдельным шагом CI — как записано в `docs/register-ir-migration.md`:
 * «Новый скрипт `npm run parity` отдельным шагом после `golden`».
 *
 * Флаг `OSNOVA_VLIW_REORDER` при этом не требуется: gate проверяет саму
 * возможность включения, независимо от того, включена ли она сейчас.
 */

import * as fs from "fs";
import * as path from "path";
import { regModuleOf } from "../vliw/regOracle";
import {
  formatGateReport,
  runReorderGate,
  type GateCase,
} from "../vliw/reorderGate";
import type { StackValue } from "../runtime/vm/interpreter";

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES = path.join(ROOT, "src", "runtime", "fixtures");

/** Программы, которые завершаются сами. */
const TERMINATING_FILES = [
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
 * модуля, поэтому эффект разбавляется.
 */
const CYCLIC_FILES = [
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
const ILP_FILES = ["ilp-low.osnova", "ilp-mid.osnova", "ilp-high.osnova"];

/** Корпус конструкций: независимое ожидание, все завершаются. */
const PARITY_FILES = ["while.osnova", "foreach.osnova", "tuple.osnova", "try.osnova"];

/**
 * Приложения с чистым входом `run_golden` (указан в их `.osapp.yaml`).
 *
 * Оконный цикл живёт в отдельной процедуре `запуск()`; `run_golden` — чистая
 * завершающаяся процедура, поэтому приложение МОЖЕТ участвовать в gate.
 */
const GOLDEN_APPS: Array<{ file: string; entry: string; args: StackValue[] }> = [
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
const NON_TERMINATING = ["todo.osnova"];

function loadCase(file: string, entry?: string, args?: StackValue[]): GateCase {
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

async function main(): Promise<number> {
  const cases: GateCase[] = [];

  for (const f of TERMINATING_FILES) cases.push(loadCase(f));
  for (const f of CYCLIC_FILES) cases.push(loadCase(f));
  for (const f of ILP_FILES) cases.push(loadCase(f));
  for (const f of PARITY_FILES) cases.push(loadCase(path.join("reg-parity", f)));
  for (const app of GOLDEN_APPS) {
    cases.push(loadCase(app.file, app.entry, app.args));
  }
  for (const f of NON_TERMINATING) {
    cases.push({ ...loadCase(f), expectNonTerminating: true });
  }

  const report = await runReorderGate(cases, { maxSteps: 200_000 });
  console.log(formatGateReport(report));

  // Дополнительно печатаем, какие программы какие: это помогает читать лог.
  console.log("");
  console.log(
    `всего программ: ${cases.length} ` +
      `(завершающихся ${cases.length - NON_TERMINATING.length}, ` +
      `исключено явно ${NON_TERMINATING.length})`,
  );

  return report.passed ? 0 : 1;
}

void main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("gate: непредвиденная ошибка:", err);
    process.exit(1);
  },
);
