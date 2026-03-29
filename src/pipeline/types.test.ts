/**
 * Тесты типов пайплайна: DiagnosticReport, DiagnosticCode, DiagnosticStatus, PipelineStatus
 */

import { describe, it, expect } from 'vitest';
import type {
  DiagnosticReport,
  DiagnosticCode,
  DiagnosticStatus,
  PipelineStatus,
  PipelineResult,
} from './types';
import {
  is015DiagnosticCode,
  isFBK016DiagnosticCode,
  isBlockedStatus,
  isResolvedStatus,
  isIgnoredStatus,
  DIAGNOSTIC_015_ATOM_NOT_FOUND,
  DIAGNOSTIC_015_ATOM_CORRUPTED,
  DIAGNOSTIC_015_DEP_UNRESOLVED,
  DIAGNOSTIC_FBK016_REJECTED,
  DIAGNOSTIC_FBK016_TIMEOUT,
  DIAGNOSTIC_FBK016_LIMIT_EXCEEDED,
} from './types';

describe('DiagnosticCode', () => {
  it('серия 015: атом не найден', () => {
    const code: DiagnosticCode = '015-001';
    expect(code).toMatch(/^015-/);
  });

  it('серия 015: атом повреждён', () => {
    const code: DiagnosticCode = '015-002';
    expect(code).toMatch(/^015-/);
  });

  it('серия 015: зависимость атома не разрешена', () => {
    const code: DiagnosticCode = '015-003';
    expect(code).toMatch(/^015-/);
  });

  it('серия FBK016: обратная связь отклонена', () => {
    const code: DiagnosticCode = 'FBK016-001';
    expect(code).toMatch(/^FBK016-/);
  });

  it('серия FBK016: таймаут обратной связи', () => {
    const code: DiagnosticCode = 'FBK016-002';
    expect(code).toMatch(/^FBK016-/);
  });

  it('серия FBK016: лимит попыток превышен', () => {
    const code: DiagnosticCode = 'FBK016-003';
    expect(code).toMatch(/^FBK016-/);
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
    expect(diagnostics[0].code).toMatch(/^015-/);
    expect(diagnostics[1].code).toMatch(/^FBK016-/);
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

describe('PipelineResult с diagnostics', () => {
  it('успешный результат без диагностик', () => {
    const result: PipelineResult = {
      status: 'success',
      repairAttempts: 0,
      totalDurationMs: 1500,
    };
    expect(result.status).toBe('success');
    expect(result.diagnostics).toBeUndefined();
  });

  it('результат с ошибкой 015 и диагностикой', () => {
    const result: PipelineResult = {
      status: 'error_015_atom_not_found',
      repairAttempts: 0,
      totalDurationMs: 500,
      error: 'Атом не найден',
      diagnostics: [
        {
          code: '015-001',
          status: 'blocked',
          message: 'Атом EPK-260328-015-001 не найден в хранилище',
          atomId: 'EPK-260328-015-001',
          timestamp: '2026-03-29T10:00:00.000Z',
        },
      ],
    };
    expect(result.status).toBe('error_015_atom_not_found');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics![0].code).toBe('015-001');
  });

  it('результат с ошибкой FBK016 и множественной диагностикой', () => {
    const result: PipelineResult = {
      status: 'error_fbk016_timeout',
      repairAttempts: 3,
      totalDurationMs: 30000,
      error: 'Таймаут обратной связи',
      diagnostics: [
        {
          code: 'FBK016-002',
          status: 'blocked',
          message: 'Таймаут ожидания ответа от агента',
          phase: 'repair',
          retryCount: 3,
          timestamp: '2026-03-29T10:10:00.000Z',
        },
        {
          code: '015-003',
          status: 'ignored',
          message: 'Зависимость не разрешена, но не критично',
          atomId: 'EPK-260328-015-002',
          timestamp: '2026-03-29T10:10:05.000Z',
        },
      ],
    };
    expect(result.status).toBe('error_fbk016_timeout');
    expect(result.diagnostics).toHaveLength(2);
    expect(result.repairAttempts).toBe(3);
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
