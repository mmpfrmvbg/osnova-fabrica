// ============================================================
// src/intelligence/sources/cvt-weekly.ts — CVT-weekly
// Сравнивает текущий snapshot с предыдущим,
// вычисляет vacancy_count_delta и new_skills[].
// Отправляет Telegram-отчёт с топ изменениями за неделю.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import type { CompetitorSnapshot } from './hh';
import { fetchHHSnapshot, appendSnapshot } from './hh';

const SNAPSHOT_FILE = path.resolve('runs/competitor-snapshots.jsonl');

// ── Загрузка истории снапшотов ─────────────────────────────

export function loadSnapshots(snapshotPath = SNAPSHOT_FILE): CompetitorSnapshot[] {
  if (!fs.existsSync(snapshotPath)) return [];
  return fs
    .readFileSync(snapshotPath, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .flatMap(l => {
      try {
        return [JSON.parse(l) as CompetitorSnapshot];
      } catch {
        return [];
      }
    });
}

// ── Вычисление дельты ──────────────────────────────────────

export interface SnapshotDelta {
  current_ts: string;
  previous_ts: string;
  vacancy_count_current: number;
  vacancy_count_previous: number;
  vacancy_count_delta: number; // абсолютная разница
  vacancy_count_delta_pct: number; // в процентах
  new_skills: string[]; // навыки которых не было в предыдущем снапшоте
  lost_skills: string[]; // навыки которые исчезли
}

export function computeDelta(
  current: CompetitorSnapshot,
  previous: CompetitorSnapshot,
): SnapshotDelta {
  const prevSkillSet = new Set(previous.new_skills);
  const currSkillSet = new Set(current.new_skills);

  const new_skills = current.new_skills.filter(s => !prevSkillSet.has(s));
  const lost_skills = previous.new_skills.filter(s => !currSkillSet.has(s));

  const delta = current.vacancy_count - previous.vacancy_count;
  const delta_pct = previous.vacancy_count > 0 ? (delta / previous.vacancy_count) * 100 : 0;

  return {
    current_ts: current.ts,
    previous_ts: previous.ts,
    vacancy_count_current: current.vacancy_count,
    vacancy_count_previous: previous.vacancy_count,
    vacancy_count_delta: delta,
    vacancy_count_delta_pct: delta_pct,
    new_skills: new_skills.slice(0, 10),
    lost_skills: lost_skills.slice(0, 10),
  };
}

// ── Форматирование отчёта ──────────────────────────────────

export function buildCvtReport(delta: SnapshotDelta): string {
  const sign = delta.vacancy_count_delta >= 0 ? '+' : '';
  const icon =
    delta.vacancy_count_delta > 0 ? '📈' : delta.vacancy_count_delta < 0 ? '📉' : '➡️';

  const lines = [
    `🏢 <b>CVT Weekly — Конкуренты</b>`,
    `Период: ${delta.previous_ts.slice(0, 10)} → ${delta.current_ts.slice(0, 10)}`,
    '',
    `Вакансий: ${delta.vacancy_count_current} ${icon} ${sign}${delta.vacancy_count_delta} (${sign}${delta.vacancy_count_delta_pct.toFixed(1)}%)`,
    '',
  ];

  if (delta.new_skills.length > 0) {
    lines.push(`🆕 Новые навыки (${delta.new_skills.length}):`);
    for (const s of delta.new_skills.slice(0, 5)) {
      lines.push(`  • ${s}`);
    }
    if (delta.new_skills.length > 5) {
      lines.push(`  … ещё ${delta.new_skills.length - 5}`);
    }
  } else {
    lines.push('🆕 Новых навыков нет');
  }

  if (delta.lost_skills.length > 0) {
    lines.push('');
    lines.push(`❌ Исчезли навыки (${delta.lost_skills.length}):`);
    for (const s of delta.lost_skills.slice(0, 5)) {
      lines.push(`  • ${s}`);
    }
  }

  return lines.join('\n');
}

// ── Telegram ──────────────────────────────────────────────

function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  if (!token || !chatId) {
    console.warn('[cvt-weekly] TELEGRAM_BOT_TOKEN/CHAT_ID не заданы');
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
            if (!r.ok) console.error('[cvt-weekly] Telegram error:', r);
            else console.log('[cvt-weekly] Telegram ✓');
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
  const noFetch = args.includes('--no-fetch'); // не делать новый снапшот, сравнить последние два

  if (!noFetch) {
    console.log('[cvt-weekly] Делаю новый snaps…');
    try {
      const snap = await fetchHHSnapshot();
      appendSnapshot(snap);
      console.log(`[cvt-weekly] snapshot сохранён: ${snap.vacancy_count} вакансий`);
    } catch (err) {
      console.error('[cvt-weekly] ошибка fetch:', err instanceof Error ? err.message : String(err));
      console.log('[cvt-weekly] продолжаю с существующими снапшотами');
    }
  }

  const snapshots = loadSnapshots();
  if (snapshots.length < 2) {
    console.log(`[cvt-weekly] Снапшотов: ${snapshots.length}. Нужно минимум 2 для сравнения.`);
    console.log('[cvt-weekly] Запусти ещё раз через неделю после первого snapshot.');
    process.exit(0);
  }

  const current = snapshots[snapshots.length - 1]!;
  const previous = snapshots[snapshots.length - 2]!;

  const delta = computeDelta(current, previous);
  const report = buildCvtReport(delta);

  console.log(report);

  if (!noTg) {
    await sendTelegram(report);
  } else {
    console.log('[cvt-weekly] --no-telegram: пропущено');
  }
}

if (require.main === module) {
  void main();
}
