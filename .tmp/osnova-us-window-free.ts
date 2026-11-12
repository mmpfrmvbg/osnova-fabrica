/**
 * СКОЛЬКО РЕГИСТРОВ ОТКРЫВАЕТ ВЫРОСШЕЕ ОКНО — И КАКИЕ ИМЕННО (task-30, шаг 1).
 *
 * Вопрос один: в процедуре, которая растит окно своим прологом (`setwd wsz=16` + `setbn rsz=15` —
 * так, как это делает конвейер, §3.56.5 правила 1–2), какие номера регистров РЕАЛЬНО адресуемы.
 * Это и есть «сколько свободно»: раскладка берёт `%b[0..9]`, рантайм массивов держит `%b[12..15]`,
 * печать портит `%b[0..11]` целиком (§3.46.3), значит свободными могут быть только номера ВЫШЕ 15.
 *
 * # Признак (различающий, а не «посмотрим»)
 *
 * Тело A пишет 42 в СВОЙ `%rK`, читает обратно и возвращает прочитанное; `main` отдаёт это кодом
 * возврата. Код `42` — регистр есть и запись прошла; код `9` — ловушка на самой записи; иной код —
 * названная причина (её печатает проба вместе с адресом ловушки).
 *
 * # Контроль В ОБЕ СТОРОНЫ (без него замер не различает)
 *
 * | режим | ожидание |
 * |---|---|
 * | `grow` — пролог A растит окно | `%r15` есть (своё окно), `%r16…%r31` — ОТКРЫТЫ ростом, `%r32` — нет |
 * | `no-grow` — тот же A БЕЗ пролога | `%r15` есть, `%r16…%r32` — нет (свободных нет вовсе) |
 *
 * Строка `%r15` стоит в обоих режимах: она доказывает, что в программе без роста проба ИСПРАВНА,
 * то есть ловушка на `%r16` означает «регистра нет», а не «сломана проба».
 *
 * Запуск: `npx tsx .tmp/osnova-us-window-free.ts`
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from '../src/e2k/backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from '../src/e2k/elfMinimal';
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from '../src/e2k/syscallRuntime';
import { CT_COND_ALWAYS } from '../src/e2k/e2k-real';
import { buildShim, runInQemu } from '../src/scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..');
const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Числа роста окна — те же, что у конвейера (`WINDOW_GROW_WSZ`/`WINDOW_GROW_RSZ` в procedureCall.ts). */
const GROW_WSZ = 16;
const GROW_RSZ = 15;

type Mode = 'grow' | 'no-grow';

/** Программа: `main →(wbs=4) A`; A пишет 42 в свой `%rK`, читает обратно и возвращает прочитанное. */
function program(mode: Mode, register: number): { bytes: Uint8Array; marks: Map<string, number> } {
  const build = (targetA: number): AsmInstruction[] => [
    // ── main ────────────────────────────────────────────────────────────────────
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: 'disp', channel: 0, operands: [imm(1), imm(targetA)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    // значение из A приходит в %r8 = %r(2*wbs); сперва читаем, потом кладём номер вызова
    { mnemonic: 'movts', channel: 0, operands: [window_(2 * SYSCALL_WBS), window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    // ── A ───────────────────────────────────────────────────────────────────────
    ...(mode === 'grow'
      ? ([
          { mnemonic: 'setwd', channel: 0, operands: [imm(GROW_WSZ), imm(0)] },
          { mnemonic: 'setbn', channel: 0, operands: [imm(GROW_RSZ), imm(0), imm(0)] },
        ] satisfies AsmInstruction[])
      : []),
    { mnemonic: 'movts', channel: 0, operands: [imm(42), window_(register)] },
    { mnemonic: 'movts', channel: 0, operands: [window_(register), window_(0)] },
    { mnemonic: 'return', channel: 0, operands: [imm(3)] },
    { mnemonic: 'ct', channel: 0, operands: [imm(3), imm(CT_COND_ALWAYS)] },
  ];
  const addressesOf = (list: readonly AsmInstruction[]): number[] => {
    const out: number[] = [];
    let offset = 0;
    for (const instruction of list) {
      out.push(offset);
      offset += encoder.encode(instruction).length;
    }
    return out;
  };
  const draft = addressesOf(build(0));
  const aStart = 7;
  const aLen = mode === 'grow' ? 2 : 0;
  const targetA = (draft[aStart]! - draft[1]!) / 8;
  const instructions = build(targetA);
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const addresses = addressesOf(instructions);
  return {
    bytes,
    marks: new Map([
      ['main: call A', MINIMAL_BASE + addresses[2]!],
      ['A: пролог роста', MINIMAL_BASE + addresses[aStart]!],
      ['A: запись в %rK', MINIMAL_BASE + addresses[aStart + aLen]!],
      ['A: возврат', MINIMAL_BASE + addresses[aStart + aLen + 2]!],
    ]),
  };
}

const REGISTERS: readonly number[] = [3, 15, 16, 17, 23, 24, 30, 31, 32];

const shim = buildShim();
if (shim === undefined) {
  console.error('шим не собран: прогон невозможен (docs/e2k-qemu-run.md §2.5)');
  process.exit(2);
}

console.log('# окно: `setwd wsz=16` + `setbn rsz=15` в прологе A; вызов A из main — wbs=4');
console.log('# код 42 = регистр адресуем и запись проходит; 9 = ловушка; иное — причина названа адресом');
console.log('режим      %rK   код   что значит');
const raw: Record<string, unknown>[] = [];
for (const mode of ['grow', 'no-grow'] as const) {
  for (const register of REGISTERS) {
    const built = program(mode, register);
    const file = path.join(ROOT, '.tmp', `osnova-us-free-${mode}-${String(register)}.elf`);
    fs.writeFileSync(file, buildElfFromCode(built.bytes, MINIMAL_BASE).bytes);
    const run = runInQemu(file, { shim: true, timeoutMs: 30_000 });
    const status = run?.status ?? null;
    const ip = run?.exceptionIp;
    const where =
      ip === undefined
        ? ''
        : `, ловушка ${[...built.marks.entries()].find(([, address]) => address === ip)?.[0] ?? `0x${ip.toString(16)}`}`;
    const verdict =
      status === 42
        ? 'регистр ЕСТЬ, запись прошла'
        : status === 9
          ? 'ловушки: регистра НЕТ'
          : `иной исход${where}`;
    console.log(`${mode.padEnd(10)} %r${String(register).padEnd(4)} ${String(status).padStart(3)}   ${verdict}`);
    raw.push({ mode, register, status, exceptionIp: ip ?? null, file: path.basename(file) });
  }
}
fs.writeFileSync(
  path.join(ROOT, '.tmp', 'osnova-us-window-free.json'),
  `${JSON.stringify(raw, null, 2)}\n`,
  'utf-8',
);
console.log('# сырые прогоны: .tmp/osnova-us-window-free.json');
