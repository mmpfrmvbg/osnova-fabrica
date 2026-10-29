/**
 * ОРАКУЛ РАСКЛАДКИ РЕГИСТРОВ: значение ПОСЛЕ раскладки обязано совпасть с VM.
 *
 * # Зачем он появился
 *
 * Пример `17-ранжирование-выбором` давал на цели **4** вместо **23**. Замер (`.tmp/osnova-17-carrier-vm.ts`,
 * `docs/hardware-debt.md` §3.35) показал, что врёт не модель и не понижение, а **раскладка регистров**:
 * граф потока управления строился на потоке, в котором цели переходов ещё не пересчитаны после снятия
 * копий, ребро «выход из внутреннего цикла» уезжало на команду, отрезок жизни накопителя рассыпался на
 * точечные — и `exit` отдавал `индекс` вместо `контроль`.
 *
 * До этого файла слой не был покрыт **ничем**: `shellPathFaithfulness.test.ts` (и прежняя
 * `.tmp/probe-17.ts`) исполняет поток ДО `allocateProgram`, поэтому «наши слои верны» было верно ровно
 * про путь до раскладки. `allocateProgram` не вызывался ни в одном тесте.
 *
 * # Как устроен оракул
 *
 * Один и тот же вопрос — «что посчитала программа?» — задаётся дважды:
 *
 * | кто считает | что это |
 * |---|---|
 * | регистровая VM (`RegVM`) | эталон языка |
 * | интерпретатор потока НОСИТЕЛЕЙ на выходе `allocateProgram` | то, что уходит в кодировку и в модель |
 *
 * Интерпретатор намеренно маленький: семантика носителей — из описания (`src/e2k/e2kRealRun.ts`),
 * память рантайма массивов — символическая (указатель — номер блока), слоты вытеснения — символические
 * ячейки. Этого хватает на весь корпус с результатом-возвратом; носитель, которого интерпретатор не
 * знает, — **названный отказ**, а не молчаливый пропуск.
 *
 * # Негативный контроль
 *
 * Со снятой правкой (цели не пересчитаны перед анализом живости) оракул **краснеет**: пример 17 даёт
 * 4 вместо 23, V5 — 4 вместо 30. Это измерено откатом правки (`docs/hardware-debt.md` §3.37), а
 * различающий опыт, который строит оба варианта рядом, — `.tmp/osnova-17-stale-targets.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { regModuleOf } from '../vliw/regOracle';
import { RegVM } from '../runtime/vm/reginterpreter';
import { createDefaultInvokeHandler } from '../runtime/vm/interpreter';
import { resolveEntryIndex } from '../oracle/parity';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { emitShell } from './emitterShell';
import { getEncoder, type AsmInstruction } from './backend';
import { allocateProgram } from './regAlloc';

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const shellEncoder = getEncoder('internal-shell');

/** Отказ оракула: носитель, которого интерпретатор не умеет. Молча пропустить его нельзя. */
export class CarrierCoverageRefusal extends Error {
  constructor(readonly mnemonic: string, detail: string) {
    super(
      `раскладка проверяется интерпретатором потока носителей, а он не знает «${mnemonic}» (${detail}). ` +
        'Расширь интерпретатор в src/e2k/regAllocCoverage.test.ts: пропуск без причины означал бы, что ' +
        'слой раскладки на этой программе не проверен',
    );
    this.name = 'CarrierCoverageRefusal';
  }
}

/**
 * Исполнить поток носителей и вернуть значение возврата.
 *
 * Операнды носителей: у `IR.move`/`IR.const` приёмник первый, у бинарных — `[dst, a, b]`
 * (`src/e2k/e2kRealRun.ts:132`); у `IR.const` второй операнд — **индекс пула констант**; у переходов —
 * абсолютный индекс носителя. Приёмник берётся по НОМЕРУ операнда, а не по его значению: первая
 * редакция этой пробы путала одно с другим и давала 0 на верной программе (положительный контроль поймал).
 */
export function interpretCarriers(
  code: readonly AsmInstruction[],
  constants: readonly unknown[],
  invokeNames: readonly string[],
): number {
  const registers = new Array<number>(64).fill(0);
  // Память рантайма массивов: указатель — номер блока. Слоты вытеснения — отдельные ячейки.
  const arrays = new Map<number, number[]>();
  const slots: number[] = [];
  let nextPointer = 1;
  /** Последнее исполненное сравнение — то, что машина держит в `%pred0` (см. `compare`). */
  let predicate = 0;
  const src = (operand: AsmInstruction['operands'][number] | undefined): number => {
    if (operand === undefined) return 0;
    return operand.kind === 'imm' ? operand.value : (registers[operand.index] ?? 0);
  };
  const dst = (operand: AsmInstruction['operands'][number] | undefined): number => {
    if (operand === undefined || operand.kind !== 'reg') {
      throw new CarrierCoverageRefusal('приёмник', 'приёмник не выражен регистром');
    }
    return operand.index;
  };
  const compare = (instruction: AsmInstruction, relation: (a: number, b: number) => boolean): void => {
    const result = relation(src(instruction.operands[1]), src(instruction.operands[2])) ? 1 : 0;
    registers[dst(instruction.operands[0])] = result;
    // ПРЕДИКАТ — отдельное состояние, и это ИЗМЕРЕНО, а не удобство: пара «сравнение + условный
    // переход» понижается в `cmp…` + `ct`, а `ct` читает `%pred0` (`PREDICATE_FOR_PAIRS = 0`), куда
    // пишет последнее ИСПОЛНЕННОЕ сравнение. Поэтому переход, до которого добрались по ветви в обход
    // своего сравнения (короткое замыкание `и`, цепочка `4 < x < 8`), проверяет результат ПРЕДЫДУЩЕГО
    // сравнения. Модель «переход читает значение регистра» расходится с машиной именно на таких ветвях:
    // на `18-цепочка-сравнений` она давала 3 вместо 2, на `28-цикл-с-двумя-условиями` зацикливалась,
    // тогда как модель давала верные 2 и 100 (шлюз `gate:qemu`). Положительным контролем здесь
    // оказалась сама модель, а не симулятор.
    predicate = result;
  };

  let pc = 0;
  let steps = 0;
  while (pc < code.length) {
    const instruction = code[pc]!;
    const operands = instruction.operands;
    steps += 1;
    if (steps > 2_000_000) throw new Error('поток не сходится: слишком много шагов (цикл?)');
    switch (instruction.mnemonic) {
      case 'IR.const':
        registers[dst(operands[0])] = Number(constants[src(operands[1])]);
        break;
      case 'IR.move':
        registers[dst(operands[0])] = src(operands[1]);
        break;
      case 'IR.add':
        registers[dst(operands[0])] = src(operands[1]) + src(operands[2]);
        break;
      case 'IR.sub':
        registers[dst(operands[0])] = src(operands[1]) - src(operands[2]);
        break;
      case 'IR.mul':
        // `MULs` даёт младшую половину 32-битного произведения — то же, что `Math.imul`.
        registers[dst(operands[0])] = Math.imul(src(operands[1]), src(operands[2]));
        break;
      case 'IR.idiv': {
        const divisor = src(operands[2]);
        if (divisor === 0) throw new CarrierCoverageRefusal('IR.idiv', 'деление на ноль на цели — исключение, а не значение');
        registers[dst(operands[0])] = Math.trunc(src(operands[1]) / divisor);
        break;
      }
      case 'IR.lt':
        compare(instruction, (a, b) => a < b);
        break;
      case 'IR.le':
        compare(instruction, (a, b) => a <= b);
        break;
      case 'IR.gt':
        compare(instruction, (a, b) => a > b);
        break;
      case 'IR.ge':
        compare(instruction, (a, b) => a >= b);
        break;
      case 'IR.eq':
        compare(instruction, (a, b) => a === b);
        break;
      case 'IR.ne':
        compare(instruction, (a, b) => a !== b);
        break;
      case 'IR.spill_st':
        // `IR.spill_st [значение, адрес, слот]` — адрес в модели слотов символический.
        slots[src(operands[2])] = src(operands[0]);
        break;
      case 'IR.spill_ld':
        registers[dst(operands[1])] = slots[src(operands[2])] ?? 0;
        break;
      case 'IR.invoke': {
        const flags = operands[0];
        if (flags === undefined || flags.kind !== 'imm') throw new CarrierCoverageRefusal('IR.invoke', 'флаги не число');
        const argc = flags.value >> 1;
        const hasDestination = (flags.value & 1) === 1;
        const name = invokeNames[src(operands[3])];
        const args = [src(operands[1]), src(operands[2])].slice(0, argc);
        switch (name) {
          case 'система.массив.создать': {
            const pointer = nextPointer++;
            arrays.set(pointer, []);
            if (hasDestination) registers[dst(operands[4])] = pointer;
            break;
          }
          case 'система.массив.длина':
            if (hasDestination) registers[dst(operands[4])] = arrays.get(args[0]!)?.length ?? 0;
            break;
          case 'система.массив.получить':
            if (hasDestination) registers[dst(operands[4])] = arrays.get(args[0]!)?.[args[1]!] ?? 0;
            break;
          case 'система.массив.добавить':
            arrays.get(args[0]!)?.push(args[1]!);
            break;
          default:
            throw new CarrierCoverageRefusal('IR.invoke', `вызов «${String(name)}» не описан в интерпретаторе`);
        }
        break;
      }
      case 'IR.jmp':
        pc = src(operands[0]);
        continue;
      case 'IR.jmp_if':
        if (predicate !== 0) {
          pc = src(operands[1]);
          continue;
        }
        break;
      case 'IR.jmp_if_not':
        if (predicate === 0) {
          pc = src(operands[1]);
          continue;
        }
        break;
      case 'IR.ret':
        return operands[0]?.kind === 'imm' && operands[0].value === 1 ? src(operands[1]) : 0;
      default:
        throw new CarrierCoverageRefusal(instruction.mnemonic, 'нет семантики в интерпретаторе');
    }
    pc += 1;
  }
  throw new Error('поток кончился без возврата со значением');
}

/** Примеры, объявленные с результатом-возвратом: список читается из корпуса, а не держится руками. */
function corpusReturnExamples(): string[] {
  return fs
    .readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dir) => {
      const meta = path.join(EXAMPLES, dir, 'meta.json');
      if (!fs.existsSync(meta) || !fs.existsSync(path.join(EXAMPLES, dir, 'main.osnova'))) return false;
      const parsed = JSON.parse(fs.readFileSync(meta, 'utf-8')) as { expected?: { via?: string } };
      return parsed.expected?.via === 'возврат';
    })
    .sort();
}

const CASES = corpusReturnExamples();

/** Значение на регистровой VM — эталон языка. */
async function vmValue(source: string): Promise<number> {
  const built = regModuleOf(source);
  if (built === null) throw new Error('пример не компилируется');
  const entry = resolveEntryIndex(built.module.procedures, undefined) ?? 0;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(built.module, { maxSteps: 500_000, invoke: (n, a) => host(n, a) });
  return Number(await vm.runProcedure(entry, []));
}

/** Значение ПОСЛЕ раскладки регистров — то, что уходит в кодировку и в модель. */
async function valueAfterAllocation(source: string): Promise<number> {
  const built = regModuleOf(source);
  if (built === null) throw new Error('пример не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  const report = allocation.report[0];
  expect(report?.ok, `раскладка отказала: ${report?.reason ?? 'причина не названа'}`).toBe(true);
  return interpretCarriers(allocation.instructions, emitted.scheduled.constants, emitted.image.invokeNames);
}

describe('раскладка регистров сохраняет поток значений', () => {
  it('корпус объявил примеры с результатом-возвратом, и среди них есть тот, ради которого оракул поставлен', () => {
    expect(CASES.length, 'примеров с expected.via = «возврат»').toBeGreaterThan(20);
    expect(CASES).toContain('17-ранжирование-выбором');
  });

  it('отказ сторожа: носитель вне интерпретатора называется, а не пропускается молча', () => {
    // НЕГАТИВНЫЙ КОНТРОЛЬ самого отказа: без него «оракул зелёный» означало бы и «проверено»,
    // и «нечего было проверять».
    const unknown: AsmInstruction = { mnemonic: 'IR.call', channel: 0, operands: [{ kind: 'imm', value: 0 }] };
    expect(() => interpretCarriers([unknown], [], [])).toThrow(CarrierCoverageRefusal);
    expect(() => interpretCarriers([unknown], [], [])).toThrow(/IR\.call/u);
  });

  for (const dir of CASES) {
    it(`${dir}: значение после раскладки совпадает с VM`, async () => {
      const source = fs.readFileSync(path.join(EXAMPLES, dir, 'main.osnova'), 'utf-8');
      const direct = await vmValue(source);
      const afterAllocation = await valueAfterAllocation(source);
      expect(
        afterAllocation,
        `${dir}: после раскладки ${String(afterAllocation)}, VM ${String(direct)} — расхождение внутри НАШИХ ` +
          'слоёв: раскладка регистров испортила поток значений (docs/hardware-debt.md §3.35/§3.37)',
      ).toBe(direct);
    });
  }
});

/**
 * ПРИЁМКА СРЕЗА 5в: НАКОПИТЕЛЬ КОНЪЮНКЦИИ НА РЕБРЕ — ОДНА КЛЕТКА.
 *
 * # Что спрашивается
 *
 * Короткое замыкание `A и B` понижается переходом ВПЕРЁД: `A` → `jmp_if_not` → `B`, а значение пары
 * читается на ЦЕЛИ — то есть на ребре, где второй терм ПРОПУЩЕН. На цели обязан лежать результат
 * ПЕРВОГО терма, а это верно ровно тогда, когда оба терма пишут ОДНУ клетку. Раскладка обязана её дать.
 *
 * # Почему проверка живёт ЗДЕСЬ, а не в сторожe
 *
 * Сторож (`src/e2k/predicatePairing.ts`, срез 5б) стоит на МЕХАНИЗМЕ и не пускает такие программы
 * вовсе — это честный отказ, но не починка. Здесь спрашивается САМ РАСКЛАДЧИК, в обход сторожа:
 * `allocateProgram` зовётся напрямую (как и во всём этом файле), поэтому проверка краснеет на САМОЙ
 * причине. Пока причина жива, файл красный — и это его работа, а не помеха.
 *
 * # Замер ДО починки (2026-10-29, срез 5в, задача 2)
 *
 * Один и тот же поток (25 носителей), две точки:
 *
 * | что | K8 (две конъюнкции) | K7b (переменные границы, ложный первый терм) |
 * |---|---|---|
 * | эталон языка (обе VM) | 10 | 0 |
 * | после `allocateProgram` | **58** | **10** |
 * | клетки первого терма / второго / цели | `%b[4]` / `%b[3]` / `%b[3]` | то же разделение |
 *
 * `cfgRanges` даёт у накопителя ДВА НЕПЕРЕСЕКАЮЩИХСЯ отрезка (`[4..5]` и `[8..9]`), линейная
 * раскладка вправе дать им разные клетки, а `applySegments` отдаёт команде клетку НАКРЫВАЮЩЕГО отрезка:
 * на цель приходит клетка, которую пишет только ПРОПУЩЕННЫЙ второй терм. Разбор — §3.142.
 */
const К8_ДВЕ_КОНЪЮНКЦИИ = [
  'процедура главная()',
  '  пусть код = 50',
  '  пусть другой = 10',
  '  пусть пер = код >= 48 и код <= 57',
  '  пусть вт = другой >= 48 и другой <= 57',
  '  вернуть пер * 10 + вт',
  'конец_процедуры',
  '',
].join('\n');

const К7Ь_ГРАНИЦЫ_ПЕРЕМЕННЫЕ = [
  'процедура главная()',
  '  пусть код = 5',
  '  пусть нижняя = 48',
  '  пусть верхняя = 57',
  '  пусть пер = код >= нижняя и код <= верхняя',
  '  вернуть пер * 10',
  'конец_процедуры',
  '',
].join('\n');

/** Поток после раскладки — тот самый, что уходит в кодировку. */
function послеРаскладки(source: string): ReturnType<typeof allocateProgram> {
  const built = regModuleOf(source);
  if (built === null) throw new Error('проба 5в не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const allocation = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
  expect(allocation.report[0]?.ok, `раскладка отказала: ${allocation.report[0]?.reason ?? 'причина не названа'}`).toBe(true);
  return allocation;
}

/**
 * Клетки одной пары «первый терм → переход вперёд → пропущенный второй терм → цель».
 *
 * Берётся ровно по потоку ПОСЛЕ раскладки: у `IR.jmp_if_not` первый операнд — накопитель (он же
 * результат первого терма), следующая команда — второй терм, а на цели стоит перенос значения в
 * переменную программы (`IR.move(переменная, накопитель)`) — читается именно второй операнд.
 */
function клеткиНакопителя(source: string): { термПервый: number; термВторой: number; цель: number }[] {
  const allocation = послеРаскладки(source);
  const найдено: { термПервый: number; термВторой: number; цель: number }[] = [];
  allocation.instructions.forEach((instruction, at) => {
    if (instruction.mnemonic !== 'IR.jmp_if_not') return;
    const target = instruction.operands[1];
    if (target?.kind !== 'imm') return;
    const первый = instruction.operands[0];
    const второй = allocation.instructions[at + 1]?.operands[0];
    const наЦели = allocation.instructions[target.value];
    const прочитанный = наЦели?.mnemonic === 'IR.move' ? наЦели.operands[1] : наЦели?.operands[0];
    if (первый?.kind !== 'reg' || второй?.kind !== 'reg' || прочитанный?.kind !== 'reg') return;
    найдено.push({ термПервый: первый.index, термВторой: второй.index, цель: прочитанный.index });
  });
  return найдено;
}

describe('приёмка 5в: накопитель конъюнкции на ребре взятого перехода — ОДНА клетка', () => {
  it('K8: оба терма пишут одну клетку, и цель читает её же (эталон 10)', async () => {
    const пары = клеткиНакопителя(К8_ДВЕ_КОНЪЮНКЦИИ);
    expect(пары.length, 'пар «конъюнкция → переход вперёд» в пробе').toBe(2);
    for (const [номер, пара] of пары.entries()) {
      expect(пара.термВторой, `пара ${String(номер)}: второй терм пишет ДРУГУЮ клетку, чем первый`).toBe(пара.термПервый);
      expect(пара.цель, `пара ${String(номер)}: цель читает ДРУГУЮ клетку, чем пишет первый терм`).toBe(пара.термПервый);
    }
    expect(await vmValue(К8_ДВЕ_КОНЪЮНКЦИИ), 'эталон языка (обе VM)').toBe(10);
    expect(
      await valueAfterAllocation(К8_ДВЕ_КОНЪЮНКЦИИ),
      'K8 после раскладки: до починки 58 вместо 10 — вторая тихая ложь (случай 55)',
    ).toBe(10);
  });

  it('K7b: переменные границы при ложном первом терме — одна клетка и верный 0', async () => {
    const пары = клеткиНакопителя(К7Ь_ГРАНИЦЫ_ПЕРЕМЕННЫЕ);
    expect(пары.length, 'пар «конъюнкция → переход вперёд» в пробе').toBe(1);
    expect(пары[0]!.термВторой, 'второй терм пишет другую клетку').toBe(пары[0]!.термПервый);
    expect(пары[0]!.цель, 'цель читает другую клетку').toBe(пары[0]!.термПервый);
    expect(await vmValue(К7Ь_ГРАНИЦЫ_ПЕРЕМЕННЫЕ), 'эталон языка (обе VM)').toBe(0);
    expect(
      await valueAfterAllocation(К7Ь_ГРАНИЦЫ_ПЕРЕМЕННЫЕ),
      'K7b после раскладки: до починки 10 вместо 0 — та же тихая ложь',
    ).toBe(0);
  });
});
