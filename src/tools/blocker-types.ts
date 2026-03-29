// ============================================================
// src/tools/blocker-types.ts — Зеркало контрактов state v5 для CLI
// Только типы и константы ATM/EPK, без IO
// ============================================================

/** Номер GitHub issue в поле `issue` записи `blockers` state v5. */
export type ForgeStateBlockerIssueId = number;

/**
 * Поле `atm_id` записи `blockers`: обычно `{@link FORGE_STATE_BLOCKER_ATM_PREFIX}` +
 * {@link FORGE_STATE_BLOCKER_EPK_ATM_015} или {@link FORGE_STATE_BLOCKER_EPK_ATM_FBK016} + `-` + порядковый суффикс.
 */
export type ForgeStateBlockerAtmId = string;

/** Префикс идентификатора атома в `atm_id` state v5. */
export const FORGE_STATE_BLOCKER_ATM_PREFIX = 'ATM-' as const;

/** Базовый токен серии 015 в `atm_id` (атомы Forge); согласовано с {@link DiagnosticCode} `015-*`. */
export const FORGE_STATE_BLOCKER_EPK_ATM_015 = 'EPK-260328-015' as const;

/** Базовый токен серии FBK016 в `atm_id` (обратная связь); согласовано с {@link DiagnosticCode} `FBK016-*`. */
export const FORGE_STATE_BLOCKER_EPK_ATM_FBK016 = 'EPK-260328-FBK016' as const;

/** Запись в массиве `blockers` при `v: 5` в `.osnova/state.yaml`. */
export interface ForgeStateBlockerRecord {
  readonly issue: ForgeStateBlockerIssueId;
  readonly atm_id: ForgeStateBlockerAtmId;
  readonly open: boolean;
  readonly updated: string;
}

/** Префикс `atm_id` blockers v5 для серии 015 (до порядкового суффикса). */
export const FORGE_STATE_BLOCKER_ATM_015_PREFIX =
  `${FORGE_STATE_BLOCKER_ATM_PREFIX}${FORGE_STATE_BLOCKER_EPK_ATM_015}-` as const;

/** Префикс `atm_id` blockers v5 для серии FBK016 (до порядкового суффикса). */
export const FORGE_STATE_BLOCKER_ATM_FBK016_PREFIX =
  `${FORGE_STATE_BLOCKER_ATM_PREFIX}${FORGE_STATE_BLOCKER_EPK_ATM_FBK016}-` as const;

/** Проверка: `atm_id` относится к сценарию blockers серии 015. */
export function is015ForgeBlockerAtmId(atmId: string): boolean {
  return atmId.startsWith(FORGE_STATE_BLOCKER_ATM_015_PREFIX);
}

/** Проверка: `atm_id` относится к сценарию blockers серии FBK016. */
export function isFBK016ForgeBlockerAtmId(atmId: string): boolean {
  return atmId.startsWith(FORGE_STATE_BLOCKER_ATM_FBK016_PREFIX);
}

/**
 * Семья сценария Forge blockers по `atm_id` (`015` / `FBK016`), если строка совпадает с префиксами v5.
 */
export function forgeBlockerScenarioFromAtmId(atmId: string): '015' | 'FBK016' | null {
  if (is015ForgeBlockerAtmId(atmId)) return '015';
  if (isFBK016ForgeBlockerAtmId(atmId)) return 'FBK016';
  return null;
}

/** Собирает `atm_id` записи blockers v5 из EPK-базы и порядкового суффикса. */
export function composeForgeStateBlockerAtmId(
  epkBase: typeof FORGE_STATE_BLOCKER_EPK_ATM_015 | typeof FORGE_STATE_BLOCKER_EPK_ATM_FBK016,
  ordinalSuffix: string
): ForgeStateBlockerAtmId {
  return `${FORGE_STATE_BLOCKER_ATM_PREFIX}${epkBase}-${ordinalSuffix}` as ForgeStateBlockerAtmId;
}

/** Причина отбраковки записи blockers при stale-чистке. */
export type BlockerStaleReason =
  | 'closed_issue'      // issue закрыт на GitHub
  | 'invalid_atm_id';   // atm_id не проходит parseForgeBlockerAtmId (устаревший формат)

/** Флаг резолвера: результат проверки записи blockers. */
export interface BlockerResolveFlag {
  readonly keep: boolean;
  readonly reason?: BlockerStaleReason;
}
