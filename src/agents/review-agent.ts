// ============================================================
// src/agents/review-agent.ts — ReviewAgent: проверка результатов выполнения пайплайна
// ============================================================

import type { ExecContext } from './exec-agent';
import type { OsnovaSpec } from '../pipeline/types';
import { hasBlockingSemanticErrors } from '../pipeline/orchestrator';

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

function linesForReport(items: readonly ReviewCheckItem[]): string {
  const header = `[ReviewAgent] проверок: ${items.length}, пройдено: ${items.filter(i => i.ok).length}`;
  const body = items.map(i => `  ${i.ok ? '✓' : '✗'} ${i.id}: ${i.detail}`).join('\n');
  return `${header}\n${body}`;
}

export class ReviewAgent {
  /**
   * Сверяет накопленное состояние выполнения с ожиданиями из spec
   * (сборка, golden, согласованность spec в контексте).
   */
  validate(spec: OsnovaSpec, ctx: ExecContext): ReviewReport {
    const items: ReviewCheckItem[] = [];

    if (!ctx.spec) {
      items.push({
        id: 'spec_in_context',
        ok: false,
        detail: 'в контексте нет OsnovaSpec',
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

    if (!ctx.buildReport) {
      items.push({
        id: 'build',
        ok: false,
        detail: 'нет BuildReport — фаза build не зафиксирована',
      });
    } else {
      const br = ctx.buildReport;
      const semanticBlock = hasBlockingSemanticErrors(br);
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
      const ok = gr.passed && vmErr === 0;
      items.push({
        id: 'golden',
        ok,
        detail: ok
          ? `golden пройден (qualityScore=${gr.qualityScore.toFixed(3)})`
          : [
              !gr.passed ? 'passed=false' : null,
              !gr.executed ? 'executed=false' : null,
              vmErr > 0 ? `vmErrors: ${vmErr}` : null,
              gr.outputDiff ? `outputDiff: ${gr.outputDiff.slice(0, 200)}${gr.outputDiff.length > 200 ? '…' : ''}` : null,
            ]
              .filter(Boolean)
              .join('; ') || 'golden не прошёл критерии',
      });
    }

    const ok = items.every(i => i.ok);
    return {
      ok,
      items,
      summaryText: linesForReport(items),
    };
  }
}
