// ============================================================
// src/pipeline/orchestrator.ts — Линейный пайплайн v0.1
// DEBT-002: DAG-оркестратор — в v0.2
// Фазы: intake → spec_generation → codegen → build → golden_check → [repair]
// ============================================================

import { randomUUID } from 'crypto';
import { IntakeAgent } from '../agents/IntakeAgent';
import { OsnovaCodegenAgent } from '../agents/OsnovaCodegen';
import { RepairEngineerAgent } from '../agents/RepairEngineer';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import { QUALITY_PARTIAL, QUALITY_PASS } from './thresholds';
import { BLOCKING_SEMANTIC_KINDS } from './semanticKinds';
import { saveTrace } from '../trace/traceStore';
import { logger } from '../logger';
import { compileSource, type CompileResult } from '../compiler/compiler';
import { runGoldenCheck } from '../runtime/goldenApps';
import { loadRegistry, registryToContext } from '../runtime/loadRegistry';
import type {
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineResult,
} from './types';

const log = logger('pipeline');
const MAX_REPAIR_LOOPS = 3;

/**
 * Адаптер: CompileResult (src/compiler/compiler.ts) → BuildReport (src/pipeline/types.ts).
 *
 * Разница:
 *   CompileResult.module       → BuildReport.bytecode
 *   + добавляет BuildReport.success = compilerSuccess && lexerErrors.length === 0
 */
export function compileToBuildReport(r: CompileResult): BuildReport {
  const blockingSemanticErrors = (r.semanticErrors ?? []).filter(
    e => (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(e.kind),
  );
  return {
    success:
      r.compilerSuccess &&
      r.lexerErrors.length === 0 &&
      r.parserErrors.length === 0 &&
      blockingSemanticErrors.length === 0,
    lexerErrors: r.lexerErrors,
    parserErrors: r.parserErrors,
    compilerErrors: r.compilerErrors,
    semanticErrors: r.semanticErrors ?? [],
    bytecode: r.module ?? null,
    compilerSuccess: r.compilerSuccess,
    durationMs: r.durationMs,
  };
}

export async function runPipeline(
  task: string,
): Promise<PipelineResult> {
  const runId = randomUUID();
  const registry = loadRegistry();
  const registryContext = registryToContext(registry);
  const startTime = Date.now();
  const modelId = process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';
  let repairAttempts = 0;

  let intent: OsnovaIntent | undefined;
  let spec: OsnovaSpec | undefined;
  let source: OsnovaSource | undefined;
  let buildReport: BuildReport | undefined;
  let goldenReport: GoldenReport | undefined;
  let lastSource: OsnovaSource | undefined;

  try {
    // ─── Фаза 1: intake ───
    log.info('phase: intake');
    const intake = new IntakeAgent(registryContext);
    intent = await intake.parseIntent({ text: task });

    // ─── Фаза 2: spec_generation ───
    log.info('phase: spec_generation');
    spec = await intake.generateSpec(intent);

    // ─── Gate G1 ───
    const g1 = checkG1(intent, spec);
    if (!g1.passed) {
      log.error('gate G1 FAIL', g1.failedChecks);
      return finish('failure', `G1 failed: ${g1.failedChecks[0]}`);
    }
    log.info('gate G1 passed');

    // ─── Фаза 3: codegen ───
    log.info('phase: codegen');
    const codegen = new OsnovaCodegenAgent(registryContext);
    source = await codegen.generate(spec);
    lastSource = source;

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
          log.info('qualityScore in [0.5, 0.7) — partial_success, no repair');
          source = lastSource;
          const result = finish('partial');
          await saveTrace({ runId, status: result.status, task, modelId, intent, spec, source, buildReport, goldenReport, repairAttempts });
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

      const result = finish(goldenReport.passed ? 'success' : 'partial');
      await saveTrace({ runId, status: result.status, task, modelId, intent, spec, source, buildReport, goldenReport, repairAttempts });
      return result;
    }

    // repair exhausted
    log.error('repair loop exhausted', { repairAttempts });
    const result = finish('repair_exhausted', 'max repair loops reached');
    await saveTrace({ runId, status: result.status, task, intent, spec, source: lastSource, buildReport, goldenReport, repairAttempts, modelId });
    return result;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('unhandled error', message);
    await saveTrace({
      runId,
      status: 'failure',
      task,
      modelId,
      intent,
      spec,
      source: lastSource ?? source,
      buildReport,
      goldenReport,
      repairAttempts,
    }).catch(() => {});
    return finish('failure', message);
  }

  function finish(status: PipelineResult['status'], error?: string): PipelineResult {
    return {
      status,
      intent,
      spec,
      source,
      buildReport,
      goldenReport,
      repairAttempts,
      totalDurationMs: Date.now() - startTime,
      error,
    };
  }
}
