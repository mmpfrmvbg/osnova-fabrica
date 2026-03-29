import { describe, it, expect } from 'vitest';
import {
  FORGE_STATE_BLOCKER_ATM_PREFIX,
  FORGE_STATE_BLOCKER_EPK_ATM_015,
  FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
  composeForgeStateBlockerAtmId,
} from '../src/tools/blocker-types';
import {
  parseForgeBlockerAtmId,
  pruneForgeStateBlockers,
  resolveForgeBlockerScenarioFromAtmId,
} from '../src/pipeline/blocker-resolver';

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
      const result = pruneForgeStateBlockers([valid015, validFbk], new Set());
      expect(result).toHaveLength(2);
      expect(result[0].issue).toBe(1);
      expect(result[1].issue).toBe(2);
    });

    it('удаляет записи с закрытыми issues', () => {
      const rec1 = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
      const rec2 = makeRecord(2, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '001'));
      const result = pruneForgeStateBlockers([rec1, rec2], new Set([2]));
      expect(result).toHaveLength(1);
      expect(result[0].issue).toBe(1);
    });

    it('удаляет записи с невалидным atm_id форматом', () => {
      const valid = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
      const invalid = makeRecord(2, 'ATM-EPK-UNKNOWN-001');
      const result = pruneForgeStateBlockers([valid, invalid], new Set());
      expect(result).toHaveLength(1);
      expect(result[0].issue).toBe(1);
    });

    it('сохраняет исходный порядок записей', () => {
      const rec1 = makeRecord(10, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '010'));
      const rec2 = makeRecord(20, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_FBK016, '020'));
      const rec3 = makeRecord(30, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '030'));
      const result = pruneForgeStateBlockers([rec1, rec2, rec3], new Set());
      expect(result.map((r) => r.issue)).toEqual([10, 20, 30]);
    });

    it('обрабатывает пустой массив entries', () => {
      expect(pruneForgeStateBlockers([], new Set())).toEqual([]);
    });

    it('обрабатывает пустой set closedIssueIds', () => {
      const rec = makeRecord(1, composeForgeStateBlockerAtmId(FORGE_STATE_BLOCKER_EPK_ATM_015, '001'));
      expect(pruneForgeStateBlockers([rec], new Set())).toEqual([rec]);
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
