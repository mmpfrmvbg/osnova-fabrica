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
  intent?: { description?: string; appType?: string };
  spec?: { mainModule?: string; procedures?: Array<{ name?: string }> };
  source?: { source?: string };
  buildReport?: {
    success?: boolean;
    compilerSuccess?: boolean;
    lexerErrors?: Array<{ message: string; line?: number; column?: number }>;
    parserErrors?: Array<{ message: string; line?: number; column?: number }>;
    compilerErrors?: Array<{ message: string; node?: string }>;
    semanticErrors?: Array<{ message: string; kind?: string }>;
  };
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

export function printRepairStats(traces: TraceEntry[]): void {
  // Распределение: сколько прогонов потребовало 0/1/2/3 repair-попыток
  const dist = new Map<number, { total: number; success: number; partial: number }>();
  for (const t of traces) {
    const r = t.repairAttempts ?? 0;
    if (!dist.has(r)) dist.set(r, { total: 0, success: 0, partial: 0 });
    const bucket = dist.get(r)!;
    bucket.total++;
    if (t.status === 'success') bucket.success++;
    if (t.status === 'partial') bucket.partial++;
  }

  console.log('\n═══ REPAIR EFFECTIVENESS ═══');
  console.log(`Всего прогонов: ${traces.length}`);
  console.log('');

  const sorted = [...dist.entries()].sort((a, b) => a[0] - b[0]);
  console.log('Попытки | Прогонов | Success | Partial | Success rate');
  console.log('--------|----------|---------|---------|-------------');
  for (const [attempts, b] of sorted) {
    const rate = b.total > 0 ? ((b.success / b.total) * 100).toFixed(1) : '0.0';
    const label = attempts === 0 ? '0 (без repair)' : String(attempts);
    console.log(
      `${label.padEnd(14)} | ${String(b.total).padEnd(8)} | ${String(b.success).padEnd(7)} | ${String(
        b.partial,
      ).padEnd(7)} | ${rate}%`,
    );
  }

  // Итог: насколько repair помогает
  const withRepair = traces.filter(t => (t.repairAttempts ?? 0) > 0);
  const withRepairSuccess = withRepair.filter(t => t.status === 'success');
  const withoutRepair = traces.filter(t => (t.repairAttempts ?? 0) === 0);
  const withoutRepairSuccess = withoutRepair.filter(t => t.status === 'success');

  console.log('');
  if (withoutRepair.length > 0) {
    const rateWithout = ((withoutRepairSuccess.length / withoutRepair.length) * 100).toFixed(1);
    console.log(`Без repair   (${withoutRepair.length} прогонов): success rate ${rateWithout}%`);
  }
  if (withRepair.length > 0) {
    const rateWith = ((withRepairSuccess.length / withRepair.length) * 100).toFixed(1);
    console.log(`С repair     (${withRepair.length} прогонов): success rate ${rateWith}%`);
  }
  const exhausted = traces.filter(t => t.status === 'repair_exhausted').length;
  if (exhausted > 0) {
    console.log(`repair_exhausted: ${exhausted} прогонов`);
  }
}

export function collectTopErrors(traces: TraceEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of traces) {
    const br = t.buildReport;
    if (!br) continue;
    const allErrors = [
      ...(br.lexerErrors ?? []),
      ...(br.parserErrors ?? []),
      ...(br.compilerErrors ?? []),
      ...(br.semanticErrors ?? []),
    ];
    for (const e of allErrors) {
      const key = e.message
        .replace(/'[^']+'/g, "'X'")
        .replace(/\d+/g, 'N')
        .slice(0, 80);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function printTopErrors(traces: TraceEntry[], topN = 10): void {
  const counts = collectTopErrors(traces);
  if (counts.size === 0) return;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  console.log('═══ ТОП ОШИБОК КОМПИЛЯТОРА ═══');
  for (const [msg, n] of sorted) {
    console.log(`  ${String(n).padStart(4)}x  ${msg}`);
  }
  console.log('');
}

export function buildModelStats(
  traces: TraceEntry[],
): Map<string, { total: number; success: number; repairs: number }> {
  const byModel = new Map<string, { total: number; success: number; repairs: number }>();
  for (const t of traces) {
    const model = t.modelId ?? 'unknown';
    const cur = byModel.get(model) ?? { total: 0, success: 0, repairs: 0 };
    cur.total++;
    if (t.status === 'success') cur.success++;
    cur.repairs += t.repairAttempts ?? 0;
    byModel.set(model, cur);
  }
  return byModel;
}

function printByModel(traces: TraceEntry[]): void {
  const byModel = buildModelStats(traces);
  if (byModel.size <= 1) return;
  console.log('═══ SUCCESS RATE ПО МОДЕЛЯМ ═══');
  for (const [model, s] of [...byModel.entries()].sort((a, b) => b[1].total - a[1].total)) {
    const pct = s.total > 0 ? ((s.success / s.total) * 100).toFixed(1) : '0.0';
    const avgR = s.total > 0 ? (s.repairs / s.total).toFixed(2) : '0.00';
    console.log(`  ${model.padEnd(25)} ${pct}% success  (${s.success}/${s.total})  avg repairs: ${avgR}`);
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

export function printSingleTrace(trace: TraceEntry): void {
  const repairs = trace.repairAttempts ?? 0;
  const model = trace.modelId ?? '—';

  console.log('\n═══ TRACE (single) ═══');
  console.log(
    `runId: ${trace.runId} | timestamp: ${trace.timestamp} | status: ${trace.status} | model: ${model} | repairAttempts: ${repairs}`,
  );
  console.log('');

  console.log('ЗАДАЧА:');
  console.log(trace.task ?? '—');
  console.log('');

  console.log('INTENT:');
  console.log(`  description: ${trace.intent?.description ?? '—'}`);
  console.log(`  appType: ${trace.intent?.appType ?? '—'}`);
  console.log('');

  console.log('SPEC:');
  console.log(`  mainModule: ${trace.spec?.mainModule ?? '—'}`);
  const procNames = (trace.spec?.procedures ?? []).map(p => p.name).filter(Boolean) as string[];
  console.log(`  procedures (${procNames.length}): ${procNames.length ? procNames.join(', ') : '—'}`);
  console.log('');

  console.log('SOURCE:');
  const srcText = trace.source?.source ?? '';
  const srcLines = srcText.split(/\r?\n/);
  const preview = srcLines.slice(0, 40).join('\n');
  console.log(preview || '—');
  console.log('');

  console.log('BUILD:');
  console.log(`  success: ${trace.buildReport?.success ?? '—'}`);
  console.log(`  compilerSuccess: ${trace.buildReport?.compilerSuccess ?? '—'}`);

  const printErrs = (title: string, errs: unknown[], format: (e: any) => string): void => {
    if (!errs || errs.length === 0) return;
    console.log(`  ${title}:`);
    for (const e of errs as any[]) {
      console.log(`    - ${format(e)}`);
    }
  };

  printErrs('lexerErrors', trace.buildReport?.lexerErrors ?? [], (e) => {
    const loc = e.line != null && e.column != null ? `L${e.line}:${e.column} ` : '';
    return `${loc}${e.message}`;
  });

  printErrs('parserErrors', trace.buildReport?.parserErrors ?? [], (e) => {
    const loc = e.line != null && e.column != null ? `L${e.line}:${e.column} ` : '';
    return `${loc}${e.message}`;
  });

  printErrs('compilerErrors', trace.buildReport?.compilerErrors ?? [], (e) => {
    const node = e.node ? ` [node: ${e.node}]` : '';
    return `${e.message}${node}`;
  });

  console.log('');

  console.log('GOLDEN:');
  console.log(`  passed: ${trace.goldenReport?.passed ?? '—'}`);
  if (typeof trace.goldenReport?.qualityScore === 'number') {
    console.log(`  qualityScore: ${trace.goldenReport.qualityScore}`);
  } else {
    console.log(`  qualityScore: —`);
  }
  console.log('  outputDiff:');
  console.log(trace.goldenReport?.outputDiff ?? '—');
}

// Keep `os` import intentional and visible for CLI environment context.
void os.platform();

// ── main ──
const args = process.argv.slice(2);
const statusFilter = args.includes('--status') ? args[args.indexOf('--status') + 1] : null;
const lastN = args.includes('--last') ? parseInt(args[args.indexOf('--last') + 1] ?? '20', 10) : 20;
const statsOnly = args.includes('--stats');
const errorsOnly = args.includes('--errors');
const modelsOnly = args.includes('--models');
const showRepair = args.includes('--repair');
const runId = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;

function printHelp(): void {
  console.error('Использование: ts-node src/scripts/trace-viewer.ts [options]');
  console.error('');
  console.error('  --status <status>        фильтр по PipelineStatus (success/partial/...)');
  console.error('  --last <N>              показать последние N трейсов');
  console.error('  --run <runId>            показать полный трейс по runId (первые 8 символов тоже работают)');
  console.error('  --stats                   показать общую статистику трейсов');
  console.error('  --errors                  показать топ ошибок компилятора');
  console.error('  --models                  показать success rate по моделям');
  console.error(
    '  --repair         показать эффективность repair-цикла (распределение попыток, success rate)',
  );
  console.error('  --help                    показать это сообщение');
}

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const all = loadTraces();
if (runId) {
  const found = all.find(t => t.runId === runId || t.runId.startsWith(runId));
  if (!found) {
    console.error(`Трейс не найден: ${runId}`);
    process.exit(1);
  }
  printSingleTrace(found);
  process.exit(0);
}

const filtered = statusFilter ? all.filter(t => t.status === statusFilter) : all;
const slice = filtered.slice(-lastN);

if (statsOnly) {
  printStats(all);
  printByModel(all);
} else if (errorsOnly) {
  printTopErrors(all);
} else if (modelsOnly) {
  printByModel(all);
} else {
  printStats(all);
  printByModel(all);
  printTopErrors(all);
  console.log(`═══ ПОСЛЕДНИЕ ${slice.length} из ${filtered.length} трейсов ═══\n`);
  printTraces(slice);
}

if (showRepair) {
  printRepairStats(filtered);
}
