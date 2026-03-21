#!/usr/bin/env tsx
// scripts/blame-mode-bisect.ts
// Бинарный поиск виновного коммита (log₂N шагов).
// Оракул: npx tsx src/scripts/analyze-language-health.ts --json --since=<дата>
//   exit 0 = GOOD, exit 1 = BAD (semantic_errors_in_success > 0)
//
// Запуск: npm run blame-mode-bisect [-- --last-good <SHA>] [-- --head <SHA>]

import { execSync, spawnSync } from 'child_process';

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(`[bisect] failed: ${cmd}\n${err.stderr ?? ''}`);
  }
}

function getCommitDate(sha: string): string {
  return run(`git log -1 --format=%aI ${sha}`);
}

function checkHealthAtDate(isoDate: string): boolean {
  const result = spawnSync(
    'npx',
    ['tsx', 'src/scripts/analyze-language-health.ts', '--json', '--since', isoDate],
    { encoding: 'utf-8', stdio: 'pipe', shell: true },
  );
  return result.status === 0;
}

function getCommitList(since: string, until: string): string[] {
  const out = run(`git log --format=%H ${since}..${until}`);
  if (!out) return [];
  return out.split('\n').filter(Boolean).reverse(); // oldest first
}

async function bisect(lastGoodSha: string, headSha: string) {
  const commits = getCommitList(lastGoodSha, headSha);
  if (commits.length === 0) {
    return { badSha: headSha, message: 'нет коммитов между lastGood и HEAD', steps: 0 };
  }
  console.log(`[bisect] ${commits.length} коммитов, log₂ ≈ ${Math.ceil(Math.log2(commits.length))} шагов`);
  let lo = 0;
  let hi = commits.length - 1;
  let steps = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const sha = commits[mid]!;
    const dt = getCommitDate(sha);
    console.log(`[bisect] шаг ${++steps}: ${sha.slice(0, 8)} (${dt})`);
    const ok = checkHealthAtDate(dt);
    console.log(`[bisect]   → ${ok ? 'GOOD ✓' : 'BAD ✗'}`);
    if (ok) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const badSha = commits[lo] ?? headSha;
  const message = run(`git log -1 --format=%s ${badSha}`);
  return { badSha, message, steps };
}

async function main() {
  const args = process.argv.slice(2);
  let headSha = 'HEAD';
  let lastGoodSha: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--head' && args[i + 1]) {
      headSha = args[++i]!;
    } else if (args[i] === '--last-good' && args[i + 1]) {
      lastGoodSha = args[++i]!;
    }
  }
  headSha = run(`git rev-parse ${headSha}`);

  if (!lastGoodSha) {
    console.log('[bisect] Ищу последний good коммит (до 50)...');
    const recent = run('git log --format=%H -50').split('\n').filter(Boolean);
    for (const sha of recent) {
      if (checkHealthAtDate(getCommitDate(sha))) {
        lastGoodSha = sha;
        console.log(`[bisect] last-good: ${sha.slice(0, 8)}`);
        break;
      }
    }
    if (!lastGoodSha) {
      console.error('[bisect] good коммит не найден. Задай --last-good вручную.');
      process.exit(1);
    }
  }

  console.log(`[bisect] HEAD:      ${headSha.slice(0, 8)}`);
  console.log(`[bisect] last-good: ${lastGoodSha.slice(0, 8)}\n`);

  const result = await bisect(lastGoodSha, headSha);

  console.log('\n═══ РЕЗУЛЬТАТ BISECT ═══');
  console.log(`Виновный коммит: ${result.badSha}`);
  console.log(`Сообщение:       ${result.message}`);
  console.log(`Шагов:           ${result.steps}`);
  console.log('\nJSON:');
  console.log(
    JSON.stringify(
      {
        blame_sha: result.badSha,
        blame_message: result.message,
        bisect_steps: result.steps,
        head_sha: headSha,
        last_good_sha: lastGoodSha,
      },
      null,
      2,
    ),
  );
}

main().catch(e => {
  console.error('[bisect] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
