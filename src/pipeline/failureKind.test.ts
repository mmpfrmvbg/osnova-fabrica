// ============================================================
// src/pipeline/failureKind.test.ts
//
// Оракул классификатора отказа. Негативный контроль обязателен: главный
// проверяемый дефект — возврат `unknown` там, где причина на самом деле есть
// (это и давало 683 записи `unknown` из 693 в runs/repair-failures.jsonl).
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  classifyBuildFailure,
  classifyFailure,
  classifyGoldenFailure,
  classifyParserMessage,
  PARSER_FAILURE_KINDS,
  EXECUTION_FAILURE_KINDS,
} from './failureKind';
import type { BuildReport, GoldenReport } from './types';

function buildReport(over: Partial<BuildReport> = {}): BuildReport {
  return {
    success: true,
    lexerErrors: [],
    parserErrors: [],
    compilerErrors: [],
    semanticErrors: [],
    bytecode: null,
    compilerSuccess: true,
    durationMs: 1,
    ...over,
  };
}

function goldenReport(over: Partial<GoldenReport> = {}): GoldenReport {
  return {
    executed: true,
    passed: false,
    qualityScore: 0.5,
    vmErrors: [],
    outputDiff: null,
    durationMs: 1,
    ...over,
  };
}

describe('classifyParserMessage', () => {
  it('«получено: =» → равно вместо сравнения', () => {
    expect(classifyParserMessage('Ожидается выражение, получено: =')).toBe('parser_eq_in_condition');
  });

  it('«Ожидается \'модуль\'» → лишний/ранний конец', () => {
    expect(classifyParserMessage("Ожидается 'модуль'")).toBe('parser_missing_module_end');
  });

  it('«Ожидается начало следующего модуля» → тот же подвид', () => {
    expect(
      classifyParserMessage('Ожидается начало следующего модуля или конец файла'),
    ).toBe('parser_missing_module_end');
  });

  it('«Ожидается имя типа» → :=', () => {
    expect(classifyParserMessage('Ожидается имя типа')).toBe('parser_colon_assign');
  });

  it('«получено: конец» → конец как имя', () => {
    expect(classifyParserMessage("Ожидается ')', получено: конец")).toBe('parser_keyword_as_name');
  });

  it('неизвестная формулировка → parser_error, а не выдумка', () => {
    expect(classifyParserMessage('Нечто новое и непонятное')).toBe('parser_error');
  });

  it('все подвиды входят в объявленный список', () => {
    const samples = [
      'Ожидается выражение, получено: =',
      "Ожидается 'модуль'",
      'Ожидается начало следующего модуля или конец файла',
      'Ожидается имя типа',
      "Ожидается ')', получено: конец",
      'что-то ещё',
    ];
    for (const s of samples) {
      expect(PARSER_FAILURE_KINDS).toContain(classifyParserMessage(s));
    }
  });
});

describe('classifyBuildFailure', () => {
  it('пустой отчёт → unknown', () => {
    expect(classifyBuildFailure(undefined)).toBe('unknown');
    expect(classifyBuildFailure(buildReport())).toBe('unknown');
  });

  it('лексер', () => {
    expect(
      classifyBuildFailure(buildReport({ lexerErrors: [{ line: 1, column: 1, message: 'e' }] })),
    ).toBe('lexer_error');
  });

  it('парсер разбирается на подвид', () => {
    expect(
      classifyBuildFailure(
        buildReport({ parserErrors: [{ line: 3, column: 1, message: 'Ожидается имя типа' }] }),
      ),
    ).toBe('parser_colon_assign');
  });

  it('блокирующая семантика важнее парсера и лексера', () => {
    expect(
      classifyBuildFailure(
        buildReport({
          parserErrors: [{ line: 1, column: 1, message: 'Ожидается имя типа' }],
          semanticErrors: [{ kind: 'redeclare_var', message: 'x' }],
        }),
      ),
    ).toBe('redeclare_var');
  });

  it('неблокирующая семантика доходит до результата', () => {
    expect(
      classifyBuildFailure(
        buildReport({ semanticErrors: [{ kind: 'sentinel_pattern', message: 'x' }] }),
      ),
    ).toBe('sentinel_pattern');
  });
});

describe('classifyGoldenFailure', () => {
  it('нет отчёта → unknown', () => {
    expect(classifyGoldenFailure(undefined)).toBe('unknown');
  });

  it('ошибки VM → vm_error', () => {
    expect(classifyGoldenFailure(goldenReport({ vmErrors: [{ message: 'boom' }] }))).toBe('vm_error');
  });

  it('расхождение вывода → golden_diff', () => {
    expect(classifyGoldenFailure(goldenReport({ outputDiff: 'ожидалось 10, получено 9' }))).toBe(
      'golden_diff',
    );
  });

  it('провал без деталей → golden_fail', () => {
    expect(classifyGoldenFailure(goldenReport())).toBe('golden_fail');
  });

  it('успешный golden → unknown', () => {
    expect(classifyGoldenFailure(goldenReport({ passed: true }))).toBe('unknown');
  });
});

describe('classifyFailure: негативный контроль главного дефекта', () => {
  // До правки этот случай давал 'unknown': сборка чистая, падение на исполнении.
  // Именно такие записи составляли 683 unknown из 693 в repair-failures.jsonl.
  it('чистая сборка + упавший golden НЕ должен быть unknown', () => {
    for (const g of [
      goldenReport({ vmErrors: [{ message: 'x' }] }),
      goldenReport({ outputDiff: 'diff' }),
      goldenReport(),
    ]) {
      const kind = classifyFailure(buildReport(), g);
      expect(kind).not.toBe('unknown');
      expect(EXECUTION_FAILURE_KINDS).toContain(kind);
    }
  });

  it('причина сборки важнее причины golden', () => {
    expect(
      classifyFailure(
        buildReport({ parserErrors: [{ line: 1, column: 1, message: 'Ожидается имя типа' }] }),
        goldenReport({ vmErrors: [{ message: 'x' }] }),
      ),
    ).toBe('parser_colon_assign');
  });

  it('без golden и без ошибок сборки → unknown (честное «не знаю»)', () => {
    expect(classifyFailure(buildReport())).toBe('unknown');
    expect(classifyFailure(undefined)).toBe('unknown');
  });
});
