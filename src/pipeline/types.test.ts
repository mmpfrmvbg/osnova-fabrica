/**
 * Тесты типов пайплайна: DiagnosticReport, DiagnosticCode, DiagnosticStatus, PipelineStatus
 */

import { describe, it, expect } from 'vitest';
import type {
  DiagnosticReport,
  DiagnosticCode,
  DiagnosticStatus,
  DiagnosticPipelineStatus,
  PipelineStatus,
  PipelineResult,
  SpecG1CheckPrefix,
  SpecG2CheckPrefix,
  SpecG3CheckPrefix,
  ForgeStateBlockerIssueId,
  ForgeStateBlockerAtmId,
  ForgeStateBlockerRecord,
} from './types';
import { QUALITY_PARTIAL, QUALITY_PASS } from './thresholds';
import {
  is015DiagnosticCode,
  isFBK016DiagnosticCode,
  is015DiagnosticPipelineStatus,
  isFBK016DiagnosticPipelineStatus,
  isBlockedStatus,
  isResolvedStatus,
  isIgnoredStatus,
  DIAGNOSTIC_015_ATOM_NOT_FOUND,
  DIAGNOSTIC_015_ATOM_CORRUPTED,
  DIAGNOSTIC_015_DEP_UNRESOLVED,
  DIAGNOSTIC_FBK016_REJECTED,
  DIAGNOSTIC_FBK016_TIMEOUT,
  DIAGNOSTIC_FBK016_LIMIT_EXCEEDED,
  PIPELINE_STATUS_FOR_DIAGNOSTIC,
  DIAGNOSTIC_CODE_FOR_PIPELINE_STATUS,
  pipelineStatusFromDiagnosticCode,
  diagnosticCodeFromPipelineStatus,
  forgeBlockerScenarioFromDiagnosticCode,
  forgeBlockerEpkBaseForDiagnosticCode,
  forgeBlockerScenarioFromAtmId,
  forgeBlockerScenarioFromPipelineStatus,
  composeForgeStateBlockerAtmId,
  is015ForgeBlockerAtmId,
  isFBK016ForgeBlockerAtmId,
  FORGE_STATE_BLOCKER_ATM_015_PREFIX,
  FORGE_STATE_BLOCKER_ATM_FBK016_PREFIX,
  SPEC_G1_CONFIDENCE_MIN,
  SPEC_INTENT_CONFIDENCE_DEFAULT,
  SPEC_QUALITY_PASS,
  SPEC_QUALITY_PARTIAL,
  SPEC_BUILD_DURATION_WARN_MS,
  FORGE_STATE_BLOCKER_ATM_PREFIX,
  FORGE_STATE_BLOCKER_EPK_ATM_015,
  FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
} from './types';

describe('DiagnosticCode', () => {
  it('серия 015: атом не найден', () => {
    const code: DiagnosticCode = '015-001';
    expect(is015DiagnosticCode(code)).toBe(true);
  });

  it('серия 015: атом повреждён', () => {
    const code: DiagnosticCode = '015-002';
    expect(is015DiagnosticCode(code)).toBe(true);
  });

  it('серия 015: зависимость атома не разрешена', () => {
    const code: DiagnosticCode = '015-003';
    expect(is015DiagnosticCode(code)).toBe(true);
  });

  it('серия FBK016: обратная связь отклонена', () => {
    const code: DiagnosticCode = 'FBK016-001';
    expect(isFBK016DiagnosticCode(code)).toBe(true);
  });

  it('серия FBK016: таймаут обратной связи', () => {
    const code: DiagnosticCode = 'FBK016-002';
    expect(isFBK016DiagnosticCode(code)).toBe(true);
  });

  it('серия FBK016: лимит попыток превышен', () => {
    const code: DiagnosticCode = 'FBK016-003';
    expect(isFBK016DiagnosticCode(code)).toBe(true);
  });
});

describe('DiagnosticStatus', () => {
  it('статус blocked', () => {
    const status: DiagnosticStatus = 'blocked';
    expect(status).toBe('blocked');
  });

  it('статус resolved', () => {
    const status: DiagnosticStatus = 'resolved';
    expect(status).toBe('resolved');
  });

  it('статус ignored', () => {
    const status: DiagnosticStatus = 'ignored';
    expect(status).toBe('ignored');
  });
});

describe('ForgeStateBlockerRecord (state v5)', () => {
  it('константы префиксов 015 / FBK016 для atm_id', () => {
    expect(FORGE_STATE_BLOCKER_ATM_PREFIX).toBe('ATM-');
    expect(FORGE_STATE_BLOCKER_EPK_ATM_015).toBe('EPK-260328-015');
    expect(FORGE_STATE_BLOCKER_EPK_ATM_FBK016).toBe('EPK-260328-FBK016');
  });

  it('запись blockers с issue и atm_id серии 015', () => {
    const row: ForgeStateBlockerRecord = {
      issue: 68 as ForgeStateBlockerIssueId,
      atm_id: composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'),
      open: true,
      updated: '2026-03-28T17:38:41.541959+03:00',
    };
    expect(row.issue).toBe(68);
    expect(row.atm_id).toBe('ATM-EPK-260328-015-001');
  });

  it('запись blockers с atm_id серии FBK016', () => {
    const row: ForgeStateBlockerRecord = {
      issue: 75 as ForgeStateBlockerIssueId,
      atm_id: composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001'),
      open: true,
      updated: '2026-03-28T20:33:26.507566+03:00',
    };
    expect(row.atm_id).toBe('ATM-EPK-260328-FBK016-001');
  });

  it('префиксы atm_id 015 / FBK016', () => {
    expect(FORGE_STATE_BLOCKER_ATM_015_PREFIX).toBe('ATM-EPK-260328-015-');
    expect(FORGE_STATE_BLOCKER_ATM_FBK016_PREFIX).toBe('ATM-EPK-260328-FBK016-');
  });
});

describe('DiagnosticReport', () => {
  it('минимальный отчёт об ошибке 015', () => {
    const report: DiagnosticReport = {
      code: '015-001',
      status: 'blocked',
      message: 'Атом не найден в хранилище',
      timestamp: '2026-03-29T10:00:00.000Z',
    };
    expect(report.code).toBe('015-001');
    expect(report.status).toBe('blocked');
    expect(report.message).toBeTruthy();
    expect(report.timestamp).toBeTruthy();
  });

  it('полный отчёт об ошибке FBK016 с контекстом', () => {
    const report: DiagnosticReport = {
      code: 'FBK016-002',
      status: 'resolved',
      message: 'Таймаут ожидания обратной связи',
      phase: 'golden_check',
      atomId: 'EPK-260328-015-003',
      retryCount: 2,
      timestamp: '2026-03-29T10:05:00.000Z',
    };
    expect(report.code).toBe('FBK016-002');
    expect(report.status).toBe('resolved');
    expect(report.phase).toBe('golden_check');
    expect(report.atomId).toBe('EPK-260328-015-003');
    expect(report.retryCount).toBe(2);
  });

  it('коллекция диагностик для PipelineResult', () => {
    const diagnostics: DiagnosticReport[] = [
      {
        code: '015-001',
        status: 'blocked',
        message: 'Атом не найден',
        timestamp: '2026-03-29T10:00:00.000Z',
      },
      {
        code: 'FBK016-001',
        status: 'ignored',
        message: 'Обратная связь отклонена',
        timestamp: '2026-03-29T10:01:00.000Z',
      },
    ];
    expect(diagnostics).toHaveLength(2);
    expect(is015DiagnosticCode(diagnostics[0].code)).toBe(true);
    expect(isFBK016DiagnosticCode(diagnostics[1].code)).toBe(true);
  });
});

describe('PipelineStatus с ошибками 015 и FBK016', () => {
  it('базовые статусы', () => {
    const statuses: PipelineStatus[] = ['success', 'partial', 'repair_exhausted', 'error'];
    expect(statuses).toHaveLength(4);
  });

  it('статус error_015_atom_not_found', () => {
    const status: PipelineStatus = 'error_015_atom_not_found';
    expect(status).toMatch(/error_015/);
  });

  it('статус error_015_atom_corrupted', () => {
    const status: PipelineStatus = 'error_015_atom_corrupted';
    expect(status).toMatch(/error_015/);
  });

  it('статус error_015_dep_unresolved', () => {
    const status: PipelineStatus = 'error_015_dep_unresolved';
    expect(status).toMatch(/error_015/);
  });

  it('статус error_fbk016_rejected', () => {
    const status: PipelineStatus = 'error_fbk016_rejected';
    expect(status).toMatch(/error_fbk016/);
  });

  it('статус error_fbk016_timeout', () => {
    const status: PipelineStatus = 'error_fbk016_timeout';
    expect(status).toMatch(/error_fbk016/);
  });

  it('статус error_fbk016_limit_exceeded', () => {
    const status: PipelineStatus = 'error_fbk016_limit_exceeded';
    expect(status).toMatch(/error_fbk016/);
  });
});

describe('DiagnosticCode ↔ DiagnosticPipelineStatus', () => {
  const pairs: [DiagnosticCode, DiagnosticPipelineStatus][] = [
    ['015-001', 'error_015_atom_not_found'],
    ['015-002', 'error_015_atom_corrupted'],
    ['015-003', 'error_015_dep_unresolved'],
    ['FBK016-001', 'error_fbk016_rejected'],
    ['FBK016-002', 'error_fbk016_timeout'],
    ['FBK016-003', 'error_fbk016_limit_exceeded'],
  ];

  it('PIPELINE_STATUS_FOR_DIAGNOSTIC совпадает с ожидаемой таблицей', () => {
    for (const [code, st] of pairs) {
      expect(PIPELINE_STATUS_FOR_DIAGNOSTIC[code]).toBe(st);
      expect(pipelineStatusFromDiagnosticCode(code)).toBe(st);
    }
  });

  it('diagnosticCodeFromPipelineStatus — обратное отображение', () => {
    for (const [code, st] of pairs) {
      expect(diagnosticCodeFromPipelineStatus(st)).toBe(code);
    }
  });

  it('DIAGNOSTIC_CODE_FOR_PIPELINE_STATUS согласован с PIPELINE_STATUS_FOR_DIAGNOSTIC', () => {
    for (const [code, st] of pairs) {
      expect(DIAGNOSTIC_CODE_FOR_PIPELINE_STATUS[st]).toBe(code);
    }
  });
});

describe('DiagnosticCode ↔ blockers (015 / FBK016)', () => {
  it('forgeBlockerScenarioFromDiagnosticCode и EPK-база', () => {
    expect(forgeBlockerScenarioFromDiagnosticCode('015-001')).toBe('015');
    expect(forgeBlockerEpkBaseForDiagnosticCode('015-001')).toBe(FORGE_STATE_BLOCKER_EPK_ATM_015);
    expect(forgeBlockerScenarioFromDiagnosticCode('FBK016-003')).toBe('FBK016');
    expect(forgeBlockerEpkBaseForDiagnosticCode('FBK016-003')).toBe(FORGE_STATE_BLOCKER_EPK_ATM_FBK016);
  });

  it('composeForgeStateBlockerAtmId + forgeBlockerScenarioFromAtmId', () => {
    const atm015 = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '042');
    expect(atm015).toBe('ATM-EPK-260328-015-042');
    expect(is015ForgeBlockerAtmId(atm015)).toBe(true);
    expect(isFBK016ForgeBlockerAtmId(atm015)).toBe(false);
    expect(forgeBlockerScenarioFromAtmId(atm015)).toBe('015');

    const atmFb = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '007');
    expect(isFBK016ForgeBlockerAtmId(atmFb)).toBe(true);
    expect(forgeBlockerScenarioFromAtmId(atmFb)).toBe('FBK016');
    expect(forgeBlockerScenarioFromAtmId('ATM-other')).toBeNull();
  });

  it('forgeBlockerScenarioFromPipelineStatus', () => {
    expect(forgeBlockerScenarioFromPipelineStatus('error_015_dep_unresolved')).toBe('015');
    expect(forgeBlockerScenarioFromPipelineStatus('error_fbk016_timeout')).toBe('FBK016');
  });

  it('is015DiagnosticPipelineStatus / isFBK016DiagnosticPipelineStatus', () => {
    expect(is015DiagnosticPipelineStatus('error_015_atom_not_found')).toBe(true);
    expect(is015DiagnosticPipelineStatus('error_fbk016_rejected')).toBe(false);
    expect(is015DiagnosticPipelineStatus('success')).toBe(false);

    expect(isFBK016DiagnosticPipelineStatus('error_fbk016_limit_exceeded')).toBe(true);
    expect(isFBK016DiagnosticPipelineStatus('error_015_atom_corrupted')).toBe(false);
  });
});

describe('PipelineResult с lastErrorKind', () => {
  it('успешный результат без lastErrorKind', () => {
    const result: PipelineResult = {
      status: 'success',
      repairAttempts: 0,
      totalDurationMs: 1500,
    };
    expect(result.status).toBe('success');
    expect(result.lastErrorKind).toBeUndefined();
  });

  it('результат с diagnostics (015/FBK016)', () => {
    const diagnostics: DiagnosticReport[] = [
      {
        code: '015-001',
        status: 'blocked',
        message: 'Атом не найден',
        timestamp: '2026-03-29T10:00:00.000Z',
      },
    ];
    const result: PipelineResult = {
      status: pipelineStatusFromDiagnosticCode('015-001'),
      repairAttempts: 0,
      totalDurationMs: 100,
      diagnostics,
    };
    expect(result.status).toBe('error_015_atom_not_found');
    expect(result.diagnostics).toHaveLength(1);
    expect(diagnosticCodeFromPipelineStatus(result.status as DiagnosticPipelineStatus)).toBe('015-001');
  });

  it('результат repair_exhausted с lastErrorKind', () => {
    const result: PipelineResult = {
      status: 'repair_exhausted',
      repairAttempts: 3,
      totalDurationMs: 30000,
      error: 'max repair loops reached',
      lastErrorKind: 'parser_error',
    };
    expect(result.status).toBe('repair_exhausted');
    expect(result.lastErrorKind).toBe('parser_error');
    expect(result.repairAttempts).toBe(3);
  });

  it('результат error с lastErrorKind', () => {
    const result: PipelineResult = {
      status: 'error',
      repairAttempts: 0,
      totalDurationMs: 500,
      error: 'LLM недоступен',
      lastErrorKind: undefined,
    };
    expect(result.status).toBe('error');
    expect(result.lastErrorKind).toBeUndefined();
  });
});

describe('Экспорт типов для agents и runtime', () => {
  it('DiagnosticReport экспортирован', () => {
    const report: DiagnosticReport = {
      code: '015-001',
      status: 'blocked',
      message: 'test',
      timestamp: '2026-03-29T10:00:00.000Z',
    };
    expect(report).toBeDefined();
  });

  it('DiagnosticCode экспортирован', () => {
    const code: DiagnosticCode = 'FBK016-001';
    expect(code).toBeDefined();
  });

  it('DiagnosticStatus экспортирован', () => {
    const status: DiagnosticStatus = 'resolved';
    expect(status).toBeDefined();
  });

  it('PipelineStatus с расширенными типами экспортирован', () => {
    const status: PipelineStatus = 'error_015_atom_corrupted';
    expect(status).toBeDefined();
  });
});

describe('Type-guards для DiagnosticCode', () => {
  it('is015DiagnosticCode: true для 015-*', () => {
    expect(is015DiagnosticCode('015-001')).toBe(true);
    expect(is015DiagnosticCode('015-002')).toBe(true);
    expect(is015DiagnosticCode('015-003')).toBe(true);
  });

  it('is015DiagnosticCode: false для FBK016-*', () => {
    expect(is015DiagnosticCode('FBK016-001')).toBe(false);
    expect(is015DiagnosticCode('FBK016-002')).toBe(false);
    expect(is015DiagnosticCode('FBK016-003')).toBe(false);
  });

  it('isFBK016DiagnosticCode: true для FBK016-*', () => {
    expect(isFBK016DiagnosticCode('FBK016-001')).toBe(true);
    expect(isFBK016DiagnosticCode('FBK016-002')).toBe(true);
    expect(isFBK016DiagnosticCode('FBK016-003')).toBe(true);
  });

  it('isFBK016DiagnosticCode: false для 015-*', () => {
    expect(isFBK016DiagnosticCode('015-001')).toBe(false);
    expect(isFBK016DiagnosticCode('015-002')).toBe(false);
    expect(isFBK016DiagnosticCode('015-003')).toBe(false);
  });
});

describe('Type-guards для DiagnosticStatus', () => {
  it('isBlockedStatus: true для blocked', () => {
    expect(isBlockedStatus('blocked')).toBe(true);
    expect(isBlockedStatus('resolved')).toBe(false);
    expect(isBlockedStatus('ignored')).toBe(false);
  });

  it('isResolvedStatus: true для resolved', () => {
    expect(isResolvedStatus('resolved')).toBe(true);
    expect(isResolvedStatus('blocked')).toBe(false);
    expect(isResolvedStatus('ignored')).toBe(false);
  });

  it('isIgnoredStatus: true для ignored', () => {
    expect(isIgnoredStatus('ignored')).toBe(true);
    expect(isIgnoredStatus('blocked')).toBe(false);
    expect(isIgnoredStatus('resolved')).toBe(false);
  });
});

describe('Алиасы DiagnosticCode', () => {
  it('алиасы серии 015', () => {
    expect(DIAGNOSTIC_015_ATOM_NOT_FOUND).toBe('015-001');
    expect(DIAGNOSTIC_015_ATOM_CORRUPTED).toBe('015-002');
    expect(DIAGNOSTIC_015_DEP_UNRESOLVED).toBe('015-003');
  });

  it('алиасы серии FBK016', () => {
    expect(DIAGNOSTIC_FBK016_REJECTED).toBe('FBK016-001');
    expect(DIAGNOSTIC_FBK016_TIMEOUT).toBe('FBK016-002');
    expect(DIAGNOSTIC_FBK016_LIMIT_EXCEEDED).toBe('FBK016-003');
  });

  it('алиас FBK016 проходит type-guard', () => {
    expect(isFBK016DiagnosticCode(DIAGNOSTIC_FBK016_REJECTED)).toBe(true);
    expect(isFBK016DiagnosticCode(DIAGNOSTIC_FBK016_TIMEOUT)).toBe(true);
    expect(isFBK016DiagnosticCode(DIAGNOSTIC_FBK016_LIMIT_EXCEEDED)).toBe(true);
  });

  it('алиас 015 проходит type-guard', () => {
    expect(is015DiagnosticCode(DIAGNOSTIC_015_ATOM_NOT_FOUND)).toBe(true);
    expect(is015DiagnosticCode(DIAGNOSTIC_015_ATOM_CORRUPTED)).toBe(true);
    expect(is015DiagnosticCode(DIAGNOSTIC_015_DEP_UNRESOLVED)).toBe(true);
  });
});

describe('Spec / gate пороги (EPK-022)', () => {
  it('SPEC_G1_CONFIDENCE_MIN совпадает с порогом G1 в gateChecker', () => {
    expect(SPEC_G1_CONFIDENCE_MIN).toBe(0.7);
  });

  it('SPEC_INTENT_CONFIDENCE_DEFAULT — дефолт intake при невалидном confidence', () => {
    expect(SPEC_INTENT_CONFIDENCE_DEFAULT).toBe(0.8);
  });

  it('SPEC_QUALITY_* согласованы с thresholds.ts', () => {
    expect(SPEC_QUALITY_PASS).toBe(QUALITY_PASS);
    expect(SPEC_QUALITY_PARTIAL).toBe(QUALITY_PARTIAL);
  });

  it('SPEC_BUILD_DURATION_WARN_MS — 30s для предупреждения G2', () => {
    expect(SPEC_BUILD_DURATION_WARN_MS).toBe(30_000);
  });

  it('префиксы gate в failedChecks (литералы контракта)', () => {
    const g1: SpecG1CheckPrefix = 'g1_confidence';
    const g2: SpecG2CheckPrefix = 'g2_semantic_clean';
    const g3: SpecG3CheckPrefix = 'g3_no_vm_errors';
    expect(`${g1}:`).toMatch(/^g1_confidence:/);
    expect(`${g2}:`).toMatch(/^g2_semantic_clean:/);
    expect(`${g3}:`).toMatch(/^g3_no_vm_errors:/);
  });
});
