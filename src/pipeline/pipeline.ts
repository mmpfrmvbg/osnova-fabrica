// ============================================================
// src/pipeline/pipeline.ts — фасад: класс Pipeline (полный цикл) + ExecAgent (линейный проход)
// Полный repair-цикл — {@link Pipeline.run} → orchestrator.runPipeline
// ============================================================

/**
 * Импорты из конкретных модулей агентов (не из `../agents` barrel) — без цикла pipeline ↔ agents/index.
 */
import { IntakeAgent } from '../agents/IntakeAgent';
import { OsnovaCodegenAgent } from '../agents/OsnovaCodegen';
import { RepairEngineerAgent } from '../agents/RepairEngineer';
import { PlanAgent } from '../agents/plan-agent';
import { ExecAgent } from '../agents/exec-agent';
import { compileSource } from '../compiler/compiler';
import { runGoldenCheck } from '../runtime/goldenApps';
import { loadAppRegistry, loadRegistry, registryToContext } from '../runtime/loadRegistry';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import {
  compileToBuildReport,
  extractLastErrorKind,
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
  PipelinePhase,
  PipelineResult,
} from './types';

export { runPipelineOrchestrator as runPipeline };

/** VM из контекста агентов после build: spec + bytecode → {@link import("../runtime/vm").applyPipelineSpecToVm}. */
export {
  createPipelineVmFromExecContext,
  safeExecutePipelineVm,
  safeExecutePipelineVmFromExecContext,
  EXEC_CONTEXT_VM_UNAVAILABLE,
} from '../agents/exec-agent';
export type { ExecContext, PipelineVmExecuteResult } from '../agents/exec-agent';

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
        lastErrorKind: undefined,
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
        async (phase: PipelinePhase, _step, ctx) => {
          switch (phase) {
            case 'codegen':
              if (ctx.source) {
                const shadowReport = analyzeShadow(ctx.source.source);
                shadowHits = shadowReport.hits;
                return {
                  ok: true,
                  patch: { source: ctx.source, intent: ctx.intent, spec: ctx.spec },
                };
              }
              const source = await codegen.generate(ctx.spec!);
              const shadowReport = analyzeShadow(source.source);
              shadowHits = shadowReport.hits;
              return {
                ok: true,
                patch: { source, intent: ctx.intent, spec: ctx.spec },
              };
            case 'build': {
              const buildReport = compileToBuildReport(compileSource(ctx.source!.source, { filename: ctx.source!.filename }));
              lastBuildForRepair = buildReport;
              const g2 = checkG2(buildReport);
              if (!g2.passed) {
                return { ok: false, error: `G2 failed: ${g2.failedChecks[0]}` };
              }
              return {
                ok: true,
                patch: { buildReport, intent: ctx.intent, spec: ctx.spec },
              };
            }
            case 'golden_check': {
              const goldenReport = await runGoldenCheck(ctx.buildReport!.bytecode, ctx.spec!);
              lastGoldenForRepair = goldenReport;
              const g3 = checkG3(goldenReport);
              const { qualityScore } = goldenReport;
              if (!g3.passed) {
                if (qualityScore >= QUALITY_PARTIAL && qualityScore < QUALITY_PASS) {
                  return {
                    ok: true,
                    patch: { goldenReport, intent: ctx.intent, spec: ctx.spec },
                  };
                }
                return { ok: false, error: `G3 failed: ${g3.failedChecks[0]}` };
              }
              return {
                ok: true,
                patch: { goldenReport, intent: ctx.intent, spec: ctx.spec },
              };
            }
            case 'intake':
            case 'spec_generation':
            case 'g1_spec_ready':
            case 'repair':
              return {
                ok: false,
                error: `runPipelineWithExecAgent: фаза «${phase}» не используется при fromScratch: false / includeRepair: false`,
              };
            default: {
              const _exhaustive: never = phase;
              return { ok: false, error: `unexpected phase: ${String(_exhaustive)}` };
            }
          }
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
            lastErrorKind: undefined,
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
            lastErrorKind: undefined,
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
            lastErrorKind: undefined,
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
            lastErrorKind: undefined,
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
          lastErrorKind: undefined,
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
          lastErrorKind: undefined,
        };
      }

      if (loop >= MAX_EXEC_REPAIR_LOOPS) {
        const br = state.buildReport ?? lastBuildForRepair;
        return {
          status: 'repair_exhausted',
          intent: state.intent ?? intent,
          spec: state.spec ?? spec,
          source: state.source,
          buildReport: br,
          goldenReport: state.goldenReport ?? lastGoldenForRepair,
          repairAttempts,
          totalDurationMs,
          shadow_hits: shadowHits,
          error: 'max repair loops reached',
          lastErrorKind: extractLastErrorKind(br, state.goldenReport ?? lastGoldenForRepair),
        };
      }

      if (stoppedAtPhase === 'build') {
        try {
          seedSource = await repairEngineer.fix(
            state.source,
            lastBuildForRepair,
            undefined,
            loop + 1,
          );
        } catch (repairErr) {
          const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
          return {
            status: 'error',
            intent: state.intent ?? intent,
            spec: state.spec ?? spec,
            source: state.source,
            buildReport: state.buildReport ?? lastBuildForRepair,
            goldenReport: state.goldenReport,
            repairAttempts,
            totalDurationMs,
            shadow_hits: shadowHits,
            error: `repair failed: ${msg}`,
            lastErrorKind: extractLastErrorKind(lastBuildForRepair),
          };
        }
        repairAttempts++;
        continue;
      }

      if (stoppedAtPhase === 'golden_check') {
        try {
          seedSource = await repairEngineer.fix(
            state.source,
            state.buildReport ?? lastBuildForRepair,
            lastGoldenForRepair,
            loop + 1,
          );
        } catch (repairErr) {
          const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
          return {
            status: 'error',
            intent: state.intent ?? intent,
            spec: state.spec ?? spec,
            source: state.source,
            buildReport: state.buildReport ?? lastBuildForRepair,
            goldenReport: state.goldenReport ?? lastGoldenForRepair,
            repairAttempts,
            totalDurationMs,
            shadow_hits: shadowHits,
            error: `repair failed: ${msg}`,
            lastErrorKind: extractLastErrorKind(
              state.buildReport ?? lastBuildForRepair,
              state.goldenReport ?? lastGoldenForRepair,
            ),
          };
        }
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
        lastErrorKind: undefined,
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
      lastErrorKind: extractLastErrorKind(undefined),
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
      lastErrorKind: undefined,
    };
  }
}
