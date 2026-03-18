const fs = require('fs');
const path = require('path');

const tracesPath = path.resolve(__dirname, '../runs/traces.jsonl');
const content = fs.readFileSync(tracesPath, 'utf-8');

const task1 = 'найди сумму чётных чисел от 2 до 50';
const task2 = 'посчитай сумму чисел кратных 3 от 3 до 30';

let last1 = null;
let last2 = null;
for (const line of content.split('\n')) {
  const t = line.trim();
  if (!t) continue;
  try {
    const e = JSON.parse(t);
    if (e.task === task1 && e.status === 'repair_exhausted') last1 = e;
    if (e.task === task2 && e.status === 'repair_exhausted') last2 = e;
  } catch (_) {}
}

function out(task, e) {
  if (!e) {
    console.log('=== ' + task + ' ===\n(нет repair_exhausted)');
    return;
  }
  console.log('\n=== ' + task + ' ===\n');
  console.log('--- source.source ---\n' + (e.source?.source || '—') + '\n');
  console.log('--- buildReport.parserErrors ---');
  console.log(JSON.stringify(e.buildReport?.parserErrors ?? [], null, 2));
  console.log('\n--- goldenReport.vmErrors ---');
  console.log(JSON.stringify(e.goldenReport?.vmErrors ?? [], null, 2));
}

out(task1, last1);
out(task2, last2);
