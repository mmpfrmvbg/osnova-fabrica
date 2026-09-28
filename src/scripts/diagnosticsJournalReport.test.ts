/**
 * Сторожа отчёта по журналу (`./diagnosticsJournalReport.ts`).
 *
 * Отчёт — единственное место, где дыра «журнал почти не хранит диагностику»
 * превращается в число. Поэтому проверяется: он считает и **поле** `diagnostics`,
 * и **проекцию** из `buildReport`/`goldenReport`; не падает на битой строке;
 * называет коды вне каталога вслух; печатает числа, а не прилагательные; и не
 * выносит наружу ни текст исходника, ни задачу, ни значения окружения.
 */

import { describe, it, expect } from 'vitest';
import { formatJournalSummary, resolveJournalPath, summarizeJournal } from './diagnosticsJournalReport';

const runId = '123e4567-e89b-12d3-a456-426614174000';
const ts = '2026-09-28T00:00:00.000Z';

const line = (rec: Record<string, unknown>): string => JSON.stringify(rec);

/** Запись нового образца: диагностика лежит полем. */
const withFieldLine = line({
  runId,
  timestamp: ts,
  status: 'repair_exhausted',
  task: 'ЗАДАЧА_СЕКРЕТ_1a2b',
  repairAttempts: 2,
  diagnostics: [
    { code: 'OSN-SEM-001', phase: 'семантика', severity: 'ошибка', message: 'нет вызова' },
    { code: 'OSN-SEM-008', phase: 'семантика', severity: 'предупреждение', message: 'цепочка' },
  ],
});

/** Запись старого образца: поля нет, диагностика восстанавливается проекцией. */
const projectedLine = line({
  runId,
  timestamp: ts,
  status: 'error',
  task: 'ЗАДАЧА_СЕКРЕТ_3c4d',
  repairAttempts: 0,
  buildReport: {
    success: false,
    compilerSuccess: false,
    lexerErrors: [],
    parserErrors: [{ line: 1, column: 2, message: 'ожидается конец' }],
    semanticErrors: [{ message: 'нет системного вызова', kind: 'unknown_syscall' }],
    compilerErrors: [],
    bytecode: null,
    durationMs: 3,
  },
  goldenReport: {
    executed: false,
    passed: false,
    qualityScore: 0,
    // Запись отказа после правки T2: код и место — полями (`vmErrorRecordOf`).
    vmErrors: [{ message: 'Remainder by zero', code: 'OSN-RT-003', op: 'rem', pc: 9 }],
    outputDiff: null,
    durationMs: 1,
  },
});

/** Запись без диагностики вообще: сам факт — тоже число отчёта. */
const emptyLine = line({
  runId,
  timestamp: ts,
  status: 'success',
  task: 'ЗАДАЧА_СЕКРЕТ_5e6f',
  repairAttempts: 0,
});

/** Запись старого образца, которую схема отклоняет (легаси-перечень). */
const rejectedLine = line({
  runId,
  timestamp: ts,
  status: 'failure',
  task: 'ЗАДАЧА_СЕКРЕТ_7a8b',
  repairAttempts: 0,
  buildReport: {
    success: false,
    compilerSuccess: false,
    lexerErrors: [],
    parserErrors: [],
    semanticErrors: [{ message: 'старая ошибка', kind: 'undeclared_var' }],
    compilerErrors: [],
    bytecode: null,
    durationMs: 1,
  },
});

describe('summarizeJournal', () => {
  it('считает поле и проекцию раздельно, битые строки — отдельно', () => {
    const text = [withFieldLine, projectedLine, emptyLine, rejectedLine, '{не json'].join('\n') + '\n';
    const s = summarizeJournal(text);

    expect(s.lines).toBe(5);
    expect(s.jsonBroken).toBe(1);
    expect(s.schemaRejected).toBe(1);
    expect(s.parsed).toBe(3);
    expect(s.parsed + s.schemaRejected + s.jsonBroken).toBe(s.lines);

    expect(s.withField).toBe(1);
    expect(s.withFieldNonEmpty).toBe(1);
    expect(s.fromField).toBe(2);
    expect(s.projected).toBe(1);
    expect(s.fromProjection).toBe(3); // парсер + семантика + исполнение
    expect(s.withoutDiagnostics).toBe(1);

    expect(s.diagnostics.total).toBe(5);
    expect(s.diagnostics.errors).toBe(4);
    expect(s.diagnostics.warnings).toBe(1);

    // Код исполнения прочитан из поля записи отказа — разрыв golden-пути виден числом.
    expect(s.diagnostics.byCode.map((c) => c.code)).toContain('OSN-RT-003');
    expect(s.diagnostics.unknownCodes).toEqual([]);

    // Потеря в отклонённой записи названа, а не умалчивается.
    expect(s.rejectedProjectedDiagnostics).toBe(1);
    expect(s.rejectionReasons[0]?.reason).toContain('status');
  });

  it('пустое поле diagnostics не отменяет проекцию из отчётов', () => {
    const s = summarizeJournal(
      line({
        runId,
        timestamp: ts,
        status: 'error',
        task: 'задача',
        repairAttempts: 0,
        diagnostics: [],
        buildReport: {
          success: false,
          compilerSuccess: false,
          lexerErrors: [{ line: 1, column: 1, message: 'символ' }],
          parserErrors: [],
          semanticErrors: [],
          compilerErrors: [],
          bytecode: null,
          durationMs: 1,
        },
      }) + '\n',
    );
    expect(s.withField).toBe(1);
    expect(s.withFieldNonEmpty).toBe(0);
    expect(s.projected).toBe(1);
    expect(s.diagnostics.byCode[0]?.code).toBe('OSN-LEX-001');
  });

  it('пустой журнал — нули, а не падение', () => {
    const s = summarizeJournal('\n\n   \n');
    expect(s.lines).toBe(0);
    expect(s.diagnostics.total).toBe(0);
    expect(s.withoutDiagnostics).toBe(0);
    expect(s.diagnostics.byPhase).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: код вне каталога назван, а не растворён среди известных', () => {
    const s = summarizeJournal(
      line({
        runId,
        timestamp: ts,
        status: 'error',
        task: 'задача',
        repairAttempts: 0,
        diagnostics: [
          { code: 'OSN-SEM-001', phase: 'семантика', severity: 'ошибка', message: 'известный' },
          { code: 'OSN-FUT-001', phase: 'семантика', severity: 'ошибка', message: 'вид из будущего' },
        ],
      }) + '\n',
    );
    expect(s.diagnostics.unknownCodes).toEqual(['OSN-FUT-001']);
    const out = formatJournalSummary(s, 'тест.jsonl');
    expect(out).toContain('вне каталога');
    expect(out).toContain('OSN-FUT-001');
  });
});

describe('formatJournalSummary', () => {
  const text = [withFieldLine, projectedLine, emptyLine, rejectedLine, '{не json'].join('\n') + '\n';

  it('печатает числа и доли, а не прилагательные', () => {
    const out = formatJournalSummary(summarizeJournal(text), 'тест.jsonl');
    expect(out).toContain('строк: 5');
    expect(out).toContain('битый JSON: 1');
    expect(out).toContain('отклонено схемой: 1');
    expect(out).toContain('разобрано: 3');
    expect(out).toContain('поле diagnostics есть: 1 (непустых 1)');
    expect(out).toContain('проекция из отчётов: 1');
    expect(out).toContain('без диагностики: 1 (33.3 %)');
    expect(out).toContain('диагностик: 5');
    expect(out).toContain('топ-5 кодов');
    expect(out).toContain('OSN-SEM-001');
    expect(out).toContain('OSN-RT-003');
    // Проценты, а не слова: у каждого кода есть доля.
    expect(out).toMatch(/OSN-SEM-001\s+2\s+40\.0 %/);
  });

  it('не выносит наружу задачу, текст исходника и значения окружения', () => {
    const sourceSecret = 'СЕКРЕТ_ИСХОДНИКА_9z8y';
    const envSecret = 'СЕКРЕТ_ОКРУЖЕНИЯ_7x6w';
    process.env.OSNOVA_REPORT_LEAK_MARKER = envSecret;
    try {
      const leaky = line({
        runId,
        timestamp: ts,
        status: 'error',
        task: `задача ${sourceSecret}`,
        repairAttempts: 0,
        source: { filename: 'main.osnova', source: `процедура главная() // ${sourceSecret}` },
        diagnostics: [
          { code: 'OSN-PAR-001', phase: 'парсер', severity: 'ошибка', message: 'ожидается конец' },
        ],
      });
      const out = formatJournalSummary(summarizeJournal(leaky + '\n'), 'тест.jsonl');
      expect(out).not.toContain(sourceSecret);
      expect(out).not.toContain(envSecret);
      expect(out).toContain('OSN-PAR-001');
    } finally {
      delete process.env.OSNOVA_REPORT_LEAK_MARKER;
    }
  });

  it('журнал без диагностики говорит об этом прямо', () => {
    const out = formatJournalSummary(summarizeJournal(emptyLine + '\n'), 'тест.jsonl');
    expect(out).toContain('кодов нет: ни одна разобранная запись не назвала причину');
  });
});

describe('resolveJournalPath', () => {
  it('аргумент важнее окружения, окружение — важнее умолчания', () => {
    const prev = process.env.OSNOVA_TRACE_DB;
    try {
      process.env.OSNOVA_TRACE_DB = 'D:/tmp-osnova/иной.jsonl';
      expect(resolveJournalPath('D:/tmp-osnova/явный.jsonl')).toContain('явный.jsonl');
      expect(resolveJournalPath()).toContain('иной.jsonl');
      delete process.env.OSNOVA_TRACE_DB;
      expect(resolveJournalPath()).toContain('traces.jsonl');
    } finally {
      if (prev === undefined) delete process.env.OSNOVA_TRACE_DB;
      else process.env.OSNOVA_TRACE_DB = prev;
    }
  });
});
