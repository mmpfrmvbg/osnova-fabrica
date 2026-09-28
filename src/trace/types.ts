// ============================================================
// src/trace/types.ts — Формат трейса прогона (traces-v1)
// Источник истины — этот файл и src/pipeline/types.ts
// Документация: docs/traces-v1.md (должна синхронизироваться с кодом)
// Запись: src/trace/traceStore.ts | Чтение: src/scripts/export-dataset.ts
// ============================================================

import type {
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineTracePersistedStatus,
} from '../pipeline/types';
import type { ShadowHit } from '../pipeline/shadowMode';
import type { DiagnosticPhase, DiagnosticSeverity } from '../compiler/diagnosticCatalogue';

export type { DiagnosticPhase, DiagnosticSeverity };

/**
 * Одна диагностика прогона в журнале — машинная личность отказа.
 *
 * **Зачем отдельное поле.** До него журнал знал об отказах только счётчики
 * (`semanticErrorCount`, `lastErrorKind`), а сами ошибки лежали во вложенных
 * отчётах — и то не всегда: замер 2026-09-28 показал `semanticErrors` в 43
 * записях из 4605 (`docs/trace-failure-report.md:17`), события VM не попадали
 * в журнал вовсе. По счётчику нельзя ни сгруппировать отказы по причине, ни
 * увидеть, чего именно не хватает каналу. Код (`OSN-SEM-001`, `OSN-RT-002`, …)
 * — то, по чему группируют.
 *
 * **Фазы и уровни** взяты из каталога компилятора
 * (`src/compiler/diagnosticCatalogue.ts`) — своего перечня здесь нет намеренно:
 * два перечня разъедутся.
 *
 * **Чего здесь намеренно нет.** Текста исходника, значений переменных
 * окружения и стека VM: журнал не канал утечки. Подробности (`ParserError.node`,
 * `VMError.stack`, сам `source`) остаются во вложенных отчётах записи —
 * `diagnostics` это **исчисляемая** проекция, а не копия.
 */
export interface DiagnosticRecord {
  /** Стабильный машинный код: `OSN-SEM-001`, `OSN-CG-001`, `OSN-RT-900`. */
  readonly code: string;
  /** Фаза, назвавшая причину. */
  readonly phase: DiagnosticPhase;
  /** Уровень: блокирующая ошибка или совет. */
  readonly severity: DiagnosticSeverity;
  /** Сообщение той же фазы — как его назвал компилятор или VM. */
  readonly message: string;
  /** Вид ошибки, когда он есть (`SemanticError.kind`, `CompilerError.kind`). */
  readonly kind?: string;
  /** Файл исходника, если фаза его назвала. */
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface TraceEntry {
  readonly runId: string;
  readonly timestamp: string;   // ISO 8601
  readonly status: PipelineTracePersistedStatus;
  readonly task: string;        // исходный текстовый запрос
  readonly modelId?: string;    // OSNOVA_MODEL, для анализа качества по провайдерам
  readonly intent?: OsnovaIntent;
  readonly spec?: OsnovaSpec;
  readonly source?: OsnovaSource;
  readonly buildReport?: BuildReport;
  readonly goldenReport?: GoldenReport;
  readonly repairAttempts: number;
  /** Всего семантических ошибок в build (A-3) */
  readonly semanticErrorCount?: number;
  /** Kind последней доминирующей ошибки при repair_exhausted (A-2) */
  readonly lastErrorKind?: string;
  /**
   * Диагностика прогона: виды с кодами. Поле **опциональное** — записи,
   * написанные до его появления, обязаны читаться без него (проверено на живом
   * журнале, `src/trace/diagnosticsJournalReport.ts`).
   */
  readonly diagnostics?: DiagnosticRecord[];
  readonly shadow_hits?: ShadowHit[];
}
