/**
 * `getsp,0` ПОСЛЕ РОСТА ОКНА: НЕ ДВИГАЕТ ЛИ USD (task-30, шаг 3).
 *
 * §3.48.6 измерил стабильность `getsp,0` в **узком** окне (`rsz = 7`): два `getsp,0` подряд дают один
 * и тот же указатель, а `getsp −16` уводит ровно на 16. С ростом окна (`setwd wsz=16` + `setbn rsz=15`)
 * это не измерялось, а вопрос существенный: если рост окна сам двигает USD, то «указатель, положенный
 * до роста» и «указатель после роста» — разные вещи, и постоянный регистр надо заводить после роста.
 *
 * # Признак и контроль в обе стороны
 *
 * | опыт | ожидание |
 * |---|---|
 * | два `getsp,0` подряд (после роста) | разность **0** — USD не двинулся |
 * | `getsp,0`, затем `getsp −16` | разность **16** — выделение видно, проба РАЗЛИЧАЕТ |
 * | два `getsp,0` подряд БЕЗ роста (контроль §3.48.6, повторён здесь) | разность **0** |
 *
 * Разность кладётся кодом возврата (`subs`), поэтому код `0` и `16` — два названных исхода.
 *
 * Запуск: `npx tsx .tmp/osnova-us-getsp-grown.ts`
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from '../src/e2k/backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from '../src/e2k/elfMinimal';
import { SYS_EXIT, WINDOW_NUMBER_REGISTER } from '../src/e2k/syscallRuntime';
import { buildShim, runInQemu } from '../src/scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..');
const encoder = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Те же байты `getsp`, что сняты ассемблером МЦСТ (§3.46.1). */
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

interface Case {
  readonly name: string;
  /** Растёт ли окно перед опытом (`setwd wsz=16` + `setbn rsz=15`). */
  readonly grow: boolean;
  /** Литералы двух `getsp` подряд. */
  readonly literals: readonly [number, number];
  readonly expect: number;
}

const CASES: readonly Case[] = [
  { name: 'два getsp,0 после роста', grow: true, literals: [0, 0], expect: 0 },
  { name: 'getsp,0 и getsp,−16 после роста', grow: true, literals: [0, -16], expect: 16 },
  { name: 'два getsp,0 БЕЗ роста (повтор §3.48.6)', grow: false, literals: [0, 0], expect: 0 },
  { name: 'getsp,0 и getsp,−16 БЕЗ роста (повтор §3.48.6)', grow: false, literals: [0, -16], expect: 16 },
];

/** Свободные регистры после роста — `%b[16..31]` (шаг 1); берём `%b[14]` и `%b[15]` — они адресуемы В ОБОИХ режимах, поэтому контроль что-то значит. */
const FIRST = 14;
const SECOND = 15;

function program(item: Case): Uint8Array {
  const chunks: Uint8Array[] = [];
  if (item.grow) {
    chunks.push(encoder.encode({ mnemonic: 'setwd', channel: 0, operands: [imm(16), imm(0)] }));
    chunks.push(encoder.encode({ mnemonic: 'setbn', channel: 0, operands: [imm(15), imm(0), imm(0)] }));
  } else {
    // Узкое окно ставит пролог образа (`rsz = 7`, шестнадцать единиц — `ARRAY_WINDOW_RSZ`).
    // Без него ни один регистр не адресуем, и контроль падал бы не на том, на чём проверяется:
    // это и было поймано первым прогоном (ловушка 0x100000 на `%b[14]`).
    chunks.push(encoder.encode({ mnemonic: 'setbn', channel: 0, operands: [imm(7), imm(0), imm(0)] }));
  }
  chunks.push(getspBytes(item.literals[0], FIRST, false));
  chunks.push(getspBytes(item.literals[1], SECOND, false));
  // Разность «первый минус второй»: 0 — USD не двинулся; 16 — выделение видно.
  // Приёмник разности — `%b[13]`: он адресуем В ОБОИХ режимах (при `rsz = 7` окно кончается на 15).
  // Первая редакция клала разность в `%b[18]` — и контроль ВСТАВАЛ ЛОВУШКОЙ не на том, что проверяет.
  chunks.push(encoder.encode({ mnemonic: 'subs', channel: 0, operands: [reg(FIRST), reg(SECOND), reg(13)] }));
  chunks.push(encoder.encode({ mnemonic: 'movts', channel: 0, operands: [reg(13), window_(WINDOW_NUMBER_REGISTER + 1)] }));
  chunks.push(encoder.encode({ mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] }));
  chunks.push(encoder.encode({ mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] }));
  chunks.push(encoder.encode({ mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] }));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

const shim = buildShim();
if (shim === undefined) {
  console.error('шим не собран: прогон невозможен (docs/e2k-qemu-run.md §2.5)');
  process.exit(2);
}

console.log('# указатели кладутся в %b[14] и %b[15] — свободные регистры выросшего окна (шаг 1)');
console.log('опыт                                      код   ожидание   что значит');
const raw: Record<string, unknown>[] = [];
for (const [index, item] of CASES.entries()) {
  const file = path.join(ROOT, '.tmp', `osnova-us-getsp-grown-${String(index)}.elf`);
  fs.writeFileSync(file, buildElfFromCode(program(item), MINIMAL_BASE).bytes);
  const run = runInQemu(file, { shim: true, timeoutMs: 30_000 });
  const status = run?.status ?? null;
  const ok = status === item.expect;
  console.log(
    `${item.name.padEnd(41)} ${String(status).padStart(3)}   ${String(item.expect).padEnd(9)} ` +
      `${ok ? 'сходится' : 'РАСХОЖДЕНИЕ'}${run?.exceptionIp === undefined ? '' : `, ловушка 0x${run.exceptionIp.toString(16)}`}`,
  );
  raw.push({ case: item.name, grow: item.grow, literals: item.literals, status, expected: item.expect, ok });
}
fs.writeFileSync(
  path.join(ROOT, '.tmp', 'osnova-us-getsp-grown.json'),
  `${JSON.stringify(raw, null, 2)}\n`,
  'utf-8',
);
console.log('# сырые прогоны: .tmp/osnova-us-getsp-grown.json');
