/**
 * Gate упаковки: `packInstructions` на всём корпусе.
 *
 * Запуск:
 *   npx tsx src/scripts/pack-gate.ts
 *   npm run gate:pack
 *
 * Прогоняет каждую программу корпуса линейно и после упаковки, сверяет
 * исполненные инструкции, значение, трассу хост-вызовов и текст ошибки, а также
 * требует, чтобы `verifyPackets` не нашёл нарушений в упакованном модуле.
 *
 * Метрика — **плотность упаковки**: инструкций на элемент кода. Это статическая
 * величина, а не скорость: сколько тактов программа займёт на настоящем e2k, из
 * неё не следует.
 *
 * Код возврата: 0 — gate зелёный, 1 — красный.
 */

import { e2kMachineModel } from "../vliw/e2kMachineModel";
import { formatPackGateReport, runPackGate } from "../vliw/packGate";
import { collectCases, NON_TERMINATING, TERMINATING_COUNT } from "./corpus";

async function main(): Promise<number> {
  const cases = collectCases();
  const report = await runPackGate(cases, { model: e2kMachineModel(), maxSteps: 200_000 });
  console.log(formatPackGateReport(report));
  console.log("");
  console.log(
    `всего программ: ${cases.length} ` +
      `(завершающихся ${TERMINATING_COUNT}, исключено явно ${NON_TERMINATING.length})`,
  );

  return report.passed ? 0 : 1;
}

void main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("gate:pack: непредвиденная ошибка:", err);
    process.exit(1);
  },
);
