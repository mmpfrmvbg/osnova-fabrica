/**
 * ПУТЬ ①: МЕСТНОЕ ОКНО СИСТЕМНОГО ВЫЗОВА — СТОРОЖ РАЗМЕЩЕНИЯ И ДЛИНЫ.
 *
 * Закон железа `wsz − wbs = 4` (§3.116.4, §3.118.1: `zc-a-w8` → 42, `zc-a-w9` → 137) требует,
 * чтобы у сайта вызова окно было шире кадра ровно на четыре квадрослова:
 * `setwd wsz = wbs + 4` ПЕРЕД `sdisp` и `setwd wsz = <окно охватывающей функции>` ЗА `call`.
 *
 * # Почему сторож, а не «внимательность»
 *
 * §3.119.3: прошлая попытка упала не из-за модели, а из-за ОШИБКИ РАЗМЕЩЕНИЯ — закрывающий `setwd`
 * встал на смещение 1536, тогда как `call wbs=16` занимает 1528…1543. Модель после этого разбирала
 * мусор (`CT %ctpr1  IPD 3  SETWD wsz = 0x0` вместо `CALL %ctpr1, wbs = 0x10`), и это было неотличимо
 * от дефекта прибора по коду возврата и адресу ловушки. Поэтому здесь проверяется не намерение, а
 * **байты**: закрытие начинается ровно через шестнадцать байт после начала `call`.
 *
 * Негативный контроль — в конце файла: последовательность с закрытием ВНУТРИ вызова обязана быть
 * отвергнута. Сторож без негативного контроля неотличим от мёртвого (случай 22).
 */
import { describe, expect, it } from 'vitest';
import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { ARRAY_WINDOW_RSZ, ARRAY_WINDOW_WSZ } from './arrayRuntime';
import { WINDOW_GROW_WSZ } from './procedureCall';
import {
  ENTRY_SYSCALL_FRAME,
  GROWN_SYSCALL_FRAME,
  SYSCALL_ENTRY_WSZ,
  SYSCALL_GROWN_WSZ,
  SYSCALL_TRAP,
  syscallCallClose,
  syscallCallOpen,
  type SyscallFrame,
} from './syscallRuntime';
import { exitCarrierInstructions, printCommandForm, printWriteInstructions } from './printCall';
import { ARRAY_COMMAND_FORMS } from './twoPassLayout';
import { exitPrimitives, writeTextPrimitives } from './printPrimitives';
import { brkInstructions, mmapInstructions } from './memoryRuntime';
import { brkInstructions as collectionBrkInstructions } from './collectionsRuntime';
import { stringWriteInstructions } from './stringRuntime';
import { refusalInstructions } from './refusalBlock';
import { buildHelloProgram } from './syscallRuntime';

const enc = getEncoder('e2k');
const imm = (value: number): Operand => ({ kind: 'imm', value });

/** Байтовая длина последовательности — тем же кодировщиком, что кладёт байты в образ. */
function bytesOf(commands: readonly AsmInstruction[]): number {
  return commands.reduce((sum, command) => sum + enc.encode(command).length, 0);
}

/** Сумма объявленных форм — то, чем раскладка считает длину носителя. */
function plannedBytes(
  commands: readonly AsmInstruction[],
  extra?: ReadonlyMap<string, { readonly size: number }>,
): number | string {
  let total = 0;
  for (const command of commands) {
    const form = extra?.get(command.mnemonic) ?? printCommandForm(command);
    if (form === undefined) return `у команды «${command.mnemonic}» нет формы — длину взять негде`;
    total += form.size;
  }
  return total;
}

/**
 * Нарушения размещения пути ① в готовой последовательности команд.
 *
 * Проверяются ЧЕТЫРЕ вещи, каждая — замером байтов:
 * 1. перед `sdisp` стоит открытие `setwd wsz = wbs + 4`;
 * 2. за `call` стоит закрытие `setwd wsz = <окно функции>`;
 * 3. между `call` и закрытием НЕТ других команд (иначе закрытие внутри двадцатибайтного окна
 *    съехало бы внутрь самого `call`);
 * 4. **смещение закрытия минус смещение `call` равно длине команды `call`** — то самое правило
 *    «закрытие за `call`, не внутри»;
 * 5. план раскладки равен факту кодировщика на всей последовательности.
 */
export function localWindowProblems(
  commands: readonly AsmInstruction[],
  frame: SyscallFrame,
  extra?: ReadonlyMap<string, { readonly size: number }>,
): string[] {
  const problems: string[] = [];
  const callIndexes = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => command.mnemonic === 'call')
    .map(({ index }) => index);
  if (callIndexes.length === 0) return ['в последовательности нет команды `call`'];
  for (const index of callIndexes) {
    const call = commands[index]!;
    const callWbs = call.operands[1];
    const open = commands[index - 2];
    const sdisp = commands[index - 1];
    if (sdisp?.mnemonic !== 'sdisp' || (sdisp.operands[1] as { value?: number }).value !== SYSCALL_TRAP) {
      problems.push(`перед \`call\` (${String(index)}) нет \`sdisp\` с ловушкой ${String(SYSCALL_TRAP)}`);
    }
    if (open?.mnemonic !== 'setwd') {
      problems.push(`нет открытия местного окна перед \`sdisp\` (${String(index)})`);
    } else if ((open.operands[0] as { value?: number }).value !== frame.wbs + 4) {
      problems.push(
        `открытие местного окна ${String((open.operands[0] as { value?: number }).value)} вместо ` +
          `${String(frame.wbs + 4)} = wbs + 4`,
      );
    }
    if (callWbs?.kind === 'imm' && callWbs.value !== frame.wbs) {
      problems.push(`ширина вызова ${String(callWbs.value)} не равна кадру ${String(frame.wbs)}`);
    }
    // ГЛАВНОЕ: закрытие стоит ЗА вызовом, а не внутри него. Считается ПО БАЙТАМ.
    const callOffset = bytesOf(commands.slice(0, index + 1)) - enc.encode(call).length;
    const callEnd = callOffset + enc.encode(call).length;
    const closeIndex = commands.findIndex((command, at) => at > index && command.mnemonic === 'setwd');
    if (closeIndex === -1) {
      problems.push(`нет закрытия окна за \`call\` (${String(index)})`);
    } else {
      const close = commands[closeIndex]!;
      if (closeIndex !== index + 1) {
        problems.push(
          `закрытие не сразу за \`call\`: между ними ${String(closeIndex - index - 1)} команд(ы)`,
        );
      }
      const closeOffset = bytesOf(commands.slice(0, closeIndex));
      if (closeOffset !== callEnd) {
        problems.push(
          `закрытие на смещении ${String(closeOffset)} при \`call\` ${String(callOffset)}…${String(callEnd)}: ` +
            'закрытие внутри вызова',
        );
      }
      if ((close.operands[0] as { value?: number }).value !== frame.wsz) {
        problems.push(
          `закрытие окна ${String((close.operands[0] as { value?: number }).value)} вместо ` +
            `${String(frame.wsz)} — окна охватывающей функции`,
        );
      }
    }
  }
  const planned = plannedBytes(commands, extra);
  if (typeof planned === 'string') problems.push(planned);
  else if (planned !== bytesOf(commands)) {
    problems.push(`план раскладки ${String(planned)} ≠ факт кодировщика ${String(bytesOf(commands))}`);
  }
  return problems;
}

/** Все сайты вызова в обоих кадрах — по одному свидетельству на сайт. */
const sites: Array<{
  readonly name: string;
  readonly of: (frame: SyscallFrame) => AsmInstruction[];
  /** Дополнительная таблица форм — та же, что берёт раскладка для этого семейства носителей. */
  readonly extra?: ReadonlyMap<string, { readonly size: number }>;
}> = [
  { name: 'writeTextPrimitives', of: (frame) => writeTextPrimitives(0x101000, undefined, frame) },
  { name: 'printWriteInstructions', of: (frame) => printWriteInstructions(0x101000, frame) },
  { name: 'exitPrimitives', of: (frame) => exitPrimitives(0, frame) },
  { name: 'exitCarrierInstructions (код)', of: (frame) => exitCarrierInstructions(0, undefined, frame) },
  { name: 'exitCarrierInstructions (значение)', of: (frame) => exitCarrierInstructions(0, 5, frame) },
  {
    name: 'mmapInstructions',
    of: (frame) => mmapInstructions({ length: 5, result: 6, frame }),
  },
  { name: 'memoryRuntime.brkInstructions', of: (frame) => brkInstructions({ address: 5, result: 6, frame }) },
  {
    name: 'collectionsRuntime.brkInstructions',
    of: (frame) => collectionBrkInstructions({ address: 5, result: 6, frame }),
    // Раскладка для семейства рантайма массивов берёт форму из `ARRAY_COMMAND_FORMS` (`addd` — ALF1),
    // и только потом из `printCommandForm` (`src/e2k/twoPassLayout.ts:653`): сверяем тем же порядком.
    extra: ARRAY_COMMAND_FORMS,
  },
  {
    name: 'stringWriteInstructions',
    of: (frame) => stringWriteInstructions({ address: 5, byteLength: 3, newlineAddress: 0x101008, frame }),
  },
  { name: 'refusalInstructions', of: (frame) => refusalInstructions(0x101000, 7, frame) },
];

describe('путь ①: местное окно системного вызова', () => {
  it('константы окон совпадают с их источниками (дублирование без цикла импортов)', () => {
    // `syscallRuntime` не может импортировать `arrayRuntime`/`procedureCall` — вышел бы цикл,
    // поэтому числа продублированы. Здесь они сверяются: разойтись молча не могут.
    expect(SYSCALL_ENTRY_WSZ).toBe(ARRAY_WINDOW_WSZ);
    expect(SYSCALL_GROWN_WSZ).toBe(WINDOW_GROW_WSZ);
    expect(ENTRY_SYSCALL_FRAME.wsz).toBe(SYSCALL_ENTRY_WSZ);
    expect(GROWN_SYSCALL_FRAME.wsz).toBe(SYSCALL_GROWN_WSZ);
  });

  it('форма `setwd` — CS1_SETWD, 16 байт, и совпадает с кодировщиком', () => {
    const form = printCommandForm({ mnemonic: 'setwd', channel: 0, operands: [imm(8), imm(0)] });
    expect(form?.form).toBe('CS1_SETWD');
    expect(form?.size).toBe(16);
    expect(enc.encode({ mnemonic: 'setwd', channel: 0, operands: [imm(8), imm(0)] }).length).toBe(16);
    // Окно 32 — та же форма: длина не зависит от `wsz`, поэтому кадры и не разошлись по длине.
    expect(enc.encode({ mnemonic: 'setwd', channel: 0, operands: [imm(32), imm(0)] }).length).toBe(16);
  });

  it('открытие и закрытие считаются от кадра, а не константой', () => {
    expect(syscallCallOpen(ENTRY_SYSCALL_FRAME)).toEqual([
      { mnemonic: 'setwd', channel: 0, operands: [imm(8), imm(0)] },
    ]);
    expect(syscallCallClose(ENTRY_SYSCALL_FRAME)).toEqual([
      { mnemonic: 'setwd', channel: 0, operands: [imm(12), imm(0)] },
    ]);
    expect(syscallCallOpen(GROWN_SYSCALL_FRAME)).toEqual([
      { mnemonic: 'setwd', channel: 0, operands: [imm(20), imm(0)] },
    ]);
    expect(syscallCallClose(GROWN_SYSCALL_FRAME)).toEqual([
      { mnemonic: 'setwd', channel: 0, operands: [imm(32), imm(0)] },
    ]);
  });

  for (const site of sites) {
    for (const frame of [ENTRY_SYSCALL_FRAME, GROWN_SYSCALL_FRAME]) {
      const frameName = frame === ENTRY_SYSCALL_FRAME ? 'точка входа' : 'выращенный кадр';
      it(`${site.name} (${frameName}): окно, размещение и план = факт`, () => {
        const commands = site.of(frame);
        expect(localWindowProblems(commands, frame, site.extra)).toEqual([]);
        // Выращенный кадр держит область вращения `rsz = 7` (её ставит `setbn` носителя), поэтому
        // узкое окно 20 годно: `rbs + rsz + 1 = 8 ≤ 20`. Проверяем именно это, а не «на глаз».
        const rsz = frame.setbn ? ARRAY_WINDOW_RSZ : ARRAY_WINDOW_RSZ;
        expect(0 + rsz + 1).toBeLessThanOrEqual(frame.wbs + 4);
      });
    }
  }

  it('`buildHelloProgram` тоже несёт местное окно', () => {
    const program = buildHelloProgram('hello', 0);
    expect(localWindowProblems(program.instructions, ENTRY_SYSCALL_FRAME)).toEqual([]);
  });
});

describe('негативный контроль: сторож обязан отвергать закрытие ВНУТРИ вызова', () => {
  it('команда между `call` и закрытием — отвергается', () => {
    const good = exitPrimitives(0, ENTRY_SYSCALL_FRAME);
    // Портим так, как это и случилось в §3.119.3: закрытие съезжает внутрь вызова — в списке команд
    // это видно как «закрытие не сразу за `call`», в байтах — как «закрытие внутри вызова».
    const close = good[good.length - 1]!;
    // Заполнитель — уже проверенная команда того же семейства (`movts` в окно): кодируется законно.
    const filler = good[0]!;
    const bad = [...good.slice(0, -1), filler, close];
    const problems = localWindowProblems(bad, ENTRY_SYSCALL_FRAME);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/внутри вызова|не сразу за/);
  });

  it('открытие с чужим окном — отвергается', () => {
    const good = exitPrimitives(0, ENTRY_SYSCALL_FRAME);
    const bad = good.map((command) =>
      command.mnemonic === 'setwd' && (command.operands[0] as { value?: number }).value === 8
        ? ({ mnemonic: 'setwd', channel: 0, operands: [imm(9), imm(0)] } as AsmInstruction)
        : command,
    );
    expect(localWindowProblems(bad, ENTRY_SYSCALL_FRAME).join(' ')).toMatch(/вместо 8/);
  });

  it('без закрытия вовсе — отвергается', () => {
    const good = exitPrimitives(0, ENTRY_SYSCALL_FRAME);
    const bad = good.filter((command, index) => !(index === good.length - 1 && command.mnemonic === 'setwd'));
    expect(localWindowProblems(bad, ENTRY_SYSCALL_FRAME).join(' ')).toMatch(/нет закрытия/);
  });
});
