/**
 * НОСИТЕЛИ БАЙТОВОГО ДОСТУПА `IR.load_byte`/`IR.store_byte`: ФОРМА, РАЗМЕЩЕНИЕ, ЖИВОСТЬ, ПОНИЖЕНИЕ.
 *
 * # Зачем они заведены (измерено, а не для полноты)
 *
 * `docs/verification-debt.md`, случай 78 + решение владельца D26b. Конкретные команды байта
 * (`ldb`/`stb`) в потоке:
 *
 * 1. **НЕ РАЗМЕЩАЮТСЯ.** `layoutOf` кладёт их в `unplaced` («не носитель IR: раскладка идёт по потоку
 *    носителей оболочки»), а `src/e2k/programImage.ts#imageOfCarriers` берёт неразмещённый носитель как
 *    ОТКАЗ — цикл рантайм-среза из них не подключается ВООБЩЕ (замер: 8 носителей цикла — размещено 6,
 *    байт 72 из 88).
 * 2. **НЕИЗВЕСТНЫ РАЗБОРУ ЖИВОСТИ.** `src/e2k/predicatePairing.ts#registersOf` знает `IR.load`/`IR.store`,
 *    но не конкретные команды, а неизвестный носитель — БАРЬЕР: сторож ребра взятого перехода отказывает
 *    («между переходом #1 и его целью #7 стоит «ldb» с неизвестными операндами»).
 *
 * Поэтому здесь проверяется ОБЕ стороны: носитель размещается, разбор живости его знает, понижение даёт
 * ровно `ldb`/`stb`, а тот же цикл, собранный НА НОСИТЕЛЯХ, размещается целиком (88 байт) и не даёт ни
 * одного отказа — тогда как тот же цикл с конкретными командами даёт 2 неразмещённых и 1 отказ.
 *
 * НЕГАТИВНЫЕ КОНТРОЛИ: у заведомо неизвестного носителя формы нет (иначе «форма есть у всех» было бы
 * неотличимо от «функция формы всегда что-то возвращает»); понижение отвергает носитель с операндами не
 * той формы НАЗВАННОЙ причиной.
 *
 * Чего здесь НЕТ: правки самого цикла среза (он всё ещё собирается конкретными командами — это переделка
 * сайта, шаг 4 порядка владельца) и правки `src/e2k/liveness.ts` (запрещена владельцем: носители
 * вставляются ПОСЛЕ раскладки, D24).
 */
import { describe, expect, it } from 'vitest';
import { getEncoder } from './backend';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { lowerCarrier } from './e2kRealRun';
import {
  LOAD_BYTE_CARRIER,
  STORE_BYTE_CARRIER,
  loadByteInstructions,
  storeByteInstructions,
} from './memoryAccess';
import { pairPredicates, registersOf } from './predicatePairing';
import { stringCopyLoopCarriers } from './stringRuntime';
import { carrierFormOf, layoutOf } from './twoPassLayout';

const encoder = getEncoder('e2k');
const reg = (index: number) => ({ kind: 'reg' as const, index });
const imm = (value: number) => ({ kind: 'imm' as const, value });
const носитель = (mnemonic: string, operands: readonly unknown[]) => ({ mnemonic, channel: 0, operands });

const РОЛИ = { source: 1, end: 2, target: 3, byte: 4, one: 5, zero: ARRAY_REGISTERS.zero, key: 7 } as const;

/**
 * ЦИКЛ КОНКРЕТНЫМИ КОМАНДАМИ — РАЗЛИЧАЮЩИЙ КОНТРОЛЬ случая 78 (носителей байта в дереве не было).
 *
 * Роли те же, что у {@link циклНаНосителях}, и порядок тот же: различие ровно в байтовом доступе, иначе
 * сравнение чисел доказывало бы что-то другое.
 */
const цикл = (loopIndex: number, continuation: number, роли: Partial<typeof РОЛИ> = {}) => {
  const р = { ...РОЛИ, ...роли };
  return [
    носитель('IR.lt', [reg(р.key), reg(р.source), reg(р.end)]),
    носитель('IR.jmp_if_not', [reg(р.key), imm(loopIndex + 7)]),
    носитель('ldb', [reg(р.source), reg(р.zero), reg(р.byte)]),
    носитель('stb', [reg(р.byte), reg(р.target), reg(р.zero)]),
    носитель('IR.add', [reg(р.source), reg(р.source), reg(р.one)]),
    носитель('IR.add', [reg(р.target), reg(р.target), reg(р.one)]),
    носитель('IR.jmp', [imm(loopIndex)]),
    носитель('IR.jmp', [imm(continuation)]),
  ];
};

/**
 * ТОТ ЖЕ ЦИКЛ, НО БАЙТОВЫЙ ДОСТУП — НОСИТЕЛЯМИ: ровно то, чего требует D26b.
 *
 * Роли операндов переводит САМ построитель: `ldb [база, индекс, приёмник]` → `IR.load_byte [адрес,
 * приёмник]`, `stb [значение, база, индекс]` → `IR.store_byte [значение, адрес]` — смещение у носителя
 * впаяно нулевой клеткой рантайма массивов, как у `IR.load`/`IR.store`.
 */
const циклНаНосителях = (loopIndex: number, continuation: number, роли: Partial<typeof РОЛИ> = {}) =>
  stringCopyLoopCarriers({ loopIndex, continuation, ...РОЛИ, ...роли });

describe('носители байтового доступа: форма и байты сходятся у одного источника', () => {
  it('форма — 8 байт у обоих, и столько же даёт кодировщик', () => {
    for (const [carrier, команда] of [
      [носитель(LOAD_BYTE_CARRIER, [reg(10), reg(15)]), 'ldb'],
      [носитель(STORE_BYTE_CARRIER, [reg(13), reg(12)]), 'stb'],
    ] as const) {
      const form = carrierFormOf(carrier as never);
      expect(form, `${carrier.mnemonic}: форма обязана быть`).toBeDefined();
      expect(form!.commands.map((command) => command.mnemonic), 'форма — ровно та команда, что понижает').toEqual([
        команда,
      ]);
      expect(form!.commands.reduce((sum, command) => sum + command.size, 0), 'объявлено 8 байт').toBe(8);
    }
    // Кодировщик — независимая сторона: он меряет БАЙТЫ, а раскладка объявляет форму.
    expect(
      encoder.encode(loadByteInstructions(10, 15)[0] as never).length,
      'ldb у кодировщика',
    ).toBe(8);
    expect(
      encoder.encode(storeByteInstructions(13, 12)[0] as never).length,
      'stb у кодировщика',
    ).toBe(8);
  });

  it('РАСКЛАДКА РАЗМЕЩАЕТ оба носителя; НЕГАТИВНЫЙ КОНТРОЛЬ: неизвестный — нет', () => {
    const раскладка = layoutOf([
      носитель(LOAD_BYTE_CARRIER, [reg(10), reg(15)]),
      носитель(STORE_BYTE_CARRIER, [reg(13), reg(12)]),
    ] as never);
    expect(раскладка.unplaced, 'неразмещённых быть не должно — это и есть смысл носителя').toEqual([]);
    expect(раскладка.totalBytes, 'два носителя по 8 байт').toBe(16);
    const чужой = layoutOf([носитель('IR.load_byte_unknown', [reg(10), reg(15)])] as never);
    expect(чужой.unplaced.map((item) => item.carrier), 'у неизвестного формы нет').toEqual(['IR.load_byte_unknown']);
    expect(чужой.unplaced[0]?.reason, 'и причина названа именем носителя').toContain('IR.load_byte_unknown');
    // …а у КОНКРЕТНОЙ команды причина другая, и она-то и есть порча из случая 78: неразмещённая команда
    // без носителя. Обе причины обязаны быть РАЗНЫМИ — иначе «не размещено» неотличимо от «носителя нет».
    const команда = layoutOf([носитель('ldb', [reg(10), reg(6), reg(15)])] as never);
    expect(команда.unplaced.map((item) => item.carrier)).toEqual(['ldb']);
    expect(команда.unplaced[0]?.reason, 'конкретная команда — «не носитель IR»').toContain('не носитель IR');
  });

  it('РАЗБОР ЖИВОСТИ ЗНАЕТ ИХ: адрес читается, приёмник пишется, запись не пишет ничего', () => {
    expect(registersOf(носитель(LOAD_BYTE_CARRIER, [reg(10), reg(15)]) as never)).toEqual({
      known: true,
      reads: [10],
      writes: [15],
    });
    expect(registersOf(носитель(STORE_BYTE_CARRIER, [reg(13), reg(12)]) as never)).toEqual({
      known: true,
      reads: [13, 12],
      writes: [],
    });
    // НЕГАТИВНЫЙ КОНТРОЛЬ: конкретная команда тому же разбору неизвестна — иначе ветви выше не доказывали
    // бы ничего (они бы «работали» при любом носителе).
    expect(registersOf(носитель('ldb', [reg(10), reg(6), reg(15)]) as never).known, 'конкретная команда').toBe(false);
  });

  it('ПОНИЖЕНИЕ даёт ровно `ldb`/`stb` с нулевой клеткой; НЕГАТИВНЫЙ КОНТРОЛЬ: чужая форма — отказ', () => {
    const чтение = lowerCarrier(носитель(LOAD_BYTE_CARRIER, [reg(10), reg(15)]) as never);
    expect(чтение.ok).toBe(true);
    expect(чтение.ok ? чтение.instructions : []).toEqual([
      { mnemonic: 'ldb', channel: 0, operands: [reg(10), reg(ARRAY_REGISTERS.zero), reg(15)] },
    ]);
    const запись = lowerCarrier(носитель(STORE_BYTE_CARRIER, [reg(13), reg(12)]) as never);
    expect(запись.ok).toBe(true);
    expect(запись.ok ? запись.instructions : []).toEqual([
      { mnemonic: 'stb', channel: 2, operands: [reg(13), reg(12), reg(ARRAY_REGISTERS.zero)] },
    ]);
    const кривой = lowerCarrier(носитель(LOAD_BYTE_CARRIER, [imm(1), reg(15)]) as never);
    expect(кривой.ok, 'литерал вместо адреса').toBe(false);
    expect(кривой.ok ? '' : кривой.reason, 'причина названа формой операндов').toContain('ожидались два регистра');
  });
});

describe('случай 78: цикл, собранный НА НОСИТЕЛЯХ, размещается и не даёт отказов', () => {
  it('РАСКЛАДКА: 88 байт, ноль неразмещённых — против 72 и двух у конкретных команд', () => {
    const наНосителях = layoutOf(циклНаНосителях(0, 42) as never);
    expect(наНосителях.unplaced, 'носители байта размещены').toEqual([]);
    expect(наНосителях.entries, 'все восемь носителей').toHaveLength(8);
    // 8 (IR.lt) + 16 (IR.jmp_if_not) + 8 (ldb) + 8 (stb) + 8 + 8 (IR.add) + 16 + 16 (IR.jmp) = 88.
    expect(наНосителях.totalBytes, 'длина цикла, которую теперь знает раскладка').toBe(88);
    // РАЗЛИЧАЮЩИЙ КОНТРОЛЬ: тот же цикл конкретными командами — 72 байта и две потерянные команды.
    const конкретными = layoutOf(цикл(0, 42) as never);
    expect(конкретными.unplaced.map((item) => item.carrier)).toEqual(['ldb', 'stb']);
    expect(конкретными.totalBytes).toBe(72);
  });

  it('ПАРА ПРЕДИКАТОВ: ноль отказов и своя клетка ключа на каждый переход', () => {
    const pairing = pairPredicates(циклНаНосителях(0, 42) as never);
    expect(pairing.refusals, 'сторож ребра взятого перехода молчит: операнды байта ИЗВЕСТНЫ').toEqual([]);
    expect(pairing.pairs).toHaveLength(1);
    // РАЗЛИЧАЮЩИЙ КОНТРОЛЬ: конкретными командами тот же цикл отказывает — причина названа.
    const конкретными = pairPredicates(цикл(0, 42) as never);
    expect(конкретными.refusals).toHaveLength(1);
    expect(конкретными.refusals[0]?.reason).toContain('ldb');
    // ДВА цикла с РАЗНЫМИ ключами на носителях — две пары И ноль отказов: правило «своя клетка ключа на
    // каждый переход» остаётся в силе, но барьера конкретных команд больше нет.
    const два = pairPredicates([
      ...циклНаНосителях(0, 42, { key: 7 }),
      ...циклНаНосителях(8, 42, { key: 9 }),
    ] as never);
    expect(два.pairs).toHaveLength(2);
    expect(два.refusals).toEqual([]);
    // А с ОДНИМ ключом — и это ИЗМЕРЕНО, а не предположено: барьера конкретных команд больше нет, и
    // общий ключ пар НЕ рвёт: каждое сравнение ПИШЕТ свою клетку ключа (`IR.lt` пишет операнд[0]),
    // поэтому окно живости первого закрывается на втором сравнении и читатель у него ровно один.
    // Прежний отказ («условие пришло не из сравнения») держался ИМЕННО на неизвестных `ldb`/`stb` —
    // это и есть измеренная граница случая 78, а не свойство ключа.
    const общийКлюч = pairPredicates([...циклНаНосителях(0, 42), ...циклНаНосителях(8, 42)] as never);
    expect(общийКлюч.pairs, 'общий ключ на носителях — обе пары').toHaveLength(2);
    expect(общийКлюч.refusals).toEqual([]);
    // РАЗЛИЧАЮЩИЙ КОНТРОЛЬ: тот же поток с конкретными командами — пара у первого сравнения ТЕРЯЕТСЯ.
    const общийКлючСырой = pairPredicates([...цикл(0, 42), ...цикл(8, 42)] as never);
    expect(общийКлючСырой.pairs, 'с барьером — только вторая пара').toHaveLength(1);
    expect(общийКлючСырой.refusals.map((отказ) => отказ.index), 'осиротевший переход первого цикла').toContain(1);
  });
});
