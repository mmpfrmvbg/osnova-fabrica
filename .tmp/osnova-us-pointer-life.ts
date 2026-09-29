/**
 * ПЕРЕЖИВАЕТ ЛИ УКАЗАТЕЛЬ СТЕКА ВЛОЖЕННЫЙ ВЫЗОВ И ПЕЧАТЬ (task-30, шаг 2).
 *
 * # Что измеряется
 *
 * Указатель берётся `getsp` и кладётся в СВОБОДНЫЙ регистр выросшего окна (`%b[16..31]` — шаг 1,
 * `.tmp/osnova-us-window-free.ts`). По указателю кладётся маркер (`79` = «O»). Затем:
 *
 *   1. **вложенный вызов** — `main` зовёт процедуру A с законным `wbs` (при выросшем до 16 окне
 *      это 8, §3.56.5 правило 3);
 *   2. **печать** — настоящая последовательность конвейера (`numberToTextPrimitives` +
 *      `writeTextPrimitives` из `src/e2k/printPrimitives.ts`), а не «похожая»: она портит `%b[0..11]`
 *      целиком (§3.46.3), и указатель обязан уцелеть именно после неё;
 *   3. **проверка** — маркер читается ОБРАТНО через тот же указатель; код возврата равен
 *      прочитанному. `79` — указатель и память целы; иное — названная причина (её видно по адресу
 *      ловушки и по коду).
 *
 * # Варианты (без них замер не различает)
 *
 * | вариант | что меняется | что этим проверяется |
 * |---|---|---|
 * | `V0-нет-роста` | роста окна нет, указатель в `%b[16]` | положительный контроль: свободных нет — `getsp` в `%b[16]` обязан встать ловушкой |
 * | `V1-тихая` | рост 16/15, `wbs=8`, A НИЧЕГО не пишет | переживает ли указатель сам вызов и печать |
 * | `V2-громкая` | то же, но A пишет свои `%b[0..9]` (так делает раскладка) | окно вызываемой НАКРЫВАЕТ `%b[16..25]` вызывающего — указатель там гибнет |
 * | `V3-громкая-край` | то же, указатель в `%b[31]` | какие номера выживают, а какие нет — граница, а не «вроде» |
 * | `V4-банк` | рост 32/31 и `wbs=16`: вызываемая живёт в `%b[32..63]` | если банк 16..31 не накрывается вызовом — вот конструкция, где указатель постоянен |
 *
 * Запуск: `npx tsx .tmp/osnova-us-pointer-life.ts`
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from '../src/e2k/backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from '../src/e2k/elfMinimal';
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from '../src/e2k/syscallRuntime';
import { CT_COND_ALWAYS } from '../src/e2k/e2k-real';
import { HEAP_OFFSET } from '../src/e2k/programImage';
import { numberToTextPrimitives, writeTextPrimitives } from '../src/e2k/printPrimitives';
import { buildShim, runInQemu } from '../src/scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..');
const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

const HEAP = MINIMAL_BASE + HEAP_OFFSET;
/** Маркер: он же код «уцелело» — 79 = 0x4f = 'O'. */
const MARKER = 79;

/** Сырые байты `getsp,0 <литерал>, <приёмник>` (§3.46.1): байт 4 — приёмник, 0x80 — оконный файл. */
function getspBytes(signedValue: number, destination: number, inWindow: boolean): Uint8Array {
  const bytes = Uint8Array.from([
    0x11, 0x00, 0x10, 0x04, 0x00, 0xd4, 0xec, 0x58, 0x00, 0x00, 0xc0, 0x01, 0x00, 0x00, 0x00, 0x00,
  ]);
  bytes[4] = (inWindow ? 0x80 : 0x00) | destination;
  if (signedValue === 0) {
    bytes[5] = 0xc0;
  } else {
    bytes[5] = 0xd4;
    bytes[14] = signedValue & 0xff;
    bytes[15] = (signedValue >> 8) & 0xff;
  }
  return bytes;
}

interface Variant {
  readonly name: string;
  /** Рост окна у main: `null` — роста нет (контроль). */
  readonly grow: { readonly wsz: number; readonly rsz: number } | null;
  /** `wbs` вложенного вызова: при выросшем окне законно 8 (§3.56.5), без роста — 4. */
  readonly innerWbs: number;
  /** Номер регистра под указатель (свободные — `%b[16..31]`). */
  readonly pointer: number;
  /** Пишет ли вызываемая свои `%b[0..9]` (так делает раскладка). */
  readonly loud: boolean;
  /** Регистр со значением для печати: `null` — печатаем 16 из `%b[14]`, иначе печатаем САМ указатель. */
  readonly printInput: number | 'pointer';
}

const GROW_DEFAULT = { wsz: 16, rsz: 15 };
const VARIANTS: readonly Variant[] = [
  { name: 'V0-нет-роста', grow: null, innerWbs: SYSCALL_WBS, pointer: 16, loud: false, printInput: 14 },
  { name: 'V1-тихая', grow: GROW_DEFAULT, innerWbs: 8, pointer: 16, loud: false, printInput: 14 },
  { name: 'V2-громкая', grow: GROW_DEFAULT, innerWbs: 8, pointer: 16, loud: true, printInput: 14 },
  { name: 'V3-громкая-край', grow: GROW_DEFAULT, innerWbs: 8, pointer: 31, loud: true, printInput: 14 },
  { name: 'V4-банк', grow: { wsz: 32, rsz: 31 }, innerWbs: 16, pointer: 16, loud: true, printInput: 14 },
  // Свидетели: печатаем САМ указатель (`%b[K]` — вход печати), поэтому подмена видна ЧИСЛОМ в выводе,
  // а не только ловушкой: у тихой вызываемой печатается адрес стека, у громкой — её ноль.
  { name: 'V5-свидетель-тихая', grow: GROW_DEFAULT, innerWbs: 8, pointer: 16, loud: false, printInput: 'pointer' },
  { name: 'V6-свидетель-громкая', grow: GROW_DEFAULT, innerWbs: 8, pointer: 16, loud: true, printInput: 'pointer' },
];

type Item = { label: string; bytes: Uint8Array };

function program(variant: Variant): Item[] {
  const items: Item[] = [];
  const instruction = (entry: AsmInstruction, label?: string): void => {
    items.push({ label: label ?? entry.mnemonic, bytes: encoder.encode(entry) });
  };

  // ── main ─────────────────────────────────────────────────────────────────────
  if (variant.grow !== null) {
    instruction({ mnemonic: 'setwd', channel: 0, operands: [imm(variant.grow.wsz), imm(0)] }, `setwd ${String(variant.grow.wsz)}`);
    instruction({ mnemonic: 'setbn', channel: 0, operands: [imm(variant.grow.rsz), imm(0), imm(0)] }, `setbn ${String(variant.grow.rsz)}`);
  }
  items.push({ label: `getsp −16 → %b[${String(variant.pointer)}]`, bytes: getspBytes(-16, variant.pointer, false) });
  instruction({ mnemonic: 'movts', channel: 0, operands: [imm(MARKER), reg(9)] }, 'маркер 79 → %b[9]');
  instruction({ mnemonic: 'movts', channel: 0, operands: [imm(0), reg(13)] }, 'ноль → %b[13] (смещение)');
  instruction(
    { mnemonic: 'std', channel: 2, operands: [reg(9), reg(variant.pointer), reg(13)] },
    'std: маркер по указателю',
  );
  instruction({ mnemonic: 'disp', channel: 0, operands: [imm(1), imm(0)] }, 'disp → A');
  instruction({ mnemonic: 'call', channel: 0, operands: [imm(1), imm(variant.innerWbs)] }, `call A, wbs=${String(variant.innerWbs)}`);
  // Печатаем либо ФИКСИРОВАННОЕ число 16 из `%b[14]`, либо САМ указатель из `%b[K]` (варианты-свидетели):
  // первый параметр `numberToTextPrimitives` — это РЕГИСТР со значением, а не литерал
  // (`printPrimitives.ts:282`), поэтому «напечатать указатель» — это `numberToTextPrimitives(K, HEAP)`.
  const printRegister = variant.printInput === 'pointer' ? variant.pointer : variant.printInput;
  if (variant.printInput !== 'pointer') {
    instruction({ mnemonic: 'movts', channel: 0, operands: [imm(16), reg(variant.printInput)] }, 'значение печати 16 → %b[14]');
  }
  const text = numberToTextPrimitives(printRegister, HEAP);
  for (const item of [...text.instructions, ...writeTextPrimitives(HEAP, variant.grow?.rsz ?? 7)]) {
    instruction(item, `печать: ${item.mnemonic}`);
  }
  instruction({ mnemonic: 'movts', channel: 0, operands: [imm(0), reg(13)] }, 'ноль → %b[13] снова');
  instruction(
    { mnemonic: 'ldd', channel: 0, operands: [reg(variant.pointer), reg(13), reg(11)] },
    'ldd: маркер обратно по указателю',
  );
  instruction({ mnemonic: 'movts', channel: 0, operands: [reg(11), window_(WINDOW_NUMBER_REGISTER + 1)] }, 'код → %r9');
  instruction({ mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] }, 'exit');
  instruction({ mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] }, 'sdisp (exit)');
  instruction({ mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] }, 'call (exit)');
  // ── A ────────────────────────────────────────────────────────────────────────
  if (variant.loud) {
    for (let index = 0; index <= 9; index++) {
      instruction({ mnemonic: 'movts', channel: 0, operands: [imm(0), window_(index)] }, `A: %r${String(index)} ← 0`);
    }
  }
  instruction({ mnemonic: 'return', channel: 0, operands: [imm(3)] }, 'A: return %ctpr3');
  instruction({ mnemonic: 'ct', channel: 0, operands: [imm(3), imm(CT_COND_ALWAYS)] }, 'A: ct %ctpr3');
  return items;
}

const shim = buildShim();
if (shim === undefined) {
  console.error('шим не собран: прогон невозможен (docs/e2k-qemu-run.md §2.5)');
  process.exit(2);
}

console.log('# указатель: getsp −16 в свободный регистр; маркер 79 кладётся по указателю,');
console.log('# затем вложенный вызов, затем НАСТОЯЩАЯ печать, затем маркер читается обратно.');
console.log('# код 79 = указатель и память целы; 9 = ловушка; иное — названная причина.');
console.log('вариант            регистр  код   вывод      что значит');
const raw: Record<string, unknown>[] = [];
for (const variant of VARIANTS) {
  const draft = program(variant);
  const offsets: number[] = [];
  let at = 0;
  for (const item of draft) {
    offsets.push(at);
    at += item.bytes.length;
  }
  // цель `disp` — первая команда A: ищем по метке
  const aIndex = draft.findIndex((item) => item.label.startsWith('A:') || item.label === 'A: return %ctpr3');
  const dispIndex = draft.findIndex((item) => item.label === 'disp → A');
  const target = (offsets[aIndex]! - offsets[dispIndex]!) / 8;
  const rebuilt = program(variant);
  rebuilt[dispIndex]!.bytes = encoder.encode({ mnemonic: 'disp', channel: 0, operands: [imm(1), imm(target)] });

  const total = rebuilt.reduce((sum, item) => sum + item.bytes.length, 0);
  const bytes = new Uint8Array(total);
  const marks = new Map<string, number>();
  let cursor = 0;
  for (const item of rebuilt) {
    marks.set(item.label, MINIMAL_BASE + cursor);
    bytes.set(item.bytes, cursor);
    cursor += item.bytes.length;
  }
  const file = path.join(ROOT, '.tmp', `osnova-us-life-${variant.name}.elf`);
  fs.writeFileSync(file, buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes);
  const run = runInQemu(file, { shim: true, timeoutMs: 30_000 });
  const status = run?.status ?? null;
  const ip = run?.exceptionIp;
  // Адрес ловушки называем ТОЧНО, если он совпал с меткой; иначе — по ближайшей метке выше.
  const exact = ip === undefined ? undefined : [...marks.entries()].find(([, address]) => address === ip)?.[0];
  const nearest = ip === undefined ? undefined : [...marks.entries()].reverse().find(([, address]) => address <= ip)?.[0];
  const where = exact ?? (nearest === undefined ? (ip === undefined ? '' : `0x${ip.toString(16)}`) : `${nearest}…`);
  const output = (run?.output ?? '').replace(/\n/gu, '\\n');
  const verdict =
    status === MARKER
      ? 'УЦЕЛЕЛ: маркер прочитан через указатель после вызова и печати'
      : status === 9
        ? `ловушка у «${where}»`
        : `иной исход${ip === undefined ? '' : `, ловушка 0x${ip.toString(16)} у «${where}»`}`;  console.log(
    `${variant.name.padEnd(18)} %b[${String(variant.pointer).padEnd(3)}] ${String(status).padStart(3)}   ` +
      `${(output === '' ? '(пусто)' : output).padEnd(10)} ${verdict}`,
  );
  raw.push({
    variant: variant.name,
    grow: variant.grow,
    innerWbs: variant.innerWbs,
    pointer: variant.pointer,
    loud: variant.loud,
    status,
    exceptionIp: ip ?? null,
    exactMark: exact ?? null,
    nearestMark: nearest ?? null,
    output,
    file: path.basename(file),
    marks: Object.fromEntries([...marks.entries()].map(([label, address]) => [label, `0x${address.toString(16)}`])),
  });
}
fs.writeFileSync(
  path.join(ROOT, '.tmp', 'osnova-us-pointer-life.json'),
  `${JSON.stringify(raw, null, 2)}\n`,
  'utf-8',
);
console.log('# сырые прогоны: .tmp/osnova-us-pointer-life.json');
