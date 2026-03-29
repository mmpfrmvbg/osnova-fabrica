// ============================================================
// Разбор поля `atm_id` записей blockers (state v5) и серии 015 / FBK016.
// Константы и префиксные проверки — в types.ts; здесь структурированный parse без IO.
// ============================================================

import {
  FORGE_STATE_BLOCKER_ATM_PREFIX,
  FORGE_STATE_BLOCKER_EPK_ATM_015,
  FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
  forgeBlockerScenarioFromAtmId,
} from './types';

export type ForgeBlockerAtmScenario = '015' | 'FBK016';

export type ParseForgeBlockerAtmIdFailureReason =
  | 'empty'
  | 'missing_atm_prefix'
  | 'unknown_epic'
  | 'missing_ordinal';

export type ParseForgeBlockerAtmIdResult =
  | {
      ok: true;
      scenario: ForgeBlockerAtmScenario;
      epkBase: typeof FORGE_STATE_BLOCKER_EPK_ATM_015 | typeof FORGE_STATE_BLOCKER_EPK_ATM_FBK016;
      ordinal: string;
    }
  | { ok: false; reason: ParseForgeBlockerAtmIdFailureReason };

/**
 * Разбирает `atm_id` вида `ATM-{EPK-база}-{порядковый суффикс}`.
 * FBK016 проверяется раньше 015, чтобы не перепутать базовые токены.
 */
export function parseForgeBlockerAtmId(atmId: string): ParseForgeBlockerAtmIdResult {
  const s = atmId.trim();
  if (s.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (!s.startsWith(FORGE_STATE_BLOCKER_ATM_PREFIX)) {
    return { ok: false, reason: 'missing_atm_prefix' };
  }
  const rest = s.slice(FORGE_STATE_BLOCKER_ATM_PREFIX.length);
  const fbk = `${FORGE_STATE_BLOCKER_EPK_ATM_FBK016}-`;
  const p15 = `${FORGE_STATE_BLOCKER_EPK_ATM_015}-`;

  if (rest.startsWith(fbk)) {
    const ordinal = rest.slice(fbk.length);
    if (ordinal.length === 0) {
      return { ok: false, reason: 'missing_ordinal' };
    }
    return {
      ok: true,
      scenario: 'FBK016',
      epkBase: FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
      ordinal,
    };
  }

  if (rest.startsWith(p15)) {
    const ordinal = rest.slice(p15.length);
    if (ordinal.length === 0) {
      return { ok: false, reason: 'missing_ordinal' };
    }
    return {
      ok: true,
      scenario: '015',
      epkBase: FORGE_STATE_BLOCKER_EPK_ATM_015,
      ordinal,
    };
  }

  if (rest === FORGE_STATE_BLOCKER_EPK_ATM_015 || rest === FORGE_STATE_BLOCKER_EPK_ATM_FBK016) {
    return { ok: false, reason: 'missing_ordinal' };
  }

  return { ok: false, reason: 'unknown_epic' };
}

/** Семья эпика по `atm_id` (те же префиксы v5, что и {@link forgeBlockerScenarioFromAtmId}). */
export function resolveForgeBlockerScenarioFromAtmId(atmId: string): ForgeBlockerAtmScenario | null {
  return forgeBlockerScenarioFromAtmId(atmId.trim());
}
