#!/usr/bin/env tsx
// scripts/report-to-pm.ts
// Отправляет PM-отчёт в Telegram при критических событиях.
// При --stop-factory создаёт файл FACTORY_STOPPED (JSON с причиной).
//
// Использование:
//   npm run report-to-pm -- --priority CRITICAL \
//     --metric "semantic_errors_in_success=37" \
//     --blame-sha <SHA> --blame-message "fix: ..." \
//     --actions-url https://github.com/... \
//     [--stop-factory] [--dry-run]

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const FACTORY_STOPPED_PATH = path.resolve('FACTORY_STOPPED');

interface ReportOptions {
  priority: 'INFO' | 'WARN' | 'CRITICAL';
  metric?: string;
  blameSha?: string;
  blameMessage?: string;
  actionsUrl?: string;
  stopFactory: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): ReportOptions {
  const opts: ReportOptions = { priority: 'INFO', stopFactory: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--priority': {
        const p = argv[++i];
        if (p === 'INFO' || p === 'WARN' || p === 'CRITICAL') opts.priority = p;
        break;
      }
      case '--metric':
        opts.metric = argv[++i];
        break;
      case '--blame-sha':
        opts.blameSha = argv[++i];
        break;
      case '--blame-message':
        opts.blameMessage = argv[++i];
        break;
      case '--actions-url':
        opts.actionsUrl = argv[++i];
        break;
      case '--stop-factory':
        opts.stopFactory = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
    }
  }
  return opts;
}

function buildMessage(opts: ReportOptions): string {
  const icon =
    opts.priority === 'CRITICAL' ? '🚨' : opts.priority === 'WARN' ? '⚠️' : 'ℹ️';
  const lines = [
    `${icon} <b>ОС-НОВА PM Report</b> [${opts.priority}]`,
    `Время: ${new Date().toISOString()}`,
  ];
  if (opts.metric) lines.push(`Метрика: <code>${opts.metric}</code>`);
  if (opts.blameSha) {
    const short = opts.blameSha.slice(0, 8);
    const msg = opts.blameMessage ? ` — ${opts.blameMessage}` : '';
    lines.push(`Виновный коммит: <code>${short}</code>${msg}`);
  }
  if (opts.actionsUrl) lines.push(`Actions: <a href="${opts.actionsUrl}">${opts.actionsUrl}</a>`);
  if (opts.stopFactory) {
    lines.push('');
    lines.push('🏭 <b>FACTORY STOPPED</b> — генерация остановлена.');
    lines.push('Снять блокировку: <code>rm FACTORY_STOPPED</code>');
  }
  return lines.join('\n');
}

function sendTelegram(text: string, opts: ReportOptions): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  if (!token || !chatId) {
    console.warn('[report-to-pm] TELEGRAM_BOT_TOKEN/CHAT_ID не заданы — пропускаю');
    return Promise.resolve();
  }
  const body = Buffer.from(
    JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_notification: opts.priority === 'INFO',
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
          const r = JSON.parse(data) as { ok?: boolean };
          if (!r.ok) console.error('[report-to-pm] Telegram error:', r);
          else console.log('[report-to-pm] Telegram ✓');
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
Usage: npx tsx scripts/report-to-pm.ts [options]
  --priority INFO|WARN|CRITICAL
  --metric <key=value>
  --blame-sha <SHA>
  --blame-message <msg>
  --actions-url <url>
  --stop-factory
  --dry-run
`);
    process.exit(0);
  }

  const opts = parseArgs(process.argv.slice(2));

  const text = buildMessage(opts);
  console.log('[report-to-pm] Сообщение:');
  console.log(text);

  if (opts.stopFactory) {
    const reason =
      [
        opts.metric ? `metric: ${opts.metric}` : null,
        opts.blameSha ? `blame_sha: ${opts.blameSha}` : null,
        opts.blameMessage ? `blame_msg: ${opts.blameMessage}` : null,
      ]
        .filter(Boolean)
        .join(', ') || 'manual stop';
    const content = JSON.stringify({ stopped_at: new Date().toISOString(), reason }, null, 2);
    fs.writeFileSync(FACTORY_STOPPED_PATH, content, 'utf-8');
    console.log(`[report-to-pm] FACTORY_STOPPED создан (${FACTORY_STOPPED_PATH})`);
  }

  if (opts.dryRun) {
    console.log('[report-to-pm] --dry-run: Telegram не отправлен');
    return;
  }

  await sendTelegram(text, opts);
}

main().catch(e => {
  console.error('[report-to-pm] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
