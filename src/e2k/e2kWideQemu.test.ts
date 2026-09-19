/**
 * ОРАКУЛ: ВЫПОЛНЯЕТ ЛИ QEMU ВСЕ СЛОГИ ШИРОКОЙ КОМАНДЫ.
 *
 * # Зачем отдельный файл
 *
 * `src/e2k/widePackets.test.ts` проверяет **раскладку** (сколько слогов в команде и какие байты).
 * Совпадение байтов с ассемблером ещё не значит, что модель **исполнит** оба слога: это свойство
 * декодера, а не кодировки. Опыт ставится здесь.
 *
 * Файл зависит от внешнего ресурса (`qemu-e2k` под шимом `mmap`) и живёт в шлюзе
 * `npm run gate:qemu`, а не в полном прогоне: оракул, который иногда падает от занятости машины,
 * врёт о проекте (`docs/verification-debt.md`, случай 12).
 *
 * # Опыты и что каждый доказывает
 *
 * 1. **Различающий.** Две независимые `adds` лежат в **одной** широкой команде, и роль источника
 *    кода возврата по очереди отдаётся первой и второй. Если бы модель исполнила только один слог,
 *    один из опытов дал бы чужой код. Вместе они доказывают, что исполнены **оба**.
 * 2. **Эквивалентность.** Линейный код (команда на инструкцию) и пакеты дают один код возврата.
 * 3. **Негативный контроль (дефект 6.2).** Две **зависимые** операции насильно положены в одну
 *    команду в обход проверки зависимостей: модель читает источники **параллельно**, поэтому
 *    вторая операция видит старое значение, и код возврата расходится (измерено: 5 вместо 13).
 *    Это и есть обоснование правила «RAW внутри широкой команды недопустим» — не предположение,
 *    а замер.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что так поведёт себя железо: QEMU — модель. И что порядок слогов внутри команды определён: из
 * опыта 1 следует только то, что **обе** операции выполнены.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { buildElfFromCode, MINIMAL_BASE, SYSCALL_WBS } from './elfMinimal';
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { packWide, wideBytes, encodeWideGroup } from './widePacker';
import { alsSyllableOf } from './e2k-real';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

const imm = (value: number): Operand => ({ kind: 'imm', value });
const base = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** `movts,0 <значение>, %b[N]` — литерал в базовый регистр (16 байт: слог ALS + слово LTS). */
const load = (value: number, register: number): AsmInstruction => ({
  mnemonic: 'movts',
  channel: 0,
  operands: [imm(value), base(register)],
});

/** `adds` в форме ALF1: src1, src2, dst. */
const add = (src1: Operand, src2: Operand, dst: Operand): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [src1, src2, dst],
});

const setbn: AsmInstruction = {
  mnemonic: 'setbn',
  channel: 0,
  operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)],
};

/** Хвост программы: `exit(<код в оконном r1>)`. */
const exitTail: AsmInstruction[] = [
  { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
  { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
  { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
];

/** Начало программы: окно и три константы. Литеральные `movts` — барьеры, поэтому они впереди. */
const head = (): AsmInstruction[] => [setbn, load(3, 1), load(5, 2), load(7, 4)];

function linearBytes(instructions: readonly AsmInstruction[]): Uint8Array {
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Собрать программу `[начало][середина][exit]`, прогнать в QEMU и вернуть код возврата. */
function runMiddle(middle: Uint8Array, file: string): number | undefined {
  const bytes = concat(linearBytes(head()), middle, linearBytes(exitTail));
  fs.writeFileSync(path.join(ROOT, '.tmp', file), buildElfFromCode(bytes, MINIMAL_BASE).bytes);
  return runInQemu(path.join(ROOT, '.tmp', file), { shim: true })?.status;
}

/** Насильно положить две операции в одну команду, обойдя проверку зависимостей. */
function forcePair(first: AsmInstruction, second: AsmInstruction): Uint8Array {
  return encodeWideGroup([
    { instruction: first, syllable: { ...alsSyllableOf(first), channel: 0 } },
    { instruction: second, syllable: { ...alsSyllableOf(second), channel: 1 } },
  ]);
}

const shim = buildShim();

describe('широкая команда: исполнение в QEMU', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length, 'путь к шиму').toBeGreaterThan(3);
  });

  it('обе операции одной широкой команды исполнены: роль источника кода по очереди', () => {
    if (shim === undefined) return;
    // Пара А: b3 = 3+5 = 8 (ненаблюдаемо), r9 = 7+5 = 12 — код возврата даёт ВТОРАЯ операция.
    const pairA = [add(base(1), base(2), base(3)), add(base(4), base(2), window_(9))];
    // Пара Б: r9 = 3+5 = 8 — код возврата даёт ПЕРВАЯ операция, вторая пишет ненаблюдаемый b10.
    const pairB = [add(base(1), base(2), window_(9)), add(base(4), base(2), base(10))];
    for (const [index, pair] of [pairA, pairB].entries()) {
      const packets = packWide(pair);
      expect(packets.length, `пара ${index}: команд`).toBe(1);
      expect(packets[0]!.slots.length, `пара ${index}: слогов в команде`).toBe(2);
    }
    const codeA = runMiddle(wideBytes(packWide(pairA)), 'e2k-wide-a.elf');
    const codeB = runMiddle(wideBytes(packWide(pairB)), 'e2k-wide-b.elf');
    if (codeA === undefined || codeB === undefined) {
      expect(codeA, 'QEMU не запустился — причина названа в оракуле прогона (e2kQemuExec.test.ts)').toBeDefined();
      return;
    }
    expect(codeA, 'код возврата, когда счёт даёт вторая операция команды').toBe(12);
    expect(codeB, 'код возврата, когда счёт даёт первая операция команды').toBe(8);
  });

  it('линейный код и пакеты дают один и тот же код возврата', () => {
    if (shim === undefined) return;
    const pair = [add(base(1), base(2), base(3)), add(base(4), base(2), window_(9))];
    const instructions = [...head(), ...pair, ...exitTail];
    const packets = packWide(instructions);
    const linear = runMiddle(linearBytes(pair), 'e2k-wide-linear.elf');
    const packed = runMiddle(wideBytes(packWide(pair)), 'e2k-wide-packed.elf');
    if (linear === undefined || packed === undefined) {
      expect(linear, 'QEMU не запустился').toBeDefined();
      return;
    }
    expect(linear, 'линейный вариант: 7 + 5 = 12').toBe(12);
    expect(packed, 'пакетный вариант даёт тот же код').toBe(linear);
    // Группировка состоялась: команд меньше, чем инструкций.
    expect(packets.length, `команд в пакетном варианте из ${instructions.length} инструкций`).toBeLessThan(
      instructions.length,
    );
  });

  it('6.2 негативный контроль: зависимые операции в одной команде дают неверный результат', () => {
    if (shim === undefined) return;
    // b3 = 3 + 5 = 8; затем r9 = b3 + 5 = 13. Вторая ЗАВИСИТ от первой — в ту же команду нельзя.
    const first = add(base(1), base(2), base(3));
    const second = add(base(3), base(2), window_(9));

    // Правильно: группировщик разводит их по разным командам, и результат верный.
    const honest = packWide([first, second]);
    expect(honest.length, 'зависимая пара: команд').toBe(2);
    expect(honest.map((packet) => packet.slots.length)).toEqual([1, 1]);
    const honestCode = runMiddle(wideBytes(honest), 'e2k-wide-dep-ok.elf');

    // Дефект: обе операции в одной команде, проверка зависимостей обойдена.
    const defectCode = runMiddle(forcePair(first, second), 'e2k-wide-dep-bad.elf');

    if (honestCode === undefined || defectCode === undefined) {
      expect(honestCode, 'QEMU не запустился').toBeDefined();
      return;
    }
    expect(honestCode, 'правильная сборка: 8 + 5 = 13').toBe(13);
    // Измерено: модель читает источники параллельно, вторая операция видит старое b3 = 0 → 5.
    // Это и есть обоснование правила: RAW внутри одной широкой команды недопустим.
    expect(
      defectCode,
      `дефект не пойман: зависимые операции в одной команде дали тот же код ${String(defectCode)}. ` +
        'Значит либо модель исполняет слоги последовательно, либо правило группировки не обосновано.',
    ).not.toBe(13);
  });
});
