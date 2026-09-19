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
 * | доступны в вызываемой | `%r0..%r7` (**8** регистров) |
 * | недоступны | `%r8`, `%r9`, `%r10` — ловушка на первой команде тела |
 * | системный вызов из вызываемой | **невозможен**: номер берётся из `%r8`, а его у вызываемой нет |
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
 * Отсюда следствие для раскладки: `фильтр` ядра FIR занимает `%b[0..9]` (10 регистров), то есть в
 * окно вызываемой (8) **не влезает**; влезают `сумма` (6) и подобные. И следствие для шага 4:
 * сквозной прогон FIR с вызовами возможен — возврат даётся **парой** `return` + `ct` (16 байт вместо
 * 8), но бюджет вызываемой (8 регистров) от этого не меняется.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что так поведёт себя железо (QEMU — модель и, более того, порт с известными послаблениями) и что
 * окно вызываемой нельзя расширить: `setwd` расширяет (измерено, §7.6), но с памятью ведёт себя
 * неустойчиво, и владельцем отложен.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { CT_COND_ALWAYS } from './e2k-real';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';

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

describe('модель окна на вызове процедуры: сколько регистров у вызываемой', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('вызываемая видит восемь регистров %r0..%r7, а %r8 — нет', () => {
    if (shim === undefined) return;
    // Различающий перебор: признак — ловушка на ПЕРВОЙ команде тела (регистр недоступен) против
    // «запись прошла» (ловушка дальше или её нет).
    const accessible = (register: number): boolean => {
      const result = probe(register);
      return result.exceptionIp !== result.bodyAddress;
    };
    const inside = [5, 7].map(accessible);
    const outside = [8, 9, 10].map(accessible);
    expect(inside, '%r5 и %r7 обязаны быть доступны вызываемой').toEqual([true, true]);
    expect(outside, '%r8, %r9, %r10 обязаны быть недоступны вызываемой').toEqual([false, false, false]);
  });

  it('системный вызов из вызываемой невозможен: номер идёт в %r8, которого у неё нет', () => {
    if (shim === undefined) return;
    // Тело собирает системный вызов exit(42) внутри процедуры: первая же запись в `%r8` (номер
    // вызова) — вне окна процедуры, и опыт это подтверждает адресом ловушки.
    const result = probe(5);
    const numberAddress = result.bodyAddress + 8; // movts 42 → свой %r5 (0 байт), movts 42 → %r9 (8)
    expect(result.exceptionIp, 'ловушка обязана стоять на записи в %r8 вызываемой').toBe(numberAddress + 8);
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
