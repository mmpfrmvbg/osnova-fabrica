// ============================================================
// src/self-improve/core.ts — Самоулучшающий контур над ядром
//
// Модель правит сам компилятор/VM: возвращает изменённые файлы ЦЕЛИКОМ
// (full-file, не unified diff — diff у LLM получается неточным), контур
// перезаписывает их с бэкапом, гоняет гейт (тесты ядра) и при провале
// откатывается; кормит вывод гейта модели и повторяет до зелёного/лимита.
//
// Ядро провайдер-агностик: генерация, применение/откат и гейт приходят
// как порты (инъекция) — петлю можно гонять на mock без сети и без git.
// ============================================================

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const DEFAULT_MAX_ITERATIONS = 4;
const DEFAULT_MAX_FILES_CHANGED = 3;
const DEFAULT_TRACE_FILE = 'runs/self-improve-traces.jsonl';

/** Текущее содержимое файлов: путь → текст (контекст для модели). */
export type PatchFiles = Record<string, string>;

/** Правки: путь → новое полное содержимое файла. */
export type FileEdits = Record<string, string>;

/** Вход генератора: цель + текущие файлы + накопленная обратная связь. */
export interface PatchGenRequest {
  readonly goal: string;
  readonly files: PatchFiles;
  readonly feedback: readonly string[];
  readonly attempt: number;
}

/** Применение/откат правок. */
export interface PatchPort {
  /** Перезаписать файлы (с бэкапом); бросает ошибку при неудаче. */
  apply(edits: FileEdits): Promise<void>;
  /** Восстановить файлы из бэкапа (идемпотентно). */
  revert(): Promise<void>;
}

/** Гейт качества: прогон тестов ядра. */
export interface GatePort {
  run(): Promise<{ passed: boolean; output: string }>;
}

/** Генерация правок (LLM); возвращает сырой ответ — парсит core. */
export interface PatchGenPort {
  generate(req: PatchGenRequest): Promise<string>;
}

export interface SelfImproveOptions {
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly maxFilesChanged?: number;
  readonly maxIterations?: number;
  readonly traceFile?: string;
  readonly readFile?: (p: string) => Promise<string>;
}

export interface SelfImproveIteration {
  readonly iteration: number;
  readonly status: 'applied' | 'passed' | 'failed' | 'rejected';
  readonly errorKind?: string;
  readonly durationMs: number;
}

export interface SelfImproveResult {
  readonly status: 'success' | 'exhausted' | 'error';
  readonly iterations: readonly SelfImproveIteration[];
  /** Принятые правки (только при success). */
  readonly edits?: FileEdits;
  readonly totalDurationMs: number;
  readonly error?: string;
}

/** Парсит ответ модели: блоки `=== path ===\n<content>` → FileEdits. */
function parseEdits(raw: string): FileEdits {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();

  const edits: FileEdits = {};
  const lines = text.split('\n');
  let currentPath: string | null = null;
  const buf: string[] = [];

  const flush = (): void => {
    if (currentPath) {
      edits[currentPath] = buf.join('\n').replace(/\n+$/, '');
      buf.length = 0;
    }
  };

  for (const line of lines) {
    const m = line.match(/^===\s*(.+?)\s*===$/);
    if (m) {
      flush();
      currentPath = m[1];
    } else if (currentPath) {
      buf.push(line);
    }
  }
  flush();
  return edits;
}

/** Проверяет, что правки лежат в разрешённой зоне и не задевают запрещённое. */
function validateEdits(
  edits: FileEdits,
  allowed: readonly string[],
  forbidden: readonly string[],
  maxFiles: number,
): void {
  const paths = Object.keys(edits);
  if (paths.length === 0) throw new Error('в ответе нет ни одного файла');
  if (paths.length > maxFiles) {
    throw new Error(`изменено ${paths.length} файлов, лимит ${maxFiles}`);
  }
  for (const p of paths) {
    if (forbidden.some(f => p.includes(f))) throw new Error(`запрещённый файл: ${p}`);
    if (!allowed.some(a => p.includes(a))) throw new Error(`файл вне разрешённой зоны: ${p}`);
  }
}

function trace(iter: SelfImproveIteration, traceFile: string, goal: string, runId: string): void {
  try {
    const target = path.resolve(traceFile);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      target,
      JSON.stringify({
        runId,
        timestamp: new Date().toISOString(),
        goal,
        iteration: iter.iteration,
        status: iter.status,
        errorKind: iter.errorKind ?? null,
        durationMs: iter.durationMs,
      }) + '\n',
      'utf-8',
    );
  } catch (err) {
    console.warn('[self-improve] trace write failed:', err);
  }
}

/** Раскрывает директории в рекурсивный список `.ts`/`.js` файлов. */
async function collectContextFiles(
  paths: readonly string[],
  readFile: (p: string) => Promise<string>,
): Promise<PatchFiles> {
  const files: PatchFiles = {};

  const walkDir = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walkDir(full);
      } else if (e.isFile() && /\.(ts|js)$/.test(e.name)) {
        files[full.replace(/\\/g, '/')] = await readFile(full).catch(() => '');
      }
    }
  };

  for (const p of paths) {
    try {
      if (fs.statSync(p).isDirectory()) {
        await walkDir(p);
      } else {
        files[p] = await readFile(p).catch(() => '');
      }
    } catch {
      // путь не существует — пропускаем
    }
  }
  return files;
}

/**
 * Самоулучшающая петля: генерирует правки → применяет → гоняет гейт →
 * при провале кормит вывод модели и откатывает, до зелёного гейта или лимита.
 */
export async function selfImprove(
  goal: string,
  opts: SelfImproveOptions,
  ports: { gen: PatchGenPort; patch: PatchPort; gate: GatePort },
): Promise<SelfImproveResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxFilesChanged = opts.maxFilesChanged ?? DEFAULT_MAX_FILES_CHANGED;
  const traceFile = opts.traceFile ?? DEFAULT_TRACE_FILE;
  const readFile = opts.readFile ?? (async (p: string) => fsp.readFile(p, 'utf-8'));
  const runId = `si-${Date.now().toString(36)}`;
  const startTime = Date.now();

  const files: PatchFiles = await collectContextFiles(opts.allowedPaths, readFile);

  const iterations: SelfImproveIteration[] = [];
  const feedback: string[] = [];
  let lastEdits: FileEdits | undefined;

  const persist = (iter: SelfImproveIteration): void => {
    iterations.push(iter);
    trace(iter, traceFile, goal, runId);
  };

  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    const t0 = Date.now();

    // ─── генерация ───
    let raw: string;
    try {
      raw = await ports.gen.generate({ goal, files, feedback, attempt });
    } catch (err) {
      return {
        status: 'error',
        iterations,
        totalDurationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // ─── парсинг и валидация ───
    let edits: FileEdits;
    try {
      edits = parseEdits(raw);
      validateEdits(edits, opts.allowedPaths, opts.forbiddenPaths, maxFilesChanged);
    } catch (err) {
      persist({
        iteration: attempt,
        status: 'rejected',
        errorKind: 'invalid_edits',
        durationMs: Date.now() - t0,
      });
      feedback.push(`Правки отклонены: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // ─── применение ───
    try {
      await ports.patch.apply(edits);
    } catch (err) {
      persist({
        iteration: attempt,
        status: 'failed',
        errorKind: 'apply',
        durationMs: Date.now() - t0,
      });
      feedback.push(`Не удалось применить правки: ${err instanceof Error ? err.message : String(err)}`);
      await ports.patch.revert().catch(() => {});
      continue;
    }

    // ─── гейт ───
    let gate: { passed: boolean; output: string };
    try {
      gate = await ports.gate.run();
    } catch (err) {
      await ports.patch.revert().catch(() => {});
      return {
        status: 'error',
        iterations,
        totalDurationMs: Date.now() - startTime,
        error: `gate error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (gate.passed) {
      lastEdits = edits;
      persist({ iteration: attempt, status: 'passed', durationMs: Date.now() - t0 });
      return {
        status: 'success',
        iterations,
        edits: lastEdits,
        totalDurationMs: Date.now() - startTime,
      };
    }

    persist({
      iteration: attempt,
      status: 'failed',
      errorKind: 'gate',
      durationMs: Date.now() - t0,
    });
    feedback.push(gate.output.slice(0, 4000));
    await ports.patch.revert().catch(() => {});
  }

  return { status: 'exhausted', iterations, totalDurationMs: Date.now() - startTime };
}
