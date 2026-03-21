// ============================================================
// src/tools/ab-prompt-test.ts — T-4
// Запускает два прогона (промпт A и промпт B) на одинаковом
// наборе задач, сравнивает success_rate / repair_attempts /
// teachability. Результат → runs/ab-results.jsonl
//
// Использование:
//   npm run ab-prompt-test -- --tasks src/tools/ab-tasks.txt
//     --prompt-a src/prompts/system-a.txt
//     --prompt-b src/prompts/system-b.txt
//     [--limit 50] [--dry-run]
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const AB_RESULTS_PATH = path.resolve('runs', 'ab-results.jsonl');

// ── Типы ──────────────────────────────────────────────────

interface RunRecord {
  task: string;
  status: string;
  repairAttempts: number;
  durationMs: number;
  error?: string;
}

interface ArmMetrics {
  label: string; // 'A' или 'B'
  prompt_file: string;
  total: number;
  success_rate: number;
  repair_exhausted_rate: number;
  avg_repair_attempts: number;
  teachability_score: number; // доля success с repairAttempts=0
  records: RunRecord[];
}

interface AbResult {
  timestamp: string;
  tasks_file: string;
  limit: number;
  arm_a: ArmMetrics;
  arm_b: ArmMetrics;
  winner: 'A' | 'B' | 'tie';
  delta_success_rate: number; // B - A
  delta_teachability: number; // B - A
}

// ── Хелперы ───────────────────────────────────────────────

function loadTasks(tasksFile: string, limit: number): string[] {
  if (!fs.existsSync(tasksFile)) {
    throw new Error(`tasks file not found: ${tasksFile}`);
  }
  return fs
    .readFileSync(tasksFile, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .slice(0, limit);
}

function computeArmMetrics(
  label: 'A' | 'B',
  promptFile: string,
  records: RunRecord[],
): ArmMetrics {
  const total = records.length;
  const successCount = records.filter(r => r.status === 'success').length;
  const exhaustedCount = records.filter(r => r.status === 'repair_exhausted').length;
  const firstAttempt = records.filter(r => r.status === 'success' && r.repairAttempts === 0).length;
  const repairSum = records.reduce((s, r) => s + r.repairAttempts, 0);

  return {
    label,
    prompt_file: promptFile,
    total,
    success_rate: total > 0 ? successCount / total : 0,
    repair_exhausted_rate: total > 0 ? exhaustedCount / total : 0,
    avg_repair_attempts: total > 0 ? repairSum / total : 0,
    teachability_score: successCount > 0 ? firstAttempt / successCount : 0,
    records,
  };
}

async function runArm(
  label: 'A' | 'B',
  promptFile: string,
  tasks: string[],
  dryRun: boolean,
): Promise<RunRecord[]> {
  // Промпт инжектируется через env (агенты могут читать OSNOVA_AB_PROMPT_FILE при генерации).
  process.env.OSNOVA_AB_PROMPT_FILE = promptFile;
  process.env.OSNOVA_DRY_RUN = dryRun ? '1' : '0';

  console.log(`\n[ab-test] ═══ ARM ${label}: ${path.basename(promptFile)} (${tasks.length} задач) ═══`);

  const { runPipeline } = await import('../pipeline/orchestrator');
  const records: RunRecord[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const t0 = Date.now();
    process.stdout.write(`  [${label}][${i + 1}/${tasks.length}] ${task.slice(0, 55)}... `);
    try {
      const r = await runPipeline(task);
      const dur = Date.now() - t0;
      const icon =
        r.status === 'success' ? '✅' : r.status === 'partial' ? '⚠️ ' : '❌';
      console.log(`${icon} ${r.status} repairs:${r.repairAttempts}`);
      records.push({
        task,
        status: r.status,
        repairAttempts: r.repairAttempts,
        durationMs: dur,
      });
    } catch (e) {
      const dur = Date.now() - t0;
      const errMsg = e instanceof Error ? e.message : String(e);
      console.log(`💥 error`);
      records.push({ task, status: 'error', repairAttempts: 0, durationMs: dur, error: errMsg });
    }
  }

  delete process.env.OSNOVA_AB_PROMPT_FILE;
  delete process.env.OSNOVA_DRY_RUN;
  return records;
}

function printComparison(result: AbResult): void {
  const { arm_a, arm_b, delta_success_rate, delta_teachability, winner } = result;
  const fmt = (v: number) => `${(v * 100).toFixed(1)}%`;
  const d = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

  console.log('\n═══ A/B РЕЗУЛЬТАТ ═══');
  console.log(`${'Метрика'.padEnd(28)} ${'A'.padEnd(10)} ${'B'.padEnd(10)} ${'Δ (B-A)'.padEnd(10)}`);
  console.log('─'.repeat(60));
  console.log(
    `${'Success rate'.padEnd(28)} ${fmt(arm_a.success_rate).padEnd(10)} ${fmt(arm_b.success_rate).padEnd(10)} ${d(delta_success_rate)}`,
  );
  console.log(
    `${'Repair exhausted'.padEnd(28)} ${fmt(arm_a.repair_exhausted_rate).padEnd(10)} ${fmt(arm_b.repair_exhausted_rate).padEnd(10)} ${d(arm_b.repair_exhausted_rate - arm_a.repair_exhausted_rate)}`,
  );
  console.log(
    `${'Teachability'.padEnd(28)} ${fmt(arm_a.teachability_score).padEnd(10)} ${fmt(arm_b.teachability_score).padEnd(10)} ${d(delta_teachability)}`,
  );
  console.log(
    `${'Avg repairs'.padEnd(28)} ${arm_a.avg_repair_attempts.toFixed(2).padEnd(10)} ${arm_b.avg_repair_attempts.toFixed(2).padEnd(10)}`,
  );
  console.log('─'.repeat(60));
  const winIcon =
    winner === 'B' ? '🏆 B лучше' : winner === 'A' ? '🏆 A лучше' : '🤝 Ничья';
  console.log(`Победитель: ${winIcon}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help')) {
    console.log(`
Usage: npm run ab-prompt-test -- [options]
  --tasks <file>     Файл с задачами (по одной на строку)
  --prompt-a <file>  Промпт A (system prompt, текстовый файл)
  --prompt-b <file>  Промпт B
  --limit <N>        Максимум задач (по умолчанию 50)
  --dry-run          Использовать OSNOVA_DRY_RUN=1
`);
    process.exit(0);
  }

  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1]! : null;
  };

  const tasksFile = get('--tasks') ?? path.resolve('src/tools/ab-tasks.txt');
  const promptA = get('--prompt-a') ?? '';
  const promptB = get('--prompt-b') ?? '';
  const limit = parseInt(get('--limit') ?? '50', 10);
  const dryRun = args.includes('--dry-run');

  if (!promptA || !promptB) {
    console.error('[ab-test] Необходимы --prompt-a и --prompt-b');
    console.error('  Пример: npm run ab-prompt-test -- --prompt-a prompts/a.txt --prompt-b prompts/b.txt');
    process.exit(1);
  }

  const tasks = loadTasks(tasksFile, limit);
  console.log(`[ab-test] Задач: ${tasks.length}, limit: ${limit}, dry-run: ${dryRun}`);
  console.log(`[ab-test] Промпт A: ${promptA}`);
  console.log(`[ab-test] Промпт B: ${promptB}`);

  const recordsA = await runArm('A', promptA, tasks, dryRun);
  const recordsB = await runArm('B', promptB, tasks, dryRun);

  const armA = computeArmMetrics('A', promptA, recordsA);
  const armB = computeArmMetrics('B', promptB, recordsB);

  const deltaSuccess = armB.success_rate - armA.success_rate;
  const deltaTeachability = armB.teachability_score - armA.teachability_score;

  // Победитель по success_rate, при ничье — по teachability
  let winner: 'A' | 'B' | 'tie';
  if (Math.abs(deltaSuccess) < 0.02) {
    winner = Math.abs(deltaTeachability) < 0.02 ? 'tie' : deltaTeachability > 0 ? 'B' : 'A';
  } else {
    winner = deltaSuccess > 0 ? 'B' : 'A';
  }

  const result: AbResult = {
    timestamp: new Date().toISOString(),
    tasks_file: tasksFile,
    limit,
    arm_a: armA,
    arm_b: armB,
    winner,
    delta_success_rate: deltaSuccess,
    delta_teachability: deltaTeachability,
  };

  printComparison(result);

  // Сохраняем в runs/ab-results.jsonl
  fs.mkdirSync(path.dirname(AB_RESULTS_PATH), { recursive: true });
  fs.appendFileSync(AB_RESULTS_PATH, JSON.stringify(result) + '\n', 'utf-8');
  console.log(`\n[ab-test] Результат сохранён → ${AB_RESULTS_PATH}`);
}

main().catch(e => {
  console.error('[ab-test] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
