/**
 * P4a: БЮДЖЕТ ТОЧКИ ВХОДА И ВЫЗЫВАЕМЫХ — НА ФОРМЕ, КОТОРАЯ РЕАЛЬНО СОБИРАЕТ ПАРСЕР.
 *
 * Задание P4a говорит «19 живых → ≤15» для черновика в 764 строки. Замер на HEAD показал, что
 * черновик-монолит отказывает по ДРУГОЙ причине (1831–3019 пересекающихся отрезков), а его B-форма
 * (разбиение на `шаг_*`) влезает по регистрам, но даёт 137 696–170 408 байт кода при прежнем потолке
 * 126 976 (`OSN-LOW-005`). Бюджет 15 выполняется на форме B2b — той, которой парсер и собран:
 * `обойти` + листья (`src/compiler-v3/parser-protocol-b2b.ts:274,439,531`).
 *
 * Здесь закреплены клетки, а не слова:
 *   • все 15 форм B2b одной программой — 54 процедуры, 0 отказов, вход ≤10, `обойти` ≤12,
 *     ни одна процедура не держит больше 15 живых, каждая вызываемая укладывается в 12 занятых;
 *   • полное понижение (`allowDeepArrayWrites`) этой же программы — ровно 192 512 байт кода
 *     (потолок образа §43, `src/e2k/elfMinimal.ts#IMAGE_TAIL_OFFSET`), то есть она собирается в ELF;
 *   • форма P4a-ветвей (17 процедур) — вход ≤12, ни одна не больше 15.
 *
 * Железо: эта же 15-формная программа добавлена в кит (`src/scripts/e2kHardwareKit.ts`), поэтому
 * `gate:hardware` сверяет её AST = `эталоннаяЛента` на E8C2. QEMU здесь не арбитр: глубина ≥ 2
 * зацикливает модель (названная стена `#180`).
 */
import { describe, expect, it } from 'vitest';
import { parseV3 } from '../compiler-v3';
import { программаПротоколаB2b } from '../compiler-v3/parser-protocol-b2b';
import { программаПротоколаP4aПоВетвям } from '../compiler-v3/parser-protocol-probe';
import { loweredProgram } from './lowered';
import { regModuleOrNamedFailure } from './recordPlan';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { emitShell } from './emitterShell';
import { shellEncoder, arrayProceduresOf, heapSlotProcedures } from './programImage';
import { entryProcedureIndex } from './procedureCall';
import { ALLOCATABLE_REGISTERS, allocateProgram } from './regAlloc';
import { CALLEE_REGISTERS } from './twoPassLayout';
import { insertListSetBounds } from './arrayBounds';
import { usesCollections, collectionReservedRegisters } from './collectionsRuntime';
import { ARRAY_REGISTERS, ENTRY_ARRAY_CELLS } from './arrayRuntime';

type Запись = { имя: string; ok: boolean; peakLive: number; used: number; причина: string };

/** Формы B2b — те же 15, что в `parserProtocolB2bHardware.test.ts` и в ките. */
const B2B1 = [
  'пусть а = 5',
  'а = 5',
  'пусть а = 1 + 2 * 3',
  'пусть а = (1 + 2) * 3',
  'пусть а = 8 / 2 - 1',
] as const;
const B2B2 = [
  'если а > 1\n    а = 2\n  конец если',
  'если а > 1\n    а = 2\n  иначе\n    а = 3\n  конец если',
  'если а > 1\n    а = 2\n  иначе если а < 0\n    а = 3\n  иначе\n    а = 4\n  конец если',
  'пока а < 3\n    а = а + 1\n  конец пока',
  'пока а < 3\n    если а == 1\n      а = 2\n    иначе\n      а = а + 1\n    конец если\n  конец пока',
] as const;
const B2B3 = [
  'пусть а = 1 + 2\n  а = а * 3\n  если а > 5\n    а = 0\n  конец если',
  'пусть а = 2\n  пусть б = 3\n  если а < б\n    а = б - а\n  конец если\n  пока а < 10\n    а = а + 1\n  конец пока',
  'пусть а = 5\n  ф(а)',
  'если а > 1\n    ф(1)\n  иначе\n    ф(2)\n  конец если',
  'пока а < 3\n    ф(а)\n    а = а + 1\n  конец пока',
] as const;

const ВСЕ_ФОРМЫ = [...B2B1, ...B2B2, ...B2B3];

function источникB2bВсе(): string {
  return программаПротоколаB2b(
    `действие главная()\n  ${ВСЕ_ФОРМЫ.join('\n  ')}\nконец главная\n`,
    'p4a-budget.osnova',
  );
}

function замерить(src: string, имя: string): Запись[] {
  const разбор = parseV3(src, имя);
  expect(разбор.errors, 'проба обязана разбираться').toEqual([]);
  const built = regModuleOrNamedFailure(src, {
    filename: имя,
    parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
  });
  expect(built.ok, built.ok ? '' : String(built.причина).slice(0, 300)).toBe(true);
  if (!built.ok) return [];
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((p) => p.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const entryAt = entryProcedureIndex(emitted.scheduled.procedures);
  const arrayProcedures = arrayProceduresOf(
    emitted.instructions,
    emitted.scheduled.procedures,
    emitted.image.invokeNames,
  );
  const heapSlotAt = heapSlotProcedures(
    emitted.instructions,
    emitted.scheduled.procedures,
    emitted.image.invokeNames,
    entryAt,
  );
  const collectionReserved = usesCollections(emitted.instructions, emitted.image.invokeNames)
    ? collectionReservedRegisters()
    : [];
  const reserved = [...collectionReserved, ...(heapSlotAt.size > 0 ? [ARRAY_REGISTERS.heapSlot] : [])];
  const entryRuntime = new Set<number>([
    12,
    ...(arrayProcedures.includes(entryAt) ? Object.values(ENTRY_ARRAY_CELLS) : []),
    ...(heapSlotAt.size > 0 ? [ARRAY_REGISTERS.heapSlot] : []),
  ]);
  const bounds = insertListSetBounds(emitted.instructions, emitted.scheduled.procedures, emitted.image.invokeNames);
  const allocation = allocateProgram(bounds.code, bounds.procedures, {
    reserved,
    freeFor: (at) =>
      at === entryAt
        ? ALLOCATABLE_REGISTERS.filter((cell) => !entryRuntime.has(cell))
        : CALLEE_REGISTERS,
    arrayProcedures,
    collectAnalysis: true,
  });
  return allocation.procedures.map((p, at) => ({
    имя: p.name,
    ok: allocation.report[at]!.ok,
    peakLive: allocation.report[at]!.peakLive,
    used: allocation.report[at]!.used,
    причина: allocation.report[at]!.reason,
  }));
}

describe('P4a: бюджет 15 живых на форме B2b', () => {
  it('все 15 форм: 54 процедуры, 0 отказов, вход ≤10, `обойти` ≤12, ни одна не >15', () => {
    const пики = замерить(источникB2bВсе(), 'p4a-budget.osnova');
    // 42 было до §41: шесть процедур добавили квадратные скобки (литерал списка и индексация),
    // разбитые по одной работе на процедуру — толстая версия не оставляла трёх клеток ПОДРЯД
    // под блок рантайма массивов и отказывала `#2023`. §41.2 добавил три: разводка имени и два её
    // тела (обычное и квалифицированное) — 49 → 52. P1 (2026-11-13) добавил два шага заголовков
    // (`шаг_действие`, `шаг_процедура`): рамку `действие` писал `главная` до цикла — 52 → 54.
    expect(пики.length).toBe(54);
    for (const запись of пики) {
      expect(запись.ok, `${запись.имя}: ${запись.причина}`).toBe(true);
      expect(запись.peakLive, `${запись.имя}: живых`).toBeLessThanOrEqual(15);
    }
    const главная = пики.find((п) => п.имя === 'главная')!;
    expect(главная.peakLive, 'вход').toBeLessThanOrEqual(10);
    expect(главная.used, 'вход: занято клеток').toBeLessThanOrEqual(10);
    const обойти = пики.find((п) => п.имя === 'обойти')!;
    expect(обойти.peakLive, 'обойти').toBeLessThanOrEqual(12);
    for (const запись of пики) {
      if (запись.имя === 'главная') continue;
      expect(запись.used, `${запись.имя}: занято клеток вызываемой`).toBeLessThanOrEqual(12);
    }
  });

  it('полное понижение 15-формной программы: 0 отказов, код ровно 192512 (потолок образа)', () => {
    const источник = источникB2bВсе();
    const разбор = parseV3(источник, 'p4a-budget.osnova');
    expect(разбор.errors).toEqual([]);
    const понижен = loweredProgram(источник, {
      filename: 'p4a-budget.osnova',
      allowDeepArrayWrites: true,
      parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
    });
    expect(понижен.ок, понижен.ок ? '' : понижен.отказ.причина.slice(0, 400)).toBe(true);
    if (!понижен.ок) return;
    expect(понижен.значение.bytes.length).toBe(192512);
  });

  it('форма P4a-ветвей: 17 процедур, 0 отказов, вход ≤12, ни одна не >15', () => {
    const пики = замерить(программаПротоколаP4aПоВетвям(), 'p4a-branches.osnova');
    expect(пики.length).toBe(17);
    for (const запись of пики) {
      expect(запись.ok, `${запись.имя}: ${запись.причина}`).toBe(true);
      expect(запись.peakLive, `${запись.имя}: живых`).toBeLessThanOrEqual(15);
    }
    const главная = пики.find((п) => п.имя === 'главная')!;
    expect(главная.peakLive, 'вход').toBeLessThanOrEqual(12);
  });
});
