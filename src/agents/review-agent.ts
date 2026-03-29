// ============================================================
// src/agents/review-agent.ts — ReviewAgent: проверка результатов выполнения пайплайна
// ============================================================

import type { ExecContext } from './exec-agent';
import { BLOCKING_SEMANTIC_KINDS } from '../compiler/semanticKinds';
import type { BuildReport, ExecutionPlan, OsnovaSpec } from '../pipeline/types';
import type { AgentReport, BaseAgent } from '../types/agents';

/** Та же логика, что {@link hasBlockingSemanticErrors} в orchestrator — без импорта оркестратора в слой агентов. */
function hasBlockingSemanticErrorsInBuild(report: BuildReport | undefined): boolean {
  if (!report) return false;
  return (report.semanticErrors ?? []).some(e =>
    (BLOCKING_SEMANTIC_KINDS as readonly string[]).includes(e.kind),
  );
}

/** Одна строка проверки в отчёте. */
export interface ReviewCheckItem {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Итог проверки + человекочитаемый отчёт. */
export interface ReviewReport {
  readonly ok: boolean;
  readonly items: readonly ReviewCheckItem[];
  /** Краткое текстовое резюме (пригодно для логов и трейсов). */
  readonly summaryText: string;
}

/** Фиксированный порядок id в отчёте (стабильные трейсы и diff). */
const REVIEW_CHECK_ORDER = [
  'spec_parameter',
  'spec_in_context',
  'plan_spec_ids',
  'plan_intent',
  'plan_source',
  'build',
  'golden',
] as const;

function sortReviewItems(items: readonly ReviewCheckItem[]): ReviewCheckItem[] {
  const rank = (id: string): number => {
    const ix = (REVIEW_CHECK_ORDER as readonly string[]).indexOf(id);
    return ix >= 0 ? ix : REVIEW_CHECK_ORDER.length;
  };
  return [...items].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** Итог ok: есть хотя бы одна проверка и все активные строки прошли. */
function aggregateReviewOk(items: readonly ReviewCheckItem[]): boolean {
  return items.length > 0 && items.every(i => i.ok);
}

function linesForReport(items: readonly ReviewCheckItem[]): string {
  const ordered = sortReviewItems(items);
  const header = `[ReviewAgent] проверок: ${ordered.length}, пройдено: ${ordered.filter(i => i.ok).length}`;
  const body = ordered.map(i => `  ${i.ok ? '✓' : '✗'} ${i.id}: ${i.detail}`).join('\n');
  return `${header}\n${body}`;
}

/** Минимальная проверка эталонного spec до обращения к полям (ExecAgent передаёт валидный OsnovaSpec). */
function isValidReviewSpec(spec: unknown): spec is OsnovaSpec {
  if (spec === null || typeof spec !== 'object') return false;
  const id = (spec as OsnovaSpec).specId;
  return typeof id === 'string' && id.trim().length > 0;
}

export class ReviewAgent implements BaseAgent {
  private lastReport: ReviewReport | null = null;

  /**
   * Полная проверка выходов пайплайна: spec в контексте, опционально соответствие плану,
   * сборка, golden.
   */
  review(spec: OsnovaSpec, ctx: ExecContext, plan?: ExecutionPlan): ReviewReport {
    const items: ReviewCheckItem[] = [];
    const refOk = isValidReviewSpec(spec);

    if (!refOk) {
      items.push({
        id: 'spec_parameter',
        ok: false,
        detail: 'некорректный эталонный OsnovaSpec: ожидается объект с непустым specId',
      });
    }

    if (!ctx.spec) {
      items.push({
        id: 'spec_in_context',
        ok: false,
        detail: 'в контексте нет OsnovaSpec',
      });
    } else if (!refOk) {
      items.push({
        id: 'spec_in_context',
        ok: false,
        detail: 'нельзя сравнить контекст с эталоном: эталонный spec невалиден',
      });
    } else if (ctx.spec.specId !== spec.specId) {
      items.push({
        id: 'spec_in_context',
        ok: false,
        detail: `несовпадение specId: ожидание ${spec.specId}, в контексте ${ctx.spec.specId}`,
      });
    } else {
      items.push({
        id: 'spec_in_context',
        ok: true,
        detail: `specId «${spec.specId}» согласован`,
      });
    }

    if (plan) {
      if (!refOk) {
        items.push({
          id: 'plan_spec_ids',
          ok: false,
          detail: 'нельзя сверить spec с планом: эталонный spec невалиден',
        });
      } else {
        const specMatchesPlan = spec.specId === plan.specId;
        const ctxSpecMatchesPlan = ctx.spec?.specId === plan.specId;
        items.push({
          id: 'plan_spec_ids',
          ok: specMatchesPlan && ctxSpecMatchesPlan,
          detail:
            specMatchesPlan && ctxSpecMatchesPlan
              ? `specId «${plan.specId}» совпадает с планом`
              : [
                  !specMatchesPlan ? `spec≠plan: ${spec.specId} vs ${plan.specId}` : null,
                  ctx.spec && !ctxSpecMatchesPlan ? `контекст: ${ctx.spec.specId} vs план ${plan.specId}` : null,
                ]
                  .filter(Boolean)
                  .join('; ') || 'несовпадение specId с планом',
        });
      }

      if (plan.fromScratch) {
        const intentOk = !!ctx.intent && ctx.intent.intentId === plan.intentId;
        items.push({
          id: 'plan_intent',
          ok: intentOk,
          detail: intentOk
            ? `intentId «${plan.intentId}» согласован с планом`
            : !ctx.intent
              ? 'ожидался OsnovaIntent в контексте (fromScratch)'
              : `несовпадение intentId: план ${plan.intentId}, в контексте ${ctx.intent.intentId}`,
        });
      } else if (ctx.intent) {
        const intentOk = ctx.intent.intentId === plan.intentId;
        items.push({
          id: 'plan_intent',
          ok: intentOk,
          detail: intentOk
            ? `intentId «${plan.intentId}» согласован с планом`
            : `несовпадение intentId: план ${plan.intentId}, в контексте ${ctx.intent.intentId}`,
        });
      }

      const needsCodegen = plan.steps.some(s => s.phase === 'codegen');
      if (needsCodegen) {
        const src = ctx.source;
        const sourceOk =
          !!src &&
          typeof src.source === 'string' &&
          src.source.trim().length > 0 &&
          typeof src.filename === 'string' &&
          src.filename.trim().length > 0;
        items.push({
          id: 'plan_source',
          ok: sourceOk,
          detail: sourceOk
            ? `исходник «${src!.filename}» присутствует (шаг codegen в плане)`
            : 'для плана с codegen нужен непустой OsnovaSource в контексте',
        });
      }
    }

    if (!ctx.buildReport) {
      items.push({
        id: 'build',
        ok: false,
        detail: 'нет BuildReport — фаза build не зафиксирована',
      });
    } else {
      const br = ctx.buildReport;
      const semanticBlock = hasBlockingSemanticErrorsInBuild(br);
      const lexer = br.lexerErrors?.length ?? 0;
      const parser = br.parserErrors?.length ?? 0;
      const compiler = br.compilerErrors?.length ?? 0;
      const ok = br.success && !semanticBlock;
      items.push({
        id: 'build',
        ok,
        detail: ok
          ? 'сборка успешна, блокирующих семантических ошибок нет'
          : [
              !br.success ? 'success=false' : null,
              semanticBlock ? 'есть блокирующие семантические ошибки' : null,
              lexer > 0 ? `lexer: ${lexer}` : null,
              parser > 0 ? `parser: ${parser}` : null,
              compiler > 0 ? `compiler: ${compiler}` : null,
            ]
              .filter(Boolean)
              .join('; ') || 'сборка не прошла критерии',
      });
    }

    if (!ctx.goldenReport) {
      items.push({
        id: 'golden',
        ok: false,
        detail: 'нет GoldenReport — фаза golden_check не зафиксирована',
      });
    } else {
      const gr = ctx.goldenReport;
      const vmErr = gr.vmErrors?.length ?? 0;
      const scoreOk = Number.isFinite(gr.qualityScore);
      const ok = gr.executed && gr.passed && vmErr === 0 && scoreOk;
      items.push({
        id: 'golden',
        ok,
        detail: ok
          ? `golden пройден (qualityScore=${gr.qualityScore.toFixed(3)})`
          : [
              !gr.executed ? 'executed=false' : null,
              !gr.passed ? 'passed=false' : null,
              !scoreOk ? 'qualityScore не число' : null,
              vmErr > 0 ? `vmErrors: ${vmErr}` : null,
              gr.outputDiff ? `outputDiff: ${gr.outputDiff.slice(0, 200)}${gr.outputDiff.length > 200 ? '…' : ''}` : null,
            ]
              .filter(Boolean)
              .join('; ') || 'golden не прошёл критерии',
      });
    }

    const ok = aggregateReviewOk(items);
    const report: ReviewReport = {
      ok,
      items: sortReviewItems(items),
      summaryText: linesForReport(items),
    };
    this.lastReport = report;
    return report;
  }

  /**
   * Два варианта: `(spec, ctx, plan?)` как раньше, либо один объект `{ spec, ctx, plan? }`.
   * Различие по числу аргументов: один аргумент — объект; два и более — кортеж (ctx обязателен).
   */
  validate(spec: OsnovaSpec, ctx: ExecContext, plan?: ExecutionPlan): ReviewReport;
  validate(input: { spec: OsnovaSpec; ctx: ExecContext; plan?: ExecutionPlan }): ReviewReport;
  validate(input: unknown, ctx?: ExecContext, plan?: ExecutionPlan): ReviewReport {
    if (arguments.length >= 2) {
      if (ctx === undefined) {
        throw new Error(
          'ReviewAgent.validate: при вызове (spec, ctx, plan?) второй аргумент (ctx) обязателен',
        );
      }
      return this.review(input as OsnovaSpec, ctx, plan);
    }
    const b = input as { spec: OsnovaSpec; ctx: ExecContext; plan?: ExecutionPlan };
    if (!b || typeof b !== 'object' || !('spec' in b) || !('ctx' in b)) {
      throw new Error(
        'ReviewAgent.validate: ожидается (spec, ctx, plan?) или { spec, ctx, plan? }',
      );
    }
    return this.review(b.spec, b.ctx, b.plan);
  }

  /** То же, что {@link review}, с сохранением для {@link report}. */
  run(input?: unknown): ReviewReport {
    if (input === undefined || typeof input !== 'object') {
      throw new Error('ReviewAgent.run: ожидается { spec, ctx, plan? }');
    }
    const p = input as { spec: OsnovaSpec; ctx: ExecContext; plan?: ExecutionPlan };
    if (!p.spec || !p.ctx) {
      throw new Error('ReviewAgent.run: ожидается { spec, ctx, plan? }');
    }
    return this.review(p.spec, p.ctx, p.plan);
  }

  report(): AgentReport {
    if (!this.lastReport) {
      return {
        ok: false,
        summaryText: '[ReviewAgent] нет отчёта — вызовите review, validate или run',
      };
    }
    return {
      ok: this.lastReport.ok,
      summaryText: this.lastReport.summaryText,
    };
  }
}

export type { AgentReport, BaseAgent } from '../types/agents';
