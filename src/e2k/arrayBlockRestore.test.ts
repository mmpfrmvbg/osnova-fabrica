/**
 * СТОРОЖ D12: САЙТ ПЕЧАТИ В ТОЧКЕ ВХОДА ВОЗВРАЩАЕТ БЛОК РАНТАЙМА МАССИВОВ ПОСЛЕ СИСТЕМНОГО ВЫЗОВА.
 *
 * # Дефект, ради которого это написано (замер 2026-11-08, канал D12)
 *
 * Прямой инструкционный зонд (`.tmp/d12-asm/probe-*.s`, вендорские `as`/`ld`; ОДИН И ТОТ ЖЕ файл
 * прогнан на железе и на модели):
 *
 *   `%b[12]=0, %b[13]=1, %b[14]=8, %b[15]=0x11` → холостой `write(1, NULL, 0)` → `exit(%b[N])`
 *
 *   • железо (`a1d3a4a788e9`, e2k E8C2): все четыре клетки читаются **0**; без вызова — **8**;
 *   • модель (наш порт): **8** и с вызовом, и без.
 *
 * Механизм — закон окна: `call wbs = 4` сдвигает окно на восемь регистров, поэтому `%b[12..15]`
 * ВЫЗЫВАЮЩЕГО — это `%b[4..7]` ВЫЗЫВАЕМОГО (ядра), и ядро их зануляет. Наша программа держала в них
 * `0`, `1`, `8` и адрес ячейки кучи (`ENTRY_ARRAY_CELLS`), поэтому после `вывести` чтение `а[1]`
 * давало `а[0]` (сдвиг на элемент), `создать` падало кодом 139, а полный лексер на железе терял
 * последний токен (342 числа из 343).
 *
 * # Что стережёт этот файл
 *
 * Восстановление — ТРИ команды (`movts 1`, `movts 8`, `movtd адрес кучи`), они встают ТОЛЬКО у
 * сайта в кадре точки входа и ТОЛЬКО у образа, который пользуется рантаймом массивов. Здесь
 * проверяется каждая часть этого решения, чтобы ни одна не пропала молча:
 *
 *   1. последовательность и её формы (раскладка обязана уметь её посчитать — класс §3.35);
 *   2. она есть в командах сайта печати с кадром возврата и её НЕТ без него (это и есть N=1:
 *      снятие восстановления из `writeTextPrimitives` краснит ровно этот файл);
 *   3. канал к раскладке: метка кадра `2` доезжает до кадра (иначе форма сайта разойдётся с байтами);
 *   4. признак образа (`entryUsesArrayRuntime`) — по массиву в теле точки входа, а не по всей программе.
 *
 * Чего здесь НЕТ и почему: поведенческой проверки на модели быть не может — модель этот закон НЕ
 * воспроизводит (см. замер выше), поэтому дефект на ней невидим. Поведение доказывается железом:
 * 5/5 проб-репро (`.tmp/hw-d12/report-fix.txt`) и полный лексер (`.tmp/hw-lexer-fix/report.txt`,
 * 342 токена, sha256 `cd75b24c…`, совпадение с эталоном модели побайтово).
 */
import { describe, expect, it } from 'vitest';
import { arrayBlockRestore } from './arrayRuntime';
import { entryUsesArrayRuntime } from './programImage';
import {
  ENTRY_SYSCALL_FRAME,
  GROWN_SYSCALL_FRAME,
  type SyscallFrame,
} from './syscallRuntime';
import {
  PRINT_FRAME_OPERAND,
  PRINT_HEAP_BY_CONVENTION,
  printCallInstructions,
  printCommandForm,
  syscallFrameOfCarrier,
  withPrintFrame,
} from './printCall';
import type { AsmInstruction } from './backend';

const HEAP = PRINT_HEAP_BY_CONVENTION;

/** Кадр точки входа, обязанный вернуть блок: ровно то, что строит конвейер для образа с массивами. */
const RESTORING_FRAME: SyscallFrame = { ...ENTRY_SYSCALL_FRAME, restoreHeapAddress: HEAP };

describe('D12: блок рантайма массивов после системного вызова в точке входа', () => {
  it('последовательность — ровно три команды: единица, восемь, адрес ячейки кучи', () => {
    const команды = arrayBlockRestore(HEAP);
    expect(команды.map((команда) => команда.mnemonic)).toEqual(['movts', 'movts', 'movtd']);
    const значения = команды.slice(0, 2).map((команда) => {
      const источник = команда.operands[0];
      const приёмник = команда.operands[1];
      expect(источник?.kind).toBe('imm');
      expect(приёмник?.kind).toBe('reg');
      return `${String(источник?.kind === 'imm' ? источник.value : '?')}→%b[${String(приёмник?.kind === 'reg' ? приёмник.index : '?')}]`;
    });
    // ЕДИНИЦА и ВОСЕМЬ — те же клетки, что кладёт пролог образа (`ENTRY_ARRAY_CELLS`): иначе
    // `добавить` посчитал бы длину как «прочитанная + 0», а чтение пошло бы по длине.
    expect(значения).toEqual(['1→%b[13]', '8→%b[14]']);
    const адрес = команды[2]?.operands[0];
    const приёмникАдреса = команды[2]?.operands[1];
    expect(адрес?.kind).toBe('imm64');
    expect(приёмникАдреса?.kind === 'reg' ? приёмникАдреса.index : undefined).toBe(15);
    expect(адрес?.kind === 'imm64' ? String(адрес.value) : undefined).toBe(String(HEAP));
  });

  it('у каждой команды есть форма — раскладка посчитает её длину (иначе адреса уедут, §3.35)', () => {
    let байт = 0;
    for (const команда of arrayBlockRestore(HEAP)) {
      const форма = printCommandForm(команда);
      expect(форма, `нет формы у «${команда.mnemonic}»`).toBeDefined();
      байт += форма!.size;
    }
    // Замер побайтовой сверки (`docs/hardware-debt.md` §3.40.5): `movts` — 8 байт, `movtd` с
    // 64-битным литералом — 16. Цена сайта с массивом названа числом: 32 байта.
    expect(байт).toBe(32);
  });

  it('сайт печати С КАДРОМ ВОЗВРАТА содержит восстановление, БЕЗ кадра — нет (N=1)', () => {
    const сВозвратом = printCallInstructions(2, HEAP, RESTORING_FRAME);
    const без = printCallInstructions(2, HEAP, ENTRY_SYSCALL_FRAME);
    const искомые = arrayBlockRestore(HEAP);
    // Кадр возврата добавляет РОВНО восстановление и ничего больше.
    expect(сВозвратом.length).toBe(без.length + искомые.length);
    // Первая различающаяся позиция — начало вставки; вставляются ровно те три команды, хвост цел.
    let i = 0;
    const подпись = (команда: AsmInstruction | undefined): string =>
      команда === undefined ? '' : `${команда.mnemonic}/${JSON.stringify(команда.operands, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))}`;
    while (i < без.length && подпись(сВозвратом[i]) === подпись(без[i])) i++;
    expect(сВозвратом.slice(i, i + искомые.length)).toEqual(искомые);
    expect(сВозвратом.slice(i + искомые.length).map((команда) => команда.mnemonic)).toEqual(
      без.slice(i).map((команда) => команда.mnemonic),
    );
    // Восстановление идёт ПОСЛЕ системного вызова, а не до: ядро портит клетки внутри `call`.
    const вызов = без.findIndex((команда) => команда.mnemonic === 'call');
    expect(вызов).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(вызов);
  });

  it('канал к раскладке: метка кадра «2» доезжает до кадра с адресом кучи, «1» остаётся выращенной', () => {
    const носитель: AsmInstruction = {
      mnemonic: 'IR.invoke',
      channel: 0,
      operands: [],
    };
    const возврат = withPrintFrame(носитель, RESTORING_FRAME);
    expect(возврат.operands[PRINT_FRAME_OPERAND]).toEqual({ kind: 'imm', value: 2 });
    const кадрВозврата = syscallFrameOfCarrier(возврат, HEAP);
    expect(кадрВозврата.restoreHeapAddress).toBe(HEAP);
    // Адрес по умолчанию — конвенция образа: разойдись она с понижением, `%b[15]` нёс бы ЧУЖОЙ адрес.
    expect(syscallFrameOfCarrier(возврат).restoreHeapAddress).toBe(PRINT_HEAP_BY_CONVENTION);
    const выращенный = withPrintFrame(носитель, GROWN_SYSCALL_FRAME);
    expect(выращенный.operands[PRINT_FRAME_OPERAND]).toEqual({ kind: 'imm', value: 1 });
    expect(syscallFrameOfCarrier(выращенный).wbs).toBe(GROWN_SYSCALL_FRAME.wbs);
    // Без метки — кадр точки входа БЕЗ возврата: программы без массивов не платят ни байта.
    expect(syscallFrameOfCarrier(носитель)).toBe(ENTRY_SYSCALL_FRAME);
    expect(withPrintFrame(носитель, ENTRY_SYSCALL_FRAME)).toBe(носитель);
  });

  it('признак образа: массив в ТЕЛЕ точки входа, а не в чужой процедуре', () => {
    const имена = ['система.массив.получить', 'система.лог.вывести'];
    const вызов = (payload: number): AsmInstruction => ({
      mnemonic: 'IR.invoke',
      channel: 0,
      operands: [{ kind: 'imm', value: 1 }, { kind: 'reg', index: 0 }, undefined, { kind: 'imm', value: payload }],
    });
    // Тело точки входа: вызов массива → признак есть.
    expect(entryUsesArrayRuntime([вызов(0)], [], 0, имена)).toBe(true);
    // Тело точки входа без массива (только печать) → признака нет: лишних команд не будет.
    expect(entryUsesArrayRuntime([вызов(1)], [], 0, имена)).toBe(false);
    // Массив живёт в ВЫЗЫВАЕМОЙ процедуре, а тело точки входа чисто → сайту печати в точке входа
    // возвращать нечего (у выращенной процедуры окно ядра далеко от блока).
    const процедуры = [
      { name: 'точка входа', codeOffset: 0 },
      { name: 'р', codeOffset: 2 },
    ];
    expect(entryUsesArrayRuntime([вызов(1), вызов(1), вызов(0)], процедуры, 0, имена)).toBe(false);
    expect(entryUsesArrayRuntime([вызов(0), вызов(1), вызов(1)], процедуры, 0, имена)).toBe(true);
  });
});
