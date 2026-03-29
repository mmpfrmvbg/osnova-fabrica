import { describe, it } from 'vitest';

describe('blocker-resolver scaffold', () => {
  describe('parseForgeBlockerAtmId', () => {
    it.todo('returns ok:true for valid 015 scenario');
    it.todo('returns ok:true for valid FBK016 scenario');
    it.todo('returns ok:false with reason "empty" for empty string');
    it.todo('returns ok:false with reason "missing_atm_prefix" for non-ATM prefix');
    it.todo('returns ok:false with reason "unknown_epic" for unknown epic');
    it.todo('returns ok:false with reason "missing_ordinal" for missing ordinal');
  });

  describe('pruneForgeStateBlockers', () => {
    it.todo('keeps valid v5 records with open issues');
    it.todo('removes records with closed issues');
    it.todo('removes records with invalid atm_id format');
    it.todo('preserves original order of records');
    it.todo('handles empty entries array');
    it.todo('handles empty closedIssueIds set');
  });

  describe('resolveForgeBlockerScenarioFromAtmId', () => {
    it.todo('returns "015" for valid 015 atm_id');
    it.todo('returns "FBK016" for valid FBK016 atm_id');
    it.todo('returns null for invalid atm_id');
  });
});
