/**
 * ОРАКУЛ ДВУХПРОХОДНОЙ РАСКЛАДКИ — НАПИСАН ДО РЕАЛИЗАЦИИ.
 *
 * # Зачем раскладка
 *
 * Смещение перехода `disp` в e2k отсчитывается **от адреса команды до адреса цели**
 * (`qemu/target/e2k/tcg/translate-ctp.c:74-75`: `disp = FIELD_SEX32(cs0, C0F2, disp)`,
 * `new_base = (instr_state.ip + (disp << 3))`), а адрес цели зависит от размеров **всех**
 * ранее разложенных команд. Поэтому понижение `IR.jmp` невозможно одним проходом: сначала
 * адреса, потом смещения.
 *
 * # Что проверяет оракул
 *
 * | # | проверка |
 * |---|---|
 * | 1.1 | первый проход: каждой инструкции с формой присвоен адрес; адреса монотонно возрастают без пропусков и пересечений |
 * | 1.2 | размер каждой понижённой команды — **из таблицы форм** (8 или 16 байт), а не выдуман |
 * | 1.3 | второй проход: для `jmp` смещение в **8-байтных единицах** от адреса команды до адреса цели |
 * | 1.4 | смещение влезает в поле `disp`: разрядность **взята из источника**, а не подобрана |
 * | 1.5 | круг: наши байты → MCST-`objdump` → цель перехода совпадает с вычисленным адресом цели |
 *
 * # Чего оракул НЕ доказывает
 *
 * Что код исполнится на e2k (эмулятора нет) и что раскладка — это раскладка **железа**:
 * проверены согласованность проходов, соответствие размеров кодировщику и чтение нами же
 * вычисленного адреса **чужим** дизассемблером.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions, verifyAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { REAL_CONTROL_OPCODES, REAL_LONG_FORM_SIZE, REAL_OPCODES, REAL_SHORT_FORM_SIZE } from './e2k-real';
import { buildElfFromCode, MINIMAL_BASE } from './elfMinimal';
import { disassembleElf, findExternalTool, parseObjdumpOutput } from '../scripts/e2kExternalObjdump';
import {
  CARRIER_FORMS,
  DISP_BITS,
  DISP_MAX,
  DISP_MIN,
  DISP_SOURCE,
  DISP_UNITS,
  carrierForm,
  carrierFormOf,
  firstPass,
  jumpCommands,
  layoutOf,
  secondPass,
  sizeOfCarrier,
} from './twoPassLayout';
import { lowerArrayCall } from './arrayRuntime';
import { allocateProgram } from './regAlloc';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS_DIR = path.join(ROOT, 'tests', 'dsp', 'kernels');

/** Пять ядер и атом каждого — тот же корпус, что в `e2kRealRun.test.ts`. */
const KERNELS: ReadonlyArray<{ name: string; atom: string }> = [
  { name: 'fir', atom: 'A5' },
  { name: 'iir', atom: 'A5' },
  { name: 'fft', atom: 'A5' },
  { name: 'convolution', atom: 'A6' },
  { name: 'correlation', atom: 'A6' },
];

const shellEncoder = getEncoder('internal-shell');
const realEncoder = getEncoder('e2k');

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/** Поток носителей IR одного ядра — тот же путь, что в сквозном прогоне. */
function kernelCarriers(name: string, atom: string): readonly AsmInstruction[] {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  const annotated = annotateAtomRegions(built.module, [
    { atom, procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) throw new Error(`${name}: разметка атомов не прошла проверку: ${problems.join('; ')}`);
  const emitted = emitShell(annotated, shellEncoder);
  // Носителей ровно столько же, сколько инструкций IR: эмиттер оболочки ставит их один к одному
  // (`emitterShell.ts`: `newCode.map(...)`). Раскладка идёт по этому потоку — то есть по
  // инструкциям IR, а не по чему-то ещё.
  if (emitted.instructions.length !== built.module.code.length) {
    throw new Error(`${name}: носителей ${emitted.instructions.length}, инструкций IR ${built.module.code.length}`);
  }
  return emitted.instructions;
}

const CARRIERS: ReadonlyMap<string, readonly AsmInstruction[]> = new Map(
  KERNELS.map(({ name, atom }) => [name, kernelCarriers(name, atom)]),
);

/**
 * `IR.invoke` РАЗМЕЩАЕТСЯ: длина берётся у рантайма, а не из догадки.
 *
 * # Почему это отдельная проверка
 *
 * У `IR.invoke` нет формы «по мнемонике»: сколько команд он займёт, зависит от **имени** вызова
 * (`payload` — индекс в `invokeNames` образа): `длина` — одна команда, `создать` — три, `получить` —
 * шесть, `добавить` — девять (измерено `.tmp/invoke-names.ts`). Пока формы нет, носитель не
 * размещается, адреса всех следующих команд уезжают, и в отчёте это выглядит как «22 отказа из 111»
 * — то есть как отсутствие понижения, хотя рантайм массивов его умеет (`src/e2k/arrayRuntime.ts`).
 *
 * # Чего проверка не делает
 *
 * Не кодирует: размеры команд берутся из **таблицы форм** (`adds`/`ldd`/`std` — ALF1, 8 байт), и это
 * сверяется с кодировщиком отдельной проверкой 1.2 — то есть раскладка остаётся независимой от
 * кодировщика, а расхождение объявления и реализации не пройдёт молча.
 */
describe('раскладка: IR.invoke получает длину от рантайма массивов', () => {
  const INVOKE_NAMES = ['система.массив.длина', 'система.массив.создать', 'система.массив.получить', 'система.массив.добавить'];
  const invoke = (payload: number, flags: number, args: readonly number[], destination?: number): AsmInstruction =>
    carrier('IR.invoke', [
      imm(flags),
      reg(args[0] ?? 0),
      reg(args[1] ?? 0),
      imm(payload),
      ...(destination === undefined ? [] : [reg(destination)]),
    ]);

  it('длина зависит от имени вызова — и совпадает с понижением рантайма', () => {
    // Флаги носителя несут арность: `flags >> 1` — сколько аргументов, `flags & 1` — есть ли приёмник.
    // Арность — по источнику (`src/runtime/vm/invokeRegistry.ts:44-50`): у «создать» 0, у «длина» 1,
    // у «получить» и «добавить» — 2. Несовпадение арности означает, что носитель и рантайм разошлись,
    // и это обязано быть видно (форма тогда не берётся, а причина называется).
    const expected: ReadonlyArray<{ payload: number; flags: number; commands: number; bytes: number }> = [
      { payload: 1, flags: 0b001, commands: 3, bytes: 24 }, // создать: 0 аргументов, приёмник есть
      { payload: 0, flags: 0b011, commands: 1, bytes: 8 }, // длина: 1 аргумент
      { payload: 2, flags: 0b101, commands: 6, bytes: 48 }, // получить: 2 аргумента
      { payload: 3, flags: 0b100, commands: 9, bytes: 72 }, // добавить: 2 аргумента, приёмника нет
    ];
    for (const item of expected) {
      const form = carrierFormOf(invoke(item.payload, item.flags, [0, 1], 2), { invokeNames: INVOKE_NAMES });
      expect(form, `payload ${item.payload}: формы нет — носитель не разместится`).toBeDefined();
      expect(form!.commands.length, `payload ${item.payload}: команд`).toBe(item.commands);
      expect(form!.commands.reduce((sum, command) => sum + command.size, 0), `payload ${item.payload}: байт`).toBe(item.bytes);
      for (const command of form!.commands) expect(command.size, `${command.mnemonic}: размер`).toBe(REAL_SHORT_FORM_SIZE);
    }
  });

  it('арность носителя и рантайма не разошлись: лишний аргумент — отказ с причиной', () => {
    // `создать` берёт 0 аргументов: если носитель принёс один, форма не берётся, и причина — от рантайма.
    const wrong = invoke(1, 0b011, [0, 1], 2);
    const table = layoutOf([wrong], { invokeNames: INVOKE_NAMES });
    expect(table.unplaced.length, 'носитель с лишним аргументом не размещён').toBe(1);
    expect(table.unplaced[0]!.reason, 'причина отказа').toMatch(/аргумент/);
  });

  it('размер формы совпадает с длиной кодирования (раскладка независима, но не расходится)', () => {
    const cases: ReadonlyArray<{ payload: number; flags: number }> = [
      { payload: 1, flags: 0b001 },
      { payload: 0, flags: 0b011 },
      { payload: 2, flags: 0b101 },
      { payload: 3, flags: 0b100 },
    ];
    for (const item of cases) {
      const form = carrierFormOf(invoke(item.payload, item.flags, [0, 1], 2), { invokeNames: INVOKE_NAMES })!;
      const lowered = lowerArrayCall(INVOKE_NAMES[item.payload]!, [reg(0), reg(1)].slice(0, item.flags >> 1), 2);
      expect(form.commands.map((command) => command.mnemonic)).toEqual(lowered.map((command) => command.mnemonic));
      form.commands.forEach((command, at) => {
        expect(command.size, `${command.mnemonic}: таблица против кодировщика`).toBe(realEncoder.encode(lowered[at]!).length);
      });
    }
  });

  it('без списка имён — отказ с причиной, а не молчание', () => {
    expect(carrierFormOf(invoke(0, 0b11, [0, 1], 2)), 'без имён форма не берётся').toBeUndefined();
    const table = layoutOf([invoke(0, 0b11, [0, 1], 2)]);
    expect(table.unplaced.length, 'носитель обязан попасть в неразмещённые').toBe(1);
    expect(table.unplaced[0]!.reason, 'причина отказа').toMatch(/имён/);
  });

  it('неподдерживаемый вызов не размещается — причина называет рантайм', () => {
    const table = layoutOf([invoke(0, 0b11, [0, 1])], { invokeNames: ['система.математика.остаток'] });
    expect(table.unplaced.length, 'неподдерживаемый вызов не размещён').toBe(1);
    expect(table.unplaced[0]!.reason, 'причина отказа').toMatch(/рантайм|операции/);
  });

  it('FIR: все 22 носителя IR.invoke размещаются — но только ПОСЛЕ раскладки регистров', () => {
    const source = fs.readFileSync(path.join(KERNELS_DIR, 'fir.osnova'), 'utf-8');
    const built = regModuleOf(source)!;
    const annotated = annotateAtomRegions(built.module, [
      { atom: 'A5', procedures: built.module.procedures.map((procedure) => procedure.name) },
    ]);
    const emitted = emitShell(annotated, shellEncoder);
    const names = emitted.image.invokeNames;
    // Порядок обязателен: рантайм массивов отказывает, если операнд попал в зарезервированную область
    // `%b[10..15]` (куча, ноль, временные), а до раскладки номера vreg'ов туда как раз и попадают.
    // Поэтому форму `IR.invoke` можно взять только у РАЗЛОЖЕННОГО потока.
    const allocated = allocateProgram(emitted.instructions, emitted.scheduled.procedures);
    const table = layoutOf(allocated.instructions, { invokeNames: names });
    const placed = table.entries.filter((entry) => entry.carrier === 'IR.invoke').length;
    expect(placed, 'размещено IR.invoke после раскладки').toBe(22);
    expect(table.unplaced.filter((item) => item.carrier === 'IR.invoke').length, 'не размещено IR.invoke').toBe(0);
    // И обратное: на НЕразложенном потоке часть носителей формы не получает — причина от рантайма,
    // а не «формы нет». Это и есть измеренная зависимость шага 2 от шага 1.
    const raw = layoutOf(emitted.instructions, { invokeNames: names });
    const rawPlaced = raw.entries.filter((entry) => entry.carrier === 'IR.invoke').length;
    expect(rawPlaced, 'без раскладки часть IR.invoke не размещается').toBeLessThan(22);
    expect(
      raw.unplaced.some((item) => item.carrier === 'IR.invoke' && /зарезервирован/.test(item.reason)),
      'причина отказа обязана называть зарезервированные регистры рантайма',
    ).toBe(true);
  });
});

const ALL_CARRIERS: readonly AsmInstruction[] = [...CARRIERS.values()].flat();

/** Ручной поток: у каждой формы свой размер, поэтому адреса проверяются арифметикой. */
const HAND: readonly AsmInstruction[] = [
  carrier('IR.move', [reg(1), reg(2)]), // 8 байт: 0
  carrier('IR.add', [reg(1), reg(2), reg(3)]), // 8 байт: 8
  carrier('IR.mul', [reg(1), reg(2), reg(3)]), // 16 байт: 16
  carrier('IR.const', [reg(1), imm(0), imm(0)]), // 16 байт: 32
  carrier('IR.jmp', [imm(0)]), // 16 байт: 48, цель — адрес 0
];

describe('двухпроходная раскладка: 1.1 первый проход — адреса', () => {
  it('каждая инструкция с формой получает адрес; адреса монотонны, без пропусков и пересечений', () => {
    const layout = layoutOf(HAND);
    expect(layout.entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
    expect(layout.entries.map((entry) => entry.address)).toEqual([0, 8, 16, 32, 48]);
    expect(layout.entries.map((entry) => entry.size)).toEqual([8, 8, 16, 16, 16]);
    expect(layout.totalBytes).toBe(64);
    expect(layout.unplaced).toEqual([]);
    expect([...layout.addresses.entries()]).toEqual([
      [0, 0],
      [1, 8],
      [2, 16],
      [3, 32],
      [4, 48],
    ]);
    // `firstPass` — та же раскладка в виде «индекс → адрес» (задача 2.1).
    const addresses = firstPass(HAND);
    expect([...addresses.entries()]).toEqual([...layout.addresses.entries()]);
  });

  it('адреса без пропусков и пересечений: следующий ровно там, где кончается предыдущий', () => {
    for (const [name, carriers] of CARRIERS) {
      const layout = layoutOf(carriers);
      expect(layout.entries.length, `${name}: ни одной размещённой инструкции`).toBeGreaterThan(0);
      let expected = 0;
      for (const entry of layout.entries) {
        expect(entry.address, `${name}: адрес #${entry.index}`).toBe(expected);
        expect(entry.size, `${name}: размер #${entry.index}`).toBeGreaterThan(0);
        expect(entry.size % DISP_UNITS, `${name}: размер #${entry.index} не кратен 8`).toBe(0);
        expected += entry.size;
      }
      expect(layout.totalBytes, `${name}: сумма размеров`).toBe(expected);
      // Пересечений быть не может: адреса строго возрастают и каждый следующий — за предыдущим.
      const addresses = layout.entries.map((entry) => entry.address);
      expect([...addresses].sort((a, b) => a - b), `${name}: адреса не возрастают`).toEqual(addresses);
    }
  });

  it('инструкции без формы не выдумываются: у них названная причина, и их ровно 131', () => {
    const layout = layoutOf(ALL_CARRIERS);
    expect(ALL_CARRIERS.length).toBe(517);
    expect(layout.entries.length, 'покрытие раскладки').toBe(386);
    expect(layout.unplaced.length, 'отказов раскладки').toBe(131);
    // Молчаливой потери нет: каждая инструкция либо размещена, либо названа.
    expect(layout.entries.length + layout.unplaced.length).toBe(ALL_CARRIERS.length);
    for (const unplaced of layout.unplaced) {
      expect(unplaced.reason.length, `#${unplaced.index}: причина не названа`).toBeGreaterThan(10);
      expect(carrierForm(unplaced.carrier), `#${unplaced.index}: у «${unplaced.carrier}» форма есть`).toBeUndefined();
    }
    const byCarrier = new Map<string, number>();
    for (const unplaced of layout.unplaced) {
      byCarrier.set(unplaced.carrier, (byCarrier.get(unplaced.carrier) ?? 0) + 1);
    }
    expect([...byCarrier.entries()].sort((a, b) => b[1] - a[1])).toEqual([
      ['IR.invoke', 87],
      ['IR.ret', 32],
      ['IR.call', 11],
      ['IR.div', 1],
    ]);
    for (const placed of ['IR.jmp', 'IR.jmp_if_not', 'IR.lt', 'IR.le', 'IR.ge']) {
      expect(byCarrier.has(placed), `${placed} обязан быть размещён`).toBe(false);
    }
  });
});

describe('двухпроходная раскладка: 1.2 размер — из таблицы форм', () => {
  it('у каждой формы назван источник, а размер — 8 или 16 байт', () => {
    expect(CARRIER_FORMS.length).toBeGreaterThan(0);
    for (const form of CARRIER_FORMS) {
      expect(form.commands.length, `${form.carrier}: ни одной команды`).toBeGreaterThan(0);
      for (const command of form.commands) {
        expect([REAL_SHORT_FORM_SIZE, REAL_LONG_FORM_SIZE], `${form.carrier}/${command.mnemonic}`).toContain(
          command.size,
        );
        expect(command.source, `${form.carrier}/${command.mnemonic}: источник размера не назван`).toMatch(
          /e2k-real\.ts|e2k-syllables-real\.md|syllab-format\.h|instr-bits\.h|opcodes\/e2k-opc\.h/,
        );
      }
      expect(sizeOfCarrier(form.carrier), `${form.carrier}: сумма размеров`).toBe(
        form.commands.reduce((sum, command) => sum + command.size, 0),
      );
    }
    expect(sizeOfCarrier('IR.invoke'), 'у непонижаемого носителя размера быть не должно').toBeUndefined();
  });

  it('каждая команда формы есть в таблицах кодировщика, а форма даёт тот же размер', () => {
    for (const form of CARRIER_FORMS) {
      for (const command of form.commands) {
        const alu = REAL_OPCODES.find((entry) => entry.mnemonic === command.mnemonic);
        const control = REAL_CONTROL_OPCODES.find((entry) => entry.mnemonic === command.mnemonic);
        expect(alu ?? control, `${form.carrier}: команды «${command.mnemonic}» нет в таблицах e2k-real`).toBeDefined();
        if (alu !== undefined) expect(command.form, `${form.carrier}/${command.mnemonic}: форма`).toContain(alu.form);
        if (control !== undefined) {
          expect(command.form, `${form.carrier}/${command.mnemonic}: форма`).toContain(control.form);
          expect(command.size, `${form.carrier}/${command.mnemonic}: размер из таблицы управления`).toBe(control.size);
        }
      }
    }
  });

  it('размер формы подтверждается кодировщиком, а не соглашением', () => {
    // Формы без литерала: длину даёт таблица опкодов (`ALF11` — ALS + ALES, то есть 16 байт).
    const measured: ReadonlyArray<{ carrier: string; instruction: AsmInstruction }> = [
      { carrier: 'IR.move', instruction: carrier('movts', [reg(2), reg(1)]) },
      { carrier: 'IR.add', instruction: carrier('adds', [reg(1), reg(2), reg(3)]) },
      { carrier: 'IR.sub', instruction: carrier('subs', [reg(1), reg(2), reg(3)]) },
      { carrier: 'IR.mul', instruction: carrier('muls', [reg(1), reg(2), reg(3)]) },
    ];
    for (const { carrier: name, instruction } of measured) {
      expect(realEncoder.encode(instruction).length, `${name}: кодировщик даёт другую длину`).toBe(
        sizeOfCarrier(name),
      );
    }
    // Литерал (LTS) занимает слово команды: `IR.const` — 16 байт, а не 8.
    const literal = realEncoder.encode(carrier('movts', [imm(42), reg(1)]));
    expect(literal.length, 'IR.const: литеральная форма длиннее короткой').toBe(sizeOfCarrier('IR.const'));
    expect(sizeOfCarrier('IR.const')).toBe(REAL_LONG_FORM_SIZE);
    // Пара перехода — две команды по 8 (замер: docs/e2k-real-run.md §2.3).
    expect(jumpCommands(3).map((command) => command.mnemonic)).toEqual(['disp', 'ct']);
    expect(jumpCommands(3).map((command) => realEncoder.encode(command).length)).toEqual([8, 8]);
    expect(sizeOfCarrier('IR.jmp')).toBe(16);
  });
});

describe('двухпроходная раскладка: 1.3 второй проход — смещения', () => {
  it('смещение считается в 8-байтных единицах от адреса команды до адреса цели', () => {
    const addresses = firstPass(HAND);
    // #4 стоит на адресе 48, цель — #0 на адресе 0: смещение отрицательное и равно −6.
    const resolved = secondPass(HAND, addresses);
    expect(resolved.refusals).toEqual([]);
    expect(resolved.displacements.length).toBe(1);
    const jump = resolved.displacements[0]!;
    expect(jump.index).toBe(4);
    expect(jump.targetIndex).toBe(0);
    expect(jump.commandAddress).toBe(48);
    expect(jump.targetAddress).toBe(0);
    expect(jump.disp).toBe(-6);
    expect(jump.commandAddress + jump.disp * DISP_UNITS).toBe(jump.targetAddress);
    // Подставленное смещение в возвращённых инструкциях совпадает с записью — не второй расчёт.
    const substituted = resolved.instructions[4]!.operands[0]!;
    expect(substituted).toEqual({ kind: 'imm', value: -6 });
    // Остальные инструкции не тронуты.
    expect(resolved.instructions[0]).toEqual(HAND[0]);
  });

  it('вперёд и назад считаются одним правилом', () => {
    // Размеры: add 8, jmp 16 (пара), mul 16, move 8, move 8, jmp 16.
    const stream: readonly AsmInstruction[] = [
      carrier('IR.add', [reg(1), reg(2), reg(3)]), // 0
      carrier('IR.jmp', [imm(4)]), // 8 → цель 48, смещение +5
      carrier('IR.mul', [reg(1), reg(2), reg(3)]), // 24
      carrier('IR.move', [reg(1), reg(2)]), // 40
      carrier('IR.move', [reg(1), reg(2)]), // 48
      carrier('IR.jmp', [imm(0)]), // 56 → цель 0, смещение −7
    ];
    const resolved = secondPass(stream, firstPass(stream));
    expect(resolved.refusals).toEqual([]);
    expect(resolved.displacements.map((item) => [item.index, item.targetIndex, item.disp])).toEqual([
      [1, 4, 5],
      [5, 0, -7],
    ]);
    for (const item of resolved.displacements) {
      expect(item.commandAddress + item.disp * DISP_UNITS, `#${item.index}`).toBe(item.targetAddress);
      expect(Number.isInteger(item.disp), `#${item.index}: смещение не целое`).toBe(true);
    }
  });

  it('на пяти ядрах все 26 переходов получают смещение, и оно ведёт ровно в цель', () => {
    let total = 0;
    for (const [name, carriers] of CARRIERS) {
      const addresses = firstPass(carriers);
      const resolved = secondPass(carriers, addresses);
      expect(resolved.refusals.map((item) => `#${item.index}: ${item.reason}`), name).toEqual([]);
      const jmps = carriers.filter((instruction) => instruction.mnemonic.startsWith('IR.jmp')).length;
      expect(resolved.displacements.length, `${name}: смещений не столько, сколько IR.jmp`).toBe(jmps);
      for (const item of resolved.displacements) {
        expect(addresses.get(item.index), `${name} #${item.index}: адрес команды`).toBe(item.commandAddress);
        expect(addresses.get(item.targetIndex), `${name} #${item.index}: адрес цели`).toBe(item.targetAddress);
        expect(item.commandAddress + item.disp * DISP_UNITS, `${name} #${item.index}`).toBe(item.targetAddress);
        // Цель — начало команды, а не середина: иначе смещение не выразить в 8-байтных единицах.
        expect(item.targetAddress % DISP_UNITS, `${name} #${item.index}`).toBe(0);
      }
      total += resolved.displacements.length;
    }
    expect(total, 'переходов пяти ядер').toBe(26);
  });

  it('цель вне раскладки — отказ с точной причиной, а не выдуманный адрес', () => {
    const stream: readonly AsmInstruction[] = [
      carrier('IR.add', [reg(1), reg(2), reg(3)]),
      carrier('IR.jmp', [imm(9)]), // цели #9 нет
      carrier('IR.invoke', [reg(1), imm(0), imm(0), imm(0), reg(1)]), // без формы
      carrier('IR.jmp', [imm(2)]), // цель есть в потоке, но не размещена
      carrier('IR.jmp', [imm(-1)]), // отрицательная цель
    ];
    const resolved = secondPass(stream, firstPass(stream));
    expect(resolved.displacements).toEqual([]);
    expect(resolved.refusals.length).toBe(3);
    expect(resolved.refusals[0]!.reason).toMatch(/вне потока/);
    expect(resolved.refusals[1]!.reason).toMatch(/не размещена/);
    expect(resolved.refusals[2]!.reason).toMatch(/вне потока/);
    for (const refusal of resolved.refusals) {
      expect(refusal.reason.length, `#${refusal.index}`).toBeGreaterThan(20);
    }
  });
});

describe('двухпроходная раскладка: 1.4 разрядность disp', () => {
  it('разрядность взята из источника, а не подобрана', () => {
    // C0F2: `FIELD_BITS(C0F2, disp, 27, 0)` — 28 бит; читается знаковым (`FIELD_SEX32`).
    expect(DISP_BITS).toBe(28);
    expect(DISP_UNITS).toBe(8);
    expect(DISP_MIN).toBe(-(2 ** 27));
    expect(DISP_MAX).toBe(2 ** 27 - 1);
    expect(DISP_SOURCE, 'источник разрядности не назван').toMatch(/C0F2|disp\[27:0\]/);
    expect(DISP_SOURCE, 'не назван файл раскладки полей').toMatch(/syllab-format\.h:\d+/);
    expect(DISP_SOURCE, 'не названо чтение смещения').toMatch(/translate-ctp\.c:\d+/);
  });

  it('источник разрядности подтверждается текстом исходников, а не пересказом', () => {
    const qemu = path.join(ROOT, '.tmp', 'e2k-sources', 'qemu-e2k', 'qemu', 'target', 'e2k', 'syllab-format.h');
    const gas = path.join(ROOT, '.tmp', 'e2k-sources', 'binutils-gdb', 'gas', 'config', 'tc-e2k.c');
    if (!fs.existsSync(qemu) || !fs.existsSync(gas)) {
      // Исходников под рукой нет — это названная причина, а не «проверено».
      expect(fs.existsSync(qemu) && fs.existsSync(gas)).toBe(false);
      return;
    }
    const syllab = fs.readFileSync(qemu, 'utf-8');
    expect(syllab, 'в syllab-format.h нет поля C0F2.disp[27:0]').toMatch(
      /FIELD_BITS\s*\(\s*C0F2\s*,\s*disp\s*,\s*27\s*,\s*0\s*\)/,
    );
    // Знаковое чтение поля — `FIELD_SEX32(instr_decoded->cs0, C0F2, disp)`.
    const translate = fs.readFileSync(path.join(path.dirname(qemu), 'tcg', 'translate-ctp.c'), 'utf-8');
    expect(translate, 'disp читается не знаковым').toMatch(/FIELD_SEX32\s*\(\s*instr_decoded->cs0\s*,\s*C0F2\s*,\s*disp\s*\)/);
    expect(translate, 'адрес цели считается не как ip + disp*8').toMatch(/instr_state\.ip\s*\+\s*\(disp\s*<<\s*3ull\)/);
    // Поле в ассемблере МЦСТ — 28 бит (`u_int32_t disp:28;`).
    expect(fs.readFileSync(gas, 'utf-8'), 'в ассемблере поле disp не 28 бит').toMatch(/disp\s*:\s*28\s*;/);
  });

  it('смещение вне 28-битного знакового поля — отказ, а не молчаливое усечение', () => {
    const stream: readonly AsmInstruction[] = [carrier('IR.add', [reg(1), reg(2), reg(3)]), carrier('IR.jmp', [imm(0)])];
    // Адрес цели взят заведомо за пределами поля: раскладка передаётся снаружи, и это её дело.
    const far = new Map<number, number>([
      [0, 2 ** 31],
      [1, 0],
    ]);
    const resolved = secondPass(stream, far);
    expect(resolved.displacements).toEqual([]);
    expect(resolved.refusals.length).toBe(1);
    expect(resolved.refusals[0]!.reason).toMatch(new RegExp(`${DISP_MIN}|${DISP_MAX}|28`));
    // Кодировщик отказывает на том же основании: значение в поле не влезает.
    expect(() => realEncoder.encode(carrier('disp', [imm(1), imm(DISP_MAX + 1)]))).toThrow(/28|диапазон|влезает/);
    expect(() => realEncoder.encode(carrier('disp', [imm(1), imm(DISP_MIN - 1)]))).toThrow(/28|диапазон|влезает/);
    // Границы поля кодируются и разбираются обратно тем же числом (знак не теряется).
    for (const edge of [DISP_MIN, -1, 0, 1, DISP_MAX]) {
      const bytes = realEncoder.encode(carrier('disp', [imm(1), imm(edge)]));
      expect(realEncoder.decode(bytes).operands[1], `disp = ${edge}`).toEqual({ kind: 'imm', value: edge });
    }
  });
});

describe('двухпроходная раскладка: 1.5 круг через MCST-objdump', () => {
  /** Байты программы: команды в порядке раскладки, без выравнивания — адреса наши. */
  function programBytes(instructions: readonly AsmInstruction[]): {
    bytes: Uint8Array;
    addresses: Map<number, number>;
    target: { commandAddress: number; targetAddress: number; disp: number };
  } {
    const addresses = firstPass(instructions);
    const resolved = secondPass(instructions, addresses);
    expect(resolved.refusals, 'переход не разрешён').toEqual([]);
    const chunks: number[] = [];
    let offset = 0;
    instructions.forEach((instruction, index) => {
      const at = addresses.get(index);
      if (at === undefined) return; // носитель без формы в байты не идёт — в этих программах таких нет
      expect(at, 'раскладка разошлась с порядком байтов').toBe(offset);
      const commands =
        instruction.mnemonic === 'IR.jmp'
          ? jumpCommands(resolved.displacements.find((item) => item.index === index)!.disp)
          : [loweredCommand(instruction)];
      for (const command of commands) {
        const encoded = realEncoder.encode(command);
        chunks.push(...encoded);
        offset += encoded.length;
      }
    });
    const jump = resolved.displacements[0]!;
    return {
      bytes: Uint8Array.from(chunks),
      addresses,
      target: { commandAddress: jump.commandAddress, targetAddress: jump.targetAddress, disp: jump.disp },
    };
  }

  /** Единственная команда понижения носителя — берётся из таблицы форм, а не из понижения. */
  function loweredCommand(instruction: AsmInstruction): AsmInstruction {
    const form = carrierForm(instruction.mnemonic);
    if (form === undefined) throw new Error(`у «${instruction.mnemonic}» нет формы`);
    const command = form.commands[0]!;
    const operands: Operand[] = [];
    if (command.mnemonic === 'movts') {
      // IR.move несёт (dst, a) — у movts порядок (src2, dst).
      operands.push(instruction.operands[1]!, instruction.operands[0]!);
    } else if (command.mnemonic === 'muls') {
      operands.push(instruction.operands[1]!, instruction.operands[2]!, instruction.operands[0]!);
    } else {
      operands.push(instruction.operands[1]!, instruction.operands[2]!, instruction.operands[0]!);
    }
    return { mnemonic: command.mnemonic, channel: 0, operands };
  }

  /** Программы для круга: цель вперёд на 1 и 3 слова и назад на 1 и 2 слова. */
  const PROGRAMS: ReadonlyArray<{ key: string; instructions: readonly AsmInstruction[] }> = [
    {
      key: 'вперёд-1',
      instructions: [
        carrier('IR.add', [reg(1), reg(2), reg(3)]), // 0
        carrier('IR.jmp', [imm(2)]), // 8, цель 16 → +1
        carrier('IR.move', [reg(1), reg(2)]), // 16
      ],
    },
    {
      key: 'вперёд-3',
      instructions: [
        carrier('IR.add', [reg(1), reg(2), reg(3)]), // 0
        carrier('IR.jmp', [imm(5)]), // 8, цель 32 → +3
        carrier('IR.move', [reg(1), reg(2)]), // 16
        carrier('IR.sub', [reg(1), reg(2), reg(3)]), // 24
        carrier('IR.move', [reg(1), reg(2)]), // 32 — цель
        carrier('IR.add', [reg(1), reg(2), reg(3)]), // 40
      ],
    },
    {
      key: 'назад-1',
      instructions: [
        carrier('IR.add', [reg(1), reg(2), reg(3)]), // 0
        carrier('IR.move', [reg(1), reg(2)]), // 8 — цель
        carrier('IR.jmp', [imm(1)]), // 16, цель 8 → −1
      ],
    },
    {
      key: 'назад-2',
      instructions: [
        carrier('IR.mul', [reg(1), reg(2), reg(3)]), // 0 — цель
        carrier('IR.add', [reg(1), reg(2), reg(3)]), // 16
        carrier('IR.jmp', [imm(0)]), // 24, цель 0 → −3
      ],
    },
  ];

  it('собранные байты читаются чужим дизассемблером, и цель перехода совпадает', () => {
    const { tool } = findExternalTool();
    if (tool === undefined) {
      // Инструмента нет — причина обязана быть названа, а не выдана за «проверено».
      const probe = findExternalTool();
      expect(probe.reason, 'причина ненайденности дизассемблера не названа').toBeDefined();
      expect(probe.reason!.length).toBeGreaterThan(30);
      return;
    }
    const problems: string[] = [];
    for (const program of PROGRAMS) {
      const built = programBytes(program.instructions);
      const elf = buildElfFromCode(built.bytes, MINIMAL_BASE);
      const result = disassembleElf(
        { bytes: Buffer.from(elf.bytes), layout: [] },
        path.join(ROOT, '.tmp', `e2k-layout-${program.key}.elf`),
      );
      if (result === undefined) {
        problems.push(`${program.key}: дизассемблер не ответил`);
        continue;
      }
      const lines = parseObjdumpOutput(result.text);
      const commandLine = lines.find((line) => line.address === MINIMAL_BASE + built.target.commandAddress);
      if (commandLine === undefined) {
        problems.push(`${program.key}: нет строки по адресу 0x${(MINIMAL_BASE + built.target.commandAddress).toString(16)}`);
        continue;
      }
      const printed = /disp %ctpr(\d+), (0x[0-9a-f]+)/.exec(commandLine.text);
      if (printed === null) {
        problems.push(`${program.key}: строка «${commandLine.text}» не похожа на disp`);
        continue;
      }
      const printedTarget = Number.parseInt(printed[2]!, 16);
      const expectedTarget = MINIMAL_BASE + built.target.targetAddress;
      if (printedTarget !== expectedTarget) {
        problems.push(
          `${program.key}: disp ведёт на 0x${printedTarget.toString(16)}, ` +
            `а цель раскладки — 0x${expectedTarget.toString(16)} (смещение ${built.target.disp})`,
        );
      }
      // И круг по своим же байтам: разобранное смещение обязано совпасть со смещением раскладки —
      // иначе знак теряется на своей стороне, а чужой дизассемблер этого не покажет.
      const commandBytes = built.bytes.slice(built.target.commandAddress, built.target.commandAddress + 8);
      const decoded = realEncoder.decode(commandBytes);
      const decodedDisp = decoded.operands[1];
      if (decodedDisp === undefined || decodedDisp.kind !== 'imm' || decodedDisp.value !== built.target.disp) {
        problems.push(
          `${program.key}: своё разобранное смещение ${JSON.stringify(decodedDisp)} ` +
            `не равно ${built.target.disp} (ожидалось ${built.target.disp})`,
        );
      }
      if (built.target.commandAddress + built.target.disp * DISP_UNITS !== built.target.targetAddress) {
        problems.push(`${program.key}: смещение ${built.target.disp} не ведёт в адрес цели`);
      }
      // Передача управления — следующая команда пары, на 8 байт дальше.
      const transferLine = lines.find((line) => line.address === MINIMAL_BASE + built.target.commandAddress + 8);
      if (transferLine === undefined || !/^ct %ctpr\d+/.test(transferLine.text)) {
        problems.push(`${program.key}: за disp нет передачи управления («${transferLine?.text ?? 'нет строки'}»)`);
      }
    }
    expect(problems, `программ проверено ${PROGRAMS.length}`).toEqual([]);
  });

  it('негативный контроль: сдвиг цели на одно слово меняет напечатанный адрес', () => {
    // Если бы оракул не читал напечатанный адрес, «цель совпала» ничего не значило бы.
    const base = PROGRAMS[0]!;
    const shifted: readonly AsmInstruction[] = base.instructions.map((instruction) =>
      instruction.mnemonic === 'IR.jmp' ? carrier('IR.jmp', [imm(1)]) : instruction,
    );
    const one = secondPass(base.instructions, firstPass(base.instructions)).displacements[0]!;
    const two = secondPass(shifted, firstPass(shifted)).displacements[0]!;
    expect(one.targetAddress, 'цель не сдвинулась — контроль бессмыслен').not.toBe(two.targetAddress);
    expect(one.disp).not.toBe(two.disp);
    expect(MINIMAL_BASE + one.targetAddress).not.toBe(MINIMAL_BASE + two.targetAddress);
  });
});
