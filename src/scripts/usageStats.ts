// ============================================================
// src/scripts/usageStats.ts
//
// Сводка по logs/llm-usage/*.jsonl: где на самом деле уходят токены —
// во входе (кэшируемом) или в выходе (не кэшируемом).
//
// Запуск: npx tsx src/scripts/usageStats.ts
// ============================================================
import * as fs from 'fs';
import * as path from 'path';

interface Entry {
  timestamp: string;
  role: string;
  model: string;
  tokenUsage: { prompt: number; completion: number; total: number };
}

const dir = path.resolve('logs', 'llm-usage');
if (!fs.existsSync(dir)) {
  console.error(`[usage-stats] нет каталога ${dir}`);
  process.exit(1);
}

const entries: Entry[] = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      /* битая строка — пропускаем */
    }
  }
}

if (entries.length === 0) {
  console.error('[usage-stats] записей нет');
  process.exit(1);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const prompt = sum(entries.map((e) => e.tokenUsage?.prompt ?? 0));
const completion = sum(entries.map((e) => e.tokenUsage?.completion ?? 0));
const total = prompt + completion;

const byRole = new Map<string, { n: number; p: number; c: number }>();
const byModel = new Map<string, { n: number; p: number; c: number }>();
for (const e of entries) {
  const r = byRole.get(e.role) ?? { n: 0, p: 0, c: 0 };
  r.n++; r.p += e.tokenUsage?.prompt ?? 0; r.c += e.tokenUsage?.completion ?? 0;
  byRole.set(e.role, r);
  const m = byModel.get(e.model) ?? { n: 0, p: 0, c: 0 };
  m.n++; m.p += e.tokenUsage?.prompt ?? 0; m.c += e.tokenUsage?.completion ?? 0;
  byModel.set(e.model, m);
}

const pct = (x: number, y: number) => ((100 * x) / (y || 1)).toFixed(1) + '%';

console.log(`Записей: ${entries.length}`);
console.log(`Период:  ${entries[0]!.timestamp} .. ${entries[entries.length - 1]!.timestamp}`);
console.log(`prompt:     ${prompt} (${pct(prompt, total)})`);
console.log(`completion: ${completion} (${pct(completion, total)})`);
console.log(`всего:      ${total}`);
console.log('');
console.log('| роль | вызовов | prompt | completion |');
console.log('|---|---:|---:|---:|');
for (const [k, v] of [...byRole].sort((a, b) => b[1].p + b[1].c - (a[1].p + a[1].c))) {
  console.log(`| ${k} | ${v.n} | ${v.p} | ${v.c} |`);
}
console.log('');
console.log('| модель | вызовов | prompt | completion |');
console.log('|---|---:|---:|---:|');
for (const [k, v] of [...byModel].sort((a, b) => b[1].p + b[1].c - (a[1].p + a[1].c))) {
  console.log(`| ${k} | ${v.n} | ${v.p} | ${v.c} |`);
}
