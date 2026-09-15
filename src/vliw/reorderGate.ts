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
import type { RegModule } from "../runtime/vm/regcode";
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
    });
  }

  return {
    passed: results.every((r) => r.ok),
    cases: results,
    proven,
    excluded,
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
  }
  lines.push("");
  lines.push(`доказано эквивалентности: ${report.proven}`);
  lines.push(`исключено (не завершаются): ${report.excluded}`);
  lines.push(`ИТОГ: ${report.passed ? "GATE ЗЕЛЁНЫЙ" : "GATE КРАСНЫЙ"}`);
  return lines.join("\n");
}
