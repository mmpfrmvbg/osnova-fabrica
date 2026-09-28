/**
 * СТОРОЖ КОНТРАКТА `OSN-LOW-*`: ПРИЧИНА — ЛИЧНОСТЬ, А НЕ СТРОКА.
 *
 * # Что здесь утверждается
 *
 * 1. **Код есть у каждого отказа и он ИЗ ТАБЛИЦЫ.** Сторож проходит по потокам реальных
 *    программ и требует у каждой записи `refused` код из `LOWERING_CODES` — не «похожий», не
 *    пустой и не выдуманный на месте.
 * 2. **Код выбирает ПРОИЗВОДИТЕЛЬ, а не читатель.** Проверяется на живых отказах: `IR.rem` даёт
 *    `001`, строковая константа — `002`, вызов вне рантайма — `003`, переход без смещения —
 *    `004`, сайт печати без свободного регистра — `005`, два возврата со значением — `006`,
 *    носитель не той формы — `007`.
 * 3. **НЕГАТИВНЫЙ КОНТРОЛЬ, ровно как заказан:**
 *    - подмена ТЕКСТА причины (значение константы, номер носителя) класс НЕ меняет;
 *    - подмена КОДА класс МЕНЯЕТ.
 *    Это и есть измеренная цена отсутствия контракта: до него первое было недостижимо.
 * 4. **Коды не переиспользуются и не остаются без имени:** у каждого кода есть расшифровка и
 *    класс, коды уникальны, и в `src/e2k/**` нет кодов, записанных СТРОКОЙ мимо таблицы —
 *    иначе контракт расползётся по литералам.
 * 5. **Каналов два — личность одна:** запись в `refused` и БРОШЕННЫЙ отказ несут один и тот же
 *    признак `code`, и читатель (`codeOfThrown`) берёт именно его, а не имя класса и не текст.
 *
 * # Чего здесь НЕТ
 *
 * Прогона в модели: все проверки — устройство конвейера и контракта. Отказы, которые видит цель,
 * проверяет шлюз (`gate:qemu`), а витрину отказов — наблюдатель
 * (`src/scripts/e2kLoweringDiagnostics.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AsmInstruction, Operand } from './backend';
import { lowerCarrier, lowerInstruction } from './e2kRealRun';
import { pairPredicates } from './predicatePairing';
import { secondPass, layoutOf } from './twoPassLayout';
import { imageOfCarriers, loweredProgram } from './programImage';
import { planPrintSite, PrintCallRefusal } from './printCall';
import {
  LOWERING_CODES,
  LOWERING_CODE_CLASSES,
  LOWERING_CODE_LIST,
  LOWERING_CODE_MEANINGS,
  codeOfThrown,
  isLoweringRefusalCode,
  type LoweringRefusalCode,
} from './loweringRefusal';
import { buildE2kImage, MultiReturnRefusal } from '../scripts/e2kProgramRun';

const ROOT = path.resolve(__dirname, '..', '..');
const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const carrier = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({ mnemonic, channel: 0, operands });

/** Программа с двумя возвратами со значением — обвязка такую вызвать не может. */
const TWO_RETURNS = fs.readFileSync(
  path.join(ROOT, 'tools', 'e2k-hardware', 'limits', 'multi-return-two-branches.osnova'),
  'utf-8',
);

/** Программа со строковой константой: значение не выражается литералом e2k. */
const STRING_CONSTANT = 'модуль С\nпроцедура главная()\n  пусть имя = "Аня"\n  вернуть система.строка.длина(имя)\nконец\nконец\n';

describe('контракт отказа понижения: код — личность причины', () => {
  it('таблица кодов: у каждого кода есть имя и класс, коды уникальны', () => {
    expect(LOWERING_CODE_LIST).toHaveLength(Object.keys(LOWERING_CODES).length);
    expect(new Set(LOWERING_CODE_LIST).size, 'коды не повторяются').toBe(LOWERING_CODE_LIST.length);
    for (const code of LOWERING_CODE_LIST) {
      expect(LOWERING_CODE_MEANINGS[code], `имя кода ${code}`).toBeTruthy();
      expect(LOWERING_CODE_CLASSES[code], `класс кода ${code}`).toBeTruthy();
      expect(isLoweringRefusalCode(code)).toBe(true);
    }
    // Классы различимы: два кода с одним классом слили бы разные причины в одну личность.
    expect(new Set(Object.values(LOWERING_CODE_CLASSES)).size, 'классы различимы').toBe(LOWERING_CODE_LIST.length);
    // Код вне таблицы читателем не признаётся — «похожего» не подбираем.
    expect(isLoweringRefusalCode('OSN-LOW-999')).toBe(false);
    expect(isLoweringRefusalCode(undefined)).toBe(false);
  });

  it('001/002/004: коды называют понижение, константа и раскладка', () => {
    // 001 — формы понижения нет (`IR.rem` в таблице понижения описан отказом).
    const noForm = lowerCarrier(carrier('IR.rem', [reg(1)]));
    expect(noForm.ok).toBe(false);
    if (!noForm.ok) expect(noForm.code).toBe(LOWERING_CODES.noForm);
    expect(lowerInstruction(carrier('IR.нетТакого', [reg(1)])).ok).toBe(false);

    // 002 — константа невыразима: значение из пула не целое 16/32 бита.
    const constant = lowerCarrier(carrier('IR.const', [reg(1), imm(0), imm(0)]), { constants: ['Аня'] });
    expect(constant.ok).toBe(false);
    if (!constant.ok) expect(constant.code).toBe(LOWERING_CODES.constant);

    // 004 — переход без смещения: смещение даёт раскладка, а не понижение.
    const jump = lowerCarrier(carrier('IR.jmp', [imm(0)]));
    expect(jump.ok).toBe(false);
    if (!jump.ok) expect(jump.code).toBe(LOWERING_CODES.layout);
  });

  it('003: операция вне рантайма и носитель вызова — «вызов-вне-рантайма»', () => {
    const invoke = carrier('IR.invoke', [imm(3), reg(1), reg(0), imm(0), reg(2)]);
    const outside = lowerCarrier(invoke, { invokeNames: ['система.строка.длина'] });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe(LOWERING_CODES.runtime);
    // Арность вызова больше носителя — та же личность: обвязка этого не несёт.
    const arity = lowerCarrier(carrier('IR.call', [imm(0b111), reg(1), reg(2), reg(3)]), { callDisplacement: 1 });
    expect(arity.ok).toBe(false);
    if (!arity.ok) expect(arity.code).toBe(LOWERING_CODES.runtime);
  });

  it('007: носитель не той формы — «контракт конвейера», а не «язык не умеет»', () => {
    // `IR.invoke` без списка имён: контекст не передан — это дефект обвязки, а не долг языка.
    const missingNames = lowerCarrier(carrier('IR.invoke', [imm(1), reg(1), reg(0), imm(0), reg(1)]));
    expect(missingNames.ok).toBe(false);
    if (!missingNames.ok) expect(missingNames.code).toBe(LOWERING_CODES.carrier);
    // Операнды сравнения не регистры.
    const comparison = lowerCarrier(carrier('IR.lt', [reg(1), imm(2), reg(3)]), {
      predicate: { mnemonic: 'cmplsb', index: 1 },
    });
    expect(comparison.ok).toBe(false);
    if (!comparison.ok) expect(comparison.code).toBe(LOWERING_CODES.carrier);
  });

  it('004: сопоставление предикатов и второй проход несут код раскладки', () => {
    // Сравнение, результат которого никто не читает: пары нет — предикат некуда деть.
    const pairing = pairPredicates([carrier('IR.lt', [reg(1), reg(2), reg(3)]), carrier('IR.ret', [imm(0), reg(1)])]);
    expect(pairing.refusals.length).toBeGreaterThan(0);
    for (const refusal of pairing.refusals) expect(refusal.code).toBe(LOWERING_CODES.layout);

    // Цель перехода вне потока — второй проход: носитель нарушает контракт (007), а не раскладка.
    const stream = [carrier('IR.jmp', [imm(9)])];
    const table = layoutOf(stream, {});
    const pass = secondPass(stream, table.addresses);
    expect(pass.refusals.length).toBe(1);
    expect(pass.refusals[0]!.code).toBe(LOWERING_CODES.carrier);
  });

  it('005: отказ печати несёт код в САМОМ исключении', () => {
    // Живы все двенадцать рабочих регистров — свободного под адрес слота нет.
    let thrown: unknown;
    try {
      planPrintSite({ argument: 13, heapAddress: 0x102000, liveAfter: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'отказ печати обязан быть брошен').toBeInstanceOf(PrintCallRefusal);
    expect(codeOfThrown(thrown)).toBe(LOWERING_CODES.print);
  });

  it('006: обвязка — два возврата со значением — код в исключении', () => {
    let thrown: unknown;
    try {
      buildE2kImage(TWO_RETURNS);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MultiReturnRefusal);
    expect(codeOfThrown(thrown)).toBe(LOWERING_CODES.wrapper);
  });

  it('записи `refused` несут код: у шести записей печати — ноль отказов, у остатка — 001', () => {
    // Печать понижается: отказов нет вовсе.
    const printed = imageOfCarriers([carrier('IR.ret', [imm(0), reg(0)])], [], []);
    expect(printed.refused).toEqual([]);
    // `IR.rem`: одна запись, и у неё код 001 — не строка без кода.
    const image = loweredProgram('модуль О\nпроцедура главная()\n  вернуть 17 % 5\nконец\nконец\n');
    expect(image.refused).toHaveLength(1);
    expect(image.refused[0]!.code).toBe(LOWERING_CODES.noForm);
    expect(image.refused[0]!.reason).toContain('IR.rem');
    for (const refusal of image.refused) expect(isLoweringRefusalCode(refusal.code)).toBe(true);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: подмена ТЕКСТА класса не меняет, подмена КОДА меняет', () => {
    // Одна и та же причина с РАЗНЫМИ значениями даёт РАЗНЫЙ текст — и тот же код.
    const first = loweredProgram(STRING_CONSTANT);
    const second = loweredProgram(STRING_CONSTANT.replace('Аня', 'Борис и компания'));
    expect(first.refused[0]!.reason, 'текст несёт значение — он различается').not.toBe(second.refused[0]!.reason);
    expect(first.refused[0]!.code, 'а код — нет: причина одна').toBe(second.refused[0]!.code);
    expect(first.refused[0]!.code).toBe(LOWERING_CODES.constant);

    // Класс читается ИЗ КОДА: тот же код — тот же класс, другой код — другой класс.
    const codeOf = (refusal: { code: LoweringRefusalCode }): string => LOWERING_CODE_CLASSES[refusal.code];
    expect(codeOf(first.refused[0]!)).toBe(codeOf(second.refused[0]!));
    expect(codeOf(first.refused[0]!)).not.toBe(LOWERING_CODE_CLASSES[LOWERING_CODES.layout]);
    expect(codeOf({ code: LOWERING_CODES.print })).not.toBe(codeOf({ code: LOWERING_CODES.constant }));
  });

  it('коды не записываются строкой мимо таблицы — контракт не расползается по литералам', () => {
    // Сторож на КЛАСС, а не на случай: смотрит исходники плоскости и требует, чтобы код
    // назывался через LOWERING_CODES, а не литералом 'OSN-LOW-00N'.
    const problems: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (path.basename(full) === 'loweringRefusal.ts') continue; // здесь коды и ОБЪЯВЛЕНЫ
        const text = fs.readFileSync(full, 'utf-8');
        for (const match of text.matchAll(/'(OSN-LOW-\d{3})'/g)) {
          problems.push(`${path.relative(ROOT, full)}: код литералом «${match[1]}» — брать из LOWERING_CODES`);
        }
      }
    };
    walk(path.join(ROOT, 'src', 'e2k'));
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
