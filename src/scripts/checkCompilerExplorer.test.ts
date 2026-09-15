/**
 * ПРОВЕРКА ДОСТУПНОСТИ КОМПИЛЯТОРА e2k НА COMPILER EXPLORER.
 *
 * # Зачем
 *
 * Кодировка e2k извлечена из четырёх открытых описаний и проверена round-trip
 * (`docs/e2k-real-run.md`), но **внешней** проверки нет: MCST-objdump и QEMU в этом окружении
 * не собраны (`docs/e2k-qemu-build.md` §2). Первый кандидат на внешнюю проверку без установки
 * Linux — онлайн-компилятор: он собирает исходник своим компилятором и показывает ассемблерный
 * вывод. Если у него есть компилятор e2k, наши байты можно сверить независимо.
 *
 * # Что проверяется
 *
 * 1. **Сервис доступен** — `https://godbolt.org` отвечает.
 * 2. **Списка компиляторов достаточно для вывода** — запрашивается полный список и
 *    проверяется, что он непустой (иначе «компилятора нет» означало бы «список не получен»).
 * 3. **Результат поиска совпадает с записанным фактом** — защита от устаревания: если
 *    компилятор e2k появится, документ обязан назвать его идентификатор; пока его нет,
 *    документ обязан содержать строку «НЕТ КОМПИЛЯТОРА e2k НА COMPILER EXPLORER».
 * 4. **Ловушка кода ответа.** `/api/compilers/e2k` отвечает **200** с пустым массивом, а не
 *    404: критерием не может быть код ответа. Это проверяется негативным контролем.
 *
 * # Поведение без сети
 *
 * Тест не краснеет от отсутствия сети: если сервис недоступен, проверяется только то, что факт
 * **записан** в документе. Слабость названа прямо — «сети не было» не превращается в «проверено».
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-external-validation.md');

/** Записанный факт: компилятора e2k на Compiler Explorer нет. */
export const CE_NO_E2K = 'НЕТ КОМПИЛЯТОРА e2k НА COMPILER EXPLORER';

/** Одна запись из `/api/compilers`. */
export interface CeCompiler {
  readonly id: string;
  readonly name: string;
  readonly lang?: string;
  readonly compilerType?: string;
  readonly instructionSet?: string;
}

/**
 * Поиск компиляторов e2k по всем формам, которыми предмет может быть назван
 * (метаправило проекта). Чистая функция — её же проверяет негативный контроль.
 *
 * Ловушка, ради которой функция вынесена: подстрока `isp` встречается в `ispc`
 * (Intel SPMD, архитектура `amd64`) — широкий шаблон дал бы ложное совпадение.
 */
export function findE2kCompilers(compilers: readonly CeCompiler[]): CeCompiler[] {
  const pattern = /(^|[^a-z0-9])(e2k|elbrus|mcst|vliw)([^a-z0-9]|$)/i;
  return compilers.filter((compiler) => {
    const haystack = [compiler.id, compiler.name, compiler.compilerType ?? '', compiler.instructionSet ?? ''].join(' ');
    return pattern.test(haystack);
  });
}

/** Результат опроса сервиса. */
export type CeProbe =
  | { readonly status: 'reachable'; readonly total: number; readonly found: readonly CeCompiler[] }
  | { readonly status: 'unreachable'; readonly reason: string };

/** Опрос Compiler Explorer: полный список компиляторов. */
export async function probeCompilerExplorer(timeoutMs = 30_000): Promise<CeProbe> {
  try {
    const root = await fetch('https://godbolt.org', {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (root.status !== 200) return { status: 'unreachable', reason: `godbolt.org ответил ${root.status}` };
    const response = await fetch('https://godbolt.org/api/compilers', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      return { status: 'unreachable', reason: `/api/compilers ответил ${response.status}` };
    }
    const compilers = (await response.json()) as CeCompiler[];
    if (!Array.isArray(compilers) || compilers.length === 0) {
      return { status: 'unreachable', reason: 'список компиляторов пуст — по нему нельзя судить' };
    }
    return { status: 'reachable', total: compilers.length, found: findE2kCompilers(compilers) };
  } catch (error) {
    return {
      status: 'unreachable',
      reason: `нет доступа: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Решение по записанному факту: что документ обязан утверждать при данном результате. */
export function requiredStatement(probe: CeProbe): string {
  if (probe.status === 'unreachable') return '';
  return probe.found.length > 0 ? probe.found[0]!.id : CE_NO_E2K;
}

describe('Compiler Explorer: есть ли компилятор e2k', () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf-8') : '';
  let cached: Promise<CeProbe> | undefined;
  const probe = (): Promise<CeProbe> => (cached ??= probeCompilerExplorer());

  it('документ с записанным фактом существует', () => {
    expect(fs.existsSync(DOC), 'нет docs/e2k-external-validation.md').toBe(true);
    expect(doc).toContain('godbolt.org');
  });

  it('сервис опрошен: результат совпадает с записанным фактом', async () => {
    const result = await probe();
    if (result.status === 'unreachable') {
      // Слабая проверка: сети нет. Это не «компилятора нет» — это «проверить не удалось»,
      // и причина обязана быть видна в тесте, а не проглочена.
      expect(result.reason.length, 'причина недоступности не названа').toBeGreaterThan(5);
      expect(doc).toMatch(new RegExp(`${CE_NO_E2K}|компилятор найден`));
      return;
    }
    expect(result.total, 'список компиляторов подозрительно мал').toBeGreaterThan(1000);
    if (result.found.length === 0) {
      expect(doc, 'компилятора e2k нет, а документ это не фиксирует').toContain(CE_NO_E2K);
    } else {
      // Защита от устаревания: появился компилятор — документ обязан назвать его идентификатор.
      for (const compiler of result.found) {
        expect(doc, `компилятор ${compiler.id} не записан в документ`).toContain(compiler.id);
      }
    }
    expect(doc, 'не записано, что проверялся список компиляторов').toMatch(/api\/compilers/);
  });

  it('ловушка записана: код ответа 200 не означает наличия компилятора', () => {
    // Проверяется не сеть, а документ: ловушка `/api/compilers/e2k` -> 200 + [] должна быть
    // названа, иначе следующий исполнитель наступит на неё снова.
    expect(doc).toContain('/api/compilers/e2k');
    expect(doc).toMatch(/200[^\n]*пуст|пустой массив/);
  });

  it('негативный контроль: поиск ловит e2k и не ловится на подстроке isp', () => {
    const synthetic: CeCompiler[] = [
      { id: 'ispc-trunk', name: 'ispc (trunk)', lang: 'ispc', compilerType: 'ispc', instructionSet: 'amd64' },
      { id: 'gcc1310', name: 'x86-64 gcc 13.1.0', lang: 'c++', compilerType: 'gcc', instructionSet: 'amd64' },
    ];
    expect(findE2kCompilers(synthetic), 'подстрока isp дала ложное совпадение').toEqual([]);

    const withE2k: CeCompiler[] = [
      ...synthetic,
      { id: 'e2k-gcc', name: 'Elbrus e2k gcc', lang: 'c++', compilerType: 'gcc', instructionSet: 'e2k' },
    ];
    const found = findE2kCompilers(withE2k);
    expect(found.map((compiler) => compiler.id)).toEqual(['e2k-gcc']);
    expect(requiredStatement({ status: 'reachable', total: withE2k.length, found })).toBe('e2k-gcc');
    expect(requiredStatement({ status: 'reachable', total: synthetic.length, found: [] })).toBe(CE_NO_E2K);
    expect(requiredStatement({ status: 'unreachable', reason: 'нет сети' })).toBe('');
  });
});
