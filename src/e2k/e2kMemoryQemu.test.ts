/**
 * ОРАКУЛ: РАБОТАЕТ ЛИ ПАМЯТЬ e2k В МОДЕЛИ.
 *
 * # Зачем
 *
 * Форма `ld*`/`st*` извлечена и сверена с ассемблером (`src/e2k/e2kMemory.test.ts`), но
 * совпадение байтов не значит, что модель **исполнит** запись и чтение. Опыт ставится здесь:
 * программа записывает значение в память и читает его обратно, код возврата — прочитанное.
 *
 * Файл зависит от внешнего ресурса (`qemu-e2k` под шимом `mmap`) и живёт в шлюзе
 * `npm run gate:qemu`, а не в полном прогоне (`docs/verification-debt.md`, случай 12).
 *
 * # Опыты
 *
 * 1. **Различающий:** записали 42 — прочитали 42; записали 43 — прочитали 43. Одного значения
 *    мало: совпадение могло быть случайным (литерал вместо чтения).
 * 2. **Негативный контроль:** записали по одному адресу, прочитали по другому — код возврата
 *    обязан **разойтись** с записанным. Иначе «память работает» неотличимо от «значение пришло
 *    не из памяти».
 *
 * # Чего оракул НЕ доказывает
 *
 * Что так поведёт себя железо: QEMU — модель. И что порядок записи/чтения виден другим каналам:
 * проверяется один канал (ALS0 для чтения, ALS2 для записи — таковы разрешённые каналы этих форм).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { DATA_SEGMENT_BASE, MINIMAL_BASE, SYSCALL_WBS, buildElfFromCode } from './elfMinimal';
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { buildShim, runInQemu } from '../scripts/e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');

const imm = (value: number): Operand => ({ kind: 'imm', value });
const base = (index: number): Operand => ({ kind: 'reg', index });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const f64 = (value: bigint): Operand => ({ kind: 'imm64', value }) as unknown as Operand;

/**
 * Смещение области данных: **отдельная страница** за кодом (`+0x2000`).
 *
 * Это не прихоть, а замер: QEMU делает страницу переведённого кода защищённой, и `std` по адресу
 * в той же странице, что код, кончается `QEMU internal SIGSEGV {code=ACCERR}`. Проверено
 * (`.tmp/mem-page.ts`): данные в странице кода → ACCERR; те же данные на отдельной странице →
 * код возврата равен записанному значению. Хвост сегмента отображается нулями и объявлен
 * `extraMemory` (`src/e2k/elfMinimal.ts:245-259`).
 */
// АДРЕС ОБЛАСТИ ДАННЫХ — ИЗ СЕГМЕНТА ДАННЫХ, а не «страницей после кода» (2026-09-30, §3.92):
// образ собирается ДВУМЯ сегментами, код R|X, данные R|W, и всё, что пишется, лежит в данных.
// Прежние 0x2000 (0x102000) после этого не отображены ВООБЩЕ — проба падала кодом 9 на первой записи.
const DATA_OFFSET = DATA_SEGMENT_BASE - MINIMAL_BASE;

/**
 * Программа: `b1` — адрес области, `b2` — нулевое смещение, `b3` — значение.
 * Запись по `[b1 + b2]`, чтение из `[b1 + b4]` (у негативного контроля `b4 = 8`), код возврата —
 * прочитанное значение (приёмник чтения — оконный `r1`).
 */
function programBytes(value: number, readOffset: number): Uint8Array {
  const build = (address: number): AsmInstruction[] => [
    { mnemonic: 'setbn', channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    // Адрес области данных — 64-битным литералом (форма 0xdc): он не влезает в 16 бит.
    { mnemonic: 'movtd', channel: 0, operands: [f64(BigInt(address)), base(1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(0), base(2)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(readOffset), base(4)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(value), base(3)] },
    // Запись: текст ассемблера идёт (значение, база, смещение) — измерено, `.tmp/std-order.ts`.
    { mnemonic: 'std', channel: 2, operands: [base(3), base(1), base(2)] },
    // Чтение в оконный r1 (код возврата `exit`).
    { mnemonic: 'ldd', channel: 0, operands: [base(1), base(4), window_(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
  ];
  // Адрес данных фиксирован (отдельная страница), поэтому второй сборки для длины кода не нужно.
  const instructions = build(MINIMAL_BASE + DATA_OFFSET);
  const bytes = new Uint8Array(instructions.reduce((sum, instruction) => sum + encoder.encode(instruction).length, 0));
  let offset = 0;
  for (const instruction of instructions) {
    const chunk = encoder.encode(instruction);
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Прогнать программу и вернуть код возврата (или причину, почему прогона нет). */
function exitCodeOf(value: number, readOffset: number, file: string): number | undefined {
  const bytes = programBytes(value, readOffset);
  fs.writeFileSync(
    path.join(ROOT, '.tmp', file),
    // Адрес данных — из СЕГМЕНТА ДАННЫХ (`DATA_SEGMENT_BASE`), а не «страницей после кода»: до
    // 2026-09-30 проба писала по 0x102000, и с двумя сегментами этот адрес не отображён вовсе.
    // Вопрос «нужен ли ещё `extraMemory`» — отдельная проверка отдельным коммитом (§3.93).
    buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: DATA_OFFSET }).bytes,
  );
  return runInQemu(path.join(ROOT, '.tmp', file), { shim: true })?.status;
}

const shim = buildShim();

describe('память e2k: исполнение в QEMU', () => {
  it('шим и модель доступны — или причина названа', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('различающий опыт: записали 42 — прочитали 42, записали 43 — прочитали 43', () => {
    if (shim === undefined) return;
    const first = exitCodeOf(42, 0, 'e2k-mem-42.elf');
    const second = exitCodeOf(43, 0, 'e2k-mem-43.elf');
    if (first === undefined || second === undefined) {
      expect(first, 'QEMU не запустился — причина названа в оракуле прогона (e2kQemuExec.test.ts)').toBeDefined();
      return;
    }
    expect(first, 'прочитано то, что записали (42)').toBe(42);
    expect(second, 'прочитано то, что записали (43) — значит значение идёт из памяти, а не из литерала').toBe(43);
  });

  it('негативный контроль: чтение по другому адресу не даёт записанного значения', () => {
    if (shim === undefined) return;
    // Запись по [b1 + 0], чтение по [b1 + 8] — разные адреса.
    const wrong = exitCodeOf(42, 8, 'e2k-mem-wrong.elf');
    if (wrong === undefined) {
      expect(wrong, 'QEMU не запустился').toBeDefined();
      return;
    }
    expect(
      wrong,
      `чтение по чужому адресу вернуло ${String(wrong)} — то же, что записано. Значит адрес в чтении ` +
        'не участвует, и «память работает» неотличимо от «значение пришло не из памяти».',
    ).not.toBe(42);
  });
});
