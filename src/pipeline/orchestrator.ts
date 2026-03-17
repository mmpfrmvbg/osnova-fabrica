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
import { saveTrace } from '../trace/traceStore';
import type {
  RawText,
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineResult,
} from './types';

const MAX_REPAIR_LOOPS = 3;

export async function runPipeline(
  task: string,
): Promise<PipelineResult> {
  const runId = randomUUID();
  const startTime = Date.now();
  let repairAttempts = 0;

  let intent: OsnovaIntent | undefined;
  let spec: OsnovaSpec | undefined;
  let source: OsnovaSource | undefined;
  let buildReport: BuildReport | undefined;
  let goldenReport: GoldenReport | undefined;

  try {
    // ─── Фаза 1: intake ───
    console.log('[pipeline] phase: intake');
    const intake = new IntakeAgent();
    intent = await intake.parseIntent({ text: task });

    // ─── Фаза 2: spec_generation ───
    console.log('[pipeline] phase: spec_generation');
    spec = await intake.generateSpec(intent);

    // ─── Gate G1 ───
    const g1 = checkG1(intent, spec);
    if (!g1.passed) {
      console.error('[gate G1 FAIL]', g1.failedChecks);
      return finish('failure', `G1 failed: ${g1.failedChecks[0]}`);
    }
    console.log('[gate G1] passed');

    // ─── Фаза 3: codegen ───
    console.log('[pipeline] phase: codegen');
    const codegen = new OsnovaCodegenAgent();
    source = await codegen.generate(spec);

    // ─── Repair loop: build → golden_check → repair ───
    let lastSource = source;

    for (let loop = 0; loop <= MAX_REPAIR_LOOPS; loop++) {
      // ─── Фаза 4: build ───
      console.log(`[pipeline] phase: build (attempt ${loop + 1})`);
      const { compileSource } = await import('../compiler/compiler');
      const compileResult = compileSource(lastSource.source);

      buildReport = {
        success: compileResult.success,
        lexerErrors: compileResult.lexerErrors ?? [],
        parserErrors: compileResult.parserErrors ?? [],
        compilerErrors: compileResult.errors ?? [],
        bytecode: compileResult.module ?? null,
        compilerSuccess: compileResult.success,
        durationMs: compileResult.durationMs ?? 0,
      };

      // ─── Gate G2 ───
      const g2 = checkG2(buildReport);
      if (!g2.passed) {
        console.warn(`[gate G2 FAIL] attempt ${loop + 1}`, g2.failedChecks);
        if (loop >= MAX_REPAIR_LOOPS) break;
        const repair = new RepairEngineerAgent();
        lastSource = await repair.fix(lastSource, buildReport, undefined);
        repairAttempts++;
        continue;
      }
      console.log('[gate G2] passed');

      // ─── Фаза 5: golden_check ───
      console.log('[pipeline] phase: golden_check');
      const { runGoldenCheck } = await import('../runtime/goldenApps');
      goldenReport = await runGoldenCheck(buildReport.bytecode, spec);

      // ─── Gate G3 ───
      const g3 = checkG3(goldenReport);
      if (!g3.passed) {
        console.warn(`[gate G3 FAIL] attempt ${loop + 1}`, g3.failedChecks);
        if (loop >= MAX_REPAIR_LOOPS) break;
        const repair = new RepairEngineerAgent();
        lastSource = await repair.fix(lastSource, buildReport, goldenReport);
        repairAttempts++;
        continue;
      }

      console.log('[gate G3] passed — pipeline complete');
      source = lastSource;

      const result = finish(
        goldenReport.passed ? 'success' : 'partial',
      );
      await saveTrace({ runId, status: result.status, task, intent, spec, source, buildReport, goldenReport, repairAttempts });
      return result;
    }

    // repair exhausted
    console.error('[pipeline] repair loop exhausted after', repairAttempts, 'attempts');
    const result = finish('repair_exhausted', 'max repair loops reached');
    await saveTrace({ runId, status: result.status, task, intent, spec, source: lastSource, buildReport, goldenReport, repairAttempts });
    return result;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline] unhandled error:', message);
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
