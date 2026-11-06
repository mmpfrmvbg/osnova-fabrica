/**
 * САЙТ РАНТАЙМ-СРЕЗА, ВАРИАНТ Г: байты + арена + нормализация — ОРАКУЛ ЗАМЕРОМ, А НЕ ПО ФОРМЕ.
 *
 * Что здесь доказывается и чем: модель клеток ИСПОЛНЯЕТ САМ ПОСТРОЕННЫЙ поток носителей
 * (`stringSliceRuntimeSite` + `stringSliceRuntimeTail`) и её ответ сверяется с ЭТАЛОНОМ —
 * `src/runtime/vm/stringUnits.ts#codePointSlice`. Неизвестный носитель — падение модели, а не
 * «пропустить»: иначе оракул сошёлся бы с собственной неполнотой (случай 78 реестра проверяемости).
 *
 * ЧТО ИМЕННО ЛОВИТСЯ ДВУМЯ ПРОВЕРКАМИ ВЛАДЕЛЬЦА:
 *   • длина результата берётся из СЧЁТЧИКА скопированных кодпоинтов — иначе отрицательный край дал бы
 *     ВЕРНУЮ длину при НЕВЕРНЫХ байтах;
 *   • границы копии — НОРМАЛИЗОВАННЫЕ края: `подстрока("абвгде", -2, 6)` обязан вернуть «де», а не
 *     байты по исходному `н = −2`.
 *
 * РАЗМЕР ВЫДЕЛЕНИЯ — 8 · (к − н) + 16, И ЭТО ЗАМЕР, А НЕ ОЦЕНКА: модель прогоняет сайт ДВАЖДЫ, и
 * второе выделение обязано быть выровнено на 8. Формула оценки (4 · (к − н) + 16) при нечётном
 * `к − н` даёт адрес, не кратный восьми, — а дескриптор читается `ldd` (невыровненное чтение даёт
 * исключение выравнивания на цели, §3.133).
 */
import { describe, expect, it } from 'vitest';
import { ARENA_FLAG_REGISTER } from './arenaRuntime';
import { ARENA_LIMIT_BASE, ARENA_POINTER_BASE } from './procedureCall';
import { layoutOf } from './twoPassLayout';
import { pairPredicates } from './predicatePairing';
import {
  STRING_SLICE_COPY_LOOP_SIZE,
  STRING_SLICE_SITE_SIZE,
  STRING_SLICE_TAIL_SIZE,
  checkStringSliceRuntimeSite,
  checkStringSliceRuntimeTail,
  stringSliceCopyLoopCarriers,
  stringSliceRuntimeSite,
  stringSliceRuntimeTail,
  type StringSliceRuntimeSiteOptions,
} from './stringRuntime';
import { codePointLength, codePointSlice } from '../runtime/vm/stringUnits';

const а = (mnemonic: string, operands: readonly unknown[]): never =>
  ({ mnemonic, channel: 0, operands }) as never;
const р = (index: number): never => ({ kind: 'reg', index }) as never;
const и = (value: number): never => ({ kind: 'imm', value }) as never;

/** РОЛИ САЙТА: шесть клеток полосы, ключ — клетка арены, остальные объявлены сайтом (D24). */
const ЯЧЕЙКИ = {
  source: 10,
  end: 11,
  zero: 12,
  one: 13,
  target: 14,
  byte: 0,
  flag: 1,
  table: 8,
  scratch: 9,
  copied: 2,
  key: ARENA_FLAG_REGISTER,
} as const;
/** Клетки ВНЕ полосы, которые ОБЪЯВЛЯЕТ САЙТ: ровно они отнимаются у программы. */
const ОБЪЯВЛЕНО = [0, 1, 2, 3, 7, 8, 9] as const;
/** Что план отдаёт раскладке: объявления сайта ПЛЮС клетки арены (их объявляет сама арена). */
const РЕЗЕРВ = [...ОБЪЯВЛЕНО, ARENA_POINTER_BASE, ARENA_FLAG_REGISTER, ARENA_LIMIT_BASE] as const;
const НАЧАЛО = 3;
const КОНЕЦ = 7;
const ПРИЁМНИК = 15;

/** Пул констант: его значения раскладка читает, чтобы взять длину `IR.const` (8 или 16 байт). */
const пул = (options: { blob: number; blobBytes: number; count: number; table: number }): number[] => [
  options.blob,
  options.blob + options.blobBytes,
  options.count,
  options.table,
  1,
  16,
];
const ЛИТЕРАЛЫ = { sourceAddress: 0, sourceEnd: 1, codePoints: 2, tableAddress: 3, one: 4, sixteen: 5 };

const опции = (options: {
  blob: number;
  blobBytes: number;
  count: number;
  table: number;
  loopIndex: number;
  refusalIndex: number;
}): StringSliceRuntimeSiteOptions => ({
  from: НАЧАЛО,
  to: КОНЕЦ,
  destination: ПРИЁМНИК,
  literals: ЛИТЕРАЛЫ,
  cells: ЯЧЕЙКИ,
  arena: {
    pointer: ARENA_POINTER_BASE,
    limit: ARENA_LIMIT_BASE,
    flag: ARENA_FLAG_REGISTER,
    refusalIndex: options.refusalIndex,
  },
  loopIndex: options.loopIndex,
});

/** МОДЕЛЬ: клетки, память и арена. Исполняет ЛЮБОЙ носитель потока; незнакомый — отказ модели. */
class Модель {
  readonly клетки = new Map<number, number>();
  readonly память = new Map<number, number>();
  указатель: number;
  readonly предел: number;
  readonly журнал: string[] = [];
  constructor(
    readonly константы: readonly number[],
    указатель: number,
    предел: number,
  ) {
    this.указатель = указатель;
    this.предел = предел;
  }
  байты(адрес: number, сколько: number): number[] {
    return Array.from({ length: сколько }, (_, смещение) => this.память.get(адрес + смещение) ?? 0);
  }
  /** Исполнить поток целиком; `стоп` — индекс, на котором поток возвращается за вызов. */
  исполнить(поток: readonly { mnemonic: string; operands: readonly unknown[] }[], стоп: number): number {
    let pc = 0;
    let шагов = 0;
    while (pc >= 0 && pc < поток.length) {
      if (pc === стоп) return pc;
      шагов += 1;
      if (шагов > 200000) throw new Error('модель: поток не завершился — петля без выхода');
      const носитель = поток[pc]!;
      const [x, y, z] = носитель.operands as never as [
        { kind: string; index?: number; value?: number },
        { kind: string; index?: number; value?: number },
        { kind: string; index?: number; value?: number },
      ];
      const значение = (операнд: typeof x): number =>
        операнд.kind === 'imm' ? Number(операнд.value) : (this.клетки.get(Number(операнд.index)) ?? 0);
      const куда = (операнд: typeof x): number => Number(операнд.index);
      switch (носитель.mnemonic) {
        case 'IR.const':
          this.клетки.set(куда(x), this.константы[Number(y.value)] ?? 0);
          break;
        case 'IR.zero':
          this.клетки.set(куда(x), 0);
          break;
        case 'IR.move':
          this.клетки.set(куда(x), значение(y));
          break;
        case 'IR.add':
          this.клетки.set(куда(x), значение(y) + значение(z));
          break;
        case 'IR.sub':
          this.клетки.set(куда(x), значение(y) - значение(z));
          break;
        case 'IR.lt':
          this.клетки.set(куда(x), значение(y) < значение(z) ? 1 : 0);
          break;
        case 'IR.le':
          this.клетки.set(куда(x), значение(y) <= значение(z) ? 1 : 0);
          break;
        case 'IR.load_byte':
          this.клетки.set(куда(y), this.память.get(значение(x)) ?? 0);
          break;
        case 'IR.store_byte':
          this.память.set(значение(y), значение(x));
          break;
        case 'IR.store':
          this.память.set(значение(y), значение(x));
          break;
        case 'IR.arena_alloc': {
          const размер = значение(x);
          this.клетки.set(куда(y), this.указатель);
          this.указатель += размер;
          break;
        }
        case 'IR.jmp':
          pc = Number((носитель.operands[0] as { value?: number }).value);
          continue;
        case 'IR.jmp_if_not':
          if (значение(x) === 0) {
            pc = Number((носитель.operands[1] as { value?: number }).value);
            continue;
          }
          break;
        default:
          throw new Error(`модель: носитель «${носитель.mnemonic}» ей неизвестен — пропустить его нельзя`);
      }
      this.журнал.push(носитель.mnemonic);
      pc += 1;
    }
    return pc;
  }
}

const ТАБЛИЦА = 0x4000;
const БЛОБ = 0x1000;

/** Собрать поток [сайт, хвост, отказ арены] и исполнить его; вернуть модель и адрес результата. */
const прогнать = (
  текст: string,
  н: number,
  к: number,
  чужая?: Модель,
): { модель: Модель; адрес: number } => {
  const байты = Array.from(new TextEncoder().encode(текст));
  const сколько = codePointLength(текст);
  const опцииСайта = опции({
    blob: БЛОБ,
    blobBytes: байты.length,
    count: сколько,
    table: ТАБЛИЦА,
    loopIndex: STRING_SLICE_SITE_SIZE,
    refusalIndex: STRING_SLICE_SITE_SIZE + STRING_SLICE_TAIL_SIZE,
  });
  const сайт = stringSliceRuntimeSite(опцииСайта);
  const хвостОпции = {
    from: НАЧАЛО,
    to: КОНЕЦ,
    destination: ПРИЁМНИК,
    literals: ЛИТЕРАЛЫ,
    cells: ЯЧЕЙКИ,
    loopIndex: STRING_SLICE_SITE_SIZE,
    successor: STRING_SLICE_SITE_SIZE + STRING_SLICE_TAIL_SIZE + 1,
  };
  expect(() => checkStringSliceRuntimeSite(опцииСайта, [...РЕЗЕРВ]), 'сторож сайта молчит на верных клетках').not.toThrow();
  const хвост = stringSliceRuntimeTail(хвостОпции);
  expect(() => checkStringSliceRuntimeTail(хвост, хвостОпции), 'сторож хвоста молчит на верном хвосте').not.toThrow();
  const поток = [...сайт, ...хвост, а('IR.exit', [и(1)])] as never[];
  const модель =
    чужая ??
    new Модель(
      пул({ blob: БЛОБ, blobBytes: байты.length, count: сколько, table: ТАБЛИЦА }),
      0x200000,
      0x300000,
    );
  байты.forEach((значение, смещение) => модель.память.set(БЛОБ + смещение, значение));
  // ТАБЛИЦА ПРОДОЛЖЕНИЙ — как её строит рантайм: признак «байт ПРОДОЛЖЕНИЕ кодпоинта».
  for (let значение = 0; значение < 256; значение += 1) {
    модель.память.set(ТАБЛИЦА + значение, значение >= 0x80 && значение < 0xc0 ? 1 : 0);
  }
  модель.константы[1] = БЛОБ + байты.length;
  модель.константы[2] = сколько;
  модель.константы[3] = ТАБЛИЦА;
  модель.клетки.set(НАЧАЛО, н);
  модель.клетки.set(КОНЕЦ, к);
  const возврат = STRING_SLICE_SITE_SIZE + STRING_SLICE_TAIL_SIZE + 1;
  const финал = модель.исполнить(поток as never, возврат);
  expect(финал, 'поток обязан вернуться за вызов, а не провалиться в блок отказа').toBe(возврат);
  return { модель, адрес: модель.клетки.get(ПРИЁМНИК) ?? 0 };
};

describe('сайт Г: байты, арена, нормализация — исполняется САМ поток и сверяется с эталоном', () => {
  it('СОСТАВ: 33 носителя сайта и 21 хвост, петля — 17 носителей', () => {
    const сайт = stringSliceRuntimeSite(
      опции({ blob: БЛОБ, blobBytes: 12, count: 6, table: ТАБЛИЦА, loopIndex: STRING_SLICE_SITE_SIZE, refusalIndex: 100 }),
    );
    expect(сайт).toHaveLength(STRING_SLICE_SITE_SIZE);
    expect(stringSliceRuntimeTail({
      from: НАЧАЛО,
      to: КОНЕЦ,
      destination: ПРИЁМНИК,
      literals: ЛИТЕРАЛЫ,
      cells: ЯЧЕЙКИ,
      loopIndex: 0,
      successor: 1,
    })).toHaveLength(STRING_SLICE_TAIL_SIZE);
    expect(STRING_SLICE_TAIL_SIZE - 4).toBe(STRING_SLICE_COPY_LOOP_SIZE);
  });

  it('СРЕЗЫ: «бвг», «йк», пусто, край за концом, отрицательные края — БАЙТЫ И ДЛИНА', () => {
    const случаи: readonly (readonly [string, number, number])[] = [
      ['абвгде', 1, 4],
      ['ёжзийк', -2, 6],
      ['ёжзийк', 0, 99],
      ['ёжзийк', 3, 1],
      ['ёжзийк', -99, -99],
      ['🙂', 0, 1],
      ['абвгде', 99, 99],
      ['ёжзийк', 2, -2],
    ];
    for (const [текст, н, к] of случаи) {
      const { модель, адрес } = прогнать(текст, н, к);
      const эталон = codePointSlice(текст, н, к);
      const ожидаемые = Array.from(new TextEncoder().encode(эталон));
      const длина = модель.память.get(адрес - 16) ?? -1;
      expect(длина, `«${текст}»[${String(н)}..${String(к)}): число кодпоинтов`).toBe(codePointLength(эталон));
      expect(модель.байты(адрес, ожидаемые.length), `«${текст}»[${String(н)}..${String(к)}): байты`).toEqual(ожидаемые);
      expect(адрес % 8, 'дескриптор читается `ldd` — адрес обязан быть кратен восьми').toBe(0);
    }
  });

  it('ОТРИЦАТЕЛЬНЫЙ КРАЙ — ЭТО НЕ КОПИЯ БЕЗ НОРМАЛИЗАЦИИ: «абвгде» −2..6 даёт «де», а не байты по н = −2', () => {
    const { модель, адрес } = прогнать('абвгде', -2, 6);
    const ожидаемые = Array.from(new TextEncoder().encode('де'));
    expect(ожидаемые, '«де» — два кодпоинта ЧЕТЫРЬМЯ байтами').toHaveLength(4);
    expect(модель.память.get(адрес - 16), 'длина — ДВА кодпоинта').toBe(2);
    expect(модель.байты(адрес, ожидаемые.length)).toEqual(ожидаемые);
  });

  it('ВЫРАВНИВАНИЕ ДОКАЗАНО ВТОРЫМ ВЫДЕЛЕНИЕМ: 8 · (к − н) + 16 держит адрес кратным восьми', () => {
    const модель = new Модель([0, 0, 0, 0, 1, 16], 0x200000, 0x300000);
    const адреса: number[] = [];
    // ТРИ СРЕЗА ПО ТРИ КОДПОИНТА: 4 · 3 + 16 = 28 — не кратно восьми, и второе выделение уехало бы.
    for (let раз = 0; раз < 3; раз += 1) {
      const { адрес } = прогнать('абвгде', 0, 3, модель);
      адреса.push(адрес);
    }
    for (const адрес of адреса) {
      expect(адрес % 8, `адрес ${String(адрес)} кратен восьми`).toBe(0);
    }
    expect(адреса[1]! > адреса[0]!, 'второе выделение идёт ЗА первым').toBe(true);
    // ЦЕНА НАЗВАНА ЧИСЛОМ: между выделениями ровно 8 · 3 + 16 = 40 байт, а не 4 · 3 + 16 = 28.
    expect(адреса[1]! - адреса[0]!).toBe(8 * 3 + 16);
  });

  it('РАСКЛАДКА И ПАРЫ: сайт на носителях размещается ЦЕЛИКОМ, петля даёт пары без отказов', () => {
    const сайт = stringSliceRuntimeSite(
      опции({ blob: БЛОБ, blobBytes: 12, count: 6, table: ТАБЛИЦА, loopIndex: 4, refusalIndex: 4 + STRING_SLICE_SITE_SIZE }),
    );
    const поток = [...сайт, ...Array.from({ length: 6 }, () => а('IR.exit', [и(0)]))] as never[];
    const раскладка = layoutOf(поток, { constants: пул({ blob: БЛОБ, blobBytes: 12, count: 6, table: ТАБЛИЦА }) });
    expect(раскладка.unplaced, 'неразмещённых носителей быть не должно').toEqual([]);
    expect(раскладка.entries.length).toBe(поток.length);
    const пары = pairPredicates(поток);
    expect(пары.refusals, 'барьера из конкретных команд больше нет').toEqual([]);
  });

  it('СТОРОЖ САЙТА: ноль не та клетка, приёмник вне полосы, чужая роль и двойная роль', () => {
    const верные = опции({ blob: БЛОБ, blobBytes: 12, count: 6, table: ТАБЛИЦА, loopIndex: 33, refusalIndex: 54 });
    expect(() => checkStringSliceRuntimeSite(верные, [...РЕЗЕРВ])).not.toThrow();
    expect(() => checkStringSliceRuntimeSite({ ...верные, cells: { ...ЯЧЕЙКИ, zero: 3 } }, [...РЕЗЕРВ, НАЧАЛО])).toThrowError(/смещение/);
    expect(() => checkStringSliceRuntimeSite({ ...верные, destination: 3 }, [...РЕЗЕРВ, НАЧАЛО])).toThrowError(/ВНЕ полосы/);
    expect(() => checkStringSliceRuntimeSite({ ...верные, cells: { ...ЯЧЕЙКИ, byte: 20 } }, [...РЕЗЕРВ])).toThrowError(/reserved/);
    expect(() => checkStringSliceRuntimeSite({ ...верные, cells: { ...ЯЧЕЙКИ, flag: ARENA_POINTER_BASE } }, [...РЕЗЕРВ, 1])).toThrowError(
      /ЖИВОЕ состояние арены/,
    );
    expect(() => checkStringSliceRuntimeSite({ ...верные, cells: { ...ЯЧЕЙКИ, scratch: 8 } }, [...РЕЗЕРВ])).toThrowError(/ДВЕ роли/);
  });

  it('СТОРОЖ ХВОСТА: длина — ИЗ СЧЁТЧИКА, границы — нормализованные, цели переходов внутри', () => {
    const хвостОпции = {
      from: НАЧАЛО,
      to: КОНЕЦ,
      destination: ПРИЁМНИК,
      literals: ЛИТЕРАЛЫ,
      cells: ЯЧЕЙКИ,
      loopIndex: STRING_SLICE_SITE_SIZE,
      successor: STRING_SLICE_SITE_SIZE + STRING_SLICE_TAIL_SIZE,
    };
    const хвост = stringSliceRuntimeTail(хвостОпции);
    expect(() => checkStringSliceRuntimeTail(хвост, хвостОпции)).not.toThrow();
    // ДЛИНА НЕ ИЗ КРАЁВ: подмена слова длины на `to − from` (клетка `to`) обязана покраснеть.
    const подмена = хвост.map((носитель, номер) =>
      номер === хвост.length - 2 ? { ...носитель, operands: [р(КОНЕЦ), ...носитель.operands.slice(1)] } : носитель,
    );
    expect(() => checkStringSliceRuntimeTail(подмена, хвостОпции)).toThrowError(/НЕ из счётчика|разошёлся/);
    // ЦЕЛЬ ВНЕ МАССИВА (первый носитель за хвостом) — та самая слепота случая 78.
    const заМассивом = хвост.map((носитель, номер) =>
      номер === 1 ? { ...носитель, operands: [р(ЯЧЕЙКИ.key), и(9999)] } : носитель,
    );
    expect(() => checkStringSliceRuntimeTail(заМассивом, хвостОпции)).toThrowError(/ВНЕ хвоста/);
    // ПОСЛЕДНИЙ НОСИТЕЛЬ — возврат за вызов: сдвинутая цель обязана покраснеть.
    const безВозврата = [...хвост.slice(0, -1), а('IR.jmp', [и(1)])];
    expect(() => checkStringSliceRuntimeTail(безВозврата, хвостОпции)).toThrowError(/возврат ушёл бы не туда|разошёлся/);
  });

  it('ПЕТЛЯ: 17 носителей, оба выхода — на запись дескриптора, пропуск — ВНУТРИ петли', () => {
    const петля = stringSliceCopyLoopCarriers({
      loopIndex: 100,
      continuation: 117,
      source: ЯЧЕЙКИ.source,
      end: ЯЧЕЙКИ.end,
      target: ЯЧЕЙКИ.target,
      byte: ЯЧЕЙКИ.byte,
      flag: ЯЧЕЙКИ.flag,
      table: ЯЧЕЙКИ.table,
      scratch: ЯЧЕЙКИ.scratch,
      left: НАЧАЛО,
      rest: КОНЕЦ,
      copied: ЯЧЕЙКИ.copied,
      one: ЯЧЕЙКИ.one,
      zero: ЯЧЕЙКИ.zero,
      key: ЯЧЕЙКИ.key,
    });
    expect(петля).toHaveLength(STRING_SLICE_COPY_LOOP_SIZE);
    const цели = петля
      .filter((носитель) => носитель.mnemonic.startsWith('IR.jmp'))
      .map((носитель) => Number((носитель.operands[носитель.operands.length - 1] as { value?: number }).value));
    expect(цели, 'два выхода и один обратный переход').toEqual([117, 117, 115, 100]);
    for (const цель of цели) {
      expect(цель >= 100 && цель < 117 || цель === 117, `цель ${String(цель)} внутри петли или сразу за ней`).toBe(true);
    }
    expect(() =>
      stringSliceCopyLoopCarriers({
        loopIndex: 100,
        continuation: 117,
        source: ЯЧЕЙКИ.source,
        end: ЯЧЕЙКИ.end,
        target: ЯЧЕЙКИ.target,
        byte: ЯЧЕЙКИ.byte,
        flag: ЯЧЕЙКИ.flag,
        table: ЯЧЕЙКИ.table,
        scratch: ЯЧЕЙКИ.scratch,
        left: НАЧАЛО,
        rest: КОНЕЦ,
        copied: ЯЧЕЙКИ.copied,
        one: ЯЧЕЙКИ.one,
        zero: 3,
        key: ЯЧЕЙКИ.key,
      }),
    ).toThrowError(/смещение/);
  });
});
