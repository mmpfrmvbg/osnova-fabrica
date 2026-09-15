/**
 * Флаг подключения перестановки и gate с двойным прогоном.
 *
 * ## Зачем флаг, а не включение по умолчанию
 *
 * В `docs/vliw-reg-plan.md` записано требование: «**Не включать планировщик по
 * умолчанию** до зелёного оракула: CLI-команда и тесты, как у Шага 1». Оракул
 * теперь есть (`runReorderEquivalence`, CLI `osnova reorder`), но включение
 * меняет поведение существующих тестов и golden-прогона. Поэтому:
 *
 * - по умолчанию перестановка **выключена** (`OSNOVA_VLIW_REORDER` не задан или
 *   равен `0`/`false`/`off`/`no`);
 * - включается явным `OSNOVA_VLIW_REORDER=1`;
 * - значение `respectClusters` тоже читается из окружения
 *   (`OSNOVA_VLIW_CLUSTERS`), потому что замер показал: на текущем корпусе оно
 *   не даёт ничего, и это должно быть видно в том же флаге.
 *
 * ## Gate: почему двойной прогон
 *
 * Смысл gate — ответить на вопрос «можно ли включать». Ответ даётся не
 * мнением, а двумя прогонами одного и того же корпуса: с перестановкой и без.
 * Совпадение наблюдаемого поведения (значение, трасса вызовов, набор инструкций)
 * на всём корпусе = включать безопасно. Любое расхождение = gate красный, и
 * приведён конкретный файл и шаг расхождения.
 *
 * Это тот же принцип, что у `docs/register-ir-migration.md`: «Не мерить паритет
 * через „golden passed". Совпадение вывода при расхождении трассы маскирует
 * баги — сравнение только по трассе».
 */

import { runReorderEquivalence, type ReorderEquivalenceReport } from "./reorderEquivalence";
import { scheduleRegWithReorder } from "./reorderScheduler";
import { isRegPacket, type RegInstruction, type RegModule } from "../runtime/vm/regcode";
import type { StackValue } from "../runtime/vm/interpreter";
import type { MemoryLevel } from "./pipelineCounters";

/** Имя переменной окружения, включающей перестановку. */
export const REORDER_FLAG = "OSNOVA_VLIW_REORDER";

/**
 * Включена ли перестановка по переменной окружения.
 *
 * По умолчанию **выключена**: любое значение, кроме явного `1`/`true`/`on`/`yes`,
 * считается «выключено». Это намеренно — флаг должен включаться осознанно, а не
 * случайным `OSNOVA_VLIW_REORDER=0`, который кто-то примет за «включено».
 */
export function reorderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[REORDER_FLAG] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * Учитывать ли кластеры АЛУ. Отдельный флаг, потому что замер показал: на
 * текущем корпусе это не даёт ничего (расписания совпадают побитово), и такую
 * настройку нужно уметь отключать, не трогая код.
 *
 * По умолчанию **включено** (как в коде планировщика) — но это не про
 * производительность, а про факт из документа.
 */
export function clustersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OSNOVA_VLIW_CLUSTERS ?? "").trim().toLowerCase();
  if (raw === "") return true;
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** Одна программа корпуса для gate. */
export interface GateCase {
  /** Имя для отчёта. */
  name: string;
  /** Регистровый модуль. */
  module: RegModule;
  /** Точка входа (по умолчанию — первая, как её находит оракул). */
  entryProcedure?: string;
  /** Аргументы точки входа. */
  args?: StackValue[];
  /**
   * Ожидается ли, что программа НЕ завершается (оконный цикл). Для таких
   * случаев gate не требует `ok` — но требует, чтобы оракул честно сказал
   * «эквивалентность не доказана», а не отрапортовал успех.
   */
  expectNonTerminating?: boolean;
}

/** Результат одной программы в gate. */
export interface GateCaseResult {
  name: string;
  ok: boolean;
  message: string;
  expectedFailure: boolean;
  /**
   * Четыре условия, которые владелец назвал обязательными для замеров на
   * программе (а не на отдельной процедуре):
   *
   * 1. сколько процедур **переставлено** (порядок выдачи изменён) — видно, что
   *    модульность действительно задействована;
   * 2. `addressesValid` — адреса корректны глобально (длина кода не изменилась,
   *    все `codeOffset` внутри кода);
   * 3. `cyclesChanged` — такты по модулю изменились. Если нет — это тоже
   *    результат («на этом классе программ выигрыша нет»), но его надо видеть, а
   *    не предполагать;
   * 4. `resultMatches` — значение и трасса совпали с линейным прогоном.
   */
  conditions?: {
    proceduresReordered: boolean;
    /** Сколько процедур переставлено (порядок выдачи изменён). */
    reorderedCount: number;
    addressesValid: boolean;
    cyclesChanged: boolean;
    cycleGain: number;
    resultMatches: boolean;
  };
}

/** Итог gate. */
export interface GateReport {
  passed: boolean;
  cases: GateCaseResult[];
  /** Сколько программ реально проверено на эквивалентность. */
  proven: number;
  /** Сколько исключено как незавершающиеся (с явной причиной). */
  excluded: number;
}

export interface GateOptions {
  memoryLevel?: MemoryLevel;
  maxSteps?: number;
  entryMaxSteps?: number;
}

/**
 * Прогон gate по корпусу.
 *
 * Возвращает `passed: true` только если:
 * - каждая завершающаяся программа доказала эквивалентность;
 * - каждая незавершающаяся честно получила `ok: false` (а не ложный успех);
 * - нигде не было ошибки исполнения.
 */
export async function runReorderGate(
  cases: readonly GateCase[],
  options: GateOptions = {},
): Promise<GateReport> {
  const results: GateCaseResult[] = [];
  let proven = 0;
  let excluded = 0;

  for (const c of cases) {
    const report: ReorderEquivalenceReport = await runReorderEquivalence(c.module, {
      ...(c.entryProcedure !== undefined ? { entryProcedure: c.entryProcedure } : {}),
      ...(c.args !== undefined ? { args: c.args } : {}),
      ...(options.memoryLevel !== undefined ? { memoryLevel: options.memoryLevel } : {}),
      maxSteps: options.maxSteps ?? options.entryMaxSteps ?? 200_000,
    });

    if (c.expectNonTerminating === true) {
      excluded++;
      // Честный отказ — это успех gate: оракул не должен объявлять
      // эквивалентность на взаимном падении.
      const honest = report.ok === false && report.message.includes("не доказана");
      results.push({
        name: c.name,
        ok: honest,
        message: honest
          ? `исключён (${report.message})`
          : `ОЖИДАЛСЯ честный отказ, получено: ok=${report.ok}, «${report.message}»`,
        expectedFailure: true,
      });
      continue;
    }

    if (report.ok) proven++;
    results.push({
      name: c.name,
      ok: report.ok,
      message: report.message,
      expectedFailure: false,
      conditions: moduleConditions(c.module, report),
    });
  }

  return {
    passed: results.every((r) => r.ok),
    cases: results,
    proven,
    excluded,
  };
}

/**
 * Проверка четырёх условий на уровне МОДУЛЯ.
 *
 * Отвечает на вопрос, который нельзя задать одной процедуре: задействована ли
 * модульность, корректны ли адреса глобально, изменились ли такты и совпал ли
 * результат. Первое условие особенно важно: без него «перестановка работает» на
 * деле означает «переставлена одна процедура из N».
 */
/** Границы тел процедур в модуле (дублирует логику `reorderEquivalence`). */
function moduleRanges(module: RegModule): Array<{ start: number; end: number }> {
  const offsets = module.procedures.map((p) => p.codeOffset);
  return offsets.map((start) => {
    const next = offsets.filter((c) => c > start).sort((a, b) => a - b)[0];
    return { start, end: next ?? module.code.length };
  });
}

function moduleConditions(
  module: RegModule,
  report: ReorderEquivalenceReport,
): NonNullable<GateCaseResult["conditions"]> {
  const ranges = moduleRanges(module);
  let reorderedCount = 0;
  for (const range of ranges) {
    const body = module.code
      .slice(range.start, range.end)
      .filter((el) => !isRegPacket(el)) as RegInstruction[];
    if (body.length < 2) continue;
    const r = scheduleRegWithReorder(body, { offsetBase: range.start });
    const localChanged = r.order.some((v, i) => v !== i);
    if (localChanged) reorderedCount++;
  }

  const scheduled = report.scheduledModule;
  const addressesValid =
    scheduled !== undefined &&
    scheduled.code.length === module.code.length &&
    scheduled.procedures.every(
      (p) => p.codeOffset >= 0 && p.codeOffset < scheduled.code.length,
    );

  return {
    proceduresReordered: reorderedCount > 0,
    reorderedCount,
    addressesValid,
    cyclesChanged: report.moduleCyclesReordered !== report.moduleCyclesInOrder,
    cycleGain: report.moduleCycleGain,
    resultMatches: report.tracesEqual && report.valuesEqual,
  };
}

/** Текстовый отчёт gate — для CI и ручного прогона. */
export function formatGateReport(report: GateReport): string {
  const lines: string[] = [];
  lines.push("=== gate перестановки: эквивалентность на корпусе ===");
  for (const r of report.cases) {
    const mark = r.ok ? "OK  " : "FAIL";
    const kind = r.expectedFailure ? " (ожидаемо исключён)" : "";
    lines.push(`  [${mark}] ${r.name}${kind}`);
    lines.push(`         ${r.message}`);
    if (r.conditions !== undefined) {
      const c = r.conditions;
      const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
      lines.push(
        `         условия: переставлено процедур ${c.reorderedCount}` +
          ` | адреса ${c.addressesValid ? "ok" : "ПЛОХИ"}` +
          ` | такты изменились: ${c.cyclesChanged ? "да" : "нет"} (${pct(c.cycleGain)})` +
          ` | результат совпал: ${c.resultMatches ? "да" : "НЕТ"}`,
      );
    }
  }
  lines.push("");
  lines.push(`доказано эквивалентности: ${report.proven}`);
  lines.push(`исключено (не завершаются): ${report.excluded}`);
  lines.push(`ИТОГ: ${report.passed ? "GATE ЗЕЛЁНЫЙ" : "GATE КРАСНЫЙ"}`);
  return lines.join("\n");
}
