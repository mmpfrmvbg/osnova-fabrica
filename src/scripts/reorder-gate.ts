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
 *
 * Корпус живёт в `src/scripts/corpus.ts` — им же пользуется `gate:pack`, чтобы
 * оба gate'а мерили на одном и том же наборе программ.
 */

import { formatGateReport, runReorderGate } from "../vliw/reorderGate";
import { collectCases, NON_TERMINATING } from "./corpus";

async function main(): Promise<number> {
  const cases = collectCases();
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
