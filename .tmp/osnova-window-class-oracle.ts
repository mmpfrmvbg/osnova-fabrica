/**
 * ОРАКУЛ КЛАССА: ТРИ ЧИСЛА ОКНА ОБЯЗАНЫ СОЙТИСЬ — ПАСПОРТ, КОНСТАНТА РАСКЛАДКИ И ЖИВАЯ МОДЕЛЬ.
 *
 * # Зачем это отдельно от оракула окна
 *
 * Нынешний `src/e2k/e2kCallWindowQemu.test.ts` утверждает **восемь**: `%r5`/`%r7` доступны,
 * `%r8`/`%r9`/`%r10` — нет (`:172-176`). Это верное утверждение о паспортной сборке, но оно не
 * связывает НИЧЕГО: если порт пересобрать с другой начальной геометрией, красными станут ровно эти
 * две проверки и паспорт, а константа `WINDOW_REGISTERS_CALLEE` (`src/e2k/regAlloc.ts:98`) останется
 * восьмёркой — и раскладка продолжит отказывать пяти ядрам, хотя модель их уже пускает. Ровно этот
 * разрыв и появляется при `size_q = 12` (task-11).
 *
 * Здесь проверяется СВЯЗЬ, а не число: порог окна ИЗМЕРЯЕТСЯ на живой сборке (первый недоступный
 * номер у вызываемой и у вызывающего), из паспортной геометрии он ВЫЧИСЛЯЕТСЯ по формуле
 * `2*(size_q − wbs)`, и оба обязаны совпасть с константами раскладки. Три источника — одно число.
 *
 * # Негативный контроль
 *
 * Проба РАЗЛИЧАЮЩАЯ: она обязана давать непустой список расхождений, когда числа не сходятся.
 * Чистая часть контроля (без модели) — `.tmp/osnova-window-s12-offline.ts`, блок 5 случаев;
 * измеренная часть — прогон этой пробы при `size_q = 12` и константе 8: она обязана назвать
 * «модель даёт 16, константа говорит 8».
 *
 * Запуск: `npx tsx .tmp/osnova-window-class-oracle.ts <size_q из паспорта>`
 * Код возврата: 0 — три числа сошлись, 1 — расхождения названы, 2 — прогон невозможен.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from '../src/e2k/backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from '../src/e2k/elfMinimal';
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from '../src/e2k/syscallRuntime';
import { CT_COND_ALWAYS } from '../src/e2k/e2k-real';
import { WINDOW_REGISTERS_CALLEE, WINDOW_REGISTERS_ENTRY } from '../src/e2k/regAlloc';
import { ARRAY_WINDOW_RSZ } from '../src/e2k/arrayRuntime';
import { buildShim, runInQemu } from '../src/scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..');
const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

type Where = 'callee' | 'caller';

/** Программа порога: пишем 42 в `%rK`; доступен — значит пара `return`+`ct` доводит вызывающего до 99. */
function program(register: number, where: Where): { bytes: Uint8Array; probeAddress: number } {
  const build = (target: number): AsmInstruction[] => [
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(55), window_(8)] },
    ...(where === 'caller'
      ? [{ mnemonic: 'movts', channel: 0, operands: [imm(42), window_(register)] } as AsmInstruction]
      : []),
    { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(target)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(99), window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(2), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(2), imm(SYSCALL_WBS)] },
    ...(where === 'callee'
      ? [{ mnemonic: 'movts', channel: 0, operands: [imm(42), window_(register)] } as AsmInstruction]
      : []),
    { mnemonic: 'return', channel: 0, operands: [imm(3)] },
    { mnemonic: 'ct', channel: 0, operands: [imm(3), imm(CT_COND_ALWAYS)] },
  ];
  const addressesOf = (list: readonly AsmInstruction[]): number[] => {
    const addresses: number[] = [];
    let offset = 0;
    for (const instruction of list) {
      addresses.push(offset);
      offset += encoder.encode(instruction).length;
    }
    return addresses;
  };
  const draft = addressesOf(build(0));
  const bodyIndex = where === 'callee' ? 8 : 9;
  const callIndex = where === 'caller' ? 3 : 2;
  const target = (draft[bodyIndex]! - draft[callIndex]!) / 8;
  const instructions = build(target);
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, probeAddress: MINIMAL_BASE + addressesOf(instructions)[where === 'callee' ? 8 : 2]! };
}

/** Доступен ли `%rK`: признак — вызывающий дошёл до своего выхода (99), а не ловушка на пробе. */
function accessible(register: number, where: Where, sizeQ: number): { ok: boolean; why: string } {
  const built = program(register, where);
  const file = path.join(ROOT, '.tmp', `osnova-window-class-${sizeQ}-${where}-${register}.elf`);
  fs.writeFileSync(file, buildElfFromCode(built.bytes, MINIMAL_BASE).bytes);
  const run = runInQemu(file, { shim: true, timeoutMs: 30_000 });
  const status = run?.status ?? null;
  if (status === 99) return { ok: true, why: 'запись прошла, возврат пары сработал (99)' };
  if (run?.exceptionIp === built.probeAddress) return { ok: false, why: 'ловушка на самой пробе — регистра нет' };
  return { ok: false, why: `исключения нет либо оно не на пробе: статус ${String(status)}` };
}

/**
 * ИЗМЕРИТЬ порог окна: три пробы вокруг предсказанного — `expected − 1`, `expected`, `expected + 1`.
 * Возвращается не «да/нет», а ЧИСЛО (первый недоступный номер), чтобы сравнение с константой шло
 * с измерением, а не с предсказанием: иначе проверка была бы тавтологией.
 */
function threshold(where: Where, expected: number, sizeQ: number): { measured?: number; notes: string[] } {
  const notes: string[] = [];
  if (expected > 63 || expected < 1) {
    return { notes: [`${where}: предсказанный порог ${expected} вне поля слога (0..63) — измерять нечего`] };
  }
  const points = [expected - 1, expected, expected + 1];
  const seen = new Map<number, boolean>();
  for (const register of points) {
    const result = accessible(register, where, sizeQ);
    seen.set(register, result.ok);
    notes.push(`%r${register} — ${result.ok ? 'доступен' : `нет (${result.why})`}`);
  }
  if (seen.get(expected - 1) === false) return { measured: expected - 1, notes };
  if (seen.get(expected) === false) return { measured: expected, notes };
  if (seen.get(expected + 1) === false) return { measured: expected + 1, notes };
  return { notes: [...notes, `${where}: ни один из трёх не закрыт — порог выше ${expected + 1}`] };
}

const sizeQ = Number.parseInt(process.argv[2] ?? '8', 10);
const shim = buildShim();
if (shim === undefined) {
  console.error('шим не собран — прогон невозможен (docs/e2k-qemu-run.md §2.5)');
  process.exit(2);
}

/** Ровно та функция, чей готовый текст идёт в `src/e2k/windowGeometry.ts` (§3.44.4). */
function windowGeometryProblems(
  passport: { sizeQ: number; wbs: number; entry: number },
  constants: { callee: number; entry: number },
  measured: { callee: number; caller: number },
): string[] {
  const problems: string[] = [];
  const callee = 2 * (passport.sizeQ - passport.wbs);
  if (constants.callee !== callee) {
    problems.push(
      `константа окна вызываемой ${constants.callee}, а паспортная геометрия (size_q=${passport.sizeQ}, wbs=${passport.wbs}) даёт ${callee}`,
    );
  }
  if (constants.entry !== passport.entry) {
    problems.push(`константа окна входа ${constants.entry}, а пролог образа (rsz=${ARRAY_WINDOW_RSZ}) даёт ${passport.entry}`);
  }
  if (measured.callee !== constants.callee) {
    problems.push(`живая модель даёт вызываемой ${measured.callee}, а константа раскладки говорит ${constants.callee}`);
  }
  if (measured.caller < constants.entry) {
    problems.push(`живая модель даёт вызывающему ${measured.caller}, а константа входа требует ${constants.entry}`);
  }
  return problems;
}

const expectedCallee = 2 * (sizeQ - SYSCALL_WBS);
const expectedCaller = 2 * sizeQ;
console.log(`# паспортная геометрия: size_q = ${sizeQ}, wbs = ${SYSCALL_WBS}, psize_q = ${SYSCALL_WBS}`);
console.log(`# вызываемая по формуле: ${expectedCallee}; константа: ${WINDOW_REGISTERS_CALLEE}`);
console.log(`# вызывающий по формуле: ${expectedCaller}; константа входа: ${WINDOW_REGISTERS_ENTRY} (пролог: rsz=${ARRAY_WINDOW_RSZ} → ${2 * (ARRAY_WINDOW_RSZ + 1)})`);

const calleeBoundary = threshold('callee', expectedCallee, sizeQ);
const callerBoundary = threshold('caller', expectedCaller, sizeQ);
console.log(`измерено у вызываемой: ${calleeBoundary.notes.join('; ')}`);
console.log(`измерено у вызывающего: ${callerBoundary.notes.join('; ')}`);
const measured = {
  callee: calleeBoundary.measured ?? expectedCallee,
  caller: callerBoundary.measured ?? expectedCaller,
};

const problems = [
  ...(calleeBoundary.measured === expectedCallee
    ? []
    : [`порог вызываемой измерен как ${calleeBoundary.measured === undefined ? '«ни один из трёх не закрыт»' : calleeBoundary.measured}, а по формуле ${expectedCallee}`]),
  ...(callerBoundary.measured === expectedCaller
    ? []
    : [`порог вызывающего измерен как ${callerBoundary.measured === undefined ? '«ни один из трёх не закрыт»' : callerBoundary.measured}, а по формуле ${expectedCaller}`]),
  ...windowGeometryProblems(
    { sizeQ, wbs: SYSCALL_WBS, entry: 2 * (ARRAY_WINDOW_RSZ + 1) },
    { callee: WINDOW_REGISTERS_CALLEE, entry: WINDOW_REGISTERS_ENTRY },
    measured,
  ),
];

if (problems.length === 0) {
  console.log('# три числа сошлись: паспорт, константы раскладки и живая модель');
  process.exit(0);
}
console.log('# РАСХОЖДЕНИЯ (оракул класса красный — и это его работа):');
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(1);
