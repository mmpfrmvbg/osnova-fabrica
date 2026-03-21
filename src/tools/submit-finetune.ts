// src/tools/submit-finetune.ts — FT-3
// Валидирует датасет, отправляет fine-tune job в DeepSeek API
// или пишет в runs/finetune-jobs.jsonl при --dry-run.
//
// Usage:
//   npm run submit-finetune:dry  -- --dataset runs/dataset-v2.jsonl
//   npm run submit-finetune      -- --dataset runs/dataset-v2.jsonl

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { loadDataset, computeStats } from './dataset-stats';

const JOBS_PATH = path.resolve('runs', 'finetune-jobs.jsonl');

// ── Типы ──────────────────────────────────────────────────

export interface FinetuneJob {
  ts: string;
  model: string;
  dataset_path: string;
  record_count: number;
  status: 'dry_run' | 'submitted' | 'error';
  job_id?: string; // из DeepSeek API ответа
  error?: string;
}

// ── Валидация датасета ─────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateDataset(datasetPath: string): ValidationResult {
  const records = loadDataset(datasetPath);
  const stats = computeStats(records);
  const errors: string[] = [];

  if (stats.total < 200) {
    errors.push(`total записей ${stats.total} < 200 — недостаточно для fine-tune`);
  }

  for (const [cat, count] of Object.entries(stats.by_category)) {
    const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
    if (pct < 10) {
      errors.push(`категория '${cat}' = ${pct.toFixed(1)}% < 10% — недопредставлена`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── DeepSeek Fine-tune API ─────────────────────────────────
// Документация: https://platform.deepseek.com/api-docs/fine-tuning
// Эндпоинт: POST https://api.deepseek.com/v1/fine_tuning/jobs
// Тело: { training_file, model, hyperparameters }
//
// DeepSeek требует сначала загрузить файл через Files API,
// получить file_id, затем передать его в jobs.
// Здесь реализован двухшаговый flow:
//   1. POST /v1/files           → { id: file_id }
//   2. POST /v1/fine_tuning/jobs → { id: job_id }

function httpsPost(
  hostname: string,
  path_: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: path_, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadDatasetFile(datasetPath: string, apiKey: string): Promise<string> {
  const fileContent = fs.readFileSync(datasetPath);
  const filename = path.basename(datasetPath);
  const boundary = `----DeepSeekBoundary${Date.now()}`;

  const parts: Buffer[] = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
        `fine-tune\r\n`,
    ),
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/jsonl\r\n\r\n`,
    ),
  );
  parts.push(fileContent);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const raw = await httpsPost('api.deepseek.com', '/v1/files', {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(body.length),
  }, body);

  let parsed: { id?: string; error?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`Files API: invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!parsed.id) {
    throw new Error(`Files API error: ${raw.slice(0, 300)}`);
  }
  return parsed.id;
}

async function createFinetuneJob(fileId: string, model: string, apiKey: string): Promise<string> {
  const body = Buffer.from(
    JSON.stringify({
      training_file: fileId,
      model,
      hyperparameters: { n_epochs: 3 },
    }),
  );

  const raw = await httpsPost('api.deepseek.com', '/v1/fine_tuning/jobs', {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
  }, body);

  let parsed: { id?: string; error?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`Jobs API: invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!parsed.id) {
    throw new Error(`Jobs API error: ${raw.slice(0, 300)}`);
  }
  return parsed.id;
}

// ── Запись job в JSONL ─────────────────────────────────────

function appendJob(job: FinetuneJob): void {
  fs.mkdirSync(path.dirname(JOBS_PATH), { recursive: true });
  fs.appendFileSync(JOBS_PATH, JSON.stringify(job) + '\n', 'utf-8');
  console.log(`[submit-finetune] job записан → ${JOBS_PATH}`);
}

// ── main ──────────────────────────────────────────────────

function parseArgs(): {
  datasetPath: string;
  model: string;
  dryRun: boolean;
  skipValidation: boolean;
} {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1]! : null;
  };
  return {
    datasetPath: get('--dataset') ?? 'runs/dataset-v2.jsonl',
    model: get('--model') ?? 'deepseek-coder',
    dryRun: args.includes('--dry-run'),
    skipValidation: args.includes('--skip-validation'),
  };
}

async function main(): Promise<void> {
  const { datasetPath, model, dryRun, skipValidation } = parseArgs();
  const absPath = path.resolve(datasetPath);

  console.log(`[submit-finetune] Датасет: ${absPath}`);
  console.log(`[submit-finetune] Модель:  ${model}`);
  console.log(`[submit-finetune] Mode:    ${dryRun ? 'DRY-RUN' : 'REAL'}`);

  if (!fs.existsSync(absPath)) {
    console.error(`[submit-finetune] Файл не найден: ${absPath}`);
    console.error('  Сначала запусти: npm run export-dataset-v2');
    process.exit(1);
  }

  // Валидация
  if (!skipValidation) {
    console.log('\n[submit-finetune] Валидация датасета…');
    const { ok, errors } = validateDataset(absPath);
    if (errors.length > 0) {
      for (const e of errors) console.warn(`  ⚠️  ${e}`);
    }
    if (!ok) {
      console.error('[submit-finetune] Валидация не пройдена — job не отправлен.');
      console.error('  Используй --skip-validation для принудительной отправки.');
      process.exit(1);
    }
    console.log('[submit-finetune] Валидация ✓');
  }

  const records = loadDataset(absPath);
  console.log(`[submit-finetune] Записей: ${records.length}`);

  // Dry-run
  if (dryRun) {
    const job: FinetuneJob = {
      ts: new Date().toISOString(),
      model,
      dataset_path: absPath,
      record_count: records.length,
      status: 'dry_run',
    };
    appendJob(job);
    console.log('[submit-finetune] ✅ DRY-RUN: job записан, API не вызывался');
    return;
  }

  // Реальная отправка
  const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
  if (!apiKey) {
    console.error('[submit-finetune] DEEPSEEK_API_KEY не задан');
    process.exit(1);
  }

  let job: FinetuneJob;
  try {
    console.log('[submit-finetune] Загружаю файл в DeepSeek Files API…');
    const fileId = await uploadDatasetFile(absPath, apiKey);
    console.log(`[submit-finetune] file_id: ${fileId}`);

    console.log('[submit-finetune] Создаю fine-tune job…');
    const jobId = await createFinetuneJob(fileId, model, apiKey);
    console.log(`[submit-finetune] job_id: ${jobId}`);

    job = {
      ts: new Date().toISOString(),
      model,
      dataset_path: absPath,
      record_count: records.length,
      status: 'submitted',
      job_id: jobId,
    };
    appendJob(job);
    console.log(`[submit-finetune] ✅ Job отправлен: ${jobId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job = {
      ts: new Date().toISOString(),
      model,
      dataset_path: absPath,
      record_count: records.length,
      status: 'error',
      error: msg,
    };
    appendJob(job);
    console.error(`[submit-finetune] ❌ Ошибка: ${msg}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[submit-finetune] fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
