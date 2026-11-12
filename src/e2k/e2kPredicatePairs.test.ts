// Состояние (перемерено 2026-09-24). См. hardware-debt §3.23.
/**
 * ОРАКУЛ СОПОСТАВЛЕНИЯ ПАРЫ «СРАВНЕНИЕ → УСЛОВНЫЙ ПЕРЕХОД» — НАПИСАН ДО РЕАЛИЗАЦИИ.
 *
 * # Почему пара, а не две независимые инструкции
 *
 * Измерено на пяти ядрах (до этой правки): `IR.jmp_if_not` — 14, `IR.jmp_if` — 0, и все 14
 * условий приходят из сравнений (`IR.lt` 12, `IR.ge` 1, `IR.le` 1). Результат каждого сравнения
 * читает **только** следующий за ним переход, лишних читателей — 0 из 14. Значит значение в
 * регистре мертво, и достаточно **предиката**: `cmp<условие> a, b → %predN` плюс
 * `ct %ctpr1 ? {~}%predN`.
 *
 * # Предпосылка, которая ПРОВЕРЯЕТСЯ, а не предполагается
 *
 * Понижение верно только тогда, когда результат сравнения никому, кроме этого перехода, не нужен.
 * Поэтому проход сопоставления (`pairPredicates`) её проверяет и **отказывает с причиной**, если
 * у результата есть другой читатель, если читателей нет вовсе, или если условие перехода пришло
 * не из сравнения. Молчаливого понижения «похоже на пару» не бывает.
 *
 * # Полярность `ct`
 *
 * `ct` передаёт управление, когда предикат **истинен**: `? %predN` — `CTCOND_PRED = 0x40`
 * (`gas/config/tc-e2k.c:4589-4591`), `? ~%predN` — `CTCOND_NEG_PRED = 0x60`
 * (`opcodes/e2k-dis.c:1584-1640`). Предикат — результат **самого сравнения**, поэтому:
 *
 * | сравнение | `jmp_if_not` (передать, когда условие ЛОЖНО) | `jmp_if` |
 * |---|---|---|
 * | `lt` → `cmplsb` (условие 6) | `ct ? ~%predN` (0x60) | `ct ? %predN` (0x40) |
 * | `le` → `cmplesb` (7) | `ct ? ~%predN` | `ct ? %predN` |
 * | `ge` = НЕ «меньше» → `cmplsb` | `ct ? %predN` — двойное отрицание | `ct ? ~%predN` |
 * | `gt` = НЕ «не больше» → `cmplesb` | `ct ? %predN` | `ct ? ~%predN` |
 * | `eq` → `cmpesb` (2) | `ct ? ~%predN` | `ct ? %predN` |
 * | `ne` = НЕ «равно» → `cmpesb` | `ct ? %predN` | `ct ? ~%predN` |
 *
 * Условий «больше»/«больше или равно» в наборе `cmp*` **нет** — оттого `ge`/`gt` и выражаются
 * отрицанием (таблица: `opcodes/e2k-opc.h:989-1064`, набор `o,b,e,be,s,p,l,le`).
 *
 * # Чего оракул НЕ доказывает
 *
 * Что код исполнится и что `ct` прочитает **готовый** предикат: `cmp` оставляет два слота выдачи
 * (`nop = 2`), а серия ставит между сравнением и передачей ровно две команды (`disp`, `ct`).
 * Это по-прежнему **допущение**, а не замер (`src/e2k/e2kPredicates.test.ts`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { getEncoder, sameInstruction, toHex, type AsmInstruction, type Operand } from './backend';
import { emitShell } from './emitterShell';
import { annotateAtomRegions, verifyAtomRegions } from '../compiler/atomRegions';
import { regModuleOf } from '../vliw/regOracle';
import { layoutOf, secondPass } from './twoPassLayout';
import { lowerCarrier, runKernelThroughRealEncoding } from './e2kRealRun';
import { assembleAll, findExternalAs, type AsSample } from '../scripts/e2kExternalAs';
import { CT_COND_ALWAYS } from './e2k-real';
import { PREDICATE_FOR_PAIRS, comparisonMnemonicOf, isMaterializingComparison, pairPredicates } from './predicatePairing';

const ROOT = path.resolve(__dirname, '..', '..');
const KERNELS = [
  { name: 'fir', atom: 'A5' },
  { name: 'iir', atom: 'A5' },
  { name: 'fft', atom: 'A5' },
  { name: 'convolution', atom: 'A6' },
  { name: 'correlation', atom: 'A6' },
];
const shellEncoder = getEncoder('internal-shell');
const realEncoder = getEncoder('e2k');

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const ir = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({ mnemonic, channel: 0, operands });

/** Поток носителей IR ядра — тот же путь, что в сквозном прогоне. */
function kernelCarriers(name: string, atom: string): readonly AsmInstruction[] {
  const source = fs.readFileSync(path.join(ROOT, 'tests', 'dsp', 'kernels', `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  const annotated = annotateAtomRegions(built.module, [
    { atom, procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) throw new Error(`${name}: разметка атомов: ${problems.join('; ')}`);
  return emitShell(annotated, shellEncoder).instructions;
}

const CARRIERS: ReadonlyMap<string, readonly AsmInstruction[]> = new Map(
  KERNELS.map(({ name, atom }) => [name, kernelCarriers(name, atom)]),
);
const ALL: readonly AsmInstruction[] = [...CARRIERS.values()].flat();

describe('сопоставление пары: 1. на пяти ядрах', () => {
  it('пар ровно 14 — столько же, сколько условных переходов и сравнений', () => {
    const pairing = pairPredicates(ALL);
    expect(pairing.pairs.length, 'пар не столько, сколько условных переходов').toBe(14);
    expect(pairing.refusals, 'в пяти ядрах все пары обязаны найтись').toEqual([]);
    const jumps = ALL.filter((item) => item.mnemonic === 'IR.jmp_if_not').length;
    expect(jumps).toBe(14);
    for (const pair of pairing.pairs) {
      // Сравнение пишет ровно тот регистр, который читает переход.
      expect(ALL[pair.comparisonIndex]!.operands[0], `${pair.comparison} #${pair.comparisonIndex}: приёмник`).toEqual(
        ALL[pair.jumpIndex]!.operands[0],
      );
      expect(ALL[pair.jumpIndex]!.mnemonic, 'переход пары').toMatch(/^IR\.jmp_if/);
      expect(ALL[pair.comparisonIndex]!.mnemonic, 'сравнение пары').toMatch(/^IR\.(lt|le|ge|gt|eq|ne)$/);
      expect(pair.predicate, 'номер предиката пары').toBe(PREDICATE_FOR_PAIRS);
      expect([0x40, 0x60], 'код условия передачи').toContain(pair.condition);
    }
    // Полярность по ядрам: lt/le с jmp_if_not — отрицание предиката (0x60), ge — двойное (0x40).
    const polarities = pairing.pairs.map((pair) => [pair.comparison, pair.condition]);
    expect(polarities.filter(([, condition]) => condition === 0x60).length).toBe(13);
    expect(polarities.filter(([, condition]) => condition === 0x40).length).toBe(1);
  });

  it('мнемоника сравнения берётся из условия IR, а не подбирается', () => {
    expect(comparisonMnemonicOf('IR.lt')).toEqual({ mnemonic: 'cmplsb', flipped: false });
    expect(comparisonMnemonicOf('IR.le')).toEqual({ mnemonic: 'cmplesb', flipped: false });
    expect(comparisonMnemonicOf('IR.eq')).toEqual({ mnemonic: 'cmpesb', flipped: false });
    // Условий «больше»/«больше или равно» в наборе cmp* нет — они выражаются отрицанием.
    expect(comparisonMnemonicOf('IR.ge')).toEqual({ mnemonic: 'cmplsb', flipped: true });
    expect(comparisonMnemonicOf('IR.gt')).toEqual({ mnemonic: 'cmplesb', flipped: true });
    expect(comparisonMnemonicOf('IR.ne')).toEqual({ mnemonic: 'cmpesb', flipped: true });
    expect(comparisonMnemonicOf('IR.jmp')).toBeUndefined();
  });
});

describe('сопоставление пары: 2. предпосылка проверяется, а не предполагается', () => {
  // Сравнение — НОВЫЙ объект на проверку: пометка материализации живёт в `WeakSet` по тождеству и
  // общий объект протёк бы из проверки в проверку (тогда «не помечено» перестало бы что-то значить).
  const cmp = (): AsmInstruction => ir('IR.lt', [reg(5), reg(3), reg(4)]);
  const JUMP_NOT = (cond: number): AsmInstruction => ir('IR.jmp_if_not', [reg(cond), imm(3)]);

  it('другой читатель результата — пара СОСТАВЛЕНА, а значение уезжает в регистр (срез A4-5а)', () => {
    const stream: readonly AsmInstruction[] = [
      cmp(),
      JUMP_NOT(5),
      ir('IR.move', [reg(9), reg(5)]), // читает результат сравнения — значение обязано жить в регистре
      ir('IR.move', [reg(9), reg(9)]),
    ];
    const pairing = pairPredicates(stream);
    // БЫЛО (до A4-5а): «другой читатель результата» — отказ, потому что предикат значения не несёт.
    // СТАЛО: сравнение помечается материализующим, значение кладут две predicated `movts`, и лишний
    // читатель-значение больше НЕ отказ. Отказ остался бы там, где значение некуда положить.
    expect(pairing.refusals, 'лишний читатель-значение снова отказ').toEqual([]);
    expect(pairing.pairs.map((пара) => пара.comparisonIndex), 'пара потеряна — переход остался бы без предиката').toEqual([
      0,
    ]);
    expect(isMaterializingComparison(stream[0]!), 'значение не материализуется — цель прочтёт мусор').toBe(true);
  });

  it('два читателя-перехода — пара не составляется и ОБА перехода отказали; ноль читателей — тоже отказ', () => {
    const twoJumps: readonly AsmInstruction[] = [cmp(), JUMP_NOT(5), JUMP_NOT(5)];
    const pairing = pairPredicates(twoJumps);
    // Предикат у пары один, а переходов-читателей два: пары нет. Значение при этом кладёт
    // материализация (срез A4-5а), а каждый осиротевший переход отказывает ПО ИМЕНИ — молчания нет.
    expect(pairing.pairs).toEqual([]);
    expect(isMaterializingComparison(twoJumps[0]!), 'значение обязано уехать в регистр').toBe(true);
    expect(pairing.refusals.map((отказ) => отказ.index), 'оба перехода обязаны быть названы').toEqual([1, 2]);
    for (const отказ of pairing.refusals) expect(отказ.reason).toMatch(/сравнени/i);

    const none: readonly AsmInstruction[] = [cmp(), ir('IR.move', [reg(9), reg(9)])];
    const unread = pairPredicates(none);
    expect(unread.pairs).toEqual([]);
    expect(unread.refusals[0]!.reason, 'не сказано, что результат никем не читается').toMatch(/никем|нет читател/i);
    expect(isMaterializingComparison(none[0]!), 'нечитанное значение материализовать нечего').toBe(false);
  });

  it('условие перехода пришло не из сравнения — отказ с причиной', () => {
    const stream: readonly AsmInstruction[] = [
      ir('IR.move', [reg(5), reg(9)]), // пишет регистр условия, но это не сравнение
      JUMP_NOT(5),
      ir('IR.move', [reg(1), reg(1)]),
    ];
    const pairing = pairPredicates(stream);
    expect(pairing.pairs).toEqual([]);
    expect(pairing.refusals.length).toBeGreaterThan(0);
    expect(pairing.refusals.map((item) => item.reason).join(' '), 'не сказано, что условие не из сравнения').toMatch(
      /сравнени/i,
    );
  });

  it('безусловный переход пары не требует и не отвергается', () => {
    const stream: readonly AsmInstruction[] = [ir('IR.jmp', [imm(0)]), ir('IR.move', [reg(1), reg(1)])];
    const pairing = pairPredicates(stream);
    expect(pairing.pairs).toEqual([]);
    expect(pairing.refusals, 'IR.jmp не условный — сопоставление его не касается').toEqual([]);
  });
});

describe('сопоставление пары: 3. понижение', () => {
  it('сравнение понижается в одну команду cmp с предикатом-приёмником', () => {
    const comparison = ir('IR.lt', [reg(5), reg(3), reg(4)]);
    const lowered = lowerCarrier(comparison, { predicate: { mnemonic: 'cmplsb', index: 0 } });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.length).toBe(1);
    expect(lowered.instructions[0]).toEqual({
      mnemonic: 'cmplsb',
      channel: 0,
      operands: [reg(3), reg(4), { kind: 'pred', index: 0 }],
    });
    // Без сопоставления — отказ с причиной, а не выдуманный предикат.
    const alone = lowerCarrier(comparison);
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.reason, 'не сказано, что нужна пара').toMatch(/пар|переход|предикат/i);
  });

  it('условный переход понижается серией disp + ct с кодом условия пары', () => {
    const jump = ir('IR.jmp_if_not', [reg(5), imm(2)]);
    const lowered = lowerCarrier(jump, { condition: 0x60, displacement: 3 });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;
    expect(lowered.instructions.map((command) => command.mnemonic)).toEqual(['disp', 'ct']);
    // disp несёт смещение, ct — условие пары.
    expect(lowered.instructions[0]!.operands[1]).toEqual(imm(3));
    expect(lowered.instructions[1]!.operands[1]).toEqual(imm(0x60));
    for (const command of lowered.instructions) {
      expect(sameInstruction(realEncoder.decode(realEncoder.encode(command)), command), command.mnemonic).toBe(true);
    }
    // Без сопоставления — отказ с причиной.
    const alone = lowerCarrier(jump, { displacement: 3 });
    expect(alone.ok).toBe(false);
    // Безусловный переход по-прежнему передаёт управление всегда.
    const always = lowerCarrier(ir('IR.jmp', [imm(2)]), { displacement: 3 });
    expect(always.ok).toBe(true);
    if (always.ok) expect(always.instructions[1]!.operands[1]).toEqual(imm(CT_COND_ALWAYS));
  });
});

describe('сопоставление пары: 4. раскладка и покрытие', () => {
  it('сравнения и условные переходы получают адреса: размещено 425, не размещено 86', () => {
    const layout = layoutOf(ALL);
    expect(layout.entries.length, 'покрытие раскладки').toBe(425);
    expect(layout.unplaced.length, 'отказов раскладки').toBe(86);
    const byCarrier = new Map<string, number>();
    for (const entry of layout.entries) byCarrier.set(entry.carrier, (byCarrier.get(entry.carrier) ?? 0) + 1);
    expect(byCarrier.get('IR.jmp_if_not')).toBe(14);
    expect(byCarrier.get('IR.lt')).toBe(12);
    expect(byCarrier.get('IR.le')).toBe(1);
    expect(byCarrier.get('IR.ge')).toBe(1);
    // Вызов и возврат ПОЛУЧИЛИ формы (шаг 3): их длина перестала быть неизвестной, и они размещаются.
    expect(byCarrier.get('IR.call'), 'вызов размещается').toBe(11);
    expect(byCarrier.get('IR.ret'), 'возврат размещается').toBe(32);
    // `IR.invoke` размещается только там, где рантайм массивов может взять имя и операнды не попали в
    // зарезервированную область; поэтому в этом потоке (носители БЕЗ раскладки регистров) его нет.
    expect(byCarrier.has('IR.invoke'), 'IR.invoke без раскладки регистров не размещается').toBe(false);
  });

  it('смещения считаются и для условных переходов', () => {
    for (const [name, carriers] of CARRIERS) {
      const resolved = secondPass(carriers, firstPassAddresses(carriers));
      expect(resolved.refusals, `${name}: смещение не разрешено`).toEqual([]);
      const jumps = carriers.filter((item) => item.mnemonic.startsWith('IR.jmp')).length;
      expect(resolved.displacements.length, `${name}: смещений не столько, сколько переходов`).toBe(jumps);
    }
  });

  it('сквозной прогон: понижено 413 из 458, отвергнуто 45, байт 7448', () => {
    let encoded = 0;
    let refused = 0;
    let bytes = 0;
    let instructions = 0;
    let eliminated = 0;
    const mismatches: string[] = [];
    for (const { name, atom } of KERNELS) {
      const source = fs.readFileSync(path.join(ROOT, 'tests', 'dsp', 'kernels', `${name}.osnova`), 'utf-8');
      const built = regModuleOf(source)!;
      const annotated = annotateAtomRegions(built.module, [
        { atom, procedures: built.module.procedures.map((procedure) => procedure.name) },
      ]);
      const emitted = emitShell(annotated, shellEncoder);
      const report = runKernelThroughRealEncoding(emitted, realEncoder, { kernel: name, atom });
      instructions += report.instructions;
      eliminated += report.eliminated;
      encoded += report.encoded;
      refused += report.refused;
      bytes += report.bytes;
      mismatches.push(...report.roundTrip.mismatches.map((item) => `${name}: ${item}`));
      // «Размещено» — у скольких носителей известна ДЛИНА; «понижено» — сколько дошло до байтов.
      // Различаются они там, где носитель с формой не понизился (у вызова `convolution` нет адреса
      // цели: вызываемая процедура не размещена). Строгое равенство — частный случай.
      expect(report.layout.placed, `${name}: понижено больше, чем размещено`).toBeGreaterThanOrEqual(report.encoded);
      expect(report.layout.placed, `${name}: размещено`).toBe(report.instructions - report.layout.unplaced);
      if (report.layout.placed === report.encoded) {
        expect(report.layout.totalBytes, `${name}: сумма размеров против байтов`).toBe(report.bytes);
      } else {
        expect(report.layout.totalBytes, `${name}: раскладка не меньше образа`).toBeGreaterThan(report.bytes);
      }
    }
    // Перемер 2026-09-27 (task-4, `src/e2k/regAlloc.ts`: цели переходов пересчитываются ДО анализа
    // живости; причина и сторож — `docs/hardware-debt.md` §3.35/§3.37). Правка меняет решения
    // раскладки во всех пяти ядрах, поэтому сдвинулись и эти числа:
    //   носителей 464 → 458, «разница» 47 → 53, покрытие 464 → 458, байт 8944 → 8800.
    // Сумма носителей эмиттера (511) НЕ сдвинулась — и это содержательная проверка: правка меняет
    // только вставки и снятия раскладки, а не то, что выдал эмиттер.
    // По ядрам: `fir` 102 → 104 носителя (процедура `фильтр` вытесняет два значения вместо одного),
    // `convolution` 117 → 110 и `correlation` 93 → 92 (вытеснений наоборот меньше), `iir` и `fft` те же.
    // Замер: `.tmp/osnova-pinned-remer.ts` (тот же путь, что здесь).
    //
    // Прежде — числа перемерены 2026-09-25 ПЯТЫЙ раз, после замены трюка через остаток на div в ядре
    // IIR (поток стал короче: 464 носителя вместо 468, отказов нет вовсе). Перемер 2026-09-24 — после
    // подъёма предела вытеснения до 4 (`.tmp/measure-realrun.ts`, пять ядер по тому же конвейеру).
    // Поток стал ДЛИННЕЕ эмиттерного: вытеснение вставляет чтения и записи слотов, поэтому поле
    // «разница носителей» — это итоговая разница, а не «снято копий»: у ядра со вставками она
    // отрицательна. Отказ остался один — вещественный `IR.div` ядра `iir`.
    // Прежние числа (455 / 62 / 447 / 8 / 8392) снимались до подъёма предела.
    // ── ПЕРЕМЕР 2026-10-10 (§3.131): ПОКРЫТИЕ УПАЛО, И ПРИЧИНА НАЗВАНА ──────────────────────────
    //
    // Этот прогон мерил пять DSP-ядер через `runKernelThroughRealEncoding`, и вызов раскладки стоял
    // в нём БЕЗ ОПЦИЙ: ни одна процедура с массивами не была помечена. До §3.128 это сходило с рук —
    // обращение к массиву понижалось «тихо», по клеткам плоскости ТОЧКИ ВХОДА, где бы процедура ни
    // лежала (тихий путь §3.127). С §3.128 базу блока выдаёт раскладка, и вызов без пометки означает
    // отказ у КАЖДОГО обращения к массивам: покрытие 372, отказов 86.
    //
    // Теперь вызов повторяет конфигурацию компилятора (`src/e2k/guards/loweredUnchecked.ts#loweredProgramUnchecked`):
    // процедуры с массивами помечены, точке входа — её пул, вызываемой — `CALLEE_REGISTERS`. Покрытие
    // 413, отказов 45 — то есть 45 обращений к массивам лежат в ВЫЗЫВАЕМЫХ процедурах, а их
    // собственная половина кадра (`%b[8..15]`, восемь клеток) занята значениями: пятёрке блока
    // рантайма места нет, и понижение отказывает ПО ИМЕНИ (`OSN-LOW-003`). Числа 458 / 53 / 511 —
    // свойства потока эмиттера и раскладки — НЕ сдвинулись; сдвинулись покрытие (458 → 413) и байты
    // образа (8800 → 6856): прежде 8800 включало последовательности рантайма массивов, понижённые
    // ТИХО, то есть в конфигурации, которой компилятор не выдаёт.
    //
    // Вернуть 458/0/8800 можно одним из двух (оба — работа, не правка чисел): выровнять блок
    // вызываемой по РОЛЯМ вызывающего (клетки 2..6 = клетки блока вызывающего, константы 0/1/8
    // перезаписываются теми же значениями — работает на глубине 1, глубже нет) или расширить кадр
    // вызываемой (A1′, §3.125). Разбор — `docs/hardware-debt.md` §3.131.
    // ── ПЕРЕМЕР 2026-10-29 (A4-5б, гигиена задачи 6): БАЙТ ОБРАЗА 6856 → 7448 ────────────────────
    //
    // Закреплённое здесь 6856 осталось от замера ДО среза A4-2, а срез 2 перенёс кучу массивов в
    // память: `создать`/`добавить` стали длиннее (слово заголовка + элемент), поэтому линейный образ
    // вырос. Число снято ПРОГОНОМ этого же теста на текущем дереве (2026-10-29), а не перенесено из
    // отчёта среза 5а — совпадение с §3.136 («линейно 6856 → 7448») здесь подтверждение, а не
    // источник. Остальные числа (458 / 53 / 511 / 413 / 45) прогон подтвердил без изменений.
    expect(instructions).toBe(458);
    expect(eliminated, 'разница носителей эмиттера и потока').toBe(53);
    expect(instructions + eliminated, 'носителей эмиттера').toBe(511);
    expect(encoded, 'покрытие').toBe(413);
    expect(refused, 'отказов').toBe(45);
    expect(bytes, 'байт образа').toBe(7448);
    expect(mismatches, 'расхождений круга быть не должно').toEqual([]);
  });
});

describe('сопоставление пары: 5. внешняя сверка цепочки', () => {
  it('ассемблер МЦСТ собирает ту же тройку «сравнение + подготовка + передача»', () => {
    const { tool } = findExternalAs();
    if (tool === undefined) return; // причина ненайденности названа в e2kExternalAs.test.ts
    // Программа целиком: метка стоит на адресе цели (в начале), смещение считает ассемблер.
    const carriers: readonly AsmInstruction[] = [
      ir('IR.move', [reg(1), reg(2)]), // 0 — цель
      ir('IR.lt', [reg(5), reg(3), reg(4)]), // 8
      ir('IR.jmp_if_not', [reg(5), imm(0)]), // 16 (пара), цель — адрес 0 → смещение −2
    ];
    const resolved = secondPass(carriers, firstPassAddresses(carriers));
    expect(resolved.refusals).toEqual([]);
    const displacement = resolved.displacements[0]!;
    expect(displacement.disp).toBe(-2);

    const comparison = ir('IR.lt', [reg(5), reg(3), reg(4)]);
    const jump = ir('IR.jmp_if_not', [reg(5), imm(0)]);
    // Условие и предикат берутся ИЗ СОПОСТАВЛЕНИЯ, а не подставляются литералами: иначе
    // перепутанная полярность (или разошедшийся номер предиката) внешней сверкой не ловилась бы.
    const pairing = pairPredicates(carriers);
    expect(pairing.refusals.map((item) => `#${item.index}: ${item.reason}`)).toEqual([]);
    expect(pairing.pairs.length, 'пара не составлена').toBe(1);
    const pair = pairing.pairs[0]!;
    expect(pair.comparisonIndex, 'пара не та').toBe(1);
    expect(pair.jumpIndex, 'переход пары не тот').toBe(2);
    const cmpLowered = lowerCarrier(comparison, { predicate: { mnemonic: pair.cmpMnemonic, index: pair.predicate } });
    const jumpLowered = lowerCarrier(jump, { condition: pair.condition, displacement: displacement.disp });
    expect(cmpLowered.ok && jumpLowered.ok).toBe(true);
    if (!cmpLowered.ok || !jumpLowered.ok) return;
    const ours = Uint8Array.from(
      [...cmpLowered.instructions, ...jumpLowered.instructions].flatMap((command) => [...realEncoder.encode(command)]),
    );
    expect(ours.length, 'наша тройка — 24 байта').toBe(24);
    // Полярность в байтах: `~%pred0` — код условия 0x60, а не 0x40.
    expect(jumpLowered.instructions[1]!.operands[1], 'полярность в команде ct').toEqual(imm(pair.condition));
    expect(pair.condition, 'полярность пары').toBe(0x60);

    const samples: AsSample[] = [
      {
        key: 'cmp-disp-ct',
        mnemonic: 'cmplsb',
        channel: 0,
        form: 'ALF7 + CS0 + SS',
        asText: [
          'osnova_target:',
          'movts,0 %b[2], %b[1]',
          'cmplsb,0 %b[3], %b[4], %pred0',
          'disp %ctpr1, osnova_target',
          'ct %ctpr1 ? ~%pred0',
        ].join('\n'),
        instruction: cmpLowered.instructions[0]!,
        source: 'docs/e2k-real-run.md §2.3, opcodes/e2k-opc.h:1019',
      },
    ];
    const result = assembleAll(samples)[0]!;
    expect(result.ok, `ассемблер отверг цепочку: ${result.ok ? '' : result.error}`).toBe(true);
    if (!result.ok) return;
    // У ассемблера первый байт-блок — movts (8 байт), дальше ровно наша тройка.
    expect(result.bytes.length, 'у ассемблера 32 байта').toBe(32);
    expect(toHex(Uint8Array.from(result.bytes.slice(8))), 'наша тройка против ассемблера').toBe(toHex(ours));
  });
});

/** Адреса первого прохода — чтобы не дублировать импорт `firstPass` в этом оракуле. */
function firstPassAddresses(instructions: readonly AsmInstruction[]): Map<number, number> {
  return new Map(layoutOf(instructions).addresses);
}
