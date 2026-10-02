/**
 * ОРАКУЛ МОДЕЛИ ОКНА НА ВЫЗОВЕ ПРОЦЕДУРЫ: сколько регистров у вызываемой и что делает `return`.
 *
 * # Зачем это отдельный опыт
 *
 * Шаг 3 критического пути — «`call`/`ret` и модель окна» — начинается не с кода, а с замера: сколько
 * регистров у вызываемой процедуры и возвращает ли управление `return %ctpr3`. Без этих двух чисел
 * раскладка регистров для вызываемой процедуры не определена: у вызывающего окно 16 регистров, а у
 * вызываемой оно **уже** (модель: `call wbs` уменьшает `size_q` — `qemu/target/e2k/tcg/translate-ct.c`
 * `e2k_cpu_exec_ct_CALL`, `base_q += wbs`, `size_q -= wbs`, `BR = 0`; индекс окна —
 * `reg-index.h:55-81`, `size_d = 2*size_q`).
 *
 * # Опыты (различающие, а не «посмотрим»)
 *
 * 1. **Окно вызываемой:** тело процедуры пишет 42 в СВОЙ `%rK`, затем выходит системным вызовом
 *    изнутри себя. Признак — **адрес ловушки**: ловушка на первой команде тела значит «регистр
 *    недоступен», иначе запись прошла. Перебор `K` даёт границу; признак различает два исхода, а
 *    одно наблюдение не доказывало бы ничего.
 * 2. **Возврат:** тело пишет свой `%r7` и возвращается — тремя способами: (а) одна CS0 `return %ctpr3`;
 *    (б) одна SS `ct %ctpr3`; (в) пара `return %ctpr3` + `ct %ctpr3`. Вызывающий после возврата выходит
 *    кодом 99. Ожидание «99» — успех; иное — названная причина.
 *
 * # Что измерено (07.2026, и почему это записано как результат, а не как успех)
 *
 * | наблюдение | число |
 * |---|---|
 * | доступны в вызываемой | при `size_q = 8` было `%r0..%r7` (**8**); с 2026-09-28 порт собран с `size_q = 12` и доступны `%r0..%r15` (**16**, §3.49) |
 * | недоступны | первый регистр СНАРУЖИ окна — ловушка на первой команде тела: при 8 это `%r8`, при 16 это `%r16` |
 * | системный вызов из вызываемой | при 8 был **невозможен** (номер идёт в `%r8`); при 16 запись в `%r8` ПРОХОДИТ, и отказ съезжает на вложенный `call` — его отвергает `psize_q` (§3.49) |
 * | `return %ctpr3` (CS0) **одна** | порт **падает на утверждении** `op_descr->is_al` (`translate-lookahead.c:318`, `e2k_update_used_regs_context`), статус 134 |
 * | `ct %ctpr3` (SS) **одна**, без подготовки | гостевое исключение на самой `ct`: `call` стирает ctpr в пустой тег `CTPEW` (`translate-ct.c:1135-1138`), статус 9 |
 * | `return %ctpr3` **и** `ct %ctpr3` подряд | **управление возвращается**: вызывающий доходит до своего выхода, статус **99** |
 *
 * **Поправка (07.2026).** Прежняя запись «системный вызов вызывающего после возврата теряет геометрию
 * окна» **неверна и снята**: она наблюдалась тогда, когда возврата не было вовсе (порт падал на
 * утверждении), и падение приписывалось возврату. В опыте с работающей парой выход вызывающего
 * (`exit(99)`) проходит — геометрия окна восстанавливается из кадра вызова
 * (`e2k_cpu_exec_ct_return`, `translate-ct.c:27-67`). Подробности и предложение правки порта —
 * `docs/e2k-return-port.md`.
 *
 * Отсюда следствие для раскладки: `фильтр` ядра FIR занимает `%b[0..9]` (10 регистров) — при окне 8 он
 * **не влезал**, при окне 16 влезает, и это ИЗМЕРЕНО порогом, а не выведено: `firstClosedRegister`
 * даёт 16 у вызываемой и 24 у вызывающего (§3.49).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что так поведёт себя железо (QEMU — модель и, более того, порт с известными послаблениями) и что
 * окно вызываемой нельзя расширить: `setwd` расширяет (измерено, §7.6), но с памятью ведёт себя
 * неустойчиво, и владельцем отложен. И что расширения окна достаточно для вызова из процедуры:
 * вложенный `call` отвергает `psize_q` — это свойство ПОРТА, а не окна (§3.49).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { CT_COND_ALWAYS } from './e2k-real';
import { WINDOW_REGISTERS_CALLEE } from './regAlloc';
import { passportWindow, windowGeometryProblems } from './windowGeometry';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';
import { runOnE2k } from '../scripts/e2kProgramRun';
import { regModuleOf } from '../vliw/regOracle';
import { RegVM } from '../runtime/vm/reginterpreter';
import { createDefaultInvokeHandler } from '../runtime/vm/interpreter';
import { resolveEntryIndex } from '../oracle/parity';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Чем заканчивается тело процедуры: своим системным вызовом, одной CS0-формой, или парой `return` + `ct`. */
type ReturnForm = 'exit' | 'cs0' | 'ss' | 'pair';

/**
 * Программа: вызывающий зовёт процедуру; процедура либо выходит сама, либо возвращается.
 *
 * Адреса считаются по длине **кодирования** каждой команды, а цель `disp` — из этих адресов: прошлая
 * редакция опыта считала адреса вручную, цель уезжала, и выводы были недействительны. Признак
 * (адрес ловушки) проверяется против того же расчёта.
 */
function program(register: number, returnForm: ReturnForm): { bytes: Uint8Array; bodyAddress: number; returnAddress: number } {
  const returnBody: Record<ReturnForm, AsmInstruction[]> = {
    exit: [
      { mnemonic: 'movts', channel: 0, operands: [imm(42), window_(WINDOW_NUMBER_REGISTER + 1)] },
      { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
      { mnemonic: 'sdisp', channel: 0, operands: [imm(2), imm(0)] },
      { mnemonic: 'call', channel: 0, operands: [imm(2), imm(SYSCALL_WBS)] },
    ],
    // CS0-форма: в порте это НЕ переход, а подготовка ctpr3 (`translate-ctp.c:110-141`), прыжка нет.
    cs0: [{ mnemonic: 'return', channel: 0, operands: [imm(3)] }],
    // SS-форма без подготовки: ctpr3 пуст (`call` стирает ctpr в тег `CTPEW`), поэтому это ловушка.
    ss: [{ mnemonic: 'ct', channel: 0, operands: [imm(3), imm(CT_COND_ALWAYS)] }],
    // Пара: подготовка плюс переход — именно так возврат исполняется в порте.
    pair: [
      { mnemonic: 'return', channel: 0, operands: [imm(3)] },
      { mnemonic: 'ct', channel: 0, operands: [imm(3), imm(CT_COND_ALWAYS)] },
    ],
  };
  const build = (callTarget: number): AsmInstruction[] => [
    // ── вызывающий ──────────────────────────────────────────────────────────────
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(55), window_(8)] },
    { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(callTarget)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    // ── если управление вернулось: выйти кодом 99 ───────────────────────────────
    { mnemonic: 'movts', channel: 0, operands: [imm(99), window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(2), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(2), imm(SYSCALL_WBS)] },
    // ── процедура ───────────────────────────────────────────────────────────────
    { mnemonic: 'movts', channel: 0, operands: [imm(42), window_(register)] },
    ...returnBody[returnForm],
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
  const draft = build(0);
  const draftAddresses = addressesOf(draft);
  const target = (draftAddresses[8]! - draftAddresses[2]!) / 8;
  expect(Number.isInteger(target), 'цель перехода не кратна 8 байтам').toBe(true);
  const instructions = build(target);
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const addresses = addressesOf(instructions);
  return {
    bytes,
    bodyAddress: MINIMAL_BASE + addresses[8]!,
    returnAddress: MINIMAL_BASE + (addresses[9] ?? addresses[8]!),
  };
}

/** Прогнать программу: тело пишет в свой `%rK`; признак — адрес ловушки. */
function probe(register: number, returnForm: ReturnForm = 'exit'): { status: number | null; exceptionIp?: number; tail: string; bodyAddress: number } {
  const built = program(register, returnForm);
  const file = path.join(ROOT, '.tmp', `e2k-call-window-${register}-${returnForm}.elf`);
  fs.writeFileSync(file, buildElfFromCode(built.bytes, MINIMAL_BASE).bytes);
  const run = runInQemu(file, { shim: true, timeoutMs: 30_000 });
  return {
    status: run?.status ?? null,
    ...(run?.exceptionIp === undefined ? {} : { exceptionIp: run.exceptionIp }),
    tail: (run?.output ?? '').trim().split('\n').slice(-1)[0] ?? '',
    bodyAddress: built.bodyAddress,
  };
}

const shim = buildShim();

/**
 * Проба «пишет СВОЙ `%rK` вызывающий»: тело возвращается парой, вызывающий выходит кодом 99.
 *
 * Вторая сторона той же пробы нужна потому, что окно вызывающего (`2*size_q`) и окно вызываемой
 * (`2*(size_q − wbs)`) — РАЗНЫЕ числа, и оракул класса (§3.44.4) требует измерить оба.
 */
function programCaller(register: number): { bytes: Uint8Array; probeAddress: number } {
  const build = (callTarget: number): AsmInstruction[] => [
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(42), window_(register)] }, // ← проба (индекс 2)
    { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(callTarget)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(99), window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(2), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(2), imm(SYSCALL_WBS)] },
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
  const draftAddresses = addressesOf(build(0));
  const target = (draftAddresses[8]! - draftAddresses[2]!) / 8;
  expect(Number.isInteger(target), 'цель перехода не кратна 8 байтам').toBe(true);
  const instructions = build(target);
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, probeAddress: MINIMAL_BASE + addressesOf(instructions)[2]! };
}

/** Проба со стороны: у вызываемой — запись в теле (пара `return`+`ct`), у вызывающего — до вызова. */
function probeSide(where: 'callee' | 'caller', register: number): { status: number | null; exceptionIp?: number; probeAddress: number } {
  const built = where === 'callee' ? program(register, 'pair') : programCaller(register);
  const probeAddress = where === 'callee' ? built.bodyAddress : built.probeAddress;
  const file = path.join(ROOT, '.tmp', `e2k-window-threshold-${where}-${String(register)}.elf`);
  fs.writeFileSync(file, buildElfFromCode(built.bytes, MINIMAL_BASE).bytes);
  const run = runInQemu(file, { shim: true, timeoutMs: 30_000 });
  return {
    status: run?.status ?? null,
    ...(run?.exceptionIp === undefined ? {} : { exceptionIp: run.exceptionIp }),
    probeAddress,
  };
}

/**
 * Первый недоступный номер у вызываемой / у вызывающего: порог ИЗМЕРЯЕТСЯ, а не предполагается.
 *
 * Признак доступности тот же, что уже измерен в этом файле: проба пишет 42 в СВОЙ `%rK`, тело
 * возвращается парой `return` + `ct`, и вызывающий доходит до своего выхода — код 99; недоступный
 * регистр даёт ловушку на самой пробе, её адрес известен
 * (построитель — `.tmp/osnova-window-ladder.ts`, им снята вся лестница §3.36).
 */
function firstClosedRegister(where: 'callee' | 'caller', around: number): number {
  for (const register of [around - 1, around, around + 1]) {
    if (register < 0 || register > 63) continue; // поле слога — шесть бит (0..63)
    const result = probeSide(where, register);
    if (result.status !== 99 || result.exceptionIp === result.probeAddress) return register;
  }
  throw new Error(`ни один из %r${String(around - 1)}..%r${String(around + 1)} не закрыт: порог выше предсказанного`);
}

describe('модель окна на вызове процедуры: сколько регистров у вызываемой', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('геометрия окна: паспорт, константы раскладки и ЖИВАЯ модель дают одно число', () => {
    if (shim === undefined) return;
    // Порог измеряется по обе стороны: у вызываемой — запись в теле, у вызывающего — до вызова.
    const passport = passportWindow();
    const measured = {
      callee: firstClosedRegister('callee', passport.callee),
      caller: firstClosedRegister('caller', passport.caller),
    };
    const problems = windowGeometryProblems(measured);
    expect(problems, problems.join('; ')).toEqual([]);
    // Числом, а не только «нет расхождений»: 2*(12−4) = 16 у вызываемой и 2*12 = 24 у вызывающего.
    expect(measured.callee, 'измеренный порог вызываемой').toBe(passport.callee);
    expect(measured.caller, 'измеренный порог вызывающего').toBe(passport.caller);
  });

  it('системный вызов из вызываемой: исход СЛЕДУЕТ из измеренной геометрии, а не утверждается', () => {
    if (shim === undefined) return;
    // Тело собирает системный вызов exit(42) внутри процедуры: запись номера идёт в `%r8` её окна.
    const result = probe(5);
    const numberAddress = result.bodyAddress + 32; // тело: %r5 ← 42 (0, 16 б), %r9 ← 42 (16, 16 б), %r8 ← SYS_EXIT (32)
    const callAddress = result.bodyAddress + 48; // затем sdisp (40) и на 48 сама `call %ctpr2, wbs=4`
    if (WINDOW_REGISTERS_CALLEE < WINDOW_NUMBER_REGISTER + 2) {
      // окно уже, чем номер и аргумент: запись номера вне окна — ловушка, и это названо адресом
      expect(result.exceptionIp, 'ловушка обязана стоять на записи в %r8 вызываемой').toBe(numberAddress);
      return;
    }
    // Окно 16 вмещает и номер, и аргумент — запись ПРОХОДИТ, и отказ съезжает на ВЛОЖЕННЫЙ ВЫЗОВ:
    // `call wbs = 4` из процедуры порт отвергает, потому что `call` ставит вызываемой
    // `psize_q = size_q − wbs = 8`, а вложенный вызов обязан иметь `wbs ≥ psize_q`
    // (`translate-ct.c`, `helper_e2k_prep_ct_CALL`: `wbs < psize_q` → исключение).
    //
    // Точный адрес ловушки здесь НЕ утверждается, и это не уступка: порт называет адрес по границам
    // ПАКЕТОВ (то же свойство измерено на `ct`: тело 0x100068, `ct` 0x100070, ловушка 0x100078), и
    // сдвиг тела на 8 байт переносит названный адрес на пакет назад — при том же дефекте. Поэтому
    // проверяется ИСХОД (кода 42 нет) и что ловушка лежит в хвосте тела, начиная с записи номера.
    //
    // Различающий замер — `.tmp/osnova-proc-syscall.ts`: то же тело даёт ловушку РОВНО на `call`
    // (0x100098, тело 0x100068), а вариант БЕЗ системного вызова и БЕЗ записи в `%r8` — на своём
    // `call` (0x100070). Значит дело не в системном вызове и не в доступе к регистру, а во
    // вложенном вызове. Что это значит для печати из процедуры — `docs/hardware-debt.md` §3.49.
    expect(result.status, 'системный вызов из процедуры ещё не исполняется').toBe(9);
    expect(
      result.exceptionIp ?? 0,
      `ловушка обязана лежать в хвосте тела (запись номера ${String(numberAddress)} … вызов ${String(callAddress)})`,
    ).toBeGreaterThanOrEqual(numberAddress);
    expect(result.exceptionIp ?? 0, 'ловушка не может стоять раньше записи номера').toBeLessThanOrEqual(callAddress);
  });

  it('одна `return %ctpr3` в этом порте не возвращает — названа причина, а не «не получилось»', () => {
    if (shim === undefined) return;
    const result = probe(7, 'cs0');
    if (result.status === 99) {
      // Если порт когда-нибудь начнёт возвращать управление, это надо увидеть здесь, а не в отчёте:
      // оракул фиксирует оба исхода и требует, чтобы исход был НАЗВАН.
      expect(result.status, 'возврат сработал — обновите документацию модели окна').toBe(99);
      return;
    }
    expect(result.status, 'ожидался либо код 99, либо падение порта на утверждении').toBe(134);
    expect(result.tail, 'падение обязано быть названо утверждением порта').toMatch(/Assertion failed|is_al/);
  });

  it('одна `ct %ctpr3` не возвращает: `call` стирает ctpr3 в пустой тег, ловушка на самой `ct`', () => {
    if (shim === undefined) return;
    const result = probe(7, 'ss');
    // Измерено: в вызванной процедуре порт называет адрес ловушки на **следующей** команде после `ct`
    // (тело 0x100068, `ct` на 0x100070, ловушка 0x100078). Для одиночной `ct` в начале программы порт
    // называл её собственный адрес — то есть адрес ловушки у порта зависит от места, и это его
    // свойство, а не наше. Поэтому проверяем названное число, а не «примерно там».
    expect(result.exceptionIp, 'ловушка обязана стоять на команде после `ct`').toBe(result.bodyAddress + 16);
    expect(result.status, 'исход обязан быть назван гостевым исключением, а не утверждением порта').toBe(9);
    expect(result.tail, 'причина обязана быть названа').toMatch(/exception/);
  });

  it('пара `return %ctpr3` + `ct %ctpr3` возвращает управление: вызывающий выходит кодом 99', () => {
    if (shim === undefined) return;
    const result = probe(7, 'pair');
    expect(
      result.status,
      'пара обязана вернуть управление (99); если здесь 134 — порт падает на утверждении, смотрите docs/e2k-return-port.md',
    ).toBe(99);
  });
});

/**
 * СТОРОЖ ВТОРОГО СЛУЧАЯ ТОГО ЖЕ МЕХАНИЗМА — на настоящей программе, а не на синтетическом теле.
 *
 * Фикстура `src/runtime/fixtures/cycle_nested.osnova` (вложенные циклы в двух вызываемых) давала на
 * модели **92** против эталона **91** — разница ровно +1. Это тот же механизм, что
 * `docs/hardware-debt.md` §3.96: выход программы считает `код = значение + %b[12]`, а `%b[4]`
 * вызываемой — это ровно `%b[12]` вызывающего, и одна из вызываемых оставляла там **1**.
 *
 * Доказано откатом: со снятым бюджетом регистров вызываемой (`src/e2k/programImage.ts`) фикстура
 * снова даёт 92, с бюджетом — 91. Замер — `.tmp/osnova-cycle-nested.ts`.
 *
 * ПОЧЕМУ СТОРОЖ ЗДЕСЬ, А НЕ В КОРПУСЕ. Фикстуры `src/runtime/fixtures/**` не входят в `examples/**`,
 * и оракул корпуса (`src/scripts/examplesE2k.audit.test.ts`) их не видит: до этой проверки у
 * `cycle_nested` на МОДЕЛИ не было ни одного сторожа — случай был измерен и ничем не держался.
 *
 * Эталон считается регистровой VM, а не берётся числом из комментария фикстуры: разойдись они —
 * это находка, а не совпадение.
 */
describe('вложенные циклы в вызываемых: значение не портится бюджетом регистров', () => {
  const ФИКСТУРА = path.join(ROOT, 'src', 'runtime', 'fixtures', 'cycle_nested.osnova');

  it('эталон: регистровая VM даёт 91 (55 + 36)', async () => {
    const source = fs.readFileSync(ФИКСТУРА, 'utf-8');
    const built = regModuleOf(source);
    expect(built, 'фикстура обязана компилироваться').not.toBeNull();
    const entry = resolveEntryIndex(built!.module.procedures, undefined) ?? 0;
    const vm = new RegVM(built!.module, { invoke: createDefaultInvokeHandler(), maxSteps: 500_000 });
    const значение = Number(await vm.runProcedure(entry, []));
    expect(значение, 'сумма квадратов 55 плюс таблица сумм 36').toBe(91);
  });

  it('модель даёт то же число 91 (со снятым бюджетом вызываемой — 92)', () => {
    if (shim === undefined) return;
    const source = fs.readFileSync(ФИКСТУРА, 'utf-8');
    const прогон = runOnE2k(source, 'cycle-nested-guard.elf');
    expect(прогон.refused, 'отказов понижения у этой фикстуры быть не должно').toEqual([]);
    expect(
      прогон.status,
      'выход программы считает `код = значение + %b[12]`, а `%b[4]` вызываемой — это `%b[12]` ' +
        'вызывающего: 92 здесь значит, что раскладка снова отдала вызываемой регистры вызывающего',
    ).toBe(91);
  });
});
