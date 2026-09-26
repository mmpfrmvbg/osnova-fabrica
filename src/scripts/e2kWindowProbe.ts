/**
 * ЗОНД ОКНА ВЫЗЫВАЕМОЙ ДЛЯ ЖИВОЙ МАШИНЫ (вопрос §3.18, вопрос №2 в `docs/e2k-hardware-access.md`).
 *
 * Зачем: все измерения окна сделаны на **нашей** сборке порта (QEMU 11.0.1 + локальная правка,
 * см. `src/e2k/qemuModelPassport.ts`), и «восемь регистров» — свойство этой сборки, а не
 * доказанное свойство e2k. Машина отвечает одной командой, поэтому зонд собран заранее.
 *
 * Конструкция (по образцу `src/e2k/e2kCallWindowQemu.test.ts`):
 *
 *   вызывающий: setbn → disp → call 1
 *   вызываемая: movts 42 → window_(K)  ← предмет вопроса
 *               movts 42 → %r1, movts SYS_EXIT → %r0, sdisp, call 2
 *
 * Смысл ответа: код возврата **42** — запись в `%rK` прошла, то есть окно вызываемой шире, чем
 * считает модель; любой другой статус (ловушка) — модель права.
 *
 * Скрипт САМ СЕБЯ ПРОВЕРЯЕТ перед отправкой на машину — иначе зонд, который ничего не проверяет,
 * отправить нельзя:
 *
 *   контроль  `%r7` — обязан дать **42** (регистр внутри окна модели);
 *   вопрос    `%r8` — на модели обязан **НЕ** дать 42 (ловушка).
 *
 * Не сойдётся — скрипт падает и ничего не пишет в кит.
 *
 *   npx tsx src/scripts/e2kWindowProbe.ts
 *
 * # СОСТОЯНИЕ 2026-09-26: первая редакция зонда НЕ ГОДНА, и вот почему (измерено этим скриптом)
 *
 * Контроль (`%r7`, регистр внутри окна модели) дал статус **9**, а не 42. Статус 9 — гостевое
 * исключение порта, то есть **вызываемая не может сделать системный вызов сама**: номер ABI
 * лежит в `%r8`, которого у вызываемой нет (`e2kCallWindowQemu.test.ts`, шапка файла). Возврат
 * из вызываемой на порте исполняется **парой** `return %ctpr3` + `ct %ctpr3`, а не выходом.
 *
 * Значит вопрос «сколько регистров у вызываемой» нельзя задать так, как я его задал. Правильная
 * конструкция (следующая редакция): вызываемая пишет метку **в память** (в записываемую область
 * образа, `buildElfFromCode(..., { writable: true })`), возвращается парой; вызывающий читает
 * память и выходит кодом метки (42), если запись прошла, и кодом 7, если память не изменилась.
 *
 * Скрипт намеренно **отказывается писать бинарь в кит**, пока контроль не сходится: зонд,
 * который ничего не проверяет, отправлять на машину нельзя.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from '../e2k/backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from '../e2k/elfMinimal';
import { HELLO_SETBN_RSZ, SYS_EXIT, WINDOW_NUMBER_REGISTER } from '../e2k/syscallRuntime';
import { buildShim, runInQemu } from './e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const KIT_BIN = path.join(ROOT, 'tools', 'e2k-hardware', 'bin');
const EXPECTED_EXIT = 42;
const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Программа зонда: вызываемая пишет в свой `%rK` и выходит кодом 42. */
function program(register: number): Uint8Array {
  const body: AsmInstruction[] = [
    { mnemonic: 'movts', channel: 0, operands: [imm(EXPECTED_EXIT), window_(register)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(EXPECTED_EXIT), window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(2), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(2), imm(SYSCALL_WBS)] },
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
  /** Цель перехода считается по длинам КОДИРОВАНИЯ: иначе `disp` уезжает (урок прошлой редакции). */
  const build = (callTarget: number): AsmInstruction[] => [
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(callTarget)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    // Если управление вернулось — выйти кодом 99: это не наш ответ, но и не молчание.
    { mnemonic: 'movts', channel: 0, operands: [imm(99), window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(2), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(2), imm(SYSCALL_WBS)] },
    ...body,
  ];
  const draft = build(0);
  const draftAddresses = addressesOf(draft);
  const calleeIndex = draft.length - body.length;
  const target = (draftAddresses[calleeIndex]! - draftAddresses[1]!) / 8;
  if (!Number.isInteger(target)) throw new Error('цель перехода не кратна 8 байтам');
  const instructions = build(target);
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function main(): void {
  const shim = buildShim();
  if (shim === undefined) {
    console.log('шим не собран — прогон в модели недоступен, зонд не проверен и не записан');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(KIT_BIN, { recursive: true });

  const results: { name: string; register: number; status: number | null; expected: string }[] = [];
  const cases: { name: string; register: number; mustBe42: boolean }[] = [
    { name: 'probe-window-control.elf', register: 7, mustBe42: true },
    { name: 'probe-window.elf', register: 8, mustBe42: false },
  ];

  for (const item of cases) {
    const elf = buildElfFromCode(program(item.register), MINIMAL_BASE).bytes;
    const file = path.join(KIT_BIN, item.name);
    fs.writeFileSync(file, elf);
    const run = runInQemu(file, { shim: true, timeoutMs: 30_000 });
    const status = run?.status ?? null;
    const ok = item.mustBe42 ? status === EXPECTED_EXIT : status !== EXPECTED_EXIT;
    results.push({
      name: item.name,
      register: item.register,
      status,
      expected: item.mustBe42 ? `обязан дать ${String(EXPECTED_EXIT)}` : `на модели обязан НЕ дать ${String(EXPECTED_EXIT)}`,
    });
    if (!ok) {
      console.log(
        `ПРОВЕРКА НЕ СОШЛАСЬ: ${item.name}, %r${String(item.register)} → статус ${String(status)}; ` +
          `ожидалось: ${item.mustBe42 ? String(EXPECTED_EXIT) : `не ${String(EXPECTED_EXIT)}`}. ` +
          'Зонд не записан в кит — сначала разобрать.',
      );
      process.exitCode = 1;
      return;
    }
  }

  for (const item of results) {
    console.log(`${item.name}: %r${String(item.register)} → статус ${String(item.status)} (${item.expected})`);
  }
  console.log('зонд проверен на модели и записан в tools/e2k-hardware/bin/');
  console.log('ответ машины: 42 — окно ШИРЕ, чем считает модель; ловушка — модель права');
}

main();
