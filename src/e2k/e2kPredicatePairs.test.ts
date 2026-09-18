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
import { PREDICATE_FOR_PAIRS, comparisonMnemonicOf, pairPredicates } from './predicatePairing';

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
  const CMP = ir('IR.lt', [reg(5), reg(3), reg(4)]);
  const JUMP_NOT = (cond: number): AsmInstruction => ir('IR.jmp_if_not', [reg(cond), imm(3)]);

  it('другой читатель результата — пара не составляется, причина названа', () => {
    const stream: readonly AsmInstruction[] = [
      CMP,
      JUMP_NOT(5),
      ir('IR.move', [reg(9), reg(5)]), // читает результат сравнения — значение обязано жить в регистре
      ir('IR.move', [reg(9), reg(9)]),
    ];
    const pairing = pairPredicates(stream);
    expect(pairing.pairs, 'пара составлена, хотя результат нужен ещё кому-то').toEqual([]);
    // Отказов два, и каждый назван: сравнение (лишний читатель) и осиротевший переход.
    expect(pairing.refusals.length).toBe(2);
    expect(pairing.refusals[0]!.index).toBe(0);
    expect(pairing.refusals[0]!.reason, 'не назван лишний читатель').toMatch(/чита|значение/i);
    expect(pairing.refusals[1]!.index).toBe(1);
    expect(pairing.refusals[1]!.reason, 'переход без пары не назван').toMatch(/сравнени/i);
  });

  it('два читателя-перехода — отказ; ноль читателей — тоже отказ', () => {
    const twoJumps: readonly AsmInstruction[] = [CMP, JUMP_NOT(5), JUMP_NOT(5)];
    const pairing = pairPredicates(twoJumps);
    expect(pairing.pairs).toEqual([]);
    expect(pairing.refusals[0]!.reason).toMatch(/чита/);

    const none: readonly AsmInstruction[] = [CMP, ir('IR.move', [reg(9), reg(9)])];
    const unread = pairPredicates(none);
    expect(unread.pairs).toEqual([]);
    expect(unread.refusals[0]!.reason, 'не сказано, что результат никем не читается').toMatch(/никем|нет читател/i);
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
  it('сравнения и условные переходы получают адреса: размещено 386, не размещено 131', () => {
    const layout = layoutOf(ALL);
    expect(layout.entries.length, 'покрытие раскладки').toBe(386);
    expect(layout.unplaced.length, 'отказов раскладки').toBe(131);
    const byCarrier = new Map<string, number>();
    for (const entry of layout.entries) byCarrier.set(entry.carrier, (byCarrier.get(entry.carrier) ?? 0) + 1);
    expect(byCarrier.get('IR.jmp_if_not')).toBe(14);
    expect(byCarrier.get('IR.lt')).toBe(12);
    expect(byCarrier.get('IR.le')).toBe(1);
    expect(byCarrier.get('IR.ge')).toBe(1);
    for (const carrier of ['IR.invoke', 'IR.call', 'IR.ret']) {
      expect(byCarrier.has(carrier), `${carrier} не должен размещаться`).toBe(false);
    }
  });

  it('смещения считаются и для условных переходов', () => {
    for (const [name, carriers] of CARRIERS) {
      const resolved = secondPass(carriers, firstPassAddresses(carriers));
      expect(resolved.refusals, `${name}: смещение не разрешено`).toEqual([]);
      const jumps = carriers.filter((item) => item.mnemonic.startsWith('IR.jmp')).length;
      expect(resolved.displacements.length, `${name}: смещений не столько, сколько переходов`).toBe(jumps);
    }
  });

  it('сквозной прогон: понижено 386, отвергнуто 131, байт 3960', () => {
    let encoded = 0;
    let refused = 0;
    let bytes = 0;
    let instructions = 0;
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
      encoded += report.encoded;
      refused += report.refused;
      bytes += report.bytes;
      mismatches.push(...report.roundTrip.mismatches.map((item) => `${name}: ${item}`));
      expect(report.layout.placed, `${name}: раскладка против понижения`).toBe(report.encoded);
      expect(report.layout.totalBytes, `${name}: сумма размеров против байтов`).toBe(report.bytes);
    }
    expect(instructions).toBe(517);
    expect(encoded, 'покрытие').toBe(386);
    expect(refused, 'отказов').toBe(131);
    expect(bytes, 'байт образа').toBe(3960);
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
