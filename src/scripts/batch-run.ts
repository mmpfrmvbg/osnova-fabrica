#!/usr/bin/env ts-node
// ============================================================
// src/scripts/batch-run.ts — Batch pipeline runner
// Запуск множества задач из файла с ограничением concurrency
// ============================================================

import { runPipeline } from '../pipeline/orchestrator';
import { validateEnv } from '../env';
import { logger } from '../logger';
import * as fs from 'fs/promises';
import * as path from 'path';

const log = logger('batch-run');

function parseArgs(): {
  tasksPath: string;
  concurrency: number;
  outputPath: string;
  skipDone: boolean;
} {
  const args = process.argv.slice(2);
  let tasksPath = 'docs/batch-tasks.txt';
  let concurrency = 1;
  let outputPath = 'runs/batch-summary.json';
  let skipDone = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tasks' && args[i + 1]) {
      tasksPath = args[++i]!;
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      concurrency = Math.max(1, parseInt(args[++i]!, 10) || 1);
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i]!;
    } else if (args[i] === '--skip-done') {
      skipDone = true;
    }
  }

  return { tasksPath, concurrency, outputPath, skipDone };
}

async function loadTasks(tasksPath: string): Promise<string[]> {
  const absPath = path.resolve(tasksPath);
  const content = await fs.readFile(absPath, 'utf-8');
  return content
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));
}

async function loadDoneTasks(): Promise<Set<string>> {
  const dbPath = process.env.OSNOVA_TRACE_DB ?? './runs/traces.jsonl';
  const absPath = path.resolve(dbPath);
  const done = new Set<string>();
  try {
    const content = await fs.readFile(absPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { task?: string };
        if (entry.task) done.add(entry.task);
      } catch {
        /* skip malformed lines */
      }
    }
  } catch {
    /* file may not exist */
  }
  return done;
}

function statusSymbol(status: string): string {
  if (status === 'success') return '✓';
  if (status === 'repair_exhausted' || status === 'failure') return '✗';
  return '~';
}

interface TaskResult {
  task: string;
  status: string;
  repairAttempts: number;
  durationMs: number;
}

async function main(): Promise<void> {
  const { tasksPath, concurrency, outputPath, skipDone } = parseArgs();

  await validateEnv();

  let tasks = await loadTasks(tasksPath);

  if (skipDone) {
    const done = await loadDoneTasks();
    const before = tasks.length;
    tasks = tasks.filter((t) => !done.has(t));
    log.info('skip-done', { skipped: before - tasks.length, remaining: tasks.length });
  }

  const total = tasks.length;
  const results: TaskResult[] = [];
  const counts = { success: 0, partial: 0, repair_exhausted: 0, failure: 0 };
  let totalRepair = 0;

  const runOne = async (task: string, index: number): Promise<TaskResult> => {
    const start = Date.now();
    const result = await runPipeline(task);
    const durationMs = Date.now() - start;
    const tr: TaskResult = {
      task,
      status: result.status,
      repairAttempts: result.repairAttempts ?? 0,
      durationMs,
    };
    const sym = statusSymbol(result.status);
    const r = result.repairAttempts ?? 0;
    const short = task.length > 45 ? task.slice(0, 42) + '...' : task;
    console.log(`[${index + 1}/${total}] ${sym} ${result.status.padEnd(16)} ${r}r  "${short}"`);
    return tr;
  };

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((task, j) => runOne(task, i + j)),
    );
    results.push(...batchResults);
    for (const r of batchResults) {
      if (r.status === 'success') counts.success++;
      else if (r.status === 'partial') counts.partial++;
      else if (r.status === 'repair_exhausted') counts.repair_exhausted++;
      else counts.failure++;
      totalRepair += r.repairAttempts;
    }
  }

  const avgRepair = total > 0 ? (totalRepair / total).toFixed(1) : '0';

  console.log(`
═══ BATCH COMPLETE ═══
Total:            ${total}
success:          ${counts.success}  (${total ? Math.round((counts.success / total) * 100) : 0}%)
partial:          ${counts.partial}  (${total ? Math.round((counts.partial / total) * 100) : 0}%)
repair_exhausted: ${counts.repair_exhausted}  (${total ? Math.round((counts.repair_exhausted / total) * 100) : 0}%)
failure:          ${counts.failure}  (${total ? Math.round((counts.failure / total) * 100) : 0}%)
avg repair:       ${avgRepair}
═══════════════════════`);

  const summary = {
    total,
    success: counts.success,
    partial: counts.partial,
    repair_exhausted: counts.repair_exhausted,
    failure: counts.failure,
    avgRepair: parseFloat(avgRepair),
    tasks: results,
  };

  const outDir = path.dirname(path.resolve(outputPath));
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.resolve(outputPath),
    JSON.stringify(summary, null, 2),
    'utf-8',
  );
  log.info('summary written', { path: outputPath });
}

main().catch((err) => {
  console.error('[batch-run]', err);
  process.exit(1);
});
