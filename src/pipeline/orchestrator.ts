// ============================================================
// src/pipeline/orchestrator.ts — Линейный пайплайн v0.1
// DEBT-002: DAG-оркестратор — в v0.2
// Фазы: intake → spec_generation → codegen → build → golden_check → [repair]
// ============================================================

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { IntakeAgent } from '../agents/IntakeAgent';
import { OsnovaCodegenAgent } from '../agents/OsnovaCodegen';
import { RepairEngineerAgent } from '../agents/RepairEngineer';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import { QUALITY_PARTIAL, QUALITY_PASS } from './thresholds';
import { BLOCKING_SEMANTIC_KINDS } from './semanticKinds';
import { saveTrace } from '../trace/traceStore';
import { logger } from '../logger';
import { compileSource, compileToBuildReport } from '../compiler/compiler';
import { runGoldenCheck } from '../runtime/goldenApps';
import { loadRegistry, loadAppRegistry, registryToContext } from '../runtime/loadRegistry';
import {
  toPipelineTracePersistedStatus,
  type OsnovaIntent,
  type OsnovaSpec,
  type OsnovaSource,
  type BuildReport,
  type GoldenReport,
  type PipelineResult,
  type IPipelineStep,
  type PipelineContext,
  type StepResult,
} from './types';
import { analyzeShadow } from './shadowMode';
import type { ShadowHit } from './shadowMode';

/** Реэкспорт из compiler — единая логика blocking semantic kinds. */
export { compileToBuildReport };

const log = logger('pipeline');
const MAX_REPAIR_LOOPS = 3;

// T-6: append в repair-failures.jsonl при exhaustion
function appendRepairFailure(entry: {
  ts: string;
  traceId: string;
  category: string;
  last_error_kind: string;
  task_summary: string;
}): void {
  try {
    const target = path.resolve('runs/repair-failures.jsonl');
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(target, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[orchestrator] appendRepairFailure failed:', err);
  }
}

function categoryForRepairFailure(intent?: OsnovaIntent): string {
  if (!intent) return 'unknown';
  if (intent.appType) return String(intent.appType);
  const f = intent.features?.[0];
  return f ?? 'unknown';
}

/**
 * Проверяет наличие blocking semantic errors в buildReport.
 * Если есть хотя бы один — финальный статус не может быть 'success'.
 */
export function hasBlockingSemanticErrors(report: BuildReport | undefined): boolean {
  if (!report) return false;
  return (report.semanticErrors ?? []).some(
    e => (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(e.kind),
  );
}

/**
 * A-2: Извлекает kind последней ошибки из buildReport.
 * Приоритет: semantic (blocking) → compiler → parser → lexer → semantic (non-blocking).
 * Если ничего нет → 'unknown'.
 */
export function extractLastErrorKind(report: BuildReport | undefined): string {
  if (!report) return 'unknown';
  const blocking = (report.semanticErrors ?? []).filter(e =>
    (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(e.kind),
  );
  if (blocking.length > 0) return blocking[blocking.length - 1]!.kind;
  if ((report.compilerErrors ?? []).length > 0) {
    const last = report.compilerErrors![report.compilerErrors!.length - 1]!;
    return (last as { kind?: string }).kind ?? 'compiler_error';
  }
  if ((report.parserErrors ?? []).length > 0) return 'parser_error';
  if ((report.lexerErrors ?? []).length > 0) return 'lexer_error';
  if ((report.semanticErrors ?? []).length > 0) {
    return report.semanticErrors![report.semanticErrors!.length - 1]!.kind ?? 'semantic_warning';
  }
  return 'unknown';
}

export async function runPipeline(
  task: string,
): Promise<PipelineResult> {
  const runId = randomUUID();
  const registry = loadRegistry();
  const appRegistry = loadAppRegistry();
  const registryContext = registryToContext(registry, appRegistry);
  const startTime = Date.now();
  const modelId = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
  let repairAttempts = 0;

  let intent: OsnovaIntent | undefined;
  let spec: OsnovaSpec | undefined;
  let source: OsnovaSource | undefined;
  let buildReport: BuildReport | undefined;
  let goldenReport: GoldenReport | undefined;
  let lastSource: OsnovaSource | undefined;
  let shadowHits: ShadowHit[] = [];

  try {
    // ─── Фаза 1: intake ───
    log.info('phase: intake');
    const intake = new IntakeAgent(registryContext);
    intent = await intake.parseIntent({ text: task });

    // ─── Фаза 2: spec_generation ───
    log.info('phase: spec_generation');
    spec = await intake.generateSpec(intent);
    intake.checkSpec(spec);

    // ─── Gate G1 ───
    const g1 = checkG1(intent, spec);
    if (!g1.passed) {
      log.error('gate G1 FAIL', g1.failedChecks);
      return finish('error', `G1 failed: ${g1.failedChecks[0]}`);
    }
    log.info('gate G1 passed');

    // ─── Фаза 3: codegen ───
    log.info('phase: codegen');
    const codegen = new OsnovaCodegenAgent(registryContext);
    source = await codegen.generate(spec);
    lastSource = source;

    // Shadow Mode: анализировать source после codegen (RFC-002, RFC-003)
    const shadowReport = analyzeShadow(lastSource.source);
    shadowHits = shadowReport.hits;
    log.info('shadow mode', {
      rfc002: shadowReport.totalByRfc['RFC-002'],
      rfc003: shadowReport.totalByRfc['RFC-003'],
    });

    // ─── Repair loop: build → golden_check → repair ───
    for (let loop = 0; loop <= MAX_REPAIR_LOOPS; loop++) {
      // ─── Фаза 4: build ───
      log.info(`phase: build (attempt ${loop + 1})`);
      buildReport = compileToBuildReport(compileSource(lastSource.source));

      // ─── Gate G2 ───
      const g2 = checkG2(buildReport);
      if (!g2.passed) {
        log.warn(`gate G2 FAIL (attempt ${loop + 1})`, g2.failedChecks);
        if (buildReport.parserErrors?.length) {
          for (const e of buildReport.parserErrors) {
            log.info(`parser error: ${e.line}:${e.column} ${e.message}`);
          }
        }
        if (buildReport.compilerErrors?.length) {
          for (const e of buildReport.compilerErrors) {
            const msg = (e as { message?: string }).message ?? JSON.stringify(e);
            log.info(`compiler error: ${msg}`);
          }
        }
        if (buildReport.semanticErrors?.length) {
          for (const e of buildReport.semanticErrors) {
            log.info(`semantic error [${e.kind}]: ${e.message}`);
          }
        }
        if (loop >= MAX_REPAIR_LOOPS) break;
        const repair = new RepairEngineerAgent();
        lastSource = await repair.fix(lastSource, buildReport, undefined, loop + 1);
        repairAttempts++;
        continue;
      }
      log.info('gate G2 passed');

      // ─── Фаза 5: golden_check ───
      log.info('phase: golden_check');
      goldenReport = await runGoldenCheck(buildReport.bytecode, spec);

      // ─── Gate G3 ───
      const g3 = checkG3(goldenReport);
      const { qualityScore } = goldenReport;
      if (!g3.passed) {
        if (qualityScore >= QUALITY_PARTIAL && qualityScore < QUALITY_PASS) {
          log.info('qualityScore in [0.5, 0.7) — partial, no repair');
          source = lastSource;
          const result = finish('partial');
          await saveTrace({
            runId,
            status: toPipelineTracePersistedStatus(result.status),
            task,
            modelId,
            intent,
            spec,
            source,
            buildReport,
            goldenReport,
            repairAttempts,
            semanticErrorCount: (buildReport?.semanticErrors ?? []).length,
            shadow_hits: shadowHits,
          });
          return result;
        }
        log.warn(`gate G3 FAIL (attempt ${loop + 1})`, g3.failedChecks);
        if (loop >= MAX_REPAIR_LOOPS) break;
        const repair = new RepairEngineerAgent();
        lastSource = await repair.fix(lastSource, buildReport, goldenReport, loop + 1);
        repairAttempts++;
        continue;
      }

      log.info('gate G3 passed — pipeline complete');
      source = lastSource;

      const blockingSemErrors = hasBlockingSemanticErrors(buildReport);
      const anySemErrors = (buildReport?.semanticErrors ?? []).length > 0;
      if (blockingSemErrors) {
        log.warn('gate G3 passed but BLOCKING semantic errors present → partial');
      }
      if (!blockingSemErrors && anySemErrors) {
        log.info(
          `gate G3 passed with ${buildReport!.semanticErrors!.length} non-blocking semantic errors → success allowed`,
        );
      }
      // success только если: golden passed + нет blocking sem errors
      // non-blocking sem errors не блокируют success (по дизайну языка)
      const finalStatus = goldenReport.passed && !blockingSemErrors ? 'success' : 'partial';
      const result = finish(finalStatus);
      await saveTrace({
        runId,
        status: toPipelineTracePersistedStatus(result.status),
        task,
        modelId,
        intent,
        spec,
        source,
        buildReport,
        goldenReport,
        repairAttempts,
        semanticErrorCount: (buildReport?.semanticErrors ?? []).length,
        shadow_hits: shadowHits,
      });
      return result;
    }

    // repair exhausted — A-2: сохраняем kind последней ошибки
    const lastErrorKind = extractLastErrorKind(buildReport);
    if (lastErrorKind === 'unknown') {
      log.warn('A-2: repair_exhausted без определённого error.kind — buildReport пустой или нет ошибок');
    } else {
      log.error('repair loop exhausted', { repairAttempts, lastErrorKind });
    }
    const result = finish('repair_exhausted', 'max repair loops reached', lastErrorKind);
    await saveTrace({
      runId,
      status: toPipelineTracePersistedStatus(result.status),
      task,
      intent,
      spec,
      source: lastSource,
      buildReport,
      goldenReport,
      repairAttempts,
      modelId,
      lastErrorKind,
      semanticErrorCount: (buildReport?.semanticErrors ?? []).length,
      shadow_hits: shadowHits,
    });
    appendRepairFailure({
      ts: new Date().toISOString(),
      traceId: runId,
      category: categoryForRepairFailure(intent),
      last_error_kind: lastErrorKind,
      task_summary: task.slice(0, 120),
    });
    return result;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('unhandled error', message);
    try {
      await saveTrace({
        runId,
        status: 'error',
        task,
        modelId,
        intent,
        spec,
        source: lastSource ?? source,
        buildReport,
        goldenReport,
        repairAttempts,
        shadow_hits: shadowHits,
      });
    } catch (traceErr) {
      console.warn('[orchestrator] saveTrace failed:', traceErr);
    }
    return finish('error', message);
  }

  function finish(status: PipelineResult['status'], error?: string, lastErrorKind?: string): PipelineResult {
    return {
      status,
      intent,
      spec,
      source,
      buildReport,
      goldenReport,
      repairAttempts,
      totalDurationMs: Date.now() - startTime,
      shadow_hits: shadowHits,
      error,
      lastErrorKind,
    };
  }
}

/**
 * Orchestrator: выполняет пайплайн по шагам.
 * @param steps - шаги пайплайна (IPipelineStep[])
 * @param initialContext - начальный контекст выполнения
 * @returns результат выполнения последнего шага
 */
export async function executePipeline(
  steps: IPipelineStep[],
  initialContext: PipelineContext,
): Promise<StepResult> {
  const sortedSteps = [...steps].sort((a, b) => a.order - b.order);
  let context: PipelineContext = initialContext;
  let result: StepResult = { success: true, context, repairAttempts: 0 };

  for (const step of sortedSteps) {
    if (step.canExecute && !step.canExecute(context)) {
      result = {
        success: false,
        context,
        error: {
          type: 'unknown',
          message: `Step ${step.id} cannot execute: preconditions not met`,
          phase: step.phase,
        },
        repairAttempts: result.repairAttempts,
      };
      break;
    }

    try {
      result = await step.execute(context);
      if (!result.success) {
        break;
      }
      context = result.context;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        success: false,
        context,
        error: {
          type: 'unknown',
          message,
          phase: step.phase,
          retryable: true,
        },
        repairAttempts: result.repairAttempts,
      };
      break;
    }
  }

  return result;
}
