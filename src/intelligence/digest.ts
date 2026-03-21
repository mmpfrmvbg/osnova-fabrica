// src/intelligence/digest.ts
// Топ-10 сигналов по relevance_score → Telegram 08:00 MSK.
// Запуск: npm run intelligence-digest [-- --no-telegram] [--top N]

import * as https from 'https';
import * as path from 'path';
import { readSignals, type IntelligenceSignal } from './store';
import { runLifecycle } from './lifecycle';
import { computeExtendedHealthMetrics } from '../tools/health-metrics-extended';

// ── Формирование дайджеста ────────────────────────────────

export function selectTopSignals(
  signals: IntelligenceSignal[],
  topN = 10,
): IntelligenceSignal[] {
  return signals
    .filter((s) => s.status === 'new' || s.status === 'watching')
    .sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
    .slice(0, topN);
}

export function buildDigestMessage(
  signals: IntelligenceSignal[],
  date: string,
): string {
  if (signals.length === 0) {
    return `📡 <b>Intelligence Digest</b> — ${date}\n\nНовых сигналов нет.`;
  }

  const lines = [
    `📡 <b>Intelligence Digest</b> — ${date}`,
    `Топ-${signals.length} сигналов:`,
    '',
  ];

  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]!;
    const score =
      s.relevance_score !== undefined ? ` [${s.relevance_score.toFixed(2)}]` : '';
    const src = s.source.padEnd(16);
    lines.push(`${i + 1}. <b>${s.title.slice(0, 80)}</b>${score}`);
    lines.push(`   ${src} <a href="${s.url}">${s.url.slice(0, 60)}</a>`);
    if (s.summary) {
      lines.push(`   ${s.summary.slice(0, 120)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Формирует блок здоровья языка из extended metrics.
 *  Возвращает null если метрики недоступны. */
export function buildHealthBlock(): string | null {
  try {
    const m = computeExtendedHealthMetrics(
      path.resolve('runs', 'traces.jsonl'),
      path.resolve('runs', 'shadow-report.jsonl'),
    );
    if (m.total === 0) return null;

    const pct = (v: number | null) =>
      v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
    const icon = (v: number | null, threshold: number, higherIsBetter: boolean) => {
      if (v === null) return '⚪';
      return higherIsBetter ? (v >= threshold ? '🟢' : '🔴') : v < threshold ? '🟢' : '🔴';
    };

    const lines = [
      '📊 <b>Здоровье языка (snapshot)</b>',
      `teachability:           ${pct(m.teachability_score)}`,
      `sentinel_rate:          ${pct(m.sentinel_rate)} ${icon(m.sentinel_rate, 0.05, false)}`,
      `invented_syntax_rate:   ${pct(m.invented_syntax_rate)} ${icon(m.invented_syntax_rate, 0.01, false)}`,
      `RFC-002: ${pct(m.shadow_rfc002_correct_rate)}  /  RFC-003: ${pct(m.shadow_rfc003_correct_rate)}`,
    ];
    return lines.join('\n');
  } catch {
    return null;
  }
}

// ── Telegram ──────────────────────────────────────────────

function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  if (!token || !chatId) {
    console.warn('[digest] TELEGRAM_BOT_TOKEN/CHAT_ID не заданы — пропускаю');
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
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const r = JSON.parse(data) as { ok: boolean };
            if (!r.ok) console.error('[digest] Telegram error:', data);
            else console.log('[digest] Telegram ✓');
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
  const topIdx = args.indexOf('--top');
  const parsedTop =
    topIdx >= 0 && args[topIdx + 1] ? Number.parseInt(args[topIdx + 1]!, 10) : 10;
  const topN = Number.isFinite(parsedTop) && parsedTop > 0 ? parsedTop : 10;

  // Применяем lifecycle перед дайджестом
  const { transitions, decayed } = runLifecycle();
  if (transitions.length > 0 || decayed > 0) {
    console.log(`[digest] lifecycle: ${transitions.length} переходов, ${decayed} decayed`);
  }

  const signals = readSignals();
  const top = selectTopSignals(signals, topN);
  const date = new Date().toISOString().slice(0, 10);
  const healthBlock = buildHealthBlock();
  const signalsPart = buildDigestMessage(top, date);
  const message = healthBlock ? `${healthBlock}\n\n${signalsPart}` : signalsPart;

  console.log(message);
  console.log(`\n[digest] Сигналов в дайджесте: ${top.length}`);

  if (!noTg) {
    await sendTelegram(message);
  } else {
    console.log('[digest] --no-telegram: пропущено');
  }
}

if (require.main === module) {
  void main();
}
