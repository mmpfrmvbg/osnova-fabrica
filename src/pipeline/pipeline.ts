// ============================================================
// src/pipeline/pipeline.ts — фасад: класс Pipeline (полный цикл) + ExecAgent (линейный проход)
// Полный repair-цикл — {@link Pipeline.run} → orchestrator.runPipeline
// ============================================================

import { IntakeAgent } from '../agents/IntakeAgent';
import { OsnovaCodegenAgent } from '../agents/OsnovaCodegen';
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
import type { OsnovaIntent, OsnovaSpec, PipelineResult } from './types';

export { runPipelineOrchestrator as runPipeline };

/**
 * Основной фасад пайплайна: intake → spec → codegen → build → golden_check → [repair] (см. {@link runPipelineOrchestrator}).
 * Repair и трейсы — как в оркестраторе; для одного линейного прохода без repair см. {@link runPipelineWithExecAgent}.
 */
export class Pipeline {
  async run(task: string): Promise<PipelineResult> {
    return runPipelineOrchestrator(task);
  }
}

/**
 * Один проход пайплайна через {@link ExecAgent}: intake → spec → codegen → build → golden_check.
 * Данные агентов (intent/spec/source/build/golden) передаются в {@link ExecAgent} как контекст шагов;
 * для байткода контекст спецификации доступен через `applyPipelineSpecToVm` в `src/runtime/vm.ts`.
 */
export async function runPipelineWithExecAgent(task: string): Promise<PipelineResult> {
  const startTime = Date.now();
  let shadowHits: ShadowHit[] = [];
  let intent: OsnovaIntent | undefined;
  let spec: OsnovaSpec | undefined;

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

    const execResult = await exec.execute(
      plan,
      async (phase, _step, ctx) => {
        if (phase === 'codegen') {
          const source = await codegen.generate(ctx.spec!);
          const shadowReport = analyzeShadow(source.source);
          shadowHits = shadowReport.hits;
          return { ok: true, patch: { source } };
        }
        if (phase === 'build') {
          const buildReport = compileToBuildReport(compileSource(ctx.source!.source));
          const g2 = checkG2(buildReport);
          if (!g2.passed) {
            return { ok: false, error: `G2 failed: ${g2.failedChecks[0]}` };
          }
          return { ok: true, patch: { buildReport } };
        }
        if (phase === 'golden_check') {
          const goldenReport = await runGoldenCheck(ctx.buildReport!.bytecode, ctx.spec!);
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
      { intent, spec, repairAttempts: 0 },
    );

    const {
      intent: outIntent,
      spec: outSpec,
      source,
      buildReport,
      goldenReport,
    } = execResult.state;

    const totalDurationMs = Date.now() - startTime;

    if (!execResult.completed || !outSpec) {
      return {
        status: 'error',
        intent: outIntent,
        spec: outSpec,
        source,
        buildReport,
        goldenReport,
        repairAttempts: 0,
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
        repairAttempts: 0,
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
        repairAttempts: 0,
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
        repairAttempts: 0,
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
      repairAttempts: 0,
      totalDurationMs,
      shadow_hits: shadowHits,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      intent,
      spec,
      repairAttempts: 0,
      totalDurationMs: Date.now() - startTime,
      shadow_hits: shadowHits,
      error: message,
    };
  }
}
