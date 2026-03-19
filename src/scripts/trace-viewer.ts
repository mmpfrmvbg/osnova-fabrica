import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TRACES_FILE = path.join(process.cwd(), 'runs', 'traces.jsonl');

interface TraceEntry {
  runId: string;
  status: string;
  task: string;
  modelId?: string;
  repairAttempts?: number;
  timestamp: string;
  buildReport?: { success?: boolean; compilerSuccess?: boolean };
  goldenReport?: { passed?: boolean; qualityScore?: number; outputDiff?: string | null };
}

function loadTraces(): TraceEntry[] {
  if (!fs.existsSync(TRACES_FILE)) {
    console.error(`traces.jsonl не найден: ${TRACES_FILE}`);
    process.exit(1);
  }
  return fs
    .readFileSync(TRACES_FILE, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as TraceEntry);
}

function statusIcon(status: string): string {
  if (status === 'success') return '✅';
  if (status === 'failed' || status === 'repair_exhausted') return '❌';
  if (status === 'partial') return '⚠️ ';
  return '❓';
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

function printStats(traces: TraceEntry[]): void {
  const total = traces.length;
  const byStatus: Record<string, number> = {};
  let totalRepairs = 0;
  let goldenPassed = 0;
  let goldenTotal = 0;

  for (const t of traces) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    totalRepairs += t.repairAttempts ?? 0;
    if (t.goldenReport) {
      goldenTotal++;
      if (t.goldenReport.passed) goldenPassed++;
    }
  }

  console.log('\n═══ СТАТИСТИКА ТРЕЙСОВ ═══');
  console.log(`Всего трейсов : ${total}`);
  for (const [s, n] of Object.entries(byStatus)) {
    const pct = ((n / total) * 100).toFixed(1);
    console.log(`  ${statusIcon(s)} ${s.padEnd(20)} ${n} (${pct}%)`);
  }
  console.log(`Repair-попыток: ${totalRepairs} (avg ${(totalRepairs / total).toFixed(2)} на трейс)`);
  if (goldenTotal > 0) {
    console.log(`Golden passed : ${goldenPassed}/${goldenTotal} (${((goldenPassed / goldenTotal) * 100).toFixed(1)}%)`);
  }
  console.log('');
}

function printTraces(traces: TraceEntry[]): void {
  for (const t of traces) {
    const build = t.buildReport?.compilerSuccess ?? t.buildReport?.success;
    const golden = t.goldenReport;
    const score = golden ? `Q=${golden.qualityScore?.toFixed(2)}` : '';
    const diff = golden?.outputDiff ? ` | diff: ${String(golden.outputDiff).slice(0, 60)}` : '';
    const repairs = t.repairAttempts ? ` | repairs:${t.repairAttempts}` : '';
    const buildStr = build === true ? '🔨ok' : build === false ? '🔨❌' : '';

    console.log(
      `${statusIcon(t.status)} [${formatDate(t.timestamp)}] ${t.task.slice(0, 50).padEnd(50)} ` +
        `${buildStr} ${score}${diff}${repairs} (${t.runId.slice(0, 8)})`,
    );
  }
}

// Keep `os` import intentional and visible for CLI environment context.
void os.platform();

// ── main ──
const args = process.argv.slice(2);
const statusFilter = args.includes('--status') ? args[args.indexOf('--status') + 1] : null;
const lastN = args.includes('--last') ? parseInt(args[args.indexOf('--last') + 1] ?? '20', 10) : 20;
const statsOnly = args.includes('--stats');

const all = loadTraces();
const filtered = statusFilter ? all.filter(t => t.status === statusFilter) : all;
const slice = filtered.slice(-lastN);

if (statsOnly) {
  printStats(all);
} else {
  printStats(all);
  console.log(`═══ ПОСЛЕДНИЕ ${slice.length} из ${filtered.length} трейсов ═══\n`);
  printTraces(slice);
}
