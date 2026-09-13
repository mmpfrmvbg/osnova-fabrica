// ============================================================
// src/pipeline/loop.ts — Автономная петля над Основа-приложениями
//
// Модель итеративно доводит .osnova-код до зелёного golden-гейта,
// на каждой итерации получая результат прошлой (ошибки компиляции /
// VM / diff вывода). В отличие от линейного runPipeline, здесь цикл
// вынесен наружу, лимит параметризуем, и каждая итерация пишется в
// отдельный трейс runs/loop-traces.jsonl.
//
// Ядро (compiler / VM / VLIW) не изменяется — только фазы и агенты.
// ============================================================

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { IntakeAgent } from '../agents/IntakeAgent';
import { OsnovaCodegenAgent } from '../agents/OsnovaCodegen';
import { RepairEngineerAgent } from '../agents/RepairEngineer';
import {
  resolveEscalationModel,
  resolveLevel,
  resolveModel,
  resolveTier,
  routingSummary,
  shouldEscalateToPro,
} from '../llm/routing';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import { QUALITY_PARTIAL, QUALITY_PASS } from './thresholds';
import { BLOCKING_SEMANTIC_KINDS } from './semanticKinds';
import { logger } from '../logger';
import { compileSource, compileToBuildReport } from '../compiler/compiler';
import { runGoldenCheck } from '../runtime/goldenApps';
import { loadRegistry, loadAppRegistry, registryToContext } from '../runtime/loadRegistry';
import type {
  OsnovaIntent,
  OsnovaSpec,
  OsnovaSource,
  BuildReport,
  GoldenReport,
  PipelineStatus,
} from './types';

const log = logger('loop');

const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_TRACE_FILE = 'runs/loop-traces.jsonl';

/** Один шаг петли (кодогенерация / сборка / golden / ремонт). */
export interface LoopIteration {
  readonly iteration: number;
  readonly phase: 'codegen' | 'build' | 'golden' | 'done';
  readonly status: 'running' | 'success' | 'partial' | 'failed';
  readonly source?: OsnovaSource;
  readonly buildReport?: BuildReport;
  readonly goldenReport?: GoldenReport;
  readonly errorKind?: string;
  readonly durationMs: number;
}

/** Итог автономной петли. */
export interface LoopResult {
  readonly status: PipelineStatus;
  readonly iterations: readonly LoopIteration[];
  readonly intent?: OsnovaIntent;
  readonly spec?: OsnovaSpec;
  readonly source?: OsnovaSource;
  readonly buildReport?: BuildReport;
  readonly goldenReport?: GoldenReport;
  readonly totalDurationMs: number;
  readonly lastErrorKind?: string;
  readonly error?: string;
}

export interface RunLoopOptions {
  /** Максимум итераций build→golden→repair. По умолчанию 6. */
  readonly maxIterations?: number;
  /** Путь к JSONL-трейсу итераций. По умолчанию runs/loop-traces.jsonl. */
  readonly traceFile?: string;
}

function hasBlockingSemanticErrors(report: BuildReport | undefined): boolean {
  if (!report) return false;
  return (report.semanticErrors ?? []).some(
    e => (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(e.kind),
  );
}

/** Kind последней ошибки сборки (как extractLastErrorKind в orchestrator, но локально). */
function lastBuildErrorKind(report: BuildReport | undefined): string {
  if (!report) return 'unknown';
  const blocking = (report.semanticErrors ?? []).filter(e =>
    (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(e.kind),
  );
  if (blocking.length > 0) return blocking[blocking.length - 1]!.kind;
  if ((report.compilerErrors ?? []).length > 0) return 'compiler_error';
  if ((report.parserErrors ?? []).length > 0) return 'parser_error';
  if ((report.lexerErrors ?? []).length > 0) return 'lexer_error';
  return 'unknown';
}

/** Короткий признак причины провала итерации — для прозрачного трейса. */
function loopErrorKind(
  buildReport: BuildReport | undefined,
  goldenReport: GoldenReport | undefined,
  phase: 'build' | 'golden',
): string {
  if (phase === 'build') return lastBuildErrorKind(buildReport);
  if (goldenReport?.vmErrors?.length) return 'vm_error';
  if (goldenReport?.outputDiff) return 'golden_diff';
  return 'golden_fail';
}

/**
 * Автономная петля: intake → spec → codegen → (build → golden → repair)×N.
 * Возвращает итог и полную историю итераций; каждую итерацию пишет в JSONL-трейс.
 */
export async function runLoop(goal: string, opts: RunLoopOptions = {}): Promise<LoopResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const traceFile = opts.traceFile ?? DEFAULT_TRACE_FILE;
  const runId = randomUUID();
  const startTime = Date.now();
  const tier = resolveTier();
  const level = resolveLevel();
  // modelId трейса — модель кодогенерации (основная фаза); полная политика — в логе.
  const modelId = resolveModel('codegen', tier);
  log.info('loop: routing', {
    tier,
    level,
    phases: routingSummary(tier, level).map(
      r => `${r.phase}=${r.model}/${r.thinking ? r.reasoningEffort : 'no-think'}`,
    ),
  });

  /** Подряд неудачных итераций build/golden — вход для эскалации repair→Pro. */
  let consecutiveFailures = 0;

  let intent: OsnovaIntent | undefined;
  let spec: OsnovaSpec | undefined;
  let source: OsnovaSource | undefined;
  let buildReport: BuildReport | undefined;
  let goldenReport: GoldenReport | undefined;
  let lastErrorKind: string | undefined;

  const iterations: LoopIteration[] = [];

  const persistIteration = (iter: LoopIteration): void => {
    iterations.push(iter);
    try {
      const target = path.resolve(traceFile);
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        target,
        JSON.stringify({
          runId,
          timestamp: new Date().toISOString(),
          modelId,
          goal,
          iteration: iter.iteration,
          phase: iter.phase,
          status: iter.status,
          errorKind: iter.errorKind ?? null,
          qualityScore: iter.goldenReport?.qualityScore ?? null,
          durationMs: iter.durationMs,
          filename: iter.source?.filename ?? null,
        }) + '\n',
        'utf-8',
      );
    } catch (err) {
      console.warn('[loop] trace write failed:', err);
    }
  };

  const finish = (status: PipelineStatus, error?: string): LoopResult => ({
    status,
    iterations,
    intent,
    spec,
    source,
    buildReport,
    goldenReport,
    totalDurationMs: Date.now() - startTime,
    lastErrorKind,
    error,
  });

  try {
    const registry = loadRegistry();
    const appRegistry = loadAppRegistry();
    const registryContext = registryToContext(registry, appRegistry);

    // ─── intake + spec (один раз) ───
    log.info('loop: intake');
    const intake = new IntakeAgent(registryContext);
    intent = await intake.parseIntent({ text: goal });
    spec = await intake.generateSpec(intent);
    intake.checkSpec(spec);

    const g1 = checkG1(intent, spec);
    if (!g1.passed) {
      log.error('loop: gate G1 FAIL', g1.failedChecks);
      return finish('error', `G1 failed: ${g1.failedChecks[0]}`);
    }

    // ─── первая версия кода ───
    log.info('loop: codegen');
    const codegen = new OsnovaCodegenAgent(registryContext);
    source = await codegen.generate(spec);
    persistIteration({
      iteration: 1,
      phase: 'codegen',
      status: 'running',
      source,
      durationMs: Date.now() - startTime,
    });

    let current: OsnovaSource = source;
    let iteration = 1;

    // ─── цикл: build → golden → repair ───
    for (; iteration <= maxIterations; iteration++) {
      const iterStart = Date.now();

      // build
      log.info(`loop: build (итерация ${iteration})`);
      buildReport = compileToBuildReport(compileSource(current.source));

      const g2 = checkG2(buildReport);
      if (!g2.passed) {
        lastErrorKind = loopErrorKind(buildReport, undefined, 'build');
        log.warn(`loop: build FAIL (итерация ${iteration})`, lastErrorKind);
        persistIteration({
          iteration,
          phase: 'build',
          status: 'failed',
          source: current,
          buildReport,
          errorKind: lastErrorKind,
          durationMs: Date.now() - iterStart,
        });
        if (iteration >= maxIterations) break;
        consecutiveFailures++;
        const escalateBuild = shouldEscalateToPro('repair', level, consecutiveFailures, tier);
        if (escalateBuild) {
          log.info(`loop: repair→Pro после ${consecutiveFailures} неудач подряд`);
        }
        const repair = new RepairEngineerAgent();
        current = await repair.fix(
          current,
          buildReport,
          undefined,
          iteration,
          escalateBuild ? { model: resolveEscalationModel('repair') } : undefined,
        );
        continue;
      }

      // golden
      goldenReport = await runGoldenCheck(buildReport.bytecode, spec);
      const g3 = checkG3(goldenReport);
      const { qualityScore } = goldenReport;

      if (!g3.passed) {
        if (qualityScore >= QUALITY_PARTIAL && qualityScore < QUALITY_PASS) {
          log.info(`loop: golden partial (${qualityScore.toFixed(2)}) — остановка`);
          source = current;
          persistIteration({
            iteration,
            phase: 'golden',
            status: 'partial',
            source: current,
            buildReport,
            goldenReport,
            durationMs: Date.now() - iterStart,
          });
          return finish('partial');
        }
        lastErrorKind = loopErrorKind(buildReport, goldenReport, 'golden');
        log.warn(`loop: golden FAIL (итерация ${iteration})`, lastErrorKind);
        persistIteration({
          iteration,
          phase: 'golden',
          status: 'failed',
          source: current,
          buildReport,
          goldenReport,
          errorKind: lastErrorKind,
          durationMs: Date.now() - iterStart,
        });
        if (iteration >= maxIterations) break;
        consecutiveFailures++;
        const escalateGolden = shouldEscalateToPro('repair', level, consecutiveFailures, tier);
        if (escalateGolden) {
          log.info(`loop: repair→Pro после ${consecutiveFailures} неудач подряд`);
        }
        const repair = new RepairEngineerAgent();
        current = await repair.fix(
          current,
          buildReport,
          goldenReport,
          iteration,
          escalateGolden ? { model: resolveEscalationModel('repair') } : undefined,
        );
        continue;
      }

      // успех
      source = current;
      const finalStatus = goldenReport.passed && !hasBlockingSemanticErrors(buildReport)
        ? 'success'
        : 'partial';
      log.info(`loop: готово — ${finalStatus} (итерация ${iteration})`);
      persistIteration({
        iteration,
        phase: 'done',
        status: finalStatus,
        source: current,
        buildReport,
        goldenReport,
        durationMs: Date.now() - iterStart,
      });
      return finish(finalStatus);
    }

    // лимит исчерпан
    lastErrorKind = loopErrorKind(buildReport, goldenReport, goldenReport ? 'golden' : 'build');
    log.error('loop: лимит итераций исчерпан', { maxIterations, lastErrorKind });
    persistIteration({
      iteration: maxIterations,
      phase: 'done',
      status: 'failed',
      source: current,
      buildReport,
      goldenReport,
      errorKind: lastErrorKind,
      durationMs: Date.now() - startTime,
    });
    return finish('repair_exhausted', 'max iterations reached');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('loop: unhandled error', message);
    return finish('error', message);
  }
}
