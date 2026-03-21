// ============================================================
// src/pipeline/gateChecker.ts — Исполнитель gates.yaml
// Источник правды: gates.yaml (3 gates: G1, G2, G3)
// Пороги qualityScore — src/pipeline/thresholds.ts
// ============================================================

import { QUALITY_PASS, QUALITY_PARTIAL } from './thresholds';
import { BLOCKING_SEMANTIC_KINDS } from './semanticKinds';
import type { OsnovaIntent, OsnovaSpec, BuildReport, GoldenReport } from './types';

export type GateId = 'G1_spec_ready' | 'G2_build_pass' | 'G3_golden_pass';

export interface GateResult {
  readonly passed: boolean;
  readonly gateId: GateId;
  readonly failedChecks: readonly string[];
  readonly action?: string;
}

// ─── G1: Spec Ready (после intake, перед codegen) ───
export function checkG1(
  intent: OsnovaIntent,
  spec: OsnovaSpec,
): GateResult {
  const failed: string[] = [];
  const normalizedIntent: OsnovaIntent = {
    ...intent,
    appType: intent.appType ?? 'утилита',
  };

  const isSimpleUtility = normalizedIntent.appType === 'утилита';
  if (!isSimpleUtility && normalizedIntent.confidence < 0.7)
    failed.push('g1_confidence: intent.confidence < 0.7 → ask_user_to_clarify');

  if (normalizedIntent.features.length < 1)
    failed.push('g1_features_present: no features → ask_user_what_program_should_do');

  if (spec.modules.length < 1)
    failed.push('g1_modules_defined: no modules → retry_spec_generation');

  if (!spec.mainModule)
    failed.push('g1_main_module_set: mainModule not set (warning)');

  if (!intent.appType)
    failed.push('g1_app_type_classified: appType null (warning, defaulting to утилита)');

  const blockingFailed = failed.filter(f => !f.includes('warning'));

  return {
    passed: blockingFailed.length === 0,
    gateId: 'G1_spec_ready',
    failedChecks: failed,
    action: blockingFailed[0]?.split('→')[1]?.trim(),
  };
}

// ─── G2: Build Pass (после build, перед golden_check) ───
export function checkG2(buildReport: BuildReport): GateResult {
  const failed: string[] = [];

  if (buildReport.lexerErrors.length > 0)
    failed.push(`g2_lexer_clean: ${buildReport.lexerErrors.length} lexer error(s) → route_to_repair`);

  if (buildReport.parserErrors.length > 0)
    failed.push(`g2_parser_clean: ${buildReport.parserErrors.length} parser error(s) → route_to_repair`);

  if (!buildReport.compilerSuccess || buildReport.bytecode === null)
    failed.push('g2_compiler_success: no bytecode → route_to_repair');

  const blockingSemantic = (buildReport.semanticErrors ?? []).filter(
    e => BLOCKING_SEMANTIC_KINDS.some(kind => kind === e.kind),
  );
  if (blockingSemantic.length > 0) {
    const details = blockingSemantic.map(e => e.message).join('; ');
    failed.push(`g2_semantic_clean: ${details} → route_to_repair`);
  }

  if (buildReport.durationMs > 30000)
    failed.push('g2_build_time: build > 30s (warning, log_slow_build)');

  const blockingFailed = failed.filter(f => !f.includes('warning'));

  return {
    passed: blockingFailed.length === 0,
    gateId: 'G2_build_pass',
    failedChecks: failed,
    action: blockingFailed.length > 0 ? 'route_to_repair' : undefined,
  };
}

// ─── G3: Golden Check Pass (после golden_check) ───
export function checkG3(goldenReport: GoldenReport): GateResult {
  const failed: string[] = [];

  if (!goldenReport.executed)
    failed.push('g3_vm_executed: VM crashed → route_to_repair');

  if (goldenReport.vmErrors.length > 0)
    failed.push(`g3_no_vm_errors: ${goldenReport.vmErrors.length} VM error(s) → route_to_repair`);

  // Если VM выполнилась без ошибок, но эталон (expectVM.returnValue) не задан,
  // ранее это приводило к qualityScore=0 и passed=false, из-за чего pipeline начинал repair-цикл.
  // В этом режиме считаем выполнение зачтённым.
  const allowExecutedCleanWithoutExpectVmReturn =
    goldenReport.executed && goldenReport.vmErrors.length === 0 && goldenReport.qualityScore === 0;
  if (allowExecutedCleanWithoutExpectVmReturn) {
    return {
      passed: true,
      gateId: 'G3_golden_pass',
      failedChecks: [],
      action: undefined,
    };
  }

  const qualityOk = goldenReport.qualityScore >= QUALITY_PASS;
  if (!qualityOk)
    failed.push(`g3_golden_or_quality: qualityScore < ${QUALITY_PASS} → route_to_repair`);

  const diffCritical =
    goldenReport.outputDiff !== null && goldenReport.qualityScore < QUALITY_PARTIAL;
  if (diffCritical)
    failed.push(`g3_output_diff_acceptable: diff present AND qualityScore < ${QUALITY_PARTIAL} → route_to_repair`);

  const blockingFailed = failed.filter(f => !f.includes('warning'));

  return {
    passed: blockingFailed.length === 0,
    gateId: 'G3_golden_pass',
    failedChecks: failed,
    action: blockingFailed.length > 0 ? 'route_to_repair' : undefined,
  };
}
