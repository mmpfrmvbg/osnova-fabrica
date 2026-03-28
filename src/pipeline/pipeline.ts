// ============================================================
// src/pipeline/pipeline.ts — фасад: класс Pipeline (полный цикл) + ExecAgent (линейный проход)
// Полный repair-цикл — {@link Pipeline.run} → orchestrator.runPipeline
// ============================================================

import { IntakeAgent } from '../agents/IntakeAgent';
import { OsnovaCodegenAgent } from '../agents/OsnovaCodegen';
import { RepairEngineerAgent } from '../agents/RepairEngineer';
import { ExecAgent } from '../agents/exec-agent';
import { PlanAgent } from '../agents/plan-agent';
import { compileSource } from '../compiler/compiler';
import { runGoldenCheck } from '../runtime/goldenApps';
import { loadAppRegistry, loadRegistry, registryToContext } from '../runtime/loadRegistry';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import {
  compileToBuildReport,
  hasBlockingSemanticErrors,
  runPipeline as runPipelineOrchestrator,
} from './orchestrator';
import { analyzeShadow } from './shadowMode';
import type { ShadowHit } from './shadowMode';
import { QUALITY_PARTIAL, QUALITY_PASS } from './thresholds';
import type {
  BuildReport,
  GoldenReport,
  OsnovaIntent,
  OsnovaSource,
  OsnovaSpec,
  PipelineResult,
} from './types';

export { runPipelineOrchestrator as runPipeline };

/**
 * Основной фасад пайплайна: intake → spec → codegen → build → golden_check → [repair] (см. {@link runPipelineOrchestrator}).
 * Альтернатива на {@link ExecAgent}: {@link runPipelineWithExecAgent} — тот же сценарий с repair и без записи трейсов в оркестраторе.
 */
export class Pipeline {
  async run(task: string): Promise<PipelineResult> {
    return runPipelineOrchestrator(task);
  }
}

/**
 * Пайплайн через {@link ExecAgent}: intake → spec → gate G1 → codegen → build → golden_check,
 * с тем же лимитом repair-попыток, что и {@link runPipelineOrchestrator} (после G2/G3 — {@link RepairEngineerAgent}).
 * Повторный заход в codegen с уже заданным `source` в контексте пропускает LLM и прогоняет исправленный код.
 */
export async function runPipelineWithExecAgent(task: string): Promise<PipelineResult> {
  const startTime = Date.now();
  let shadowHits: ShadowHit[] = [];
  let intent: OsnovaIntent | undefined;
  let spec: OsnovaSpec | undefined;
  let repairAttempts = 0;

  try {
    const registry = loadRegistry();
    const appRegistry = loadAppRegistry();
    const registryContext = registryToContext(registry, appRegistry);

    const intake = new IntakeAgent(registryContext);
    const planAgent = new PlanAgent();
    const exec = new ExecAgent(planAgent);

    intent = await intake.parseIntent({ text: task });
    spec = await intake.generateSpec(intent);
    intake.checkSpec(spec);

    const g1 = checkG1(intent, spec);
    if (!g1.passed) {
      return {
        status: 'error',
        intent,
        spec,
        repairAttempts: 0,
        totalDurationMs: Date.now() - startTime,
        shadow_hits: shadowHits,
        error: `G1 failed: ${g1.failedChecks[0]}`,
      };
    }

    const plan = planAgent.buildPlan(intent, spec, { fromScratch: false, includeRepair: false });
    const codegen = new OsnovaCodegenAgent(registryContext);
    const repairEngineer = new RepairEngineerAgent();

    /** Совпадает с `MAX_REPAIR_LOOPS` в orchestrator.ts — не импортируем, чтобы не раздувать публичный API. */
    const MAX_EXEC_REPAIR_LOOPS = 3;
    let seedSource: OsnovaSource | undefined;

    for (let loop = 0; loop <= MAX_EXEC_REPAIR_LOOPS; loop++) {
      let lastBuildForRepair: BuildReport | undefined;
      let lastGoldenForRepair: GoldenReport | undefined;

      const execResult = await exec.execute(
        plan,
        async (phase, _step, ctx) => {
          if (phase === 'codegen') {
            if (ctx.source) {
              const shadowReport = analyzeShadow(ctx.source.source);
              shadowHits = shadowReport.hits;
              return { ok: true, patch: { source: ctx.source } };
            }
            const source = await codegen.generate(ctx.spec!);
            const shadowReport = analyzeShadow(source.source);
            shadowHits = shadowReport.hits;
            return { ok: true, patch: { source } };
          }
          if (phase === 'build') {
            const buildReport = compileToBuildReport(compileSource(ctx.source!.source));
            lastBuildForRepair = buildReport;
            const g2 = checkG2(buildReport);
            if (!g2.passed) {
              return { ok: false, error: `G2 failed: ${g2.failedChecks[0]}` };
            }
            return { ok: true, patch: { buildReport } };
          }
          if (phase === 'golden_check') {
            const goldenReport = await runGoldenCheck(ctx.buildReport!.bytecode, ctx.spec!);
            lastGoldenForRepair = goldenReport;
            const g3 = checkG3(goldenReport);
            const { qualityScore } = goldenReport;
            if (!g3.passed) {
              if (qualityScore >= QUALITY_PARTIAL && qualityScore < QUALITY_PASS) {
                return {
                  ok: true,
                  patch: { goldenReport },
                };
              }
              return { ok: false, error: `G3 failed: ${g3.failedChecks[0]}` };
            }
            return { ok: true, patch: { goldenReport } };
          }
          return { ok: false, error: `unexpected phase: ${phase}` };
        },
        { intent, spec, source: seedSource, repairAttempts },
      );

      const {
        intent: outIntent,
        spec: outSpec,
        source,
        buildReport,
        goldenReport,
      } = execResult.state;

      const totalDurationMs = Date.now() - startTime;

      if (execResult.completed) {
        if (!outSpec) {
          return {
            status: 'error',
            intent: outIntent,
            spec: outSpec,
            source,
            buildReport,
            goldenReport,
            repairAttempts,
            totalDurationMs,
            shadow_hits: shadowHits,
            error: execResult.error ?? 'exec incomplete',
          };
        }

        if (!goldenReport || !buildReport) {
          return {
            status: 'error',
            intent: outIntent,
            spec: outSpec,
            source,
            buildReport,
            goldenReport,
            repairAttempts,
            totalDurationMs,
            shadow_hits: shadowHits,
            error: 'missing build or golden report',
          };
        }

        const g3 = checkG3(goldenReport);
        const { qualityScore } = goldenReport;
        if (!g3.passed && qualityScore >= QUALITY_PARTIAL && qualityScore < QUALITY_PASS) {
          return {
            status: 'partial',
            intent: outIntent,
            spec: outSpec,
            source,
            buildReport,
            goldenReport,
            repairAttempts,
            totalDurationMs,
            shadow_hits: shadowHits,
          };
        }

        if (!g3.passed) {
          return {
            status: 'error',
            intent: outIntent,
            spec: outSpec,
            source,
            buildReport,
            goldenReport,
            repairAttempts,
            totalDurationMs,
            shadow_hits: shadowHits,
            error: `G3 failed: ${g3.failedChecks[0]}`,
          };
        }

        const blockingSem = hasBlockingSemanticErrors(buildReport);
        const finalStatus =
          goldenReport.passed && !blockingSem ? 'success' : 'partial';

        return {
          status: finalStatus,
          intent: outIntent,
          spec: outSpec,
          source,
          buildReport,
          goldenReport,
          repairAttempts,
          totalDurationMs,
          shadow_hits: shadowHits,
        };
      }

      const { stoppedAtPhase, state, error: execErr } = execResult;
      const errMsg = execErr ?? 'exec incomplete';

      if (!state.source) {
        return {
          status: 'error',
          intent: state.intent ?? intent,
          spec: state.spec ?? spec,
          source: state.source,
          buildReport: state.buildReport,
          goldenReport: state.goldenReport,
          repairAttempts,
          totalDurationMs,
          shadow_hits: shadowHits,
          error: errMsg,
        };
      }

      if (loop >= MAX_EXEC_REPAIR_LOOPS) {
        return {
          status: 'repair_exhausted',
          intent: state.intent ?? intent,
          spec: state.spec ?? spec,
          source: state.source,
          buildReport: state.buildReport ?? lastBuildForRepair,
          goldenReport: state.goldenReport ?? lastGoldenForRepair,
          repairAttempts,
          totalDurationMs,
          shadow_hits: shadowHits,
          error: 'max repair loops reached',
        };
      }

      if (stoppedAtPhase === 'build') {
        seedSource = await repairEngineer.fix(
          state.source,
          lastBuildForRepair,
          undefined,
          loop + 1,
        );
        repairAttempts++;
        continue;
      }

      if (stoppedAtPhase === 'golden_check') {
        seedSource = await repairEngineer.fix(
          state.source,
          state.buildReport ?? lastBuildForRepair,
          lastGoldenForRepair,
          loop + 1,
        );
        repairAttempts++;
        continue;
      }

      return {
        status: 'error',
        intent: state.intent ?? intent,
        spec: state.spec ?? spec,
        source: state.source,
        buildReport: state.buildReport,
        goldenReport: state.goldenReport,
        repairAttempts,
        totalDurationMs,
        shadow_hits: shadowHits,
        error: errMsg,
      };
    }

    return {
      status: 'repair_exhausted',
      intent,
      spec,
      repairAttempts,
      totalDurationMs: Date.now() - startTime,
      shadow_hits: shadowHits,
      error: 'max repair loops reached',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      intent,
      spec,
      repairAttempts,
      totalDurationMs: Date.now() - startTime,
      shadow_hits: shadowHits,
      error: message,
    };
  }
}
