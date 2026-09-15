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
import {
  CE_NO_E2K,
  findE2kCompilers,
  probeAssemblers,
  probeCompilerExplorer,
  requiredStatement,
  type CeCompiler,
  type CeProbe,
} from './compilerExplorer';

const ROOT = path.resolve(__dirname, '..', '..');
const DOC = path.join(ROOT, 'docs', 'e2k-external-validation.md');

export { CE_NO_E2K, findE2kCompilers, requiredStatement };

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

  it('отдельный список ассемблеров тоже без e2k', async () => {
    // Вторая форма поиска: если компилятора e2k нет, ассемблер e2k всё равно дал бы внешнюю
    // проверку — он собирал бы инструкцию в байты.
    const assemblers = await probeAssemblers();
    if (assemblers.status === 'unreachable') {
      expect(assemblers.reason.length).toBeGreaterThan(5);
      return;
    }
    expect(assemblers.total).toBeGreaterThan(10);
    if (assemblers.found.length === 0) {
      expect(doc, 'ассемблеров e2k нет, а документ это не фиксирует').toMatch(/ассемблер/i);
    } else {
      for (const assembler of assemblers.found) expect(doc).toContain(assembler.id);
    }
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
