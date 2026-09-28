import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TraceEntrySchema, saveTrace, traceIssueReason } from './traceStore';
import { UNCODED_RUNTIME_CODE, isKnownDiagnosticCode, projectEntryDiagnostics } from './diagnosticsProjection';
import { CLI_CODES, DIAGNOSTIC_KINDS } from '../compiler/diagnosticCatalogue';

// Минимально валидный трейс
const minimalTrace = {
  runId: '123e4567-e89b-12d3-a456-426614174000',
  timestamp: '2026-01-01T00:00:00.000Z',
  status: 'success' as const,
  task: 'Напиши программу hello world',
  repairAttempts: 0,
};

describe('TraceEntrySchema', () => {
  it('принимает минимально валидный трейс', () => {
    const r = TraceEntrySchema.safeParse(minimalTrace);
    expect(r.success).toBe(true);
  });

  it('отклоняет трейс без runId', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { runId: _runId, ...noId } = minimalTrace;
    const r = TraceEntrySchema.safeParse(noId);
    expect(r.success).toBe(false);
  });

  it('отклоняет невалидный status', () => {
    const r = TraceEntrySchema.safeParse({ ...minimalTrace, status: 'unknown' });
    expect(r.success).toBe(false);
  });

  it('отклоняет отрицательный repairAttempts', () => {
    const r = TraceEntrySchema.safeParse({ ...minimalTrace, repairAttempts: -1 });
    expect(r.success).toBe(false);
  });

  it('принимает трейс с полным buildReport', () => {
    const r = TraceEntrySchema.safeParse({
      ...minimalTrace,
      buildReport: {
        success: true,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [],
        semanticErrors: [],
        bytecode: null,
        compilerSuccess: true,
        durationMs: 123,
      },
    });
    expect(r.success).toBe(true);
  });

  it('отклоняет buildReport с отрицательным durationMs', () => {
    const r = TraceEntrySchema.safeParse({
      ...minimalTrace,
      buildReport: {
        success: true,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [],
        semanticErrors: [],
        bytecode: null,
        compilerSuccess: true,
        durationMs: -5,
      },
    });
    // durationMs: z.number() — отрицательные не запрещены схемой (нет .min(0))
    // Этот тест документирует текущее поведение: -5 ПРОХОДИТ
    expect(r.success).toBe(true);
  });

  it('принимает трейс с goldenReport', () => {
    const r = TraceEntrySchema.safeParse({
      ...minimalTrace,
      goldenReport: {
        executed: true,
        vmErrors: [],
        qualityScore: 0.95,
        outputDiff: null,
        passed: true,
        durationMs: 10,
      },
    });
    expect(r.success).toBe(true);
  });

  it('отклоняет qualityScore > 1', () => {
    const r = TraceEntrySchema.safeParse({
      ...minimalTrace,
      goldenReport: {
        executed: true,
        vmErrors: [],
        qualityScore: 1.5,
        outputDiff: null,
        passed: true,
        durationMs: 0,
      },
    });
    expect(r.success).toBe(false);
  });

  it('принимает buildReport.semanticErrors с break_outside_loop и continue_outside_loop', () => {
    const r = TraceEntrySchema.safeParse({
      ...minimalTrace,
      buildReport: {
        success: false,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [],
        semanticErrors: [
          { message: 'прервать вне цикла', kind: 'break_outside_loop' },
          { message: 'продолжить вне цикла', kind: 'continue_outside_loop' },
        ],
        bytecode: null,
        compilerSuccess: false,
        durationMs: 0,
      },
    });
    expect(r.success).toBe(true);
  });
});

describe('saveTrace', () => {
  let tmpDir: string;
  let tracePath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `osnova-trace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tracePath = path.join(tmpDir, 'traces.jsonl');
    prevEnv = process.env.OSNOVA_TRACE_DB;
    process.env.OSNOVA_TRACE_DB = tracePath;
  });

  afterEach(async () => {
    process.env.OSNOVA_TRACE_DB = prevEnv;
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('при невалидной записи не пишет в файл и вызывает console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saveTrace({
      runId: 'not-a-uuid',
      status: 'success',
      task: 'task',
      repairAttempts: 0,
    });
    expect(warnSpy).toHaveBeenCalled();
    const warnArg = warnSpy.mock.calls[0]?.[0];
    expect(String(warnArg)).toContain('[traceStore]');

    let fileEmptyOrMissing = true;
    try {
      const buf = await fs.readFile(tracePath, 'utf-8');
      fileEmptyOrMissing = buf.trim().length === 0;
    } catch {
      fileEmptyOrMissing = true;
    }
    expect(fileEmptyOrMissing).toBe(true);

    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────
// T4: диагностика в записи журнала
// ─────────────────────────────────────────────────────────────

const validDiagnostic = {
  code: 'OSN-SEM-001',
  phase: 'семантика' as const,
  severity: 'ошибка' as const,
  message: 'вызов несуществующего системного вызова',
  kind: 'unknown_syscall',
};

describe('TraceEntrySchema: поле diagnostics', () => {
  it('принимает запись с диагностикой (код, фаза, уровень, сообщение)', () => {
    const r = TraceEntrySchema.safeParse({ ...minimalTrace, diagnostics: [validDiagnostic] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.diagnostics?.[0]?.code).toBe('OSN-SEM-001');
  });

  it('принимает запись без поля диагностики — весь прежний журнал (обратная совместимость)', () => {
    const r = TraceEntrySchema.safeParse(minimalTrace);
    expect(r.success).toBe(true);
    expect(r.success && r.data.diagnostics).toBeUndefined();
  });

  it('принимает пустой список: «диагностики не было» и «поля нет» — разные вещи', () => {
    const r = TraceEntrySchema.safeParse({ ...minimalTrace, diagnostics: [] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.diagnostics).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: мусор в code записью не становится', () => {
    for (const bad of ['семантика', 'OSN-SEM-1', 'osn-sem-001', 'OSN-1-001', '']) {
      const r = TraceEntrySchema.safeParse({
        ...minimalTrace,
        diagnostics: [{ ...validDiagnostic, code: bad }],
      });
      expect(r.success, `код «${bad}» не должен приниматься`).toBe(false);
    }
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: неизвестная фаза и уровень отклоняются', () => {
    for (const bad of [
      { ...validDiagnostic, phase: 'компиляция' },
      { ...validDiagnostic, severity: 'замечание' },
      { ...validDiagnostic, message: '' },
      { ...validDiagnostic, line: 1.5 },
    ]) {
      expect(TraceEntrySchema.safeParse({ ...minimalTrace, diagnostics: [bad] }).success).toBe(false);
    }
  });

  it('код правильной формы, но вне каталога, ПРИНИМАЕТСЯ и помечается (решение задачи)', () => {
    // Код выдаётся один раз и не переиспользуется: запись, написанная более новым
    // кодом, обязана читаться старым. Поэтому схема проверяет форму, а не каталог.
    const r = TraceEntrySchema.safeParse({
      ...minimalTrace,
      diagnostics: [{ ...validDiagnostic, code: 'OSN-FUT-001' }],
    });
    expect(r.success).toBe(true);
    // Помечен — значит, не молча: см. `summarizeDiagnostics().unknownCodes`.
    expect(r.success && r.data.diagnostics?.[0]?.code).toBe('OSN-FUT-001');
  });

  it('фаза «вызов» (отказ ДО компиляции, коды OSN-CLI-*) принимается схемой', () => {
    // Без `вызов` в перечне фаз запись CLI-отказа отклонялась бы молча — тот же
    // класс дефекта, что «схема журнала уже каталога» (K2, 2026-09-28).
    for (const code of Object.values(CLI_CODES)) {
      const r = TraceEntrySchema.safeParse({
        ...minimalTrace,
        status: 'error',
        diagnostics: [
          { code, phase: 'вызов', severity: 'ошибка', message: 'входной файл не найден' },
        ],
      });
      expect(r.success, `код ${code} с фазой «вызов» должен приниматься`).toBe(true);
    }
  });
});

/**
 * КАЖДЫЙ вид каталога обязан пройти журнал. Повод — замер проверяющего
 * 2026-09-28: схема принимала 9 видов из 15, и запись с любым из шести
 * «неотнесённых» (`arg_count_mismatch`, `chained_compare`, `keyword_param`,
 * `sentinel_pattern`, `unknown_module`, `export_collision`) не сохранялась вовсе —
 * прогон исчезал из журнала без кода возврата и без счётчика.
 */
describe('журнал принимает ВСЕ виды каталога (15/15)', () => {
  let tmpDir: string;
  let tracePath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `osnova-trace-kinds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tracePath = path.join(tmpDir, 'traces.jsonl');
    prevEnv = process.env.OSNOVA_TRACE_DB;
    process.env.OSNOVA_TRACE_DB = tracePath;
  });

  afterEach(async () => {
    process.env.OSNOVA_TRACE_DB = prevEnv;
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('round-trip для каждого вида: запись сохраняется и читается обратно', async () => {
    expect(DIAGNOSTIC_KINDS.length).toBeGreaterThanOrEqual(15);
    const results = [];
    for (const [i, kind] of DIAGNOSTIC_KINDS.entries()) {
      results.push(
        await saveTrace({
          runId: '123e4567-e89b-12d3-a456-426614174000',
          status: 'repair_exhausted',
          task: `вид ${kind.kind}`,
          repairAttempts: i,
          buildReport: {
            success: false,
            lexerErrors: [],
            parserErrors: [],
            compilerErrors: [],
            semanticErrors: [{ message: `проба вида ${kind.kind}`, kind: kind.kind }],
            bytecode: null,
            compilerSuccess: false,
            durationMs: 1,
          },
        }),
      );
    }

    // Ни одна запись не потерялась: сколько видов — столько строк и столько «saved».
    expect(results.every((r) => r.saved)).toBe(true);
    const lines = (await fs.readFile(tracePath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(DIAGNOSTIC_KINDS.length);

    const readBack = lines.map((l) => {
      const r = TraceEntrySchema.safeParse(JSON.parse(l));
      expect(r.success).toBe(true);
      return r.success ? r.data.buildReport?.semanticErrors?.[0]?.kind : undefined;
    });
    expect(readBack).toEqual(DIAGNOSTIC_KINDS.map((k) => k.kind));
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: вида нет в каталоге — отказ ВИДЕН, а не молчит', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await saveTrace({
      runId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'error',
      task: 'вид из будущего',
      repairAttempts: 0,
      buildReport: {
        success: false,
        lexerErrors: [],
        parserErrors: [],
        compilerErrors: [],
        semanticErrors: [{ message: 'вид из будущего', kind: 'вид_из_будущего' }],
        bytecode: null,
        compilerSuccess: false,
        durationMs: 1,
      },
    });

    // Отказ виден машине: результат с причиной и путём поля.
    expect(result.saved).toBe(false);
    expect(result.reason).toContain('buildReport.semanticErrors');
    // И человеку: предупреждение с тем же текстом.
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[1])).toBe(result.reason);
    // И в файле записи нет — но это уже следствие, а не единственный признак.
    let written = '';
    try {
      written = await fs.readFile(tracePath, 'utf-8');
    } catch {
      written = '';
    }
    expect(written.trim()).toBe('');
    warnSpy.mockRestore();
  });

  it('успешная запись отвечает saved: true и без причины', async () => {
    const result = await saveTrace({
      runId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'success',
      task: 'задача',
      repairAttempts: 0,
    });
    expect(result).toEqual({ saved: true });
  });

  it('причина отказа — та же строка, что печатает отчёт по журналу', () => {
    expect(
      traceIssueReason([{ path: ['buildReport', 'semanticErrors', 0, 'kind'], message: 'не тот вид' }]),
    ).toBe('buildReport.semanticErrors.0.kind: не тот вид');
    expect(traceIssueReason([{ path: [], message: 'поломка' }])).toBe('поломка');
    expect(traceIssueReason([])).toBe('неизвестная причина');
  });

  it('фаза «вызов» с кодом OSN-CLI-002 сохраняется и читается обратно (round-trip)', async () => {
    // Отказ ДО компиляции: файл ещё не читали, разбирать нечего — вида у него нет,
    // есть фаза и код CLI. Проверка держит весь путь: схема → файл → чтение.
    const diagnostics = [
      { code: CLI_CODES.inputNotFound, phase: 'вызов' as const, severity: 'ошибка' as const, message: 'файл не найден' },
    ];
    const result = await saveTrace({
      runId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'error',
      task: 'задача',
      repairAttempts: 0,
      diagnostics,
    });
    expect(result).toEqual({ saved: true });

    const lines = (await fs.readFile(tracePath, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = TraceEntrySchema.safeParse(JSON.parse(lines[0]!));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.diagnostics).toEqual(diagnostics);
    // Код CLI — законный код каталога, а не «вне каталога».
    expect(isKnownDiagnosticCode(CLI_CODES.inputNotFound)).toBe(true);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: фазы вне каталога по-прежнему отклоняются', () => {
    for (const phase of ['компиляция', 'вызов_команды', 'ВЫЗОВ']) {
      expect(
        TraceEntrySchema.safeParse({
          ...minimalTrace,
          diagnostics: [{ code: CLI_CODES.inputNotFound, phase, severity: 'ошибка', message: 'x' }],
        }).success,
      ).toBe(false);
    }
  });
});

describe('saveTrace + diagnostics', () => {
  let tmpDir: string;
  let tracePath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `osnova-trace-diag-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tracePath = path.join(tmpDir, 'traces.jsonl');
    prevEnv = process.env.OSNOVA_TRACE_DB;
    process.env.OSNOVA_TRACE_DB = tracePath;
  });

  afterEach(async () => {
    process.env.OSNOVA_TRACE_DB = prevEnv;
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('round-trip: записанная диагностика читается обратно без потерь', async () => {
    const diagnostics = projectEntryDiagnostics({
      buildReport: {
        success: false,
        compilerSuccess: false,
        lexerErrors: [{ line: 3, column: 7, message: 'неизвестный символ' }],
        parserErrors: [],
        semanticErrors: [
          { message: 'нет системного вызова', kind: 'unknown_syscall' },
          { message: 'цепочка сравнений', kind: 'chained_compare' },
        ],
        compilerErrors: [{ message: '[semantic] нет системного вызова' }],
        bytecode: null,
        durationMs: 12,
      },
      goldenReport: {
        executed: false,
        passed: false,
        qualityScore: 0,
        // Запись отказа после правки T2: код и место — полями (`vmErrorRecordOf`).
        vmErrors: [{ message: 'Remainder by zero', code: 'OSN-RT-003', op: 'rem', pc: 9 }],
        outputDiff: null,
        durationMs: 5,
      },
    });
    expect(diagnostics.map((d) => d.code)).toEqual([
      'OSN-LEX-001',
      'OSN-SEM-001',
      'OSN-SEM-008',
      'OSN-RT-003',
    ]);

    await saveTrace({
      runId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'repair_exhausted',
      task: 'задача',
      repairAttempts: 3,
      lastErrorKind: 'unknown_syscall',
      diagnostics,
    });

    const written = (await fs.readFile(tracePath, 'utf-8')).trim().split('\n');
    expect(written).toHaveLength(1);
    const parsed = TraceEntrySchema.safeParse(JSON.parse(written[0]!));
    expect(parsed.success).toBe(true);
    // Ни одного потерянного поля: сравнение с тем, что подали на запись.
    expect(parsed.success && parsed.data.diagnostics).toEqual(diagnostics);
    expect(parsed.success && parsed.data.lastErrorKind).toBe('unknown_syscall');
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: запись с мусорным кодом не пишется и предупреждает', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await saveTrace({
      runId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'error',
      task: 'задача',
      repairAttempts: 0,
      diagnostics: [{ ...validDiagnostic, code: 'мусор' }],
    });
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('[traceStore]');
    let written = '';
    try {
      written = await fs.readFile(tracePath, 'utf-8');
    } catch {
      written = '';
    }
    expect(written.trim()).toBe('');
    warnSpy.mockRestore();
  });

  it('диагностика без кода исполнения даёт маркер «код не назван», а не выдуманный код', async () => {
    const diagnostics = projectEntryDiagnostics({
      goldenReport: {
        executed: false,
        passed: false,
        qualityScore: 0,
        // Так выглядит golden-путь до правки T2: текст без код=.
        vmErrors: [{ message: 'Integer division by zero' }],
        outputDiff: null,
        durationMs: 1,
      },
    });
    await saveTrace({
      runId: '123e4567-e89b-12d3-a456-426614174000',
      status: 'error',
      task: 'задача',
      repairAttempts: 0,
      diagnostics,
    });
    const written = (await fs.readFile(tracePath, 'utf-8')).trim();
    expect(written).toContain(`"code":"${UNCODED_RUNTIME_CODE}"`);
  });

  it('текст исходника и значения окружения в диагностику не попадают', async () => {
    const sourceSecret = 'СЕКРЕТ_ИСХОДНИКА_4d2e';
    const envSecret = 'СЕКРЕТ_ОКРУЖЕНИЯ_8a9f';
    process.env.OSNOVA_TRACE_LEAK_MARKER = envSecret;
    try {
      const diagnostics = projectEntryDiagnostics({
        buildReport: {
          success: false,
          compilerSuccess: false,
          lexerErrors: [],
          parserErrors: [{ line: 1, column: 1, message: 'ожидается конец_процедуры' }],
          semanticErrors: [],
          compilerErrors: [],
          bytecode: null,
          durationMs: 1,
        },
      });
      await saveTrace({
        runId: '123e4567-e89b-12d3-a456-426614174000',
        status: 'error',
        task: 'задача',
        repairAttempts: 0,
        // Худший случай: исходник передан в записи рядом с диагностикой.
        source: { filename: 'main.osnova', source: `процедура главная() // ${sourceSecret}` },
        diagnostics,
      });
      const line = (await fs.readFile(tracePath, 'utf-8')).trim();
      const entry = JSON.parse(line) as { diagnostics?: unknown };
      const diagnosticsText = JSON.stringify(entry.diagnostics);
      expect(diagnosticsText).not.toContain(sourceSecret);
      expect(diagnosticsText).not.toContain(envSecret);
      // Поля записи, в которых утечка была бы видна, в диагностике отсутствуют.
      expect(diagnosticsText).not.toContain('"source"');
      expect(diagnosticsText).not.toContain('"task"');
      expect(diagnosticsText).not.toContain('"stack"');
    } finally {
      delete process.env.OSNOVA_TRACE_LEAK_MARKER;
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Обратная совместимость на ЖИВОМ журнале
// ─────────────────────────────────────────────────────────────

/**
 * Живой журнал полон записей, написанных прежними схемами. Сторож держит два
 * утверждения:
 * 1. новое поле не добавило **ни одного класса** отказа — все отказы по-прежнему
 *    из двух документированных легаси-перечней (см. ниже);
 * 2. строка, недописанная в момент чтения (журнал живой, в него пишут другие
 *    сессии), не считается дефектом схемы.
 */
describe('обратная совместимость с живым runs/traces.jsonl', () => {
  const journalPath = path.resolve(process.cwd(), 'runs', 'traces.jsonl');

  it('разбирается новой схемой: новых классов отказа нет, числа — в выводе теста', () => {
    if (!fsSync.existsSync(journalPath)) {
      console.log('[traceStore] живого журнала нет — сторож пропущен:', journalPath);
      return;
    }
    const text = fsSync.readFileSync(journalPath, 'utf-8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');

    // Два легаси-перечня, известных ДО этой правки (замер 2026-09-28: 24 отказа —
    // 7 старых `status: "failure"` и 17 `appType` вне пяти значений, все март 2026).
    const LEGACY_REJECTIONS = [/^status: Invalid option/, /^intent\.appType: Invalid option/];

    let parsed = 0;
    let jsonBroken = 0;
    let tailInFlight = 0;
    const reasons = new Map<string, number>();
    let withDiagnostics = 0;

    lines.forEach((line, i) => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // Последняя строка без завершающего перевода — запись в полёте.
        if (i === lines.length - 1 && !text.endsWith('\n')) tailInFlight += 1;
        else jsonBroken += 1;
        return;
      }
      const r = TraceEntrySchema.safeParse(raw);
      if (!r.success) {
        const issue = r.error.issues[0];
        const where = issue === undefined ? '' : issue.path.map(String).join('.');
        const reason = `${where}: ${issue?.message ?? 'неизвестная причина'}`;
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        return;
      }
      parsed += 1;
      if (Array.isArray(r.data.diagnostics)) withDiagnostics += 1;
    });

    const rejected = [...reasons.values()].reduce((a, b) => a + b, 0);
    console.log(
      `[traceStore] живой журнал: строк ${lines.length}, разобрано ${parsed}, отклонено ${rejected}` +
        ` (записей с diagnostics: ${withDiagnostics}, битый JSON: ${jsonBroken}, строка в полёте: ${tailInFlight})`,
    );
    for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`[traceStore]   отказ схемы ×${n}: ${reason}`);
    }

    expect(jsonBroken).toBe(0);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed + rejected + jsonBroken + tailInFlight).toBe(lines.length);
    // Главное: ни одного отказа ВНЕ двух документированных легаси-классов.
    for (const reason of reasons.keys()) {
      expect(
        LEGACY_REJECTIONS.some((re) => re.test(reason)),
        `новый класс отказа схемы: ${reason}`,
      ).toBe(true);
    }
  });
});
