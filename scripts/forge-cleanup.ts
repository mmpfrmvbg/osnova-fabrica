#!/usr/bin/env tsx
// scripts/forge-cleanup.ts — dry-run план чистки blockers в state v5 (без записи на диск).
//
// Путь к state: позиционный аргумент, --state <path>, или OSNOVA_STATE_PATH / FORGE_STATE_PATH
// (по умолчанию .osnova/state.yaml).
//
// Закрытые issues (как в pruneForgeStateBlockers): --closed "1,2,3" или FORGE_CLOSED_BLOCKER_ISSUES.
//
// Запуск: npx tsx scripts/forge-cleanup.ts [--dry-run] [--state path] [path]

import * as path from 'path';

import { parseForgeBlockerAtmId, pruneForgeStateBlockers } from '../src/pipeline/blocker-resolver';
import { loadForgeState } from '../src/pipeline/executor';
import type { ForgeStateBlockerIssueId } from '../src/pipeline/types';

function parseClosedIds(raw: string | undefined): Set<ForgeStateBlockerIssueId> {
  if (!raw?.trim()) return new Set();
  const out = new Set<ForgeStateBlockerIssueId>();
  for (const part of raw.split(/[\s,]+/)) {
    const t = part.trim();
    if (!t) continue;
    const n = Number(t);
    if (Number.isInteger(n)) out.add(n);
  }
  return out;
}

function resolveStatePath(argv: string[]): { path: string; closed: Set<ForgeStateBlockerIssueId> } {
  let explicit: string | undefined;
  let closedRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state' || a === '-s') {
      explicit = argv[++i];
      continue;
    }
    if (a === '--closed' || a === '-c') {
      closedRaw = argv[++i];
      continue;
    }
    if (a === '--dry-run') continue;
    if (!a.startsWith('-')) {
      explicit ??= a;
    }
  }
  const fromEnv = process.env.OSNOVA_STATE_PATH ?? process.env.FORGE_STATE_PATH;
  const p = path.resolve(explicit ?? fromEnv ?? '.osnova/state.yaml');
  const closed = parseClosedIds(
    closedRaw ?? process.env.FORGE_CLOSED_BLOCKER_ISSUES ?? process.env.FORGE_CLOSED_ISSUES
  );
  return { path: p, closed };
}

function reasonLabel(
  r: Extract<ReturnType<typeof parseForgeBlockerAtmId>, { ok: false }>['reason']
): string {
  switch (r) {
    case 'empty':
      return 'пустой atm_id';
    case 'missing_atm_prefix':
      return 'нет префикса ATM-';
    case 'unknown_epic':
      return 'неизвестная EPK-база в atm_id';
    case 'missing_ordinal':
      return 'нет порядкового суффикса после EPK-базы';
    default:
      return String(r);
  }
}

function main(): void {
  const { path: statePath, closed } = resolveStatePath(process.argv.slice(2));

  const state = loadForgeState(statePath);
  if (state === null) {
    console.log(`forge-cleanup (dry-run): нет файла или пустой YAML — ${statePath}`);
    console.log('Действий по blockers не требуется.');
    process.exit(0);
  }

  const entries = state.blockers ?? [];
  const removeClosed: typeof entries = [];
  const removeStaleAtm: typeof entries = [];

  for (const e of entries) {
    if (closed.has(e.issue)) {
      removeClosed.push(e);
    } else {
      const parsed = parseForgeBlockerAtmId(e.atm_id);
      if (!parsed.ok) {
        removeStaleAtm.push(e);
      }
    }
  }

  const pruned = pruneForgeStateBlockers(entries, closed);
  const totalRemove = entries.length - pruned.length;

  console.log('Forge blocker cleanup — только dry-run (файл state не изменяется).');
  console.log(`State: ${statePath}`);
  console.log(`Записей blockers: ${entries.length}`);
  if (closed.size > 0) {
    console.log(`Закрытые issues (внешний список): ${[...closed].sort((a, b) => a - b).join(', ')}`);
  }
  console.log('');
  console.log('План удаления:');
  console.log('');

  if (removeClosed.length > 0) {
    console.log(`— По закрытому issue (${removeClosed.length}):`);
    for (const e of removeClosed) {
      console.log(`    issue #${e.issue}  atm_id=${JSON.stringify(e.atm_id)}  updated=${e.updated}`);
    }
    console.log('');
  }

  if (removeStaleAtm.length > 0) {
    console.log(`— Устаревший формат atm_id (${removeStaleAtm.length}):`);
    for (const e of removeStaleAtm) {
      const p = parseForgeBlockerAtmId(e.atm_id);
      if (!p.ok) {
        console.log(
          `    issue #${e.issue}  atm_id=${JSON.stringify(e.atm_id)}  причина: ${reasonLabel(p.reason)}`
        );
      }
    }
    console.log('');
  }

  if (totalRemove === 0) {
    console.log('(ничего не удалится — список уже соответствует правилам pruneForgeStateBlockers)');
  } else {
    console.log(`Итого к удалению: ${totalRemove}; останется записей: ${pruned.length}.`);
    console.log('Чтобы применить на диске, используйте пайплайн с applyStaleBlockerCleanup (не этот скрипт).');
  }
}

main();
