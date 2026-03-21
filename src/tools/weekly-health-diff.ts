// ============================================================
// src/tools/weekly-health-diff.ts — S-8
// Сравнивает health-метрики текущей недели с прошлой,
// отправляет дельту в Telegram каждое воскресенье 10:00 MSK.
// ============================================================

import * as path from 'path';
import * as https from 'https';
import { loadTraces, computeHealthMetrics } from '../scripts/analyze-language-health';

const TRACES_PATH = path.resolve('runs/traces.jsonl');

// ── Типы ──────────────────────────────────────────────────
interface WeekMetrics {
  total: number;
  success_rate: number;
  repair_exhausted_rate: number;
  semantic_errors_in_success: number;
  avg_quality_score: number;
  avg_repair_attempts: number;
  build_success_rate: number;
  teachability_score: number;
}

export interface WeekDiff {
  current: WeekMetrics;
  previous: WeekMetrics;
  delta: Partial<Record<keyof WeekMetrics, number>>;
  week_label: string; // "2026-W12"
  prev_week_label: string;
}

// ── Хелперы ───────────────────────────────────────────────

function getWeekBounds(weeksAgo: number): { from: Date; to: Date } {
  const now = new Date();
  // Начало текущей недели (понедельник 00:00 UTC)
  const day = now.getUTCDay(); // 0=Sun, 1=Mon...
  const diff = day === 0 ? -6 : 1 - day; // сдвиг до понедельника
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff - weeksAgo * 7);
  monday.setUTCHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 7);
  return { from: monday, to: sunday };
}

function isoWeekLabel(date: Date): string {
  // Простой ISO-week label: YYYY-WNN
  const jan1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function extractWeekMetrics(
  traces: ReturnType<typeof loadTraces>,
  from: Date,
  to: Date,
): WeekMetrics {
  const windowed = traces.filter(t => {
    if (!t.timestamp) return false;
    const ts = new Date(t.timestamp).getTime();
    return ts >= from.getTime() && ts < to.getTime();
  });
  const m2 = computeHealthMetrics(windowed);
  const total = m2.total;
  const byStatus = m2.byStatus;
  const successCount = byStatus['success'] ?? 0;
  const exhaustedCount = byStatus['repair_exhausted'] ?? 0;
  return {
    total,
    success_rate: total > 0 ? successCount / total : 0,
    repair_exhausted_rate: total > 0 ? exhaustedCount / total : 0,
    semantic_errors_in_success: m2.semantic_errors_in_success,
    avg_quality_score: m2.avg_quality_score,
    avg_repair_attempts: m2.avg_repair_attempts,
    build_success_rate: m2.build_success_rate,
    teachability_score: m2.teachability_score,
  };
}

export function computeWeekDiff(tracesPath = TRACES_PATH): WeekDiff {
  const traces = loadTraces(tracesPath);
  const currBounds = getWeekBounds(0);
  const prevBounds = getWeekBounds(1);

  const current = extractWeekMetrics(traces, currBounds.from, currBounds.to);
  const previous = extractWeekMetrics(traces, prevBounds.from, prevBounds.to);

  const delta: Partial<Record<keyof WeekMetrics, number>> = {};
  for (const key of Object.keys(current) as Array<keyof WeekMetrics>) {
    if (key === 'total') continue;
    delta[key] = current[key] - previous[key];
  }

  return {
    current,
    previous,
    delta,
    week_label: isoWeekLabel(currBounds.from),
    prev_week_label: isoWeekLabel(prevBounds.from),
  };
}

function formatDelta(val: number, isPercent = true): string {
  const formatted = isPercent ? `${(val * 100).toFixed(1)}%` : val.toFixed(2);
  const sign = val > 0 ? '+' : '';
  const icon = val > 0 ? '🟢' : val < 0 ? '🔴' : '⚪';
  return `${icon} ${sign}${formatted}`;
}

export function buildWeeklyReport(diff: WeekDiff): string {
  const { current, delta, week_label, prev_week_label } = diff;
  const stopSignal = current.semantic_errors_in_success > 0;

  const lines = [
    `📅 <b>Weekly Health Diff</b>`,
    `${prev_week_label} → ${week_label}`,
    `Трейсов за неделю: ${current.total}`,
    '',
    `Success rate:      ${(current.success_rate * 100).toFixed(1)}%  ${formatDelta(delta.success_rate ?? 0)}`,
    `Repair exhausted:  ${(current.repair_exhausted_rate * 100).toFixed(1)}%  ${formatDelta(delta.repair_exhausted_rate ?? 0)}`,
    `Build success:     ${(current.build_success_rate * 100).toFixed(1)}%  ${formatDelta(delta.build_success_rate ?? 0)}`,
    `Avg quality score: ${current.avg_quality_score.toFixed(3)}  ${formatDelta(delta.avg_quality_score ?? 0, false)}`,
    `Avg repairs:       ${current.avg_repair_attempts.toFixed(2)}  ${formatDelta(delta.avg_repair_attempts ?? 0, false)}`,
    `Teachability:      ${(current.teachability_score * 100).toFixed(1)}%  ${formatDelta(delta.teachability_score ?? 0)}`,
    '',
    stopSignal
      ? `🚨 semantic_errors_in_success: ${current.semantic_errors_in_success} — СТОП-СИГНАЛ`
      : `✅ semantic_errors_in_success: 0`,
  ];
  return lines.join('\n');
}

function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  if (!token || !chatId) {
    console.warn('[weekly-diff] TELEGRAM_BOT_TOKEN/CHAT_ID не заданы');
    return Promise.resolve();
  }
  const body = Buffer.from(
    JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_notification: false,
    }),
  );
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      },
      res => {
        let data = '';
        res.on('data', c => {
          data += c;
        });
        res.on('end', () => {
          try {
            const r = JSON.parse(data) as { ok?: boolean };
            if (!r.ok) console.error('[weekly-diff] Telegram error:', r);
            else console.log('[weekly-diff] Telegram ✓');
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noTg = args.includes('--no-telegram');

  const diff = computeWeekDiff();
  const report = buildWeeklyReport(diff);
  console.log(report);

  if (!noTg) {
    await sendTelegram(report);
  } else {
    console.log('[weekly-diff] --no-telegram: пропущено');
  }
}

if (require.main === module) {
  void main();
}
