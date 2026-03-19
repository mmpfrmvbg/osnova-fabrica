import * as fs from 'fs';
import * as path from 'path';

const TASKS_FILE = process.argv[2] ?? path.join(process.cwd(), 'src/scripts/batch-tasks.txt');
const DRY_RUN = process.env.OSNOVA_DRY_RUN === '1';

if (!DRY_RUN) {
  console.error('❌ Установи OSNOVA_DRY_RUN=1 перед запуском batch-run (или используй реальный LLM осторожно)');
  console.error('   OSNOVA_DRY_RUN=1 npx tsx src/scripts/batch-run.ts [tasks-file]');
  process.exit(1);
}

if (!fs.existsSync(TASKS_FILE)) {
  console.error(`Файл задач не найден: ${TASKS_FILE}`);
  console.error('Создай src/scripts/batch-tasks.txt — по одной задаче на строку');
  process.exit(1);
}

const tasks = fs.readFileSync(TASKS_FILE, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

console.log(`\n[batch-run] Задач: ${tasks.length}, dry-run: ${DRY_RUN}\n`);

interface BatchResult {
  task: string;
  status: string;
  repairAttempts: number;
  durationMs: number;
  error?: string;
}

const results: BatchResult[] = [];

async function main(): Promise<void> {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    const t0 = Date.now();
    process.stdout.write(`[${i + 1}/${tasks.length}] ${task.slice(0, 60)}... `);
    try {
      const { runPipeline } = await import('../pipeline/orchestrator');
      const r = await runPipeline(task);
      const dur = Date.now() - t0;
      results.push({ task, status: r.status, repairAttempts: r.repairAttempts, durationMs: dur });
      const icon = r.status === 'success' ? '✅' : r.status === 'partial' ? '⚠️ ' : '❌';
      console.log(`${icon} ${r.status} (${dur}ms, repairs:${r.repairAttempts})`);
    } catch (e) {
      const dur = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ task, status: 'error', repairAttempts: 0, durationMs: dur, error: msg });
      console.log(`💥 error: ${msg.slice(0, 80)}`);
    }
  }

  // Статистика
  const total = results.length;
  const byStatus: Record<string, number> = {};
  let totalRepairs = 0;
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    totalRepairs += r.repairAttempts;
  }

  console.log('\n═══ ИТОГИ BATCH-RUN ═══');
  console.log(`Всего: ${total}`);
  for (const [s, n] of Object.entries(byStatus)) {
    const pct = ((n / total) * 100).toFixed(1);
    console.log(`  ${s.padEnd(20)} ${n} (${pct}%)`);
  }
  console.log(`Repair-попыток: ${totalRepairs} (avg ${(totalRepairs / total).toFixed(2)})`);

  // Сохраняем результат
  const outPath = path.join(process.cwd(), 'runs', `batch-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), total, byStatus, results }, null, 2));
  console.log(`\nРезультат сохранён: ${outPath}\n`);
}

main().catch((e) => {
  console.error('[batch-run] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
