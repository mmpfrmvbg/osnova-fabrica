// ============================================================
// src/pipeline/executor.ts — Безопасный IO для .osnova/state.yaml (v5)
// Только fs + path; без сети. Запись — через временный файл и rename.
// Переходы «задача → запись state»: защита от гонок read-modify-write и инвариантов
// blockers (контракт atm_id 015 / FBK016, см. blocker-resolver).
// ============================================================

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'js-yaml';

import type { ForgeStateBlockerIssueId, ForgeStateBlockerRecord } from './types';
import { parseForgeBlockerAtmId, pruneForgeStateBlockers } from './blocker-resolver';

/** Секция `sessionstats` state v5 (ключи как в YAML). */
export interface ForgeStateSessionStats {
  epicsreceived?: number;
  epicsdone?: number;
  epicsblocked?: number;
  atomstotal?: number;
  atomsdone?: number;
  atomsblocked?: number;
  passrate?: number;
}

/** Секция `epicprogress` state v5. */
export interface ForgeStateEpicProgress {
  totalatoms?: number;
  done?: number;
  blocked?: number;
  current?: string | null;
}

/** Секция `ci` state v5. */
export interface ForgeStateCi {
  lastrun?: string | null;
  laststatus?: string | null;
  passrate7d?: number | null;
  openblockerissues?: number;
  lastepicissue?: number | null;
  ci_pending_issue?: number | null;
  ci_pending_epic?: string | null;
}

/** Секция `heart` state v5. */
export interface ForgeStateHeart {
  lastbeat?: string | null;
  restartstoday?: number;
  lastrestart?: string | null;
  statebackups?: number;
}

/** Статус одного исполнителя в `executors`. */
export interface ForgeStateExecutorProbe {
  available?: boolean;
  lastprobe?: string | null;
}

/** Секция `executors` state v5. */
export interface ForgeStateExecutors {
  qwen?: ForgeStateExecutorProbe;
  cursor?: ForgeStateExecutorProbe;
  activefallback?: string | null;
}

/** Счётчики по зоне в `zones`. */
export interface ForgeStateZoneCounters {
  done?: number;
  blk?: number;
}

/** Секция `budget` state v5. */
export interface ForgeStateBudget {
  qwenusedtoday?: number;
  qwenlimit?: number;
  cursortaskstoday?: number;
  qwenatomizerusedtoday?: number;
  qwenatomizerlimit?: number;
}

/**
 * Корень `.osnova/state.yaml` при `v: 5`.
 * Неизвестные ключи верхнего уровня при парсе отбрасываются не будут, если читать через load как unknown;
 * тип описывает ожидаемый контракт пайплайна.
 */
export interface ForgeStateV5 {
  v: 5;
  session?: string | null;
  updatedat?: string | null;
  currentepic?: string | null;
  epicprogress?: ForgeStateEpicProgress;
  sessionstats?: ForgeStateSessionStats;
  ci?: ForgeStateCi;
  brainsource?: string;
  heart?: ForgeStateHeart;
  executors?: ForgeStateExecutors;
  blockers?: ForgeStateBlockerRecord[];
  recent?: unknown[];
  zones?: Record<string, ForgeStateZoneCounters>;
  budget?: ForgeStateBudget;
  zonemap?: Record<string, string[]>;
  testcommands?: Record<string, string>;
}

const YAML_DUMP_OPTS: YAML.DumpOptions = {
  lineWidth: -1,
  noRefs: true,
  quotingType: "'",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Снимок mtime+size для обнаружения параллельной записи state между load и save. */
function forgeStateFileStamp(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function forgeStateStampEqual(
  a: { mtimeMs: number; size: number } | null,
  b: { mtimeMs: number; size: number } | null
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * Перед сериализацией: отбрасывает строки blockers с невалидным `atm_id`
 * (иначе сценарии 015/FBK016 и парсер blockers дают расхождения).
 */
function sanitizeForgeStateBlockers(state: ForgeStateV5): ForgeStateV5 {
  const entries = state.blockers;
  if (!entries?.length) return state;
  const kept: ForgeStateBlockerRecord[] = [];
  let dropped = 0;
  for (const e of entries) {
    if (parseForgeBlockerAtmId(e.atm_id).ok) kept.push(e);
    else dropped += 1;
  }
  if (dropped === 0) return state;
  console.warn(
    `[forge-state] save: dropped ${dropped} blocker row(s) with invalid atm_id (015/FBK016 contract)`
  );
  return { ...state, blockers: kept };
}

function parseForgeStateV5(raw: unknown): ForgeStateV5 {
  if (!isPlainObject(raw)) {
    throw new Error('state.yaml: корень должен быть объектом');
  }
  if (raw.v !== 5) {
    throw new Error(`state.yaml: ожидался v: 5, получено ${String(raw.v)}`);
  }
  return raw as unknown as ForgeStateV5;
}

/**
 * Читает state v5 по пути. Без сетевых вызовов.
 * @returns `null`, если файла нет или содержимое пустое (только пробелы).
 * @throws при невалидном YAML или если `v` не равен 5.
 */
export function loadForgeState(filePath: string): ForgeStateV5 | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) {
    return null;
  }
  let loaded: unknown;
  try {
    loaded = YAML.load(text, { schema: YAML.DEFAULT_SCHEMA });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`state.yaml: ошибка разбора YAML: ${msg}`);
  }
  return parseForgeStateV5(loaded);
}

function atomicWriteUtf8(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  try {
    if (process.platform === 'win32' && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Сериализует state v5 в YAML и атомарно записывает по пути (temp + rename).
 * Без сетевых вызовов.
 */
export function saveForgeState(filePath: string, state: ForgeStateV5): void {
  if (state.v !== 5) {
    throw new Error('saveForgeState: state.v должен быть 5');
  }
  const toWrite = sanitizeForgeStateBlockers(state);
  const body = YAML.dump(toWrite, YAML_DUMP_OPTS);
  const withNl = body.endsWith('\n') ? body : `${body}\n`;
  atomicWriteUtf8(filePath, withNl);
}

/**
 * Sweep `blockers` в state v5: удаляет записи по закрытым issues и устаревший формат `atm_id`
 * (см. {@link pruneForgeStateBlockers}). Запись на диск — только если список реально изменился.
 * В лог только агрегированные числа (без номеров issues и строк `atm_id`).
 */
export function applyStaleBlockerCleanup(
  statePath: string,
  closedIds: ReadonlySet<ForgeStateBlockerIssueId> | Iterable<ForgeStateBlockerIssueId>
): void {
  const closed =
    closedIds instanceof Set
      ? closedIds
      : new Set<ForgeStateBlockerIssueId>(closedIds);

  const label = path.basename(statePath);
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const stampBeforeLoad = forgeStateFileStamp(statePath);
    const state = loadForgeState(statePath);
    const stampAfterLoad = forgeStateFileStamp(statePath);
    if (!forgeStateStampEqual(stampBeforeLoad, stampAfterLoad)) {
      continue;
    }

    if (state === null) {
      if (attempt === 0) {
        console.info(`[forge-state] blocker sweep: skip (no state) file=${label}`);
      }
      return;
    }

    const entries = state.blockers ?? [];
    const before = entries.length;

    let removedClosed = 0;
    let removedStaleAtm = 0;
    for (const entry of entries) {
      if (closed.has(entry.issue)) {
        removedClosed += 1;
        continue;
      }
      if (!parseForgeBlockerAtmId(entry.atm_id).ok) {
        removedStaleAtm += 1;
      }
    }

    const pruned = pruneForgeStateBlockers(entries, closed);
    const after = pruned.length;

    if (after === before) {
      if (attempt === 0) {
        console.info(
          `[forge-state] blocker sweep: no-op before=${before} removed_closed=${removedClosed} removed_stale_atm=${removedStaleAtm} file=${label}`
        );
      }
      return;
    }

    const stampBeforeWrite = forgeStateFileStamp(statePath);
    if (!forgeStateStampEqual(stampAfterLoad, stampBeforeWrite)) {
      continue;
    }

    saveForgeState(statePath, { ...state, blockers: pruned });
    console.info(
      `[forge-state] blocker sweep: wrote before=${before} after=${after} removed_closed=${removedClosed} removed_stale_atm=${removedStaleAtm} file=${label}`
    );
    return;
  }

  console.warn(
    `[forge-state] blocker sweep: abandoned after ${maxAttempts} attempts (concurrent state writes?) file=${label}`
  );
}
