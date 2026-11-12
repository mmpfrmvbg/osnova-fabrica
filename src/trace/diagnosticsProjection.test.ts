/**
 * Сторожа проекции диагностики (`./diagnosticsProjection.ts`).
 *
 * Проверяется то, за что проекция отвечает перед журналом:
 * 1. каждая фаза компилятора даёт запись с кодом из каталога, а не с выдуманным;
 * 2. зеркало `[semantic] …` в `compilerErrors` не считается второй раз;
 * 3. отказ без названной причины становится `OSN-CG-002`, а не пустотой;
 * 4. код исполнения читается и полем, и текстом `код=…`, а без кода — честный
 *    `OSN-RT-000` (разрыв golden-пути измерен в шапке модуля);
 * 5. **негативные контроли:** мусор в `code` не считается кодом, код вне
 *    каталога не растворяется среди известных, а текст исходника и переменные
 *    окружения в проекцию не попадают.
 */

import { describe, it, expect } from 'vitest';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  UNCATALOGUED_KIND_CODE,
  UNCODED_RUNTIME_CODE,
  diagnosticsFromBuildReport,
  diagnosticsFromGoldenReport,
  isDiagnosticCodeShape,
  isKnownDiagnosticCode,
  knownDiagnosticCodes,
  projectEntryDiagnostics,
  runtimeCodeOf,
  summarizeDiagnostics,
} from './diagnosticsProjection';
import {
  CLI_CODES,
  DIAGNOSTIC_KINDS,
  INTERNAL_CODES,
  PHASE_CODES,
  UNCATALOGUED_CODES,
} from '../compiler/diagnosticCatalogue';
import { RUNTIME_CODES, RUNTIME_CODE_TABLE, runtimeCodeInfo } from '../runtime/runtimeCodes';

const buildOk = {
  success: true,
  compilerSuccess: true,
  lexerErrors: [],
  parserErrors: [],
  compilerErrors: [],
  semanticErrors: [],
  bytecode: null,
  durationMs: 1,
};

const goldenOk = {
  executed: true,
  passed: true,
  qualityScore: 1,
  vmErrors: [],
  outputDiff: null,
  durationMs: 1,
};

describe('проекция отчёта сборки', () => {
  it('семантическая ошибка получает код вида из каталога, а не выдуманный', () => {
    const records = diagnosticsFromBuildReport({
      ...buildOk,
      success: false,
      compilerSuccess: false,
      semanticErrors: [{ message: 'вызов несуществующего системного вызова', kind: 'unknown_syscall' }],
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe('OSN-SEM-001');
    expect(records[0]?.phase).toBe('семантика');
    expect(records[0]?.severity).toBe('ошибка');
    expect(records[0]?.kind).toBe('unknown_syscall');
    expect(isKnownDiagnosticCode('OSN-SEM-001')).toBe(true);
  });

  it('неблокирующий вид — предупреждение, а не ошибка (канон §13.10)', () => {
    const records = diagnosticsFromBuildReport({
      ...buildOk,
      semanticErrors: [{ message: 'цепочка сравнений', kind: 'chained_compare' }],
    });
    expect(records[0]?.severity).toBe('предупреждение');
  });

  it('лексер, парсер и сборка получают коды своих фаз', () => {
    const records = diagnosticsFromBuildReport({
      ...buildOk,
      success: false,
      compilerSuccess: false,
      lexerErrors: [{ line: 1, column: 2, message: 'неизвестный символ' }],
      parserErrors: [{ line: 3, column: 4, message: 'ожидается конец' }],
      compilerErrors: [{ message: 'нет такой процедуры' }],
    });
    expect(records.map((r) => r.code)).toEqual([
      PHASE_CODES.лексер,
      PHASE_CODES.парсер,
      PHASE_CODES.сборка,
    ]);
    expect(records.map((r) => r.phase)).toEqual(['лексер', 'парсер', 'сборка']);
    expect(records[0]?.line).toBe(1);
    expect(records[1]?.column).toBe(4);
  });

  it('зеркало [semantic] в compilerErrors не считается второй раз', () => {
    const records = diagnosticsFromBuildReport({
      ...buildOk,
      success: false,
      compilerSuccess: false,
      semanticErrors: [{ message: 'переменная не объявлена', kind: 'undeclared_var' }],
      compilerErrors: [{ message: '[semantic] переменная не объявлена' }],
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe('OSN-SEM-002');
  });

  it('отказ без диагностики становится OSN-CG-002, а не пустотой', () => {
    const records = diagnosticsFromBuildReport({
      ...buildOk,
      success: false,
      compilerSuccess: false,
      bytecode: null,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe('OSN-CG-002');
    expect(records[0]?.phase).toBe('сборка');
    expect(records[0]?.message).toContain('дефект компилятора');
  });

  it('успешная сборка диагностик не порождает (негативный контроль)', () => {
    expect(diagnosticsFromBuildReport(buildOk)).toEqual([]);
    // Отчёта не было — тоже пусто: причина не выдумывается.
    expect(diagnosticsFromBuildReport(undefined)).toEqual([]);
  });
});

describe('проекция отчёта исполнения', () => {
  it('код читается из поля записи отказа (контракт vmErrorRecordOf)', () => {
    const records = diagnosticsFromGoldenReport({
      ...goldenOk,
      executed: false,
      passed: false,
      qualityScore: 0,
      // Так запись выглядит после правки T2: код и место — полями, текст не тронут.
      vmErrors: [
        { message: 'Integer division by zero', code: RUNTIME_CODES.divisionByZero, op: 'idiv', pc: 6 },
      ],
    });
    expect(records[0]?.code).toBe('OSN-RT-002');
    expect(records[0]?.phase).toBe('исполнение');
    expect(records[0]?.message).toBe('Integer division by zero');
    expect(isKnownDiagnosticCode('OSN-RT-002')).toBe(true);
    // Место отказа (`op`/`pc`) в диагностику не переносится: она исчисляемая,
    // подробности остаются в `goldenReport.vmErrors`.
    expect(records[0]).not.toHaveProperty('op');
    expect(records[0]).not.toHaveProperty('pc');
  });

  it('без кода пишется OSN-RT-000 — «код не назван», а не выдуманный код', () => {
    const records = diagnosticsFromGoldenReport({
      ...goldenOk,
      executed: false,
      passed: false,
      vmErrors: [{ message: 'Integer division by zero' }],
    });
    expect(records[0]?.code).toBe(UNCODED_RUNTIME_CODE);
  });

  it('«код не назван» виден в сводке или объявлен внутренним — но не молчит', () => {
    // Маркер разрыва (`RUNTIME_CODES.unnamedRefusal`) обязан быть либо назван
    // каталогом как внутренний, либо показан в `unknownCodes`. Молча «известным»
    // он не бывает — иначе 51 отказ без кода выглядел бы благополучно.
    const records = diagnosticsFromGoldenReport({
      ...goldenOk,
      executed: false,
      passed: false,
      vmErrors: [{ message: 'Integer division by zero' }],
    });
    const summary = summarizeDiagnostics(records);
    if (isKnownDiagnosticCode(UNCODED_RUNTIME_CODE)) {
      expect(runtimeCodeInfo(UNCODED_RUNTIME_CODE)?.internal).toBe(true);
    } else {
      expect(summary.unknownCodes).toContain(UNCODED_RUNTIME_CODE);
    }
  });

  it('«не исполнено без причины» — тоже запись, а не тишина', () => {
    const records = diagnosticsFromGoldenReport({ ...goldenOk, executed: false, vmErrors: [] });
    expect(records).toHaveLength(1);
    expect(records[0]?.code).toBe(UNCODED_RUNTIME_CODE);
  });

  it('успешный прогон диагностик не порождает (негативный контроль)', () => {
    expect(diagnosticsFromGoldenReport(goldenOk)).toEqual([]);
    expect(diagnosticsFromGoldenReport(undefined)).toEqual([]);
  });
});

describe('чтение кода исполнения', () => {
  it('runtimeCodeOf читает код ТОЛЬКО из поля записи', () => {
    expect(runtimeCodeOf({ message: 'x', code: 'OSN-RT-005' })).toBe('OSN-RT-005');
    expect(runtimeCodeOf({ message: 'x' })).toBe(UNCODED_RUNTIME_CODE);
    // Не-объект не роняет проекцию.
    expect(runtimeCodeOf('строка')).toBe(UNCODED_RUNTIME_CODE);
    expect(runtimeCodeOf(undefined)).toBe(UNCODED_RUNTIME_CODE);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: код в тексте кодом не считается — иначе разрыв канала не виден', () => {
    // Контракт (`src/runtime/runtimeCodes.ts`): код читается полем, разбор текста
    // запрещён — текст человеческий и может измениться. Замер живого журнала:
    // ни одна запись не несёт `код=OSN-RT…` в тексте, значит угадывание из строки
    // не спасло бы ни одной записи, зато замаскировало бы 51 отказ без кода.
    expect(runtimeCodeOf({ message: 'Remainder by zero op=rem pc=7 код=OSN-RT-003' })).toBe(
      UNCODED_RUNTIME_CODE,
    );
  });

  it('код из metadata.runtimeCode читается так же, как в VM (чужой класс ошибки)', () => {
    // `TimeoutError` держит в `code` своё значение (`TIMEOUT_ERROR`), поэтому
    // код исполнения у него лежит в `metadata.runtimeCode`.
    expect(runtimeCodeOf({ message: 'timeout', code: 'TIMEOUT_ERROR', metadata: { runtimeCode: 'OSN-RT-006' } })).toBe(
      'OSN-RT-006',
    );
  });

  it('чужое значение в поле code кодом исполнения не считается', () => {
    // ENOENT — код файловой системы, а не отказ VM: должен уйти в маркер.
    expect(runtimeCodeOf({ message: 'нет файла', code: 'ENOENT' })).toBe(UNCODED_RUNTIME_CODE);
  });

  it('маркер «код не назван» — тот самый код из таблицы VM, а не второй литерал', () => {
    expect(UNCODED_RUNTIME_CODE).toBe(RUNTIME_CODES.unnamedRefusal);
    expect(RUNTIME_CODE_TABLE.find((r) => r.code === UNCODED_RUNTIME_CODE)?.internal).toBe(true);
  });

  it('маркер «вид не каталогизирован»: правильной формы, не вид и не растворяется', () => {
    // Маркер живёт в каталоге — второе имя того же кода разъехалось бы молча
    // (было: литерал здесь против пустой строки в `compileDiagnostics.ts`, T3).
    expect(UNCATALOGUED_KIND_CODE).toBe(UNCATALOGUED_CODES.kindNotCatalogued);
    // Форма — код, а не слово: иначе маркер нельзя было бы считать.
    expect(isDiagnosticCodeShape(UNCATALOGUED_KIND_CODE)).toBe(true);
    // Это МАРКЕР, а не вид каталога: ни один вид не носит его код.
    expect(DIAGNOSTIC_KINDS.some((k) => k.code === UNCATALOGUED_KIND_CODE)).toBe(false);

    const records = diagnosticsFromBuildReport({
      ...buildOk,
      success: false,
      compilerSuccess: false,
      semanticErrors: [{ message: 'новый вид', kind: 'вид_из_будущего' }],
    });
    expect(records[0]?.code).toBe(UNCATALOGUED_KIND_CODE);
    // Каталог объявил маркер — значит, он не «вне каталога», но и не вид: сводка
    // молчит о нём как о чужом коде, а видом он не притворяется.
    const summary = summarizeDiagnostics(records);
    expect(summary.unknownCodes).toEqual([]);
    expect(summary.byCode[0]?.known).toBe(true);
  });

  it('коды CLI (фаза «вызов») — законные коды каталога, а не «вне каталога»', () => {
    for (const code of Object.values(CLI_CODES)) {
      expect(isDiagnosticCodeShape(code)).toBe(true);
      expect(isKnownDiagnosticCode(code)).toBe(true);
    }
    const summary = summarizeDiagnostics(
      Object.values(CLI_CODES).map((code) => ({
        code,
        phase: 'вызов' as const,
        severity: 'ошибка' as const,
        message: 'отказ до компиляции',
      })),
    );
    expect(summary.unknownCodes).toEqual([]);
    expect(summary.byPhase).toEqual([{ phase: 'вызов', count: 2 }]);
  });
});

describe('форма и каталог кодов', () => {
  it('форма OSN-<ФАЗА>-<НОМЕР> принимается, мусор — нет (негативный контроль)', () => {
    for (const good of ['OSN-SEM-001', 'OSN-CG-002', 'OSN-LEX-001', 'OSN-PAR-001', 'OSN-RT-900']) {
      expect(isDiagnosticCodeShape(good)).toBe(true);
    }
    for (const bad of [
      'семантика',
      'OSN-SEM-1',
      'OSN-1-001',
      'osn-sem-001',
      'OSN-SEM-0001',
      '',
      'OSN-SEM-001 ',
      undefined,
      null,
      42,
      'OSN-SEM-001; rm -rf /',
    ]) {
      expect(isDiagnosticCodeShape(bad)).toBe(false);
    }
  });

  it('каталог кодов включает все виды, коды фаз, внутренние, CLI и коды исполнения', () => {
    const known = knownDiagnosticCodes();
    for (const kind of DIAGNOSTIC_KINDS) expect(known.has(kind.code)).toBe(true);
    for (const code of Object.values(PHASE_CODES)) expect(known.has(code)).toBe(true);
    for (const code of Object.values(INTERNAL_CODES)) expect(known.has(code)).toBe(true);
    // Маркеры и коды CLI: пропустить их здесь значило бы объявить «вне каталога»
    // законные коды — тот же дрейф, только с другой стороны.
    for (const code of Object.values(UNCATALOGUED_CODES)) expect(known.has(code)).toBe(true);
    for (const code of Object.values(CLI_CODES)) expect(known.has(code)).toBe(true);
    for (const rt of RUNTIME_CODE_TABLE) expect(known.has(rt.code)).toBe(true);
    expect(known.has('OSN-CG-002')).toBe(true);
  });

  it('сводка называет код вне каталога и не считает его известным', () => {
    // Негативный контроль: код правильной формы, которого нет ни в одном
    // каталоге. Так выглядит запись, написанная более новым кодом (или дефект
    // каталога) — она обязана быть ВИДНА, а не раствориться среди известных.
    const records = diagnosticsFromBuildReport({
      ...buildOk,
      success: false,
      compilerSuccess: false,
      semanticErrors: [{ message: 'новый вид', kind: 'вид_из_будущего' }],
    });
    expect(records[0]?.code).toBe(UNCATALOGUED_KIND_CODE);

    const future = summarizeDiagnostics([
      { code: 'OSN-FUT-001', phase: 'семантика', severity: 'ошибка', message: 'вид из будущего' },
    ]);
    expect(future.unknownCodes).toEqual(['OSN-FUT-001']);
    expect(future.byCode[0]?.known).toBe(false);

    const mixed = summarizeDiagnostics([
      { code: 'OSN-SEM-001', phase: 'семантика', severity: 'ошибка', message: 'известный' },
      { code: 'OSN-FUT-001', phase: 'семантика', severity: 'ошибка', message: 'вид из будущего' },
    ]);
    expect(mixed.unknownCodes).toEqual(['OSN-FUT-001']);
    // Порядок при равной частоте — по коду: FUT раньше SEM, и метка `known` разная.
    expect(mixed.byCode.map((c) => [c.code, c.known])).toEqual([
      ['OSN-FUT-001', false],
      ['OSN-SEM-001', true],
    ]);
  });
});

describe('сводка', () => {
  it('считает по кодам и фазам, сортирует по частоте', () => {
    const records = projectEntryDiagnostics({
      buildReport: {
        ...buildOk,
        success: false,
        compilerSuccess: false,
        semanticErrors: [
          { message: 'раз', kind: 'unknown_syscall' },
          { message: 'два', kind: 'unknown_syscall' },
          { message: 'три', kind: 'chained_compare' },
        ],
      },
      goldenReport: {
        ...goldenOk,
        executed: false,
        vmErrors: [{ message: 'boom код=OSN-RT-002' }],
      },
    });
    const summary = summarizeDiagnostics(records);
    expect(summary.total).toBe(4);
    expect(summary.errors).toBe(3);
    expect(summary.warnings).toBe(1);
    expect(summary.byCode[0]).toMatchObject({ code: 'OSN-SEM-001', count: 2 });
    expect(summary.byPhase.map((p) => p.phase)).toContain('исполнение');
    expect(summary.unknownCodes).toEqual([]);
  });

  it('пустой набор — нули, а не выдуманные доли', () => {
    const summary = summarizeDiagnostics([]);
    expect(summary).toMatchObject({ total: 0, errors: 0, warnings: 0, unknownCodes: [] });
    expect(summary.byCode).toEqual([]);
    expect(summary.byPhase).toEqual([]);
  });
});

describe('журнал не утекает', () => {
  it('проекция не несёт ни текста исходника, ни значений окружения', () => {
    const sourceSecret = 'СЕКРЕТ_ИЗ_ИСХОДНИКА_9f3a';
    const envSecret = 'СЕКРЕТ_ИЗ_ОКРУЖЕНИЯ_7b1c';
    process.env.OSNOVA_TEST_LEAK_MARKER = envSecret;
    try {
      // Запись целиком: текст исходника и задача лежат рядом с отчётами — как в
      // настоящем журнале (`TraceEntry.source.source`, `TraceEntry.task`).
      const entryLike = {
        task: `сделай программу ${sourceSecret}`,
        source: { filename: 'main.osnova', source: `процедура главная() // ${sourceSecret}` },
        buildReport: {
          ...buildOk,
          success: false,
          compilerSuccess: false,
          semanticErrors: [{ message: 'вызов несуществующего системного вызова', kind: 'unknown_syscall' }],
        },
        // Стек VM и переменные окружения — то, что в журнал попадать не должно.
        goldenReport: {
          ...goldenOk,
          executed: false,
          vmErrors: [{ message: 'boom код=OSN-RT-002', stack: [sourceSecret, envSecret] }],
        },
      };
      const records = projectEntryDiagnostics(entryLike);
      const text = JSON.stringify(records);
      expect(text).not.toContain(sourceSecret);
      expect(text).not.toContain(envSecret);
      expect(records).toHaveLength(2);

      // Структурная гарантия: кроме перечисленных полей проекция не добавляет ничего.
      const allowed = ['code', 'phase', 'severity', 'message', 'kind', 'file', 'line', 'column'];
      for (const r of records) {
        for (const key of Object.keys(r)) expect(allowed).toContain(key);
      }
    } finally {
      delete process.env.OSNOVA_TEST_LEAK_MARKER;
    }
  });

  it('сообщение переносится как есть: проекция его не дописывает и не переписывает', () => {
    // Компилятор сам решает, что в тексте диагностики; проекция — перенос.
    const message = 'ожидается конец_процедуры';
    const records = diagnosticsFromBuildReport({
      ...buildOk,
      success: false,
      compilerSuccess: false,
      parserErrors: [{ line: 2, column: 3, message }],
    });
    expect(records[0]?.message).toBe(message);
  });
});

describe('сторож проводки: оркестратор обязан заполнять поле', () => {
  /**
   * Правка в замороженном `src/pipeline/orchestrator.ts` аддитивная и потому
   * тихая: забыть поле в новом месте записи — значит снова получить журнал без
   * диагностики, и заметить это можно только замером. Сторож держит проводку:
   * сколько мест записи в оркестраторе — столько раз передана проекция.
   */
  it('у каждого saveTrace в оркестраторе есть diagnostics из проекции, а его итог прочитан', () => {
    const file = path.resolve(process.cwd(), 'src', 'pipeline', 'orchestrator.ts');
    const text = fsSync.readFileSync(file, 'utf-8');
    const callSites = text.match(/await saveTrace\(\{/g) ?? [];
    const filled = text.match(/diagnostics: diagnosticsForTrace\(\),/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    expect(filled.length).toBe(callSites.length);
    // Отказ записи обязан быть прочитан: `saved: false` не имеет права остаться
    // незамеченным ровно так же, как молчащий отказ компилятора.
    const checked = text.match(/if \(!\w+Trace\.saved\)/g) ?? [];
    expect(checked.length).toBe(callSites.length);
    expect(text).toContain("import { projectEntryDiagnostics } from '../trace/diagnosticsProjection';");
  });
});
