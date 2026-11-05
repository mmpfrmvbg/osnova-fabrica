/**
 * O(n) ЦИКЛ КОПИРОВАНИЯ СТРОКИ: ФОРМА, ПАРА ПРЕДИКАТОВ, ИНДЕКС ВЫХОДА — БЕЗ НОВЫХ НОСИТЕЛЕЙ.
 *
 * # Что здесь утверждается и чем это ловится
 *
 * 1. **НОВЫХ НОСИТЕЛЕЙ НЕ ЗАВЕДЕНО — это ФАКТ, а не намерение.** У каждого носителя цикла либо есть
 *    форма у раскладки (`carrierFormOf`), либо это КОНКРЕТНАЯ команда (`ldb`/`stb`), которой раскладка
 *    пользуется и сегодня — развёрткой арены. Носителя с байтовой шириной в дереве НЕТ
 *    (`IR.load`/`IR.store` — восьмибайтные `ldd`/`std`), а вводить его значило бы тронуть живучесть и
 *    сопоставление предикатов — это ВНЕ границы, названной владельцем.
 *    НЕГАТИВНЫЙ КОНТРОЛЬ: у заведомо неизвестного носителя формы нет — значит проверка имеет зубы.
 * 2. **ДЛИНА ЦИКЛА ИЗВЕСТНА РАСКЛАДКЕ ЗАРАНЕЕ И БЕЗ ПЛОСКОСТИ (§3.135).** 88 байт: 8 (`IR.lt`) +
 *    16 (`IR.jmp_if_not`) + 8 (`ldb`) + 8 (`stb`) + 8 + 8 (`IR.add`) + 16 + 16 (`IR.jmp`). Число
 *    закреплено: по нему считается место хвоста потока, и «примерно» здесь означает уехавшие адреса.
 * 3. **ИНДЕКС ВЫХОДА — ПРОДОЛЖЕНИЕ.** Ветвь «скопировано всё» ведёт на ПОСЛЕДНИЙ носитель цикла
 *    (`loopIndex + 7`), а тот — на ИСХОДНЫЙ индекс носителя ЗА вызовом: пересчёт `expandCarriers`
 *    сдвинет его вместе с потоком. Провал в область отказов означал бы, что удачная копия печатает
 *    отказ. Различающий контроль: сдвиг `loopIndex` двигает ОБА перехода.
 * 4. **ПАРА ПРЕДИКАТОВ СОСТАВЛЯЕТСЯ, и ключ цикла обязан быть СВОИМ У КАЖДОГО ЦИКЛА — причина
 *    ИЗМЕРЕНА, и первое моё объяснение было НЕВЕРНЫМ.** Сначала здесь стояло «дерево не даёт двум
 *    сравнениям один ключ». Различающая проба это ОТВЕРГЛА: две пары `IR.lt`+`IR.jmp_if_not` с ОДНИМ
 *    ключом и БЕЗ команд байта между ними дают **две** пары. Отказ появляется, когда между сравнениями
 *    стоят КОНКРЕТНЫЕ `ldb`/`stb`: они разбору регистров (`predicatePairing#registersOf`) НЕИЗВЕСТНЫ
 *    (`known: false` — он знает НОСИТЕЛИ `IR.load`/`IR.store`, но не конкретные команды), а неизвестный
 *    носитель — **БАРЬЕР**: окно «следующий писатель ключа» не закрывается на втором сравнении, в окно
 *    попадает и переход ВТОРОГО цикла, и первое сравнение получает двух читателей-переходов вместо
 *    одного. Итог: пара не составляется, первый переход получает НАЗВАННЫЙ отказ `OSN-LOW-004`.
 *    Отсюда правило САЙТА (а не формы): **своя клетка ключа на каждый цикл** — тогда срез откажет по
 *    имени, а не соврёт.
 * 5. **ЖИВУЧЕСТЬ ЗНАЕТ НОСИТЕЛИ ЦИКЛА.** `IR.lt`/`IR.add`/`IR.jmp*` названы в разборе регистров.
 *    У КОНКРЕТНЫХ `ldb`/`stb` действует ОБЩЕЕ правило дерева: операнд[0] считается записываемым (у
 *    `ldb` это база, у `stb` — значение). Это НЕ новая неточность: ровно так же выглядит развёртка
 *    арены (`stringArenaCopyInstructions`), и здесь она безвредна ровно потому, что клетки цикла
 *    ЗАКРЕПЛЯЮТСЯ за рантаймом: раскладчик их не двигает и не вытесняет. **Закрепление — работа
 *    САЙТА**; цикл своих клеток не выбирает (роли приходят параметрами) — это проверяется ниже.
 * 6. **МЕХАНИЗМ ЗАКРЕПЛЕНИЯ ИЗМЕРЕН, И ОН ТОТ ЖЕ, ЧТО У ЦИКЛА КОЛЛЕКЦИЙ.** Клетки обязаны лежать либо
 *    в полосе `RESERVED_REGISTERS` (`src/e2k/regAlloc.ts` — `%b[10..15]`: раскладка не отдаёт их
 *    НИКОГДА и ни в какой плоскости), либо быть объявленными УСЛОВНО — списком вида
 *    `collectionReservedRegisters()`, который доезжает до `regAlloc.reserved`
 *    (`src/e2k/regAlloc.ts:430/508/672`) через `src/e2k/programImage.ts`. Отсюда ответ на вопрос
 *    владельца: **`stringCopyLoopCarriers` НЕ обязан возвращать закреплённые регистры** — номера
 *    клеток выбирает САЙТ, а форма от них не зависит (это и проверяется ниже).
 */
import { describe, expect, it } from 'vitest';
import { getEncoder } from './backend';
import { defUseOf } from './liveness';
import { pairPredicates } from './predicatePairing';
import { RESERVED_REGISTERS, allocateProgram } from './regAlloc';
import { carrierFormOf } from './twoPassLayout';
import {
  STRING_COPY_LOOP_SIZE,
  checkStringCopyLoopCells,
  checkStringCopyLoopRoles,
  stringCopyLoopCarriers,
} from './stringRuntime';

const encoder = getEncoder('e2k');

/** Размер КОНКРЕТНОЙ команды — тем же кодировщиком, которым её закодирует цель. */
const encodedBytes = (instruction: { mnemonic: string; channel: number; operands: readonly unknown[] }): number =>
  encoder.encode(instruction as never).length;

/** Роли цикла — любые клетки: цикл их не выбирает, и это тоже утверждение (владелец клеток — САЙТ). */
const РОЛИ = { source: 1, end: 2, target: 3, byte: 4, one: 5, zero: 6, key: 7 } as const;

const цикл = (loopIndex: number, continuation: number, роли: Partial<typeof РОЛИ> = {}) =>
  stringCopyLoopCarriers({ loopIndex, continuation, ...РОЛИ, ...роли });

describe('O(n) цикл копирования строки: восемь носителей, новых форм нет', () => {
  it('СОСТАВ И ИНДЕКСЫ: вход — назад на начало, выход — продолжение за вызовом', () => {
    const loop = цикл(100, 42);
    expect(loop.map((carrier) => carrier.mnemonic)).toEqual([
      'IR.lt',
      'IR.jmp_if_not',
      'ldb', // КОНКРЕТНАЯ команда: байтового НОСИТЕЛЯ памяти в дереве нет
      'stb',
      'IR.add',
      'IR.add',
      'IR.jmp',
      'IR.jmp',
    ]);
    expect(loop).toHaveLength(STRING_COPY_LOOP_SIZE);
    // Ветвь выхода ведёт на ПОСЛЕДНИЙ носитель цикла (он же — переход за цикл), а не в середину.
    expect(loop[1]?.operands[1], 'ветвь «скопировано всё»').toEqual({ kind: 'imm', value: 107 });
    expect(loop[6]?.operands[0], 'обратный переход — на первый носитель').toEqual({ kind: 'imm', value: 100 });
    expect(loop[7]?.operands[0], 'выход — на ПРОДОЛЖЕНИЕ по исходному индексу').toEqual({ kind: 'imm', value: 42 });
    // РАЗЛИЧАЮЩИЙ КОНТРОЛЬ: индексы ЧИТАЮТСЯ, а не зашиты. Сдвиг начала двигает и ветвь выхода.
    const сдвинутый = цикл(200, 77);
    expect(сдвинутый[1]?.operands[1]).toEqual({ kind: 'imm', value: 207 });
    expect(сдвинутый[6]?.operands[0]).toEqual({ kind: 'imm', value: 200 });
    expect(сдвинутый[7]?.operands[0]).toEqual({ kind: 'imm', value: 77 });
  });

  it('РАСКЛАДКА ЗНАЕТ ЦИКЛ ЦЕЛИКОМ: 88 байт, и это сумма форм, а не догадка', () => {
    const loop = цикл(100, 42);
    const БЕЗ_ФОРМЫ = ['ldb', 'stb'];
    const по_формам: number[] = [];
    const без_формы: string[] = [];
    for (const carrier of loop) {
      const form = carrierFormOf(carrier as never);
      if (form === undefined) {
        без_формы.push(carrier.mnemonic);
        continue;
      }
      по_формам.push(form.commands.reduce((sum, command) => sum + command.size, 0));
    }
    // Форму обязаны иметь ВСЕ носители, кроме КОНКРЕТНЫХ команд байта: их раскладка кодирует тем же
    // путём, что и развёртку арены (`printCommandForm`), а не формой носителя.
    expect(без_формы, 'новых носителей не заведено: без формы — ровно конкретные команды байта').toEqual(БЕЗ_ФОРМЫ);
    const конкретные = loop.filter((carrier) => БЕЗ_ФОРМЫ.includes(carrier.mnemonic));
    const байт = конкретные.reduce((sum, carrier) => sum + encodedBytes(carrier as never), 0);
    expect(байт, 'байт и его запись кодируются в 8 байт каждый').toBe(16);
    expect(по_формам.reduce((sum, size) => sum + size, 0) + байт, 'длина цикла известна раскладке').toBe(88);
    /*
     * НЕГАТИВНЫЙ КОНТРОЛЬ: у носителя, которого дерево не знает, формы НЕТ. Без него «формы есть у всех»
     * было бы неотличимо от «функция формы всегда что-то возвращает».
     */
    expect(carrierFormOf({ mnemonic: 'IR.string_copy_loop', channel: 0, operands: [] } as never)).toBeUndefined();
  });

  it('ПАРА ПРЕДИКАТОВ: причина отказа — БАРЬЕР команд байта, и ключ цикла обязан быть своим', () => {
    const pairing = pairPredicates(цикл(100, 42) as never);
    expect(pairing.refusals, 'причина отказа обязана молчать').toEqual([]);
    expect(pairing.pairs, 'сравнение указателей обязано стать парой').toHaveLength(1);
    expect(pairing.pairs[0]?.cmpMnemonic).toBeDefined();
    /*
     * РАЗЛИЧАЮЩАЯ ПРОБА — она и отвергла первое объяснение («дерево не даёт двум сравнениям один
     * ключ»). Две пары с ОДНИМ ключом и БЕЗ команд байта между ними дают ДВЕ пары: значит общий ключ
     * сам по себе не мешает.
     */
    const r = (index: number): { kind: 'reg'; index: number } => ({ kind: 'reg', index });
    const i = (value: number): { kind: 'imm'; value: number } => ({ kind: 'imm', value });
    const к = (mnemonic: string, operands: readonly unknown[]) => ({ mnemonic, channel: 0, operands });
    const безБайта = pairPredicates([
      к('IR.lt', [r(7), r(1), r(2)]),
      к('IR.jmp_if_not', [r(7), i(90)]),
      к('IR.lt', [r(7), r(3), r(4)]),
      к('IR.jmp_if_not', [r(7), i(90)]),
    ] as never);
    expect(безБайта.pairs, 'общий ключ БЕЗ команд байта — две пары').toHaveLength(2);
    expect(безБайта.refusals, 'и ни одного отказа').toEqual([]);
    // Тот же поток, но между сравнениями вставлены КОНКРЕТНЫЕ `ldb`/`stb` — и пара рвётся: это БАРЬЕР
    // (`registersOf` знает носители `IR.load`/`IR.store`, но не конкретные команды), а не каприз ключа.
    const сБайтом = pairPredicates([
      к('IR.lt', [r(7), r(1), r(2)]),
      к('IR.jmp_if_not', [r(7), i(90)]),
      к('ldb', [r(1), r(6), r(4)]),
      к('stb', [r(4), r(3), r(6)]),
      к('IR.lt', [r(7), r(3), r(4)]),
      к('IR.jmp_if_not', [r(7), i(90)]),
    ] as never);
    expect(сБайтом.pairs, 'с барьером пара остаётся только у ПОСЛЕДНЕГО сравнения').toHaveLength(1);
    expect(сБайтом.refusals, 'первый переход получает НАЗВАННЫЙ отказ').toHaveLength(1);
    expect(сБайтом.refusals[0]?.code, 'личность отказа — раскладка').toBe('OSN-LOW-004');
    // ДВА цикла с РАЗНЫМИ ключами — ДВЕ пары: «первая съела вторую» не происходит.
    const разные = pairPredicates([...цикл(100, 42, { key: 7 }), ...цикл(108, 42, { key: 9 })] as never);
    expect(разные.refusals).toEqual([]);
    expect(разные.pairs).toHaveLength(2);
    // А с ОДНИМ ключом — названный отказ, и достаётся он первому переходу: граница САЙТА, закреплённая
    // здесь, чтобы её не «починили» тишиной.
    const общий = pairPredicates([...цикл(100, 42), ...цикл(108, 42)] as never);
    expect(общий.pairs).toHaveLength(1);
    expect(общий.refusals).toHaveLength(1);
    expect(общий.refusals[0]?.code, 'личность отказа — раскладка').toBe('OSN-LOW-004');
    expect(общий.refusals[0]?.reason, 'в причине назван носитель').toContain('IR.jmp_if_not');
  });

  it('ЗАКРЕПЛЕНИЕ КЛЕТОК: механизм тот же, что у цикла коллекций — форма его не несёт', () => {
    /*
     * Полоса `%b[10..15]` не отдаётся раскладкой НИКОГДА — значит роли цикла из этой полосы не требуют
     * ни одного объявления. Всё, что вне её (регистры окна), обязано быть объявлено УСЛОВНО списком
     * (`regAlloc.reserved`), как у коллекций: `collectionReservedRegisters()`. Носители цикла регистров
     * не выбирают — номера приходят параметрами, поэтому закрепление остаётся работой САЙТА.
     */
    expect(RESERVED_REGISTERS, 'полоса рантайма: раскладка её не отдаёт').toEqual([10, 11, 12, 13, 14, 15]);
    const изПолосы = stringCopyLoopCarriers({
      loopIndex: 0,
      continuation: 9,
      source: 10,
      end: 11,
      target: 12,
      byte: 13,
      one: 14,
      zero: 15,
      key: 12,
    });
    for (const carrier of изПолосы) {
      for (const operand of carrier.operands) {
        if (typeof operand === 'object' && operand !== null && (operand as { kind?: string }).kind === 'reg') {
          const index = (operand as { index: number }).index;
          expect(RESERVED_REGISTERS.includes(index), `клетка %b[${String(index)}] обязана быть закреплена`).toBe(true);
        }
      }
    }
    // И обратная сторона: клетка вне полосы закреплена НЕ будет — её обязан объявить САЙТ.
    expect(RESERVED_REGISTERS.includes(8), 'регистр окна вне полосы: без объявления сайта не закреплён').toBe(false);
  });

  it('ЖИВУЧЕСТЬ: носители цикла названы, у конкретных команд — общее правило дерева', () => {
    const loop = цикл(100, 42);
    expect([...defUseOf(loop[0] as never).def], 'сравнение пишет ключ').toEqual([РОЛИ.key]);
    expect([...defUseOf(loop[0] as never).use], 'сравнение читает указатели').toEqual([РОЛИ.source, РОЛИ.end]);
    expect([...defUseOf(loop[1] as never).use], 'переход читает ключ').toEqual([РОЛИ.key]);
    expect([...defUseOf(loop[4] as never).def], 'шаг пишет указатель').toEqual([РОЛИ.source]);
    expect([...defUseOf(loop[4] as never).use], 'шаг читает указатель и единицу').toEqual([РОЛИ.source, РОЛИ.one]);
    /*
     * КОНКРЕТНЫЕ КОМАНДЫ БАЙТА — ОБЩЕЕ ПРАВИЛО ДЕРЕВА: операнд[0] считается записываемым. У `ldb` это
     * БАЗА (читается), у `stb` — ЗНАЧЕНИЕ (читается). Ровно так же выглядит развёртка арены, и это
     * записано здесь ЧИСЛОМ, а не спрятано: циклу безвредно, пока клетки цикла закреплены за рантаймом
     * (работа САЙТА), — тогда раскладчик их не двигает и не вытесняет.
     */
    expect([...defUseOf(loop[2] as never).def], 'ldb: операнд[0] (база) — по общему правилу').toEqual([РОЛИ.source]);
    expect([...defUseOf(loop[2] as never).use], 'ldb: смещение и приёмник').toEqual([РОЛИ.zero, РОЛИ.byte]);
    expect([...defUseOf(loop[3] as never).def], 'stb: операнд[0] (значение) — по общему правилу').toEqual([РОЛИ.byte]);
    expect([...defUseOf(loop[3] as never).use], 'stb: приёмник и смещение').toEqual([РОЛИ.target, РОЛИ.zero]);
  });

  it('РОЛИ ПРИХОДЯТ ПАРАМЕТРАМИ: цикл своих клеток не выбирает — это работа сайта', () => {
    // Другой набор клеток — те же носители и та же длина: значит цикл не «зашит» под конкретные номера.
    const другие = stringCopyLoopCarriers({
      loopIndex: 0,
      continuation: 9,
      source: 21,
      end: 22,
      target: 23,
      byte: 24,
      one: 25,
      zero: 26,
      key: 27,
    });
    expect(другие.map((carrier) => carrier.mnemonic)).toEqual(цикл(0, 9).map((carrier) => carrier.mnemonic));
    expect(другие[0]?.operands).toEqual([
      { kind: 'reg', index: 27 },
      { kind: 'reg', index: 21 },
      { kind: 'reg', index: 22 },
    ]);
    expect(другие[2]?.operands).toEqual([
      { kind: 'reg', index: 21 },
      { kind: 'reg', index: 26 },
      { kind: 'reg', index: 24 },
    ]);
  });

  it('НЕПОЛНАЯ ИЛИ НЕЧИСЛОВАЯ РОЛЬ — НАЗВАННЫЙ ОТКАЗ, а не операнд без номера', () => {
    /*
     * Замер 2026-11-06 (`.tmp/string-copy-loop-трасса.ts`): вызов из JS/дата-файла МИМО типов проходил
     * молча, построитель выдавал `{kind:'reg'}` без номера, и такой поток уезжал в раскладку, которая
     * переназначала клетки. Тип ловит пропуск только у вызова из TypeScript — поэтому отказ живёт в
     * САМОМ построителе.
     */
    const безРоли = { loopIndex: 0, continuation: 9, ...РОЛИ } as Record<string, unknown>;
    for (const имя of ['source', 'end', 'target', 'byte', 'one', 'zero', 'key']) {
      const испорченный = { ...безРоли };
      delete испорченный[имя];
      expect(
        () => stringCopyLoopCarriers(испорченный as never),
        `пропущенная роль «${имя}» обязана отказать по имени`,
      ).toThrowError(new RegExp(`«${имя}»`));
    }
    // НЕ ЧИСЛО — тоже отказ: строка, NaN, дробное, отрицательное.
    for (const [значение, что] of [
      ['7', 'строка'],
      [Number.NaN, 'NaN'],
      [1.5, 'дробное'],
      [-1, 'отрицательное'],
    ] as const) {
      expect(
        () => stringCopyLoopCarriers({ loopIndex: 0, continuation: 9, ...РОЛИ, source: значение } as never),
        `роль-${что} обязана отказать`,
      ).toThrowError(/«source»/);
    }
    // ГРАНИЦА РЕГИСТРОВОГО ФАЙЛА: `%b[999]` не проходит молча — иначе чужая клетка уехала бы в байты.
    expect(
      () => stringCopyLoopCarriers({ loopIndex: 0, continuation: 9, ...РОЛИ, byte: 999 }),
      'клетка вне регистрового файла',
    ).toThrowError(/вне 0\.\.31/);
    expect(
      () => stringCopyLoopCarriers({ loopIndex: 0, continuation: 9, ...РОЛИ, byte: 32 }),
      'ровно за границей — тоже отказ',
    ).toThrowError(/вне 0\.\.31/);
    expect(() => stringCopyLoopCarriers({ loopIndex: 0, continuation: 9, ...РОЛИ, byte: 31 }), '31 — крайняя допустимая').not.toThrow();
    expect(() => stringCopyLoopCarriers({ loopIndex: -1, continuation: 9, ...РОЛИ }), 'индекс вне потока').toThrowError(/loopIndex/);
    expect(() => stringCopyLoopCarriers({ loopIndex: 0, continuation: -2, ...РОЛИ }), 'продолжение вне потока').toThrowError(/continuation/);
  });

  it('СТОРОЖ ВЫБОРА РОЛЕЙ: полоса или reserved — иначе отказ (D24)', () => {
    const карта = { loopIndex: 0, continuation: 9, source: 8, end: 9, target: 10, byte: 11, one: 13, zero: 12, key: 14 };
    // Карта сайта целиком законна: 5 ролей в полосе, 2 объявлены.
    expect(() => checkStringCopyLoopRoles(карта, [8, 9]), 'полоса + объявление').not.toThrow();
    // НЕ объявленная клетка окна — отказ, и в причине НАЗВАНЫ и роль, и клетка.
    expect(() => checkStringCopyLoopRoles(карта, [9]), 'source = %b[8] не объявлен').toThrowError(/«source» = %b\[8\]/);
    expect(() => checkStringCopyLoopRoles(карта, []), 'обе клетки окна не объявлены').toThrowError(/«source» = %b\[8\], «end» = %b\[9\]/);
    // Клетка в полосе объявления не требует — это и есть «полоса, которую раскладка не отдаёт никогда».
    expect(() => checkStringCopyLoopRoles({ ...карта, source: 10, end: 11 }, []), 'всё в полосе').not.toThrow();
  });

  it('СТОРОЖ СБОРКИ: роли, переназначенные раскладкой, краснят — цикл ставится ПОСЛЕ раскладки (D24)', () => {
    const карта = { loopIndex: 0, continuation: 9, source: 8, end: 9, target: 10, byte: 11, one: 13, zero: 12, key: 14 };
    const образ = stringCopyLoopCarriers(карта);
    expect(() => checkStringCopyLoopCells(образ, карта), 'нерушимый поток проходит').not.toThrow();
    /*
     * РАЗЛИЧАЮЩИЙ КОНТРОЛЬ — ровно тот случай, который владелец назвал «вставили до раскладки».
     * Замер 2026-11-06: `allocateProgram` переназначает КАЖДУЮ записанную клетку (14→3, 8→0, 10→1, 11→2)
     * и не трогает читаемые (9, 12, 13), причём `reserved` этого не предотвращает — он это и вызывает.
     */
    const поток = [
      { mnemonic: 'IR.const', channel: 0, operands: [{ kind: 'vreg', index: 1 }, { kind: 'imm', value: 1 }, { kind: 'imm', value: 0 }] },
      { mnemonic: 'IR.ret', channel: 0, operands: [{ kind: 'imm', value: 1 }, { kind: 'vreg', index: 1 }] },
      ...образ,
    ];
    const раскладка = allocateProgram(поток as never, [{ name: 'главная', codeOffset: 0, vregs: 2 }], {
      reserved: [карта.source, карта.end],
    });
    expect(раскладка.report[0]?.ok, 'раскладка обязана пройти: она не знает, что это сайт').toBe(true);
    const послеРаскладки = раскладка.instructions.slice(-образ.length);
    expect(
      послеРаскладки.map((carrier) => carrier.operands),
      'контроль обязан РАЗЛИЧАТЬ: если операнды не изменились, сторож — пустышка',
    ).not.toEqual(образ.map((carrier) => carrier.operands));
    expect(
      () => checkStringCopyLoopCells(послеРаскладки, карта),
      'сторож обязан покраснеть на переназначенных клетках',
    ).toThrowError(/клетки переназначены/);
    // И он же различает ЧУЖУЮ правку роли: одна клетка заменена — отказ, а не молчание.
    const подмена = образ.map((carrier, номер) => (номер === 3 ? { ...carrier, operands: [{ kind: 'reg', index: 15 }, { kind: 'reg', index: 10 }, { kind: 'reg', index: 12 }] } : carrier));
    expect(() => checkStringCopyLoopCells(подмена, карта), 'подмена клетки приёмника').toThrowError(/клетки переназначены/);
  });
});
