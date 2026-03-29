// ============================================================
// Разбор поля `atm_id` записей blockers (state v5) и серии 015 / FBK016.
// Константы и префиксные проверки — в types.ts; здесь структурированный parse без IO.
// ============================================================

import type { ForgeStateBlockerIssueId, ForgeStateBlockerRecord } from './types';
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

/**
 * Контракт **stale** для blockers state v5 (серии EPK-260328-015 и EPK-260328-FBK016, см. ATM-003 / FBK016):
 * актуальна только запись, у которой {@link parseForgeBlockerAtmId} возвращает `ok: true` — то есть `atm_id`
 * строго вида `ATM-EPK-260328-015-<suffix>` или `ATM-EPK-260328-FBK016-<suffix>` с непустым суффиксом.
 * Всё остальное (другие эпики, строка без `ATM-`, без ординала, пусто) считается устаревшим префиксом/форматом
 * и отбрасывается при чистке списка вместе с записями по уже закрытым GitHub issues.
 *
 * @param entries исходный массив в исходном порядке
 * @param closedIssueIds номера issues, закрытых на GitHub (или эквивалентный снимок); такие строки удаляются
 * @returns подмножество записей в том же порядке, без мутации полей и без IO
 */
export function pruneForgeStateBlockers(
  entries: readonly ForgeStateBlockerRecord[],
  closedIssueIds: ReadonlySet<ForgeStateBlockerIssueId> | Iterable<ForgeStateBlockerIssueId>
): ForgeStateBlockerRecord[] {
  const closed =
    closedIssueIds instanceof Set
      ? closedIssueIds
      : new Set<ForgeStateBlockerIssueId>(closedIssueIds);
  const pruned: ForgeStateBlockerRecord[] = [];
  for (const entry of entries) {
    if (closed.has(entry.issue)) continue;
    if (!parseForgeBlockerAtmId(entry.atm_id).ok) continue;
    pruned.push(entry);
  }
  return pruned;
}
