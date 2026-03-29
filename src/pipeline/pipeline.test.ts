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
 * --- Глобальные ключи (`PIPELINE_VM_GLOBAL_KEYS`, `applyPipelineSpecToVm`) ---
 * `runGoldenCheck` → {@link createGoldenCheckVm} вызывает `applyPipelineSpecToVm`; контракт syscall
 * `система.пайплайн.*` и сами ключи покрыты в `src/runtime/vm.test.ts`. В этом файле E2E не
 * ассертит значения `vm.globals` и не дергает `система.пайплайн.*` — мок-код использует только
 * `система.лог.вывести`.
 *
 * Карта сценариев (VM / отчёт):
 * - Реальная VM + полный отчёт: успешные `Pipeline.run` / `runPipelineWithExecAgent`, ReviewAgent,
 *   инвариант «оба фасада», E2E id/plan/review — везде `assertVmReturnValueIsSum1To10`
 *   (доп. проверка `expectedReturnValue: 55`).
 * - Только поля отчёта (без реального прогона VM): `mockGoldenInPartialBand` подменяет
 *   `runGoldenCheck`.
 * - Синтетический `GoldenReport` для гейтов: `makeGateGolden`, в т.ч. `g3_vm_executed` при
 *   `executed: false` — не интерпретатор, а контракт `checkG3`.
 *
 * Пробелы покрытия относительно контракта VM: нет E2E на syscall `система.пайплайн.*` и чтение
 * globals; нет сценария с реальными `vmErrors` из интерпретатора (частичный golden мокает отчёт);
 * спек из мока Intake по-прежнему без `expectedReturnValue` — строгая проверка возврата только в
 * `assertVmReturnValueIsSum1To10`.
 *
 * --- VM: фактический результат ---
 * Spec из мока Intake не содержит `expectedReturnValue`, поэтому фаза golden в пайплайне
 * не проверяет совпадение возврата процедуры. Здесь дополнительно вызывается
 * {@link runGoldenCheck} с `expectedReturnValue: 55` (сумма 1…10), иначе тест был бы
 * ложноположительным при частичном qualityScore (например 6/7 > 0.7 при неверном return).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Pipeline, runPipelineWithExecAgent } from './pipeline';
import { IntakeAgent } from '../agents/IntakeAgent';
import { OsnovaCodegenAgent } from '../agents/OsnovaCodegen';
import { ReviewAgent } from '../agents/review-agent';
import { PlanAgent } from '../agents/plan-agent';
import type { ExecContext } from '../agents/exec-agent';
import {
  ALL_DIAGNOSTIC_PIPELINE_STATUSES,
  SPEC_BUILD_DURATION_WARN_MS,
  SPEC_G1_CONFIDENCE_MIN,
  SPEC_QUALITY_PARTIAL,
  SPEC_QUALITY_PASS,
  composeForgeStateBlockerAtmId,
  FORGE_STATE_BLOCKER_EPK_ATM_015,
  FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
  type BuildReport,
  type GoldenReport,
  type OsnovaIntent,
  type OsnovaSpec,
} from './types';
import { parseForgeBlockerAtmId, resolveForgeBlockerScenarioFromAtmId } from './blocker-resolver';
import { checkG1, checkG2, checkG3 } from './gateChecker';
import { calcHealthScore } from './healthScore';
import { QUALITY_PARTIAL, QUALITY_PASS } from './thresholds';
import { compileSource } from '../compiler/compiler';
import * as goldenApps from '../runtime/goldenApps';
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

describe('оркестрация — успешный прогон (инварианты)', () => {
  it('оба фасада: success, totalDurationMs > 0, shadow_hits — массив', async () => {
    const orchestrator = await new Pipeline().run('посчитай сумму от 1 до 10');
    const execFacade = await runPipelineWithExecAgent('посчитай сумму от 1 до 10');

    expect(orchestrator.status).toBe('success');
    expect(execFacade.status).toBe('success');
    expect(orchestrator.totalDurationMs).toBeGreaterThan(0);
    expect(execFacade.totalDurationMs).toBeGreaterThan(0);
    expect(Array.isArray(orchestrator.shadow_hits)).toBe(true);
    expect(Array.isArray(execFacade.shadow_hits)).toBe(true);
    await assertVmReturnValueIsSum1To10(orchestrator.buildReport!.bytecode!, orchestrator.spec!);
    await assertVmReturnValueIsSum1To10(execFacade.buildReport!.bytecode!, execFacade.spec!);
  }, 45000);
});

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

    await assertVmReturnValueIsSum1To10(result.buildReport!.bytecode!, result.spec!);

    expect(result.source?.source).toContain(result.spec!.mainModule);
    const recomputed = compileSource(result.source!.source);
    expect(recomputed.compilerSuccess).toBe(true);
    expect(JSON.stringify(recomputed.module)).toBe(JSON.stringify(result.buildReport!.bytecode));
  }, 20000);
});

describe('оркестрация — ошибки агентов и gates (фасады pipeline.ts)', () => {
  it('Pipeline.run: IntakeAgent.parseIntent отклоняется → error', async () => {
    vi.spyOn(IntakeAgent.prototype, 'parseIntent').mockRejectedValueOnce(new Error('LLM недоступен'));
    const result = await new Pipeline().run('задача');
    expect(result.status).toBe('error');
    expect(result.error).toContain('LLM недоступен');
  });

  it('runPipelineWithExecAgent: IntakeAgent.parseIntent отклоняется → error', async () => {
    vi.spyOn(IntakeAgent.prototype, 'parseIntent').mockRejectedValueOnce(new Error('LLM недоступен'));
    const result = await runPipelineWithExecAgent('задача');
    expect(result.status).toBe('error');
    expect(result.error).toContain('LLM недоступен');
  });

  it('Pipeline.run: OsnovaCodegenAgent.generate отклоняется → error', async () => {
    vi.spyOn(OsnovaCodegenAgent.prototype, 'generate').mockRejectedValueOnce(new Error('codegen fail'));
    const result = await new Pipeline().run('посчитай сумму от 1 до 10');
    expect(result.status).toBe('error');
    expect(result.error).toContain('codegen fail');
  }, 20000);

  it('runPipelineWithExecAgent: G1 (пустые features у intent) → error', async () => {
    vi.spyOn(IntakeAgent.prototype, 'parseIntent').mockResolvedValueOnce({
      intentId: 'g1-test',
      description: 'тест',
      features: [],
      appType: 'утилита',
      constraints: {},
      confidence: 0.9,
    } as OsnovaIntent);
    const result = await runPipelineWithExecAgent('тест G1');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/G1 failed/);
  }, 20000);

  it('Pipeline.run: G1 (пустые features у intent) → error', async () => {
    vi.spyOn(IntakeAgent.prototype, 'parseIntent').mockResolvedValueOnce({
      intentId: 'g1-test-pipeline',
      description: 'тест',
      features: [],
      appType: 'утилита',
      constraints: {},
      confidence: 0.9,
    } as OsnovaIntent);
    const result = await new Pipeline().run('тест G1 pipeline');
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/G1 failed/);
  }, 20000);

  it('Pipeline.run и runPipelineWithExecAgent: generateSpec отклоняется → error', async () => {
    const spy = vi
      .spyOn(IntakeAgent.prototype, 'generateSpec')
      .mockRejectedValueOnce(new Error('spec gen fail'));
    const r1 = await new Pipeline().run('задача');
    expect(r1.status).toBe('error');
    expect(r1.error).toContain('spec gen fail');
    spy.mockRejectedValueOnce(new Error('spec gen fail'));
    const r2 = await runPipelineWithExecAgent('задача');
    expect(r2.status).toBe('error');
    expect(r2.error).toContain('spec gen fail');
  }, 20000);

  it('runPipelineWithExecAgent: OsnovaCodegenAgent.generate отклоняется → error', async () => {
    vi.spyOn(OsnovaCodegenAgent.prototype, 'generate').mockRejectedValueOnce(new Error('codegen fail exec'));
    const result = await runPipelineWithExecAgent('посчитай сумму от 1 до 10');
    expect(result.status).toBe('error');
    expect(result.error).toContain('codegen fail exec');
  }, 20000);
});

// ─── Фабрики для gate / health (поля совпадают с gateChecker.test, имена привязаны к types) ───

function makeGateIntent(overrides: Partial<OsnovaIntent> = {}): OsnovaIntent {
  return {
    intentId: 'gate-i',
    description: 'тест',
    features: ['x'],
    appType: 'утилита',
    constraints: {},
    confidence: 0.9,
    ...overrides,
  };
}

function makeGateSpec(overrides: Partial<OsnovaSpec> = {}): OsnovaSpec {
  return {
    specId: 'gate-s',
    modules: [{ name: 'м', description: '', isMain: true }],
    mainModule: 'м',
    types: [],
    procedures: [],
    syscalls: [],
    conventions: {},
    ...overrides,
  };
}

function makeGateBuild(overrides: Partial<BuildReport> = {}): BuildReport {
  return {
    success: true,
    lexerErrors: [],
    parserErrors: [],
    compilerErrors: [],
    semanticErrors: [],
    bytecode: {},
    compilerSuccess: true,
    durationMs: 100,
    ...overrides,
  };
}

function makeGateGolden(overrides: Partial<GoldenReport> = {}): GoldenReport {
  return {
    executed: true,
    passed: true,
    qualityScore: 0.9,
    vmErrors: [],
    outputDiff: null,
    durationMs: 10,
    ...overrides,
  };
}

describe('spec-гейты и healthScore — контракт types.ts / thresholds', () => {
  it('SPEC_QUALITY_PASS / SPEC_QUALITY_PARTIAL совпадают с thresholds.ts (G3)', () => {
    expect(SPEC_QUALITY_PASS).toBe(QUALITY_PASS);
    expect(SPEC_QUALITY_PARTIAL).toBe(QUALITY_PARTIAL);
  });

  it('G1: для не-утилиты блок при confidence < SPEC_G1_CONFIDENCE_MIN, проход на границе', () => {
    const low = checkG1(
      makeGateIntent({ appType: 'алгоритм', confidence: SPEC_G1_CONFIDENCE_MIN - 1e-6 }),
      makeGateSpec(),
    );
    expect(low.passed).toBe(false);
    expect(low.failedChecks.some(f => f.startsWith('g1_confidence'))).toBe(true);

    const edge = checkG1(
      makeGateIntent({ appType: 'модуль', confidence: SPEC_G1_CONFIDENCE_MIN }),
      makeGateSpec(),
    );
    expect(edge.passed).toBe(true);
  });

  it('G2: предупреждение по длительности строго после SPEC_BUILD_DURATION_WARN_MS', () => {
    const ok = checkG2(makeGateBuild({ durationMs: SPEC_BUILD_DURATION_WARN_MS }));
    expect(ok.passed).toBe(true);
    expect(ok.failedChecks.filter(f => f.includes('g2_build_time'))).toHaveLength(0);

    const warn = checkG2(makeGateBuild({ durationMs: SPEC_BUILD_DURATION_WARN_MS + 1 }));
    expect(warn.passed).toBe(true);
    expect(warn.failedChecks.some(f => f.startsWith('g2_build_time'))).toBe(true);
  });

  it('G3: границы qualityScore относительно SPEC_QUALITY_PASS / SPEC_QUALITY_PARTIAL', () => {
    expect(checkG3(makeGateGolden({ qualityScore: SPEC_QUALITY_PASS })).passed).toBe(true);

    const belowPass = checkG3(makeGateGolden({ qualityScore: SPEC_QUALITY_PASS - 1e-6 }));
    expect(belowPass.passed).toBe(false);
    expect(belowPass.failedChecks.some(f => f.startsWith('g3_golden_or_quality'))).toBe(true);

    const atPartial = checkG3(
      makeGateGolden({ qualityScore: SPEC_QUALITY_PARTIAL, outputDiff: 'x', passed: false }),
    );
    expect(atPartial.passed).toBe(false);
    expect(atPartial.failedChecks.some(f => f.startsWith('g3_golden_or_quality'))).toBe(true);
    expect(atPartial.failedChecks.some(f => f.startsWith('g3_output_diff_acceptable'))).toBe(false);

    const diffCrash = checkG3(
      makeGateGolden({
        qualityScore: SPEC_QUALITY_PARTIAL - 1e-6,
        outputDiff: 'diff',
        passed: false,
      }),
    );
    expect(diffCrash.passed).toBe(false);
    expect(diffCrash.failedChecks.some(f => f.startsWith('g3_output_diff_acceptable'))).toBe(true);
  });

  it('G3: VM crash (executed=false) блокирует независимо от qualityScore', () => {
    const r = checkG3(
      makeGateGolden({ executed: false, qualityScore: 1, vmErrors: [], passed: false }),
    );
    expect(r.passed).toBe(false);
    expect(r.failedChecks.some(f => f.startsWith('g3_vm_executed'))).toBe(true);
  });

  it('calcHealthScore: partial + golden 1.0; все DiagnosticPipelineStatus дают 0 без golden', () => {
    expect(
      calcHealthScore({
        status: 'partial',
        repairAttempts: 0,
        goldenQualityScore: 1,
      }),
    ).toBe(0.8);

    for (const status of ALL_DIAGNOSTIC_PIPELINE_STATUSES) {
      expect(calcHealthScore({ status, repairAttempts: 0 }), status).toBe(0);
    }
    expect(calcHealthScore({ status: 'error', repairAttempts: 0 })).toBe(0);
    expect(calcHealthScore({ status: 'success', repairAttempts: 0 })).toBe(1);
  });
});

describe('partial: qualityScore ∈ [SPEC_QUALITY_PARTIAL, SPEC_QUALITY_PASS) без регрессии фасадов', () => {
  const midPartialQuality = (SPEC_QUALITY_PARTIAL + SPEC_QUALITY_PASS) / 2;

  function mockGoldenInPartialBand() {
    return vi.spyOn(goldenApps, 'runGoldenCheck').mockResolvedValue({
      executed: true,
      passed: false,
      qualityScore: midPartialQuality,
      vmErrors: [],
      outputDiff: null,
      durationMs: 1,
    });
  }

  it('Pipeline.run (оркестратор) → status partial, repairAttempts = 0', async () => {
    const spy = mockGoldenInPartialBand();
    try {
      const result = await new Pipeline().run('посчитай сумму от 1 до 10');
      expect(spy, 'сценарий partial опирается на подмену runGoldenCheck').toHaveBeenCalled();
      expect(result.status).toBe('partial');
      expect(result.repairAttempts).toBe(0);
      expect(result.goldenReport?.qualityScore).toBe(midPartialQuality);
    } finally {
      spy.mockRestore();
    }
  }, 20000);

  it('runPipelineWithExecAgent → status partial при том же qualityScore', async () => {
    const spy = mockGoldenInPartialBand();
    try {
      const result = await runPipelineWithExecAgent('посчитай сумму от 1 до 10');
      expect(spy, 'сценарий partial опирается на подмену runGoldenCheck').toHaveBeenCalled();
      expect(result.status).toBe('partial');
      expect(result.repairAttempts).toBe(0);
    } finally {
      spy.mockRestore();
    }
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

describe('blocker-resolver — parse atm_id, эпики 015 / FBK016 (без IO)', () => {
  it('parse: валидные atm_id серий 015 и FBK016', () => {
    const a015 = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001');
    const aFb = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '007');
    expect(parseForgeBlockerAtmId(a015)).toEqual({
      ok: true,
      scenario: '015',
      epkBase: FORGE_STATE_BLOCKER_EPK_ATM_015,
      ordinal: '001',
    });
    expect(parseForgeBlockerAtmId(aFb)).toEqual({
      ok: true,
      scenario: 'FBK016',
      epkBase: FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
      ordinal: '007',
    });
  });

  it('parse: краевые форматы — пусто, нет ATM-, нет суффикса, неизвестный эпик', () => {
    expect(parseForgeBlockerAtmId('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseForgeBlockerAtmId('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseForgeBlockerAtmId('EPK-260328-015-001')).toEqual({ ok: false, reason: 'missing_atm_prefix' });
    expect(parseForgeBlockerAtmId('ATM-EPK-260328-015')).toEqual({ ok: false, reason: 'missing_ordinal' });
    expect(parseForgeBlockerAtmId('ATM-EPK-260328-FBK016')).toEqual({ ok: false, reason: 'missing_ordinal' });
    expect(parseForgeBlockerAtmId('ATM-EPK-260328-015-')).toEqual({ ok: false, reason: 'missing_ordinal' });
    expect(parseForgeBlockerAtmId('ATM-other')).toEqual({ ok: false, reason: 'unknown_epic' });
  });

  it('resolve: совпадает с префиксным контрактом types; trim для пробелов', () => {
    const id = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001');
    expect(resolveForgeBlockerScenarioFromAtmId(id)).toBe('FBK016');
    expect(resolveForgeBlockerScenarioFromAtmId(`  ${id}  `)).toBe('FBK016');
    expect(resolveForgeBlockerScenarioFromAtmId('ATM-other')).toBeNull();
  });
});
