/**
 * БЛОК РАНТАЙМА МАССИВОВ: ТОЛЬКО СОБСТВЕННЫЙ КАДР ПРОЦЕДУРЫ (§3.131).
 *
 * # Что здесь проверяется и почему именно так
 *
 * Блок рантайма массивов — пять клеток, в которые пролог значений пишет НОЛЬ, ЕДИНИЦУ и ВОСЕМЬ
 * (`src/e2k/arrayRuntime.ts#arrayValuePrologue`), а операции берут оттуда адрес элемента. Значит
 * клетки блока — не «просто временные»: их пишет САМА процедура в точке входа, и всё, что живёт
 * в этих клетках у кого-то другого, будет затёрто молча.
 *
 * У вызываемой процедуры младшая половина кадра (`%b[0..7]`) — ЧУЖАЯ (`call wbs = 4` сдвигает окно
 * на `2*wbs = 8`):
 *
 * | клетка вызываемой | чья она на самом деле |
 * |---|---|
 * | `%b[0]`, `%b[1]` | аргументы вызова (соглашение ABI) |
 * | `%b[2..7]` | `%b[10..15]` ВЫЗЫВАЮЩЕГО — его рантайм массивов и указатель кучи |
 * | `%b[8..15]` | собственные клетки вызываемой |
 *
 * # Замер, которым это поймано (2026-10-10, §3.130 → §3.131)
 *
 * Стенд (`allocateProgram` без `freeFor`) выдавал блок вызываемой из пула `%b[0..9]` — то есть
 * клал его в клетки 3..7 или 4..8, а это `%b[11..15]` и `%b[12..16]` ВЫЗЫВАЮЩЕГО. Пролог значений
 * вызываемой писал ЕДИНИЦУ в клетку 12 вызывающего, а выход программы считает `код = значение +
 * %b[12]` (`src/e2k/printCall.ts#exitCarrierInstructions`) — и число уезжало на «+1»: М3 давало 7
 * вместо 6, М4 — 6 вместо 5, К3 — 8 вместо 7. Это не смещённый адрес: адрес был верный, прибавлена
 * была затёртая чужая клетка.
 *
 * # Правило, которое проверяет оракул
 *
 * Блок вызываемой лежит в ЕЁ СОБСТВЕННОЙ половине кадра (`%b[8..15]` при `wbs = 4`), а не в первой
 * свободной пятёрке чьего угодно пула. Нет такой пятёрки — блока НЕТ, и понижение отказывает ПО
 * ИМЕНИ (`OSN-LOW-003`, «раскладка не выдала базу блока рантайма»), а не отдаёт чужие клетки.
 *
 * Негативный контроль — третья проверка: растянутый бюджет вызываемой (`freeFor` не задан, как в
 * стендовых пробах) обязан кончиться ОТСУТСТВИЕМ базы. Прежняя редакция выдавала базу 3 — и число
 * было неверным тихо.
 */
import { describe, expect, it } from 'vitest';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { getEncoder } from './backend';
import { emitShell } from './emitterShell';
import { allocateProgram } from './regAlloc';
import { CALL_WBS, CALLEE_REGISTERS } from './twoPassLayout';
import { ARRAY_BLOCK_SIZE, ENTRY_ARRAY_BASE, arrayCells } from './arrayRuntime';
import { entryProcedureIndex } from './procedureCall';
import { regModuleWithRecordPlan } from './recordPlan';
import { parseV3 } from '../compiler-v3/index';

/** Первая клетка СОБСТВЕННОЙ половины кадра вызываемой: `call wbs = 4` сдвигает окно на восемь. */
const OWN_HALF_FROM = 2 * CALL_WBS;

/** М3 §3.130: список `[5, 6]` строится в точке входа, `а[1]` читает процедура ПЛОСКОСТИ 2. */
const ПЛОСКОСТЬ_2 = [
  'процедура у_2(а: Список Число) → Число',
  '  вернуть а[1]',
  'конец',
  '',
  'процедура у_1(а: Список Число) → Число',
  '  вернуть у_2(а)',
  'конец',
  '',
  'действие главная()',
  '  пусть с: Список Число = []',
  '  добавить в с элемент 5',
  '  добавить в с элемент 6',
  '  вернуть у_1(с)',
  'конец',
  '',
].join('\n');

/**
 * Разложить программу. `бюджет` — правило раскладки:
 *   `продакшн` — как в `loweredProgram` (`src/e2k/programImage.ts`): точке входа `%b[0..9]`,
 *                вызываемой `CALLEE_REGISTERS`;
 *   `стенд`    — как в стендовых пробах: всем `%b[0..9]` (`freeFor` не задан).
 */
function разложить(
  источник: string,
  бюджет: 'продакшн' | 'стенд',
): {
  имена: readonly string[];
  вход: number;
  базы: readonly (number | undefined)[];
  занято: readonly (readonly number[])[];
  /** Кого зовёт каждая процедура: индекс вызываемой из операнда 3 носителя `IR.call`. */
  зовёт: readonly (readonly number[])[];
} {
  const разбор = parseV3(источник, 'блок.osnova');
  expect(разбор.errors, 'разбор программы').toEqual([]);
  const built = regModuleWithRecordPlan(источник, {
    filename: 'блок.osnova',
    parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
  });
  if (built === null) throw new Error('модуль не собран');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((п) => п.name) },
  ]);
  const emitted = emitShell(annotated, getEncoder('internal-shell'));
  const вход = entryProcedureIndex(emitted.scheduled.procedures);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures, {
    // Процедуры с массивами — те же, что называет конвейер (`arrayProceduresOf`): тело процедуры
    // содержит вызов рантайма массивов. Здесь это все процедуры с телом, кроме чистого передатчика.
    arrayProcedures: emitted.scheduled.procedures
      .map((_, at) => at)
      .filter((at) => {
        const to = emitted.scheduled.procedures[at + 1]?.codeOffset ?? emitted.instructions.length;
        return emitted.instructions
          .slice(emitted.scheduled.procedures[at]!.codeOffset, to)
          .some((carrier) => carrier.mnemonic === 'IR.invoke' || carrier.mnemonic === 'IR.call');
      }),
    ...(бюджет === 'продакшн'
      ? { freeFor: (at: number) => (at === вход ? undefined : CALLEE_REGISTERS) }
      : {}),
  });
  for (const отчёт of allocation.report) {
    expect(отчёт.ok, `раскладка процедуры «${отчёт.procedure}»: ${отчёт.reason ?? '—'}`).toBe(true);
  }
  // ГРАФ ВЫЗОВОВ: у вызываемой её клетка `N` — это клетка `N + 2*wbs` ВЫЗЫВАЮЩЕГО. Без перевода
  // сравнивать номера клеток из разных плоскостей нельзя: у процедуры глубины 2 та же клетка — уже
  // другая клетка машины (это и была ошибка первого разбора).
  const зовёт = emitted.scheduled.procedures.map((процедура, at) => {
    const to = emitted.scheduled.procedures[at + 1]?.codeOffset ?? allocation.instructions.length;
    const found: number[] = [];
    for (const carrier of allocation.instructions.slice(процедура.codeOffset, to)) {
      if (carrier.mnemonic !== 'IR.call') continue;
      const payload = carrier.operands[3];
      if (payload !== undefined && payload.kind === 'imm') found.push(payload.value);
    }
    return found;
  });
  return {
    имена: emitted.scheduled.procedures.map((п) => п.name),
    вход,
    базы: allocation.arrayBases,
    занято: allocation.report.map((отчёт) => отчёт.usedRegisters),
    зовёт,
  };
}

/** Клетки блока по базе; `undefined` — базы нет. */
function клетки(база: number | undefined): readonly number[] {
  if (база === undefined) return [];
  const { zero, one, eight, scratch, scratch2 } = arrayCells(база);
  return [zero, one, eight, scratch, scratch2];
}

describe('блок рантайма массивов не пересекается с живыми клетками вызывающего', () => {
  it('вызываемая получает блок в СВОЕЙ половине кадра, а не в пуле вызывающего', () => {
    const { имена, вход, базы } = разложить(ПЛОСКОСТЬ_2, 'продакшн');
    // Точка входа распоряжается всем файлом: её блок — измеренные клетки `%b[10..14]`.
    expect(базы[вход], `блок точки входа «${имена[вход] ?? '?'}»`).toBe(ENTRY_ARRAY_BASE);
    for (const [at, база] of базы.entries()) {
      if (at === вход || база === undefined) continue;
      const cells = клетки(база);
      expect(cells.length, 'клеток в блоке').toBe(ARRAY_BLOCK_SIZE);
      for (const клетка of cells) {
        expect(
          клетка,
          `блок процедуры «${имена[at] ?? '?'}» (база ${String(база)}) занял %b[${String(клетка)}] — ` +
            'это клетка ВЫЗЫВАЮЩЕГО (его рантайм и указатель кучи), а не своя',
        ).toBeGreaterThanOrEqual(OWN_HALF_FROM);
      }
    }
  });

  it('блок вызываемой, переведённый через границу вызова, не накрывает живые клетки вызывающего', () => {
    // Это и есть правило «блок не пересекается с живыми клетками» в точной форме: клетка вызываемой
    // `N` — это клетка `N + 2*wbs` вызывающего, и она не имеет права совпасть ни с занятой клеткой
    // вызывающего, ни с его рантаймом, ни с клетками аргументов (их вызывающий ПИШЕТ сам).
    const { базы, имена, занято, зовёт } = разложить(ПЛОСКОСТЬ_2, 'продакшн');
    const нарушения: string[] = [];
    for (const [звонящий, вызовы] of зовёт.entries()) {
      const живыеЗвонящего = new Set<number>([
        ...(занято[звонящий] ?? []),
        ...клетки(базы[звонящий]),
        OWN_HALF_FROM,
        OWN_HALF_FROM + 1,
      ]);
      for (const вызываемая of вызовы) {
        for (const клетка of клетки(базы[вызываемая])) {
          const вПлоскостиЗвонящего = клетка + OWN_HALF_FROM;
          if (живыеЗвонящего.has(вПлоскостиЗвонящего)) {
            нарушения.push(
              `«${имена[звонящий] ?? '?'}» → «${имена[вызываемая] ?? '?'}»: клетка ` +
                `%b[${String(клетка)}] вызываемой — это %b[${String(вПлоскостиЗвонящего)}] вызывающего`,
            );
          }
        }
      }
    }
    expect(нарушения, 'блок вызываемой лёг на живые клетки вызывающего').toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: растянутый бюджет вызываемой — ОТКАЗ, а не чужие клетки', () => {
    // Растянутый бюджет — не выдумка: ровно так зовут раскладку стендовые пробы
    // (`.tmp/recon-wall-mechanism.ts`, `.tmp/recon-wall-bench.ts`) и любой оракул без `freeFor`.
    // Прежняя редакция выдавала такой вызываемой базу 3 (клетки 3..7 = `%b[11..15]` вызывающего) —
    // и число уезжало на «+1» ТИХО. Правильное поведение — базы нет.
    const { имена, вход, базы } = разложить(ПЛОСКОСТЬ_2, 'стенд');
    const выданы = базы
      .map((база, at) => ({ at, база }))
      .filter(({ at, база }) => at !== вход && база !== undefined);
    expect(
      выданы.map(({ at, база }) => `«${имена[at] ?? '?'}» база ${String(база)}`),
      'вызываемым выданы блоки из пула вызывающего — клетка 12 вызывающего будет затёрта единицей, ' +
        'и выход прибавит её к ответу (замер: М3 7 вместо 6, К3 8 вместо 7)',
    ).toEqual([]);
  });
});
