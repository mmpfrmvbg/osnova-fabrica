// src/tools/health-diff.ts — S-11
// Читает два snapshot-файла из runs/health-snapshots/,
// вычисляет дельту по метрикам, шлёт HTML-таблицу в Telegram.
//
// Usage:
//   npm run health-diff [-- --no-telegram]
//   npm run health-diff -- --current YYYY-MM-DD --previous YYYY-MM-DD

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const SNAPSHOTS_DIR = path.resolve('runs', 'health-snapshots');

// ── Тип snapshot ──────────────────────────────────────────

export interface HealthSnapshot {
  total: number;
  semantic_errors_in_success: number;
  avg_quality_score?: number;
  avg_repair_attempts?: number;
  build_success_rate?: number;
  teachability_score?: number;
  byStatus?: Record<string, number>;
  generated_at?: string;
  sentinel_rate?: number | null;
  invented_syntax_rate?: number | null;
  shadow_rfc002_correct_rate?: number | null;
  shadow_rfc003_correct_rate?: number | null;
}

// ── Загрузка snapshots ────────────────────────────────────

export function listSnapshotDates(dir = SNAPSHOTS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace('.json', ''))
    .sort(); // хронологический порядок
}

export function loadSnapshot(date: string, dir = SNAPSHOTS_DIR): HealthSnapshot | null {
  const file = path.join(dir, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as HealthSnapshot;
  } catch {
    return null;
  }
}

/** Находит snapshot ближайший к targetDate - 7 дней (±1 день допуск). */
export function findPreviousSnapshot(currentDate: string, dir = SNAPSHOTS_DIR): string | null {
  const dates = listSnapshotDates(dir);
  const current = new Date(currentDate).getTime();
  const target = current - 7 * 24 * 60 * 60 * 1000; // -7 дней

  let best: string | null = null;
  let bestDiff = Infinity;
  for (const d of dates) {
    if (d === currentDate) continue;
    const dt = new Date(d).getTime();
    if (dt >= current) continue; // только прошлые
    const diff = Math.abs(dt - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  // Принимаем только если в пределах 2 дней от целевой даты
  if (best && bestDiff <= 2 * 24 * 60 * 60 * 1000) return best;
  return null;
}

// ── Метрики для сравнения ─────────────────────────────────

export interface MetricRow {
  key: string;
  label: string;
  current: number;
  previous: number;
  delta: number;
  isRate: boolean; // true = умножать на 100 для отображения %
  higherIsBetter: boolean;
  threshold?: number;
}

export function buildMetricRows(cur: HealthSnapshot, prev: HealthSnapshot): MetricRow[] {
  const successCur = cur.byStatus?.['success'] ?? 0;
  const exhaustCur = cur.byStatus?.['repair_exhausted'] ?? 0;
  const successPrev = prev.byStatus?.['success'] ?? 0;
  const exhaustPrev = prev.byStatus?.['repair_exhausted'] ?? 0;

  const sr_cur = cur.total > 0 ? successCur / cur.total : 0;
  const sr_prev = prev.total > 0 ? successPrev / prev.total : 0;
  const re_cur = cur.total > 0 ? exhaustCur / cur.total : 0;
  const re_prev = prev.total > 0 ? exhaustPrev / prev.total : 0;

  return [
    {
      key: 'teachability_score',
      label: 'Teachability',
      current: cur.teachability_score ?? 0,
      previous: prev.teachability_score ?? 0,
      delta: (cur.teachability_score ?? 0) - (prev.teachability_score ?? 0),
      isRate: true,
      higherIsBetter: true,
    },
    {
      key: 'build_success_rate',
      label: 'Build success',
      current: cur.build_success_rate ?? 0,
      previous: prev.build_success_rate ?? 0,
      delta: (cur.build_success_rate ?? 0) - (prev.build_success_rate ?? 0),
      isRate: true,
      higherIsBetter: true,
    },
    {
      key: 'success_rate',
      label: 'Success rate',
      current: sr_cur,
      previous: sr_prev,
      delta: sr_cur - sr_prev,
      isRate: true,
      higherIsBetter: true,
    },
    {
      key: 'repair_exhausted_rate',
      label: 'Repair exhausted',
      current: re_cur,
      previous: re_prev,
      delta: re_cur - re_prev,
      isRate: true,
      higherIsBetter: false,
    },
    {
      key: 'avg_repair_attempts',
      label: 'Avg repairs',
      current: cur.avg_repair_attempts ?? 0,
      previous: prev.avg_repair_attempts ?? 0,
      delta: (cur.avg_repair_attempts ?? 0) - (prev.avg_repair_attempts ?? 0),
      isRate: false,
      higherIsBetter: false,
    },
    {
      key: 'avg_quality_score',
      label: 'Avg quality',
      current: cur.avg_quality_score ?? 0,
      previous: prev.avg_quality_score ?? 0,
      delta: (cur.avg_quality_score ?? 0) - (prev.avg_quality_score ?? 0),
      isRate: false,
      higherIsBetter: true,
    },
    {
      key: 'sentinel_rate',
      label: 'Sentinel rate',
      current: cur.sentinel_rate ?? 0,
      previous: prev.sentinel_rate ?? 0,
      delta: (cur.sentinel_rate ?? 0) - (prev.sentinel_rate ?? 0),
      isRate: true,
      higherIsBetter: false,
      threshold: 0.05,
    },
    {
      key: 'invented_syntax_rate',
      label: 'Invented syntax',
      current: cur.invented_syntax_rate ?? 0,
      previous: prev.invented_syntax_rate ?? 0,
      delta: (cur.invented_syntax_rate ?? 0) - (prev.invented_syntax_rate ?? 0),
      isRate: true,
      higherIsBetter: false,
      threshold: 0.01,
    },
    {
      key: 'shadow_rfc002_correct_rate',
      label: 'RFC-002 correct',
      current: cur.shadow_rfc002_correct_rate ?? 0,
      previous: prev.shadow_rfc002_correct_rate ?? 0,
      delta:
        (cur.shadow_rfc002_correct_rate ?? 0) - (prev.shadow_rfc002_correct_rate ?? 0),
      isRate: true,
      higherIsBetter: true,
      threshold: 0.8,
    },
    {
      key: 'shadow_rfc003_correct_rate',
      label: 'RFC-003 correct',
      current: cur.shadow_rfc003_correct_rate ?? 0,
      previous: prev.shadow_rfc003_correct_rate ?? 0,
      delta:
        (cur.shadow_rfc003_correct_rate ?? 0) - (prev.shadow_rfc003_correct_rate ?? 0),
      isRate: true,
      higherIsBetter: true,
      threshold: 0.95,
    },
  ];
}

// ── HTML-таблица для Telegram ─────────────────────────────

export function buildDiffMessage(
  rows: MetricRow[],
  currentDate: string,
  previousDate: string,
): string {
  const lines = [
    `📊 <b>Weekly Health Diff</b>`,
    `${previousDate} → ${currentDate}`,
    '',
    '<pre>',
    'Метрика             Текущая  Пред.    Δ',
    '─────────────────────────────────────────',
  ];

  for (const r of rows) {
    const fmt = (v: number) => (r.isRate ? `${(v * 100).toFixed(1)}%` : v.toFixed(3));
    const d = r.isRate
      ? `${r.delta >= 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}%`
      : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(3)}`;

    const overThreshold =
      r.threshold !== undefined
        ? r.higherIsBetter
          ? r.current >= r.threshold
          : r.current < r.threshold
        : null;
    const isBetter =
      overThreshold !== null
        ? overThreshold
        : r.higherIsBetter
          ? r.delta > 0
          : r.delta < 0;
    const isWorse =
      overThreshold !== null
        ? !overThreshold
        : r.higherIsBetter
          ? r.delta < 0
          : r.delta > 0;
    const icon = isBetter ? '🟢' : isWorse ? '🔴' : '⚪';

    lines.push(
      `${r.label.padEnd(20)}${fmt(r.current).padEnd(9)}${fmt(r.previous).padEnd(9)}${icon} ${d}`,
    );
  }

  lines.push('</pre>');
  return lines.join('\n');
}

// ── Telegram ──────────────────────────────────────────────

function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  if (!token || !chatId) {
    console.warn('[health-diff] TELEGRAM_BOT_TOKEN/CHAT_ID не заданы');
    return Promise.resolve();
  }
  const body = Buffer.from(
    JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  );
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const r = JSON.parse(data) as { ok: boolean };
            if (!r.ok) console.error('[health-diff] Telegram error:', data);
            else console.log('[health-diff] Telegram ✓');
          } catch {
            /* ignore */
          }
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noTg = args.includes('--no-telegram');
  const get = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 && args[i + 1] ? args[i + 1]! : null;
  };

  const dates = listSnapshotDates();
  if (dates.length === 0) {
    console.log('[health-diff] Нет снапшотов в runs/health-snapshots/ — пропускаю');
    process.exit(0);
  }

  const currentDate = get('--current') ?? dates[dates.length - 1]!;
  const previousDate = get('--previous') ?? findPreviousSnapshot(currentDate);

  if (!previousDate) {
    console.log(`[health-diff] Снапшот недельной давности не найден для ${currentDate} — пропускаю`);
    process.exit(0);
  }

  const current = loadSnapshot(currentDate);
  const previous = loadSnapshot(previousDate);

  if (!current || !previous) {
    console.log('[health-diff] Не удалось загрузить снапшоты — пропускаю');
    process.exit(0);
  }

  console.log(`[health-diff] ${previousDate} → ${currentDate}`);

  const rows = buildMetricRows(current, previous);
  const message = buildDiffMessage(rows, currentDate, previousDate);
  console.log(message);

  if (!noTg) {
    await sendTelegram(message);
  } else {
    console.log('[health-diff] --no-telegram: пропущено');
  }
}

if (require.main === module) {
  void main();
}
