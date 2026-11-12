/**
 * ОРАКУЛ ДОСТУПА ПО АДРЕСУ-РЕГИСТРУ: `IR.load` / `IR.store`.
 *
 * # Зачем эти носители вообще
 *
 * В языке уже были носители памяти — `IR.spill_ld`/`IR.spill_st`, — и первая редакция плана
 * коллекций (§3.95.2) собиралась выразить `[база + индекс·8]` ими. **Замер это опроверг:** они
 * адресуют **СЛОТ**: понижение кладёт ЛИТЕРАЛЬНЫЙ адрес слота в регистр-адрес (`movtd #слот, регистр`)
 * и только потом делает обращение. Регистр-адрес затирается литералом, и смещение так не выражается.
 *
 * Здесь проверяется то, что отличает новые носители от вытеснения: **адрес приходит готовым
 * регистром**, смещение — регистр нуля, и роли операндов у чтения и записи РАЗНЫЕ.
 *
 * # Почему без модели
 *
 * Спрашивается наш слой: одна ли команда, какая форма, кто определён и кто прочитан, соблюдён ли
 * закон формы памяти. Прогон в модели спрашивает другое, и он будет у сайта коллекций — здесь ему
 * нечего добавить: команды `ldd`/`std` на цели уже измерены (`src/e2k/e2kMemoryQemu.test.ts`,
 * `src/e2k/e2kArraysQemu.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { LOAD_CARRIER, STORE_CARRIER, loadInstructions, storeInstructions } from './memoryAccess';
import { ARRAY_REGISTERS, memoryOperandPairProblems } from './arrayRuntime';
import { carrierForm } from './twoPassLayout';
import { lowerCarrier } from './e2kRealRun';
import { defUseOf } from './liveness';
import { registersOf } from './predicatePairing';
import type { AsmInstruction, Operand } from './backend';

const reg = (index: number): Operand => ({ kind: 'reg', index });

/** Носитель с двумя регистрами: у чтения `[адрес, приёмник]`, у записи `[значение, адрес]`. */
const carrier = (mnemonic: string, first: number, second: number): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands: [reg(first), reg(second)],
});

describe('доступ по адресу-регистру: форма и понижение', () => {
  it('ЧТЕНИЕ: одна команда `ldd`, основание — адрес, смещение — РЕГИСТР нуля рантайма', () => {
    const [command] = loadInstructions(3, 4);
    expect(command!.mnemonic).toBe('ldd');
    // Порядок операндов формы памяти — (основание, смещение, приёмник), и смещение РЕГИСТРОМ:
    // литерала в команде нет, адрес в e2k — сумма двух регистров.
    expect(command!.operands[0]).toEqual(reg(3));
    expect(command!.operands[1]).toEqual(reg(ARRAY_REGISTERS.zero));
    expect(command!.operands[2]).toEqual(reg(4));
  });

  it('ЗАПИСЬ: одна команда `std` в канале 2 — `st*` в других каналах не кодируется', () => {
    const [command] = storeInstructions(5, 6);
    expect(command!.mnemonic).toBe('std');
    expect(command!.channel, 'каналы записи — только 2 и 5 (opcodes/e2k-opc.h:969-984)').toBe(2);
    expect(command!.operands[0], 'значение первым').toEqual(reg(5));
    expect(command!.operands[1], 'основание вторым').toEqual(reg(6));
    expect(command!.operands[2], 'смещение — регистр нуля').toEqual(reg(ARRAY_REGISTERS.zero));
  });

  it('ЗАКОН ФОРМЫ ПАМЯТИ соблюдён по построению: два регистра адреса РАЗНЫЕ', () => {
    // Иначе модель взводит исключение при входе в блок, и обращение НЕ исполняется — молча
    // (механизм и замер — шапка `ldd` в `src/e2k/arrayRuntime.ts`). Сторож есть, и он обязан
    // молчать на настоящем понижении: положительный контроль рядом.
    expect(memoryOperandPairProblems(loadInstructions(3, 4))).toEqual([]);
    expect(memoryOperandPairProblems(storeInstructions(5, 6))).toEqual([]);
    // А на подделке — краснеть. Негативный контроль на сторожа, а не на себя.
    expect(memoryOperandPairProblems([{ mnemonic: 'ldd', channel: 0, operands: [reg(12), reg(12), reg(4)] }]).length).toBe(1);
  });

  it('ФОРМА и ПОНИЖЕНИЕ — из одного источника: число команд и их мнемоники совпадают', () => {
    // Разойдись они — уехали бы адреса переходов после носителя, и молча (класс §3.35).
    for (const [mnemonic, commands] of [
      [LOAD_CARRIER, loadInstructions(3, 4)],
      [STORE_CARRIER, storeInstructions(5, 6)],
    ] as const) {
      const form = carrierForm(mnemonic);
      expect(form, `${mnemonic}: формы нет — носитель не разместится`).toBeDefined();
      expect(form!.commands.map((command) => command.mnemonic)).toEqual(commands.map((command) => command.mnemonic));
    }
  });

  it('ПОНИЖЕНИЕ: роли операндов НЕ перепутаны — адрес не становится приёмником', () => {
    // Это и есть различие с вытеснением, и оно единственное: у `IR.spill_ld` первый операнд —
    // регистр, в который КЛАДЁТСЯ литеральный адрес слота (то есть приёмник адреса), а у `IR.load`
    // первый операнд — ИСТОЧНИК адреса. Перепутай их — чтение поехало бы не туда.
    const read = lowerCarrier(carrier(LOAD_CARRIER, 3, 4));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.instructions[0]!.operands[0], 'первый операнд — ИСТОЧНИК адреса').toEqual(reg(3));
    const write = lowerCarrier(carrier(STORE_CARRIER, 5, 6));
    expect(write.ok).toBe(true);
    if (write.ok) expect(write.instructions[0]!.operands[0], 'первый операнд — ЗНАЧЕНИЕ').toEqual(reg(5));
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: нерегистровый или непарный операнд — отказ с кодом, а не молчание', () => {
    const неРегистр = lowerCarrier({ mnemonic: LOAD_CARRIER, channel: 0, operands: [reg(3), { kind: 'imm', value: 4 }] });
    expect(неРегистр.ok).toBe(false);
    if (!неРегистр.ok) expect(неРегистр.code).toBe('OSN-LOW-007');
    const один = lowerCarrier({ mnemonic: STORE_CARRIER, channel: 0, operands: [reg(3)] });
    expect(один.ok).toBe(false);
  });
});

describe('доступ по адресу-регистру: кто определён и кто прочитан', () => {
  it('ЧТЕНИЕ пишет ПРИЁМНИК, а читает АДРЕС — умолчание прочло бы их наоборот', () => {
    // Общее правило разбора — `[d, a, b]`. Здесь порядок другой, и это не мелочь: перепутай роли —
    // раскладка сочла бы адрес ОПРЕДЕЛЕНИЕМ, приёмник — ЧТЕНИЕМ, и отрезки жизни разъехались бы
    // (класс §3.96: тихая ложь, а не отказ).
    expect(defUseOf(carrier(LOAD_CARRIER, 3, 4))).toEqual({ def: [4], use: [3] });
    expect(registersOf(carrier(LOAD_CARRIER, 3, 4)), 'сопоставление предикатов видит то же').toEqual({
      known: true,
      reads: [3],
      writes: [4],
    });
  });

  it('ЗАПИСЬ не пишет НИЧЕГО, а читает И значение, И адрес', () => {
    expect(defUseOf(carrier(STORE_CARRIER, 5, 6))).toEqual({ def: [], use: [5, 6] });
    expect(registersOf(carrier(STORE_CARRIER, 5, 6))).toEqual({ known: true, reads: [5, 6], writes: [] });
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: отличие от вытеснения — в ПОНИЖЕНИИ, а не в ролях def/use', () => {
    // ЗАМЕР, ИСПРАВИВШИЙ МОЮ ЖЕ ПОСЫЛКУ. Я записал сюда «у вытеснения роли другие» — и проверка
    // покраснела на верном коде: у `IR.spill_ld` роли ТЕ ЖЕ (`use` — первый операнд, `def` —
    // второй). Отличие не в разборе регистров, а в том, ЧТО ИЗ КОМАНД: вытеснение кладёт
    // литеральный адрес слота в регистр-адрес (`movtd`), то есть ЗАТИРАЕТ его, и потому не может
    // выразить смещение; чтение по адресу-регистру адрес НЕ трогает и стоит ОДНУ команду.
    // Проверка переписана на то, что действительно различает два носителя.
    const spill = lowerCarrier({ mnemonic: 'IR.spill_ld', channel: 0, operands: [reg(3), reg(4), { kind: 'imm', value: 0 }] });
    expect(spill.ok).toBe(true);
    if (spill.ok) {
      expect(spill.instructions.length, 'вытеснение — ДВЕ команды').toBe(2);
      expect(spill.instructions[0]!.mnemonic, 'и первая ЗАТИРАЕТ регистр-адрес литералом слота').toBe('movtd');
    }
    const read = lowerCarrier(carrier(LOAD_CARRIER, 3, 4));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.instructions.length, 'чтение по адресу — ОДНА команда').toBe(1);
      expect(read.instructions[0]!.mnemonic, 'и адрес не затирается ничем').toBe('ldd');
    }
    expect(defUseOf(carrier(LOAD_CARRIER, 3, 4)), 'при этом роли совпадают — различие не здесь').toEqual(
      defUseOf({ mnemonic: 'IR.spill_ld', channel: 0, operands: [reg(3), reg(4), { kind: 'imm', value: 0 }] }),
    );
  });
});
