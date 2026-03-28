/**
 * Интеграционные E2E-тесты фасада pipeline.ts: Intake → Plan → Exec → OsnovaCodegen,
 * реальная компиляция и runGoldenCheck (VM). Мок только LLM.
 *
 * --- Сценарии, затрагивающие VM / golden ---
 * - Полный проход до фазы `golden_check`: {@link runGoldenCheck} получает bytecode и тот же
 *   `OsnovaSpec`, что сформировал Intake (мок). Исполняется процедура входа на интерпретаторе VM
 *   (`src/runtime/goldenApps.ts`), без repair-цикла.
 * - Наблюдаемые поля {@link GoldenReport}: `executed`, `passed`, `qualityScore`, `vmErrors`,
 *   `outputDiff`, `durationMs` — в успешном сценарии проверяются executed/passed/qualityScore;
 *   ниже явно фиксируется отсутствие ошибок VM.
 *
 * --- Глобальные ключи пайплайна (`PIPELINE_VM_GLOBAL_KEYS`, `applyPipelineSpecToVm`) ---
 * Контракт syscall `система.пайплайн.*` и запись spec в `OsVbcVM.globals` описаны в
 * `src/runtime/vm.ts` и покрыты unit-тестами там же. Текущий путь `runGoldenCheck` не вызывает
 * `applyPipelineSpecToVm`; E2E здесь проверяет итог выполнения и отчёт, а не чтение globals
 * из байткода.
 *
 * --- VM: фактический результат ---
 * Spec из мока Intake не содержит `expectedReturnValue`, поэтому фаза golden в пайплайне
 * не проверяет совпадение возврата процедуры. Здесь дополнительно вызывается
 * {@link runGoldenCheck} с `expectedReturnValue: 55` (сумма 1…10), иначе тест был бы
 * ложноположительным при частичном qualityScore (например 6/7 > 0.7 при неверном return).
 */

import { describe, it, expect, vi } from 'vitest';
import { Pipeline, runPipelineWithExecAgent } from './pipeline';
import { ReviewAgent } from '../agents/review-agent';
import { PlanAgent } from '../agents/plan-agent';
import type { ExecContext } from '../agents/exec-agent';
import type { OsnovaSpec } from './types';
import { compileSource } from '../compiler/compiler';
import { runGoldenCheck } from '../runtime/goldenApps';

const createMockProvider = () => ({
  id: 'mock',
  name: 'MockLLM',
  async checkHealth() {
    return { available: true };
  },
  async listModels() {
    return [];
  },
  async complete(request: { messages: { role: string; content: string }[] }) {
    const messages = request.messages;
    const lastMsg = messages[messages.length - 1];
    const content = typeof lastMsg.content === 'string' ? lastMsg.content : '';
    const systemContent = messages[0]?.role === 'system' ? (messages[0].content as string) : '';

    if (messages.length === 1 && content.includes('Analyze this programming task')) {
      return {
        content: JSON.stringify({
          intent: 'Посчитать сумму чисел от 1 до 10',
          confidence: 0.95,
          language: 'osnova',
          features: ['arithmetic loop', 'print result'],
          params: {},
        }),
        model: 'mock',
        done: true,
      };
    }

    if (
      messages.length === 2 &&
      systemContent.includes('modules') &&
      (systemContent.includes('Return ONLY this JSON') || systemContent.includes('Верни ТОЛЬКО'))
    ) {
      return {
        content: JSON.stringify({
          modules: [{ name: 'Главный', description: 'Main', isMain: true }],
          mainModule: 'главная',
          types: [],
          procedures: [{ name: 'главная', params: {}, returnType: 'Ничто' }],
          syscalls: ['система.лог.вывести'],
          conventions: {},
        }),
        model: 'mock',
        done: true,
      };
    }

    if (systemContent.includes('OsnovaCodegen') && systemContent.includes('Syscall API')) {
      const osnovaSource = `
модуль Главный
процедура главная()
  пусть сумма = 0
  пусть счётчик = 1
  пока счётчик <= 10
    сумма = сумма + счётчик
    счётчик = счётчик + 1
  конец
  система.лог.вывести(сумма)
  вернуть сумма
конец
`.trim();
      return {
        content: osnovaSource,
        model: 'mock',
        done: true,
      };
    }

    const osnovaRepair = `
модуль Главный
процедура главная()
  пусть сумма = 0
  пусть счётчик = 1
  пока счётчик <= 10
    сумма = сумма + счётчик
    счётчик = счётчик + 1
  конец
  система.лог.вывести(сумма)
  вернуть сумма
конец
`.trim();
    return {
      content: osnovaRepair,
      model: 'mock',
      done: true,
    };
  },
  async completeStream() {
    throw new Error('completeStream not used in pipeline');
  },
});

vi.mock('../llm/index', () => ({
  getLLMProvider: () => createMockProvider(),
  DEFAULT_PROVIDER: 'qwen-cli',
  getDefaultModel: () => 'mock',
  PROVIDER_DEFAULT_MODEL: {},
}));

/** Сумма 1…10; без этой проверки golden мог пройти при неверном значении на стеке (см. runGoldenCheck). */
async function assertVmReturnValueIsSum1To10(bytecode: unknown, spec: OsnovaSpec): Promise<void> {
  const report = await runGoldenCheck(bytecode, {
    ...spec,
    expectedReturnValue: 55,
  });
  expect(report.executed, 'процедура входа должна выполниться').toBe(true);
  expect(report.vmErrors, 'ошибки VM должны попадать в отчёт, а не глотаться').toEqual([]);
  expect(report.passed, 'все проверки golden включая vmReturnMatches').toBe(true);
  expect(report.qualityScore, 'полный набор проверок без пропусков').toBe(1);
  expect(report.outputDiff, 'при несовпадении return был бы JSON с vmReturnDiff').toBeNull();
}

describe('Pipeline.run — полный пайплайн (оркестратор + repair)', () => {
  it('intake → spec → codegen → build → golden, success', async () => {
    const result = await new Pipeline().run('посчитай сумму от 1 до 10');
    expect(result.status).toBe('success');
    expect(result.intent?.description).toContain('сумм');
    expect(result.spec?.mainModule).toBe('главная');
    expect(result.spec?.procedures?.some(p => p.name === 'главная')).toBe(true);
    expect(result.source?.source).toContain('модуль Главный');
    expect(result.buildReport?.success).toBe(true);
    expect(result.goldenReport?.passed).toBe(true);
    expect(result.repairAttempts).toBe(0);
    await assertVmReturnValueIsSum1To10(result.buildReport!.bytecode!, result.spec!);
  }, 20000);
});

describe('runPipelineWithExecAgent — E2E: agents + compiler + runtime (golden)', () => {
  it('полный проход: intent → spec → Plan/Exec → codegen → build → golden, passrate > 0.8', async () => {
    const result = await runPipelineWithExecAgent('посчитай сумму от 1 до 10');

    expect(result.status).toBe('success');
    expect(result.intent?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.spec?.mainModule).toBe('главная');
    expect(result.source?.source).toContain('модуль');
    expect(result.buildReport?.success).toBe(true);
    expect(result.buildReport?.bytecode).toBeTruthy();
    expect(result.goldenReport?.executed).toBe(true);
    expect(result.goldenReport?.qualityScore).toBeGreaterThan(0.8);
    expect(result.goldenReport?.passed).toBe(true);
    expect(result.goldenReport?.vmErrors).toEqual([]);
    expect(result.repairAttempts).toBe(0);

    await assertVmReturnValueIsSum1To10(result.buildReport!.bytecode!, result.spec!);
  }, 20000);

  it('ReviewAgent принимает контекст после успешного Exec-пайплайна', async () => {
    const result = await runPipelineWithExecAgent('посчитай сумму от 1 до 10');
    expect(result.spec).toBeDefined();
    expect(result.buildReport).toBeDefined();
    expect(result.goldenReport).toBeDefined();
    await assertVmReturnValueIsSum1To10(result.buildReport!.bytecode!, result.spec!);

    const ctx: ExecContext = {
      repairAttempts: 0,
      intent: result.intent,
      spec: result.spec,
      source: result.source,
      buildReport: result.buildReport,
      goldenReport: result.goldenReport,
    };
    const review = new ReviewAgent().validate(result.spec!, ctx);
    expect(review.ok).toBe(true);
  }, 20000);

  it('E2E: intake → plan → exec → review — id и артефакты согласованы', async () => {
    const result = await runPipelineWithExecAgent('посчитай сумму от 1 до 10');
    expect(result.status).toBe('success');
    expect(result.intent?.intentId).toBeTruthy();
    expect(result.spec?.specId).toBeTruthy();

    const plan = new PlanAgent().buildPlan(result.intent!, result.spec!, {
      fromScratch: false,
      includeRepair: false,
    });
    expect(plan.intentId).toBe(result.intent!.intentId);
    expect(plan.specId).toBe(result.spec!.specId);
    expect(plan.steps.map(s => s.phase)).toEqual(['codegen', 'build', 'golden_check']);

    const ctx: ExecContext = {
      repairAttempts: 0,
      intent: result.intent,
      spec: result.spec,
      source: result.source,
      buildReport: result.buildReport,
      goldenReport: result.goldenReport,
    };
    const report = new ReviewAgent().review(result.spec!, ctx, plan);
    expect(report.ok, report.summaryText).toBe(true);
    expect(report.items.every(i => i.ok)).toBe(true);

    expect(result.source?.source).toContain(result.spec!.mainModule);
    const recomputed = compileSource(result.source!.source);
    expect(recomputed.compilerSuccess).toBe(true);
    expect(JSON.stringify(recomputed.module)).toBe(JSON.stringify(result.buildReport!.bytecode));
  }, 20000);
});

describe('Pipeline.run (оркестратор) + ReviewAgent — тот же стек, что ExecAgent-фасад', () => {
  it('intake → … → build → golden через orchestrator; контекст проходит ReviewAgent', async () => {
    const result = await new Pipeline().run('посчитай сумму от 1 до 10');
    expect(result.status).toBe('success');
    expect(result.buildReport?.bytecode).toBeTruthy();
    await assertVmReturnValueIsSum1To10(result.buildReport!.bytecode!, result.spec!);

    const plan = new PlanAgent().buildPlan(result.intent!, result.spec!, {
      fromScratch: false,
      includeRepair: false,
    });
    const report = new ReviewAgent().review(
      result.spec!,
      {
        repairAttempts: result.repairAttempts ?? 0,
        intent: result.intent,
        spec: result.spec,
        source: result.source,
        buildReport: result.buildReport,
        goldenReport: result.goldenReport,
      },
      plan,
    );
    expect(report.ok, report.summaryText).toBe(true);
  }, 20000);
});
