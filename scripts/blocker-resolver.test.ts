import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  FORGE_STATE_BLOCKER_ATM_PREFIX,
  FORGE_STATE_BLOCKER_EPK_ATM_015,
  FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
  composeForgeStateBlockerAtmId,
} from '../src/tools/blocker-types';
import {
  parseForgeBlockerAtmId,
  pruneForgeStateBlockers as prunePipeline,
  resolveForgeBlockerScenarioFromAtmId,
} from '../src/pipeline/blocker-resolver';
import {
  loadForgeState,
  extractBlockersFromState,
  loadAndExtractBlockers,
  pruneForgeStateBlockers as pruneTools,
  type ForgeStateV5,
} from '../src/tools/blocker-resolver';

describe('blocker-types', () => {
  describe('parseForgeBlockerAtmId — дискриминанты и литералы', () => {
    it('возвращает ok:true для валидного 015 сценария', () => {
      const atmId = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001');
      const result = parseForgeBlockerAtmId(atmId);
      expect(result).toEqual({
        ok: true,
        scenario: '015',
        epkBase: FORGE_STATE_BLOCKER_EPK_ATM_015,
        ordinal: '001',
      });
    });

    it('возвращает ok:true для валидного FBK016 сценария', () => {
      const atmId = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '002');
      const result = parseForgeBlockerAtmId(atmId);
      expect(result).toEqual({
        ok: true,
        scenario: 'FBK016',
        epkBase: FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
        ordinal: '002',
      });
    });

    it('возвращает ok:false с reason "empty" для пустой строки', () => {
      expect(parseForgeBlockerAtmId('')).toEqual({ ok: false, reason: 'empty' });
      expect(parseForgeBlockerAtmId('   ')).toEqual({ ok: false, reason: 'empty' });
    });

    it('возвращает ok:false с reason "missing_atm_prefix" для префикса не ATM', () => {
      expect(parseForgeBlockerAtmId('EPK-260328-015-001')).toEqual({
        ok: false,
        reason: 'missing_atm_prefix',
      });
    });

    it('возвращает ok:false с reason "unknown_epic" для неизвестного эпика', () => {
      expect(parseForgeBlockerAtmId('ATM-EPK-UNKNOWN-001')).toEqual({
        ok: false,
        reason: 'unknown_epic',
      });
    });

    it('возвращает ok:false с reason "missing_ordinal" для отсутствующего ordinal', () => {
      expect(parseForgeBlockerAtmId('ATM-EPK-260328-015')).toEqual({
        ok: false,
        reason: 'missing_ordinal',
      });
      expect(parseForgeBlockerAtmId('ATM-EPK-260328-FBK016')).toEqual({
        ok: false,
        reason: 'missing_ordinal',
      });
      expect(parseForgeBlockerAtmId('ATM-EPK-260328-015-')).toEqual({
        ok: false,
        reason: 'missing_ordinal',
      });
    });
  });

  describe('pruneForgeStateBlockers — узкие инварианты', () => {
    const makeRecord = (issue: number, atmId: string, open = true): typeof import('../src/tools/blocker-types').ForgeStateBlockerRecord => ({
      issue,
      atm_id: atmId,
      open,
      updated: '2026-03-29T00:00:00Z',
    });

    it('сохраняет валидные v5 записи с открытыми issues', () => {
      const valid015 = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
      const validFbk = makeRecord(2, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001'));
      const result = prunePipeline([valid015, validFbk], new Set());
      expect(result).toHaveLength(2);
      expect(result[0].issue).toBe(1);
      expect(result[1].issue).toBe(2);
    });

    it('удаляет записи с закрытыми issues', () => {
      const rec1 = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
      const rec2 = makeRecord(2, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001'));
      const result = prunePipeline([rec1, rec2], new Set([2]));
      expect(result).toHaveLength(1);
      expect(result[0].issue).toBe(1);
    });

    it('удаляет записи с невалидным atm_id форматом', () => {
      const valid = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
      const invalid = makeRecord(2, 'ATM-EPK-UNKNOWN-001');
      const result = prunePipeline([valid, invalid], new Set());
      expect(result).toHaveLength(1);
      expect(result[0].issue).toBe(1);
    });

    it('сохраняет исходный порядок записей', () => {
      const rec1 = makeRecord(10, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '010'));
      const rec2 = makeRecord(20, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '020'));
      const rec3 = makeRecord(30, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '030'));
      const result = prunePipeline([rec1, rec2, rec3], new Set());
      expect(result.map((r) => r.issue)).toEqual([10, 20, 30]);
    });

    it('обрабатывает пустой массив entries', () => {
      expect(prunePipeline([], new Set())).toEqual([]);
    });

    it('обрабатывает пустой set closedIssueIds', () => {
      const rec = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
      expect(prunePipeline([rec], new Set())).toEqual([rec]);
    });
  });

  describe('resolveForgeBlockerScenarioFromAtmId — CLI дискриминанты', () => {
    it('возвращает "015" для валидного 015 atm_id', () => {
      const atmId = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001');
      expect(resolveForgeBlockerScenarioFromAtmId(atmId)).toBe('015');
    });

    it('возвращает "FBK016" для валидного FBK016 atm_id', () => {
      const atmId = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001');
      expect(resolveForgeBlockerScenarioFromAtmId(atmId)).toBe('FBK016');
    });

    it('возвращает null для невалидного atm_id', () => {
      expect(resolveForgeBlockerScenarioFromAtmId('ATM-other')).toBeNull();
      expect(resolveForgeBlockerScenarioFromAtmId('')).toBeNull();
    });

    it('игнорирует пробелы вокруг atm_id', () => {
      const atmId = composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001');
      expect(resolveForgeBlockerScenarioFromAtmId(`  ${atmId}  `)).toBe('FBK016');
    });
  });
});

describe('tool classify — классификация stale ATM-блокеров', () => {
  const makeRecord = (issue: number, atmId: string, open = true): typeof import('../src/tools/blocker-types').ForgeStateBlockerRecord => ({
    issue,
    atm_id: atmId,
    open,
    updated: '2026-03-29T00:00:00Z',
  });

  it('pruneTools: сохраняет валидные 015/FBK016 записи', () => {
    const rec015 = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
    const recFbk = makeRecord(2, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001'));
    const result = pruneTools([rec015, recFbk], new Set());
    expect(result).toHaveLength(2);
  });

  it('pruneTools: удаляет закрытые issues', () => {
    const rec1 = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
    const rec2 = makeRecord(2, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001'));
    const result = pruneTools([rec1, rec2], new Set([2]));
    expect(result).toHaveLength(1);
    expect(result[0].issue).toBe(1);
  });

  it('pruneTools: удаляет stale atm_id (invalid format)', () => {
    const valid = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
    const stale = makeRecord(2, 'ATM-EPK-UNKNOWN-001');
    const result = pruneTools([valid, stale], new Set());
    expect(result).toHaveLength(1);
    expect(result[0].issue).toBe(1);
  });

  it('pruneTools: приоритет — closed issue > invalid atm_id', () => {
    const recClosedInvalid = makeRecord(5, 'INVALID-ATM');
    const result = pruneTools([recClosedInvalid], new Set([5]));
    expect(result).toHaveLength(0);
  });

  it('pruneTools: эквивалентность pruneTools и prunePipeline', () => {
    const entries = [
      makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001')),
      makeRecord(2, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '002')),
      makeRecord(3, 'ATM-EPK-UNKNOWN-003'),
      makeRecord(4, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '004')),
    ];
    const closed = new Set([2]);
    const resultTools = pruneTools(entries, closed);
    const resultPipeline = prunePipeline(entries, closed);
    expect(resultTools).toEqual(resultPipeline);
  });
});

describe('tool read — загрузка и извлечение blockers', () => {
  const REPO_ROOT = path.resolve(__dirname, '..');
  const STATE_PATH = '.osnova/state.yaml';

  describe('loadForgeState', () => {
    it('загружает валидный state v5 из репозитория', () => {
      const result = loadForgeState(REPO_ROOT, STATE_PATH);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.v).toBe(5);
        expect(Array.isArray(result.state.blockers)).toBe(true);
      }
    });

    it('возвращает file_not_found для несуществующего пути', () => {
      const result = loadForgeState(REPO_ROOT, 'nonexistent.yaml');
      expect(result).toEqual({ ok: false, reason: 'file_not_found' });
    });

    it('возвращает file_not_found для несуществующего относительного пути', () => {
      const result = loadForgeState(REPO_ROOT, '.osnova/missing.yaml');
      expect(result).toEqual({ ok: false, reason: 'file_not_found' });
    });
  });

  describe('extractBlockersFromState', () => {
    const makeState = (blockers: Array<Partial<ForgeStateV5['blockers'][number]>>): ForgeStateV5 => ({
      v: 5,
      blockers: blockers.map((b) => ({
        issue: b.issue ?? 1,
        atm_id: b.atm_id ?? 'ATM-EPK-260328-015-001',
        open: b.open ?? true,
        updated: b.updated ?? '2026-03-29T00:00:00Z',
      })),
    });

    it('извлекает валидные blockers и считает диагностику', () => {
      const state = makeState([
        { issue: 1, atm_id: composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001') },
        { issue: 2, atm_id: composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '002') },
      ]);
      const result = extractBlockersFromState(state);
      expect(result.blockers).toHaveLength(2);
      expect(result.diagnostics.total).toBe(2);
      expect(result.diagnostics.valid).toBe(2);
      expect(result.diagnostics.invalid).toBe(0);
      expect(result.diagnostics.invalidReasons).toEqual([]);
    });

    it('отфильтровывает невалидные atm_id и возвращает причины', () => {
      const state = makeState([
        { issue: 1, atm_id: composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001') },
        { issue: 2, atm_id: 'ATM-EPK-UNKNOWN-001' },
        { issue: 3, atm_id: '' },
      ]);
      const result = extractBlockersFromState(state);
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0].issue).toBe(1);
      expect(result.diagnostics.total).toBe(3);
      expect(result.diagnostics.valid).toBe(1);
      expect(result.diagnostics.invalid).toBe(2);
      expect(result.diagnostics.invalidReasons).toHaveLength(2);
    });

    it('обрабатывает пустой массив blockers', () => {
      const state = makeState([]);
      const result = extractBlockersFromState(state);
      expect(result.blockers).toEqual([]);
      expect(result.diagnostics.total).toBe(0);
      expect(result.diagnostics.valid).toBe(0);
      expect(result.diagnostics.invalid).toBe(0);
    });

    it('обрабатывает отсутствие поля blockers в state', () => {
      const state: ForgeStateV5 = { v: 5 };
      const result = extractBlockersFromState(state);
      expect(result.blockers).toEqual([]);
      expect(result.diagnostics.total).toBe(0);
    });
  });

  describe('loadAndExtractBlockers', () => {
    it('загружает state и извлекает blockers одним вызовом', () => {
      const result = loadAndExtractBlockers(REPO_ROOT, STATE_PATH);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockers.length).toBeGreaterThan(0);
        expect(result.diagnostics.total).toBeGreaterThanOrEqual(result.diagnostics.valid);
      }
    });

    it('возвращает ошибку для несуществующего файла', () => {
      const result = loadAndExtractBlockers(REPO_ROOT, 'nonexistent.yaml');
      expect(result).toEqual({ ok: false, reason: 'file_not_found' });
    });
  });
});
