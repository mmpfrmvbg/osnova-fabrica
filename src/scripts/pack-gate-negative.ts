/**
 * Негативный контроль gate'а конвейера.
 *
 * Запуск:
 *   npx tsx src/scripts/pack-gate-negative.ts
 *   npm run gate:pack:negative
 *
 * ## Зачем
 *
 * Зелёный gate сам по себе ничего не доказывает: он может быть зелёным потому,
 * что ничего не проверяет. Поэтому каждое правило ломается по очереди, и gate
 * обязан покраснеть. Дефекты вносятся в **настоящий** код параметром
 * (`PackDefects` упаковщика, `PipelineDefects` конвейера), а не в копию
 * алгоритма: копия стареет вместе с кодом.
 *
 * ## Что здесь видно
 *
 * Какой именно контроль ловит дефект. Это не деталь:
 *
 * - RAW / WAR / WAW и совместимость со слотами **не видны прогону** (VM исполняет
 *   слоты последовательно), их ловит только `verifyPackets`;
 * - цель перехода внутри пакета `verifyPackets` увидеть не может, её ловит прогон;
 * - подмена модуля на стыке «перестановка → упаковка» не видна ни верификатору,
 *   ни сравнению с эталоном по НАБОРУ инструкций: её ловит только сравнение
 *   ПОРЯДКА с конфигурацией перестановки.
 *
 * Код возврата: 0 — все дефекты пойманы; 1 — какой-то дефект прошёл незамеченным.
 */

import { e2kMachineModel } from "../vliw/e2kMachineModel";
import { runPackGate, type PackGateReport } from "../vliw/packGate";
import type { PackDefects } from "../vliw/packetPacker";
import type { PipelineDefects } from "../vliw/vliwPipeline";
import { collectCases } from "./corpus";

interface Variant {
  label: string;
  defects?: PackDefects;
  pipelineDefects?: PipelineDefects;
  /** Какой контроль обязан среагировать. */
  expected: string;
}

const VARIANTS: Variant[] = [
  {
    label: "регистры (RAW/WAR/WAW) не проверяются",
    defects: { ignoreRegisters: true },
    expected: "только verifyPackets: VM исполняет слоты последовательно и RAW не видит",
  },
  {
    label: "передача управления не закрывает пакет",
    defects: { ignoreControlTransfer: true },
    expected: "verifyPackets и эквивалентность (измеренный дефект: 49 вместо 1049)",
  },
  {
    label: "совместимость со слотами не проверяется",
    defects: { ignoreSlots: true },
    expected: "только verifyPackets: конфликт слотов",
  },
  {
    label: "цель перехода не открывает пакет",
    defects: { ignoreEntryPoints: true },
    expected: "только эквивалентность: verifyPackets этого не видит",
  },
  {
    label: "на стыке упакован исходный модуль вместо переставленного",
    pipelineDefects: { packOriginalAfterReorder: true },
    expected:
      "только сравнение ПОРЯДКА с перестановкой: набор инструкций и значение при этом совпадают",
  },
];

function firstRedProblem(report: PackGateReport): string {
  for (const c of report.cases) {
    if (c.problems.length > 0) return `${c.name}: ${c.problems[0]}`;
  }
  return "—";
}

/** Сколько программ поймал верификатор и сколько — сравнение прогонов. */
function caughtBy(report: PackGateReport): { verifier: number; runs: number } {
  let verifier = 0;
  let runs = 0;
  for (const c of report.cases) {
    if (c.configs.some((x) => !x.verify.ok)) verifier++;
    if (c.configs.some((x) => !x.equivalent)) runs++;
  }
  return { verifier, runs };
}

async function main(): Promise<number> {
  const cases = collectCases();
  const model = e2kMachineModel();

  console.log("Негативный контроль gate'а конвейера VLIW");
  console.log(`корпус: ${cases.length} программ, модель: ${model.slots} слотов, конфигураций: 4`);
  console.log("");

  // 0. Базовая линия: без дефектов gate обязан быть зелёным. Иначе негативный
  // контроль бессмыслен: нельзя утверждать, что красное вызвано дефектом.
  const baseline = await runPackGate(cases, { model, maxSteps: 200_000 });
  console.log(
    `базовая линия (без дефектов): ${baseline.passed ? "gate зелёный" : "gate КРАСНЫЙ"} ` +
      `(зелёных ${baseline.green}, красных ${baseline.red})`,
  );
  if (!baseline.passed) {
    console.log(`  первая причина: ${firstRedProblem(baseline)}`);
  }
  console.log("");

  let caught = 0;
  let missed = 0;
  for (const variant of VARIANTS) {
    const report = await runPackGate(cases, {
      model,
      maxSteps: 200_000,
      ...(variant.defects !== undefined ? { defects: variant.defects } : {}),
      ...(variant.pipelineDefects !== undefined ? { pipelineDefects: variant.pipelineDefects } : {}),
    });
    const isRed = !report.passed;
    if (isRed) caught++;
    else missed++;

    const by = caughtBy(report);
    console.log(`дефект: ${variant.label}`);
    console.log(`  gate: ${isRed ? "КРАСНЫЙ" : "зелёный (дефект НЕ пойман)"}`);
    console.log(`  поймал верификатор: ${by.verifier} программ; расхождение прогонов: ${by.runs} программ`);
    console.log(`  первая причина: ${firstRedProblem(report)}`);
    console.log(`  ожидание: ${variant.expected}`);
    console.log("");
  }

  console.log(`итого дефектов: ${VARIANTS.length}, поймано: ${caught}, пропущено: ${missed}`);
  const ok = missed === 0 && baseline.passed;
  console.log(
    ok
      ? "негативный контроль пройден: каждое снятое правило делает gate красным"
      : "негативный контроль НЕ пройден",
  );
  return ok ? 0 : 1;
}

void main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("gate:pack:negative: непредвиденная ошибка:", err);
    process.exit(1);
  },
);
