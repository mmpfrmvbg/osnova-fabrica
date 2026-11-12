/**
 * АРЕНА КАК ОПЕРАЦИЯ ЯЗЫКА: ФОРМА, ЖИЗНЬ РЕГИСТРОВ И ИНДЕКСЫ БЛОКА ОТКАЗА (без модели).
 *
 * Прогон на цели — `src/e2k/arenaQemu.test.ts` (шлюз `gate:qemu`). Здесь то, что обязано совпасть
 * ДО прогона, иначе образ уедет молча:
 *
 * | что | почему это сторож, а не формальность |
 * |---|---|
 * | форма носителя равна байтам понижения | расхождение — уехавшие адреса переходов и вызовов (§3.35) |
 * | регистры состояния арены живут для раскладки | сайт печати сохраняет живое, и если указатель арены не виден — развёртка затрёт его молча |
 * | индекс блока отказа совпадает с целью переходов | переход в никуда или в чужое тело |
 * | пара «сравнение + переход» СОСТАВЛЯЕТСЯ | без пары предиката нет, и понижение откажет (§3.80.1) |
 */
import { describe, it, expect } from 'vitest';
import { getEncoder } from './backend';
import type { AsmInstruction } from './backend';
import {
  ARENA_BASE,
  ARENA_BYTES,
  ARENA_EXTRA_MEMORY,
  ARENA_FLAG_REGISTER,
  ARENA_LIMIT,
  ARENA_REFUSAL_CARRIER,
  ARENA_REFUSAL_CODE,
  ARENA_REFUSAL_TEXT,
  arenaCarrierInstructions,
  arenaGroups,
  arenaRefusalCarriers,
  arenaReservedRegisters,
  arenaSiteCarriers,
  usesArena,
} from './arenaRuntime';
import {
  ARENA_ALLOC_CARRIER,
  ARENA_INIT_CARRIER,
  ARENA_LIMIT_BASE,
  ARENA_LIMIT_CARRIER,
  ARENA_POINTER_BASE,
  ARENA_POINTER_CARRIER,
} from './procedureCall';
import { carrierFormOf } from './twoPassLayout';
import { defUseOf } from './liveness';
import { pairPredicates } from './predicatePairing';
import { PRINT_PRIMITIVE_CLOBBERS } from './printPrimitives';
import { printAreaOf } from './printPrimitives';
import { planPrintSite } from './printCall';
import { IMAGE_TAIL_OFFSET, MINIMAL_BASE } from './elfMinimal';
import { STRING_ARENA_CONCAT_CARRIER, STRING_ARENA_COPY_CARRIER } from './stringRuntime';

const encoder = getEncoder('e2k');
const carrier = (mnemonic: string, operands: AsmInstruction['operands']): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});
const imm = (value: number) => ({ kind: 'imm', value }) as const;
const reg = (index: number) => ({ kind: 'reg', index }) as const;

/** Образцы носителей: те же, что ставит конвейер (`arenaGroups` + блок отказа). */
const SAMPLES: readonly AsmInstruction[] = [
  carrier(ARENA_INIT_CARRIER, [imm(ARENA_BASE), imm(ARENA_LIMIT)]),
  carrier(ARENA_ALLOC_CARRIER, [reg(0), reg(1)]),
  // ВЫДЕЛЕНИЕ С ЧИСЛОВЫМ РАЗМЕРОМ — вторая редакция того же носителя: так выделяет себя склейка
  // строк сверх статического буфера (длины статические, регистра под размер брать негде).
  carrier(ARENA_ALLOC_CARRIER, [imm(21), reg(1)]),
  carrier(ARENA_POINTER_CARRIER, [reg(2)]),
  carrier(ARENA_LIMIT_CARRIER, [reg(3)]),
  // `IR.exit` блока отказа — носитель ПЕЧАТИ (`src/e2k/printCall.ts#EXIT_CARRIER`), у него своя
  // форма и свой сторож; здесь только носители арены.
  ...arenaRefusalCarriers(0x101e75, ARENA_REFUSAL_TEXT.length).filter(
    (item) => item.mnemonic !== 'IR.exit',
  ),
];

describe('арена: форма носителя обязана совпасть с байтами понижения', () => {
  it('каждый носитель арены объявляет ровно те команды, что кодирует кодировщик', () => {
    for (const sample of SAMPLES) {
      const commands = arenaCarrierInstructions(sample);
      expect(commands, `${sample.mnemonic}: понижение обязано давать команды`).toBeDefined();
      const declared = carrierFormOf(sample, { invokeNames: [], constants: [] });
      expect(declared, `${sample.mnemonic}: форма обязана быть известна раскладке`).toBeDefined();
      const declaredBytes = declared!.commands.reduce((sum, command) => sum + command.size, 0);
      const realBytes = commands!.reduce((sum, command) => sum + encoder.encode(command).length, 0);
      expect(declaredBytes, `${sample.mnemonic}: объявлено ${String(declaredBytes)}, а байт ${String(realBytes)}`).toBe(
        realBytes,
      );
    }
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: занижённое объявление расходится с байтами — сверка это ловит', () => {
    const sample = carrier(ARENA_INIT_CARRIER, [imm(ARENA_BASE), imm(ARENA_LIMIT)]);
    const commands = arenaCarrierInstructions(sample)!;
    const realBytes = commands.reduce((sum, command) => sum + encoder.encode(command).length, 0);
    // Прежняя редакция объявляла заведение двумя командами по 8 байт (16 вместо 32) — ровно этот
    // дефект и был в дереве: `movtd` с 64-битным литералом несёт литеральное слово.
    expect(realBytes).not.toBe(16);
    expect(realBytes).toBe(32);
  });
});

describe('арена: регистры состояния видны раскладке', () => {
  it('носитель выделения читает и пишет указатель арены', () => {
    const use = defUseOf(carrier(ARENA_ALLOC_CARRIER, [reg(0), reg(1)]));
    expect(use.use).toContain(ARENA_POINTER_BASE);
    expect(use.def).toContain(ARENA_POINTER_BASE);
    expect(use.def, 'приёмник операции тоже определяется').toContain(1);
  });

  it('заведение пишет оба регистра состояния, блок отказа регистров не трогает', () => {
    expect(defUseOf(carrier(ARENA_INIT_CARRIER, [imm(ARENA_BASE), imm(ARENA_LIMIT)])).def).toEqual([
      ARENA_POINTER_BASE,
      ARENA_LIMIT_BASE,
    ]);
    expect(defUseOf(carrier(ARENA_REFUSAL_CARRIER, [imm(0), imm(1)]))).toEqual({ def: [], use: [] });
  });

  it('САЙТ ПЕЧАТИ СОХРАНЯЕТ АРЕНУ: живой указатель и предел попадают в сохраняемые', () => {
    // Живость приходит от раскладки (`cfgLiveSets` + `defUseOf`); здесь проверяется само правило:
    // что живёт И что портит развёртка — то и сохраняется.
    const plan = planPrintSite({
      argument: 7,
      heapAddress: MINIMAL_BASE + 0x2000,
      liveAfter: [ARENA_POINTER_BASE, ARENA_LIMIT_BASE, 7],
      clobbered: PRINT_PRIMITIVE_CLOBBERS,
    });
    const saved = plan.saved.map((item) => item.register);
    expect(saved, 'указатель арены обязан пережить печать').toContain(ARENA_POINTER_BASE);
    expect(saved, 'предел арены обязан пережить печать').toContain(ARENA_LIMIT_BASE);
  });
});

describe('арена: расширение потока', () => {
  const invoke = carrier('IR.invoke', [imm(3), reg(0), reg(0), imm(0), reg(1)]);

  it('заведение встаёт прологом ТОЧКИ ВХОДА, а не началом потока', () => {
    // Точка входа может стоять в модуле не первой: тогда конвейер ставит в начало переход к ней, и
    // заведение, положенное в начало, осталось бы ЗА переходом (измерено: указатель читался мусором).
    const groups = arenaGroups([reg(0) as never, invoke], ['система.память.выделить'], 1);
    expect(groups.groups.has(0), 'пролог чужой процедуры не трогаем').toBe(false);
    expect(groups.groups.get(1)?.[0]?.mnemonic).toBe(ARENA_INIT_CARRIER);
  });

  it('цель перехода сайта указывает РОВНО на блок отказа', () => {
    const code: AsmInstruction[] = [invoke, invoke];
    const groups = arenaGroups(code, ['система.память.выделить'], 0);
    // Поток после расширения: заведение (1) + два сайта по три носителя + блок (2).
    const lengthAfter = 1 + 2 * 3 + 2;
    expect(groups.refusalIndex).toBe(lengthAfter - 2);
    const site = groups.groups.get(1);
    expect(site?.[2]?.mnemonic).toBe('IR.jmp_if_not');
    expect(site?.[2]?.operands[1]).toEqual(imm(groups.refusalIndex));
  });

  it('пара «сравнение + условный переход» СОСТАВЛЯЕТСЯ конвейером', () => {
    const site = arenaSiteCarriers(reg(0), reg(1), 5);
    const pairing = pairPredicates(site);
    expect(pairing.refusals, 'отказов сопоставления быть не должно').toEqual([]);
    expect(pairing.pairs).toHaveLength(1);
    expect(pairing.pairs[0]!.cmpMnemonic, 'условие пишется как есть (§3.80.1)').toBe('cmplesb');
    expect(pairing.pairs[0]!.condition, 'переход — с отрицанием предиката').toBe(0x60);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: барьер ВНУТРИ окна ломает пару, барьер ПОСЛЕ читателя — нет', () => {
    // ПРАВИЛО ГРАНИЦ (случай 89): `known:false`-барьер ЗАКРЫВАЕТ окно, а не отдаёт его концу потока.
    // Поэтому барьер после перехода-читателя пару НЕ ломает: читатель уже внутри окна.
    const first = arenaSiteCarriers(reg(0), reg(1), 99);
    const second = arenaSiteCarriers(reg(0), reg(1), 99);
    const unknown: AsmInstruction = { ...first[0]!, mnemonic: 'IR.arena_alloc_unknown' };
    const после = pairPredicates([...first, unknown, ...second]);
    expect(
      после.pairs.map((pair) => pair.comparisonIndex),
      'барьер после перехода-читателя закрывает окно, но пару не рвёт',
    ).toContain(1);
    expect(после.refusals, 'лишних отказов нет: читатель первого сравнения внутри окна').toEqual([]);

    // А барьер МЕЖДУ сравнением и его переходом — ломает: живость не доказана, переход остаётся без
    // предиката и обязан отказать по имени. Это и есть различающий контроль.
    const внутри = pairPredicates([first[0]!, first[1]!, unknown, first[2]!, ...second]);
    expect(
      внутри.pairs.map((pair) => pair.comparisonIndex),
      'сравнение первого сайта пары не образует: живость не доказана',
    ).not.toContain(1);
    // Отказ ПЕРЕНАЗВАН срезом A4-5а и остаётся отказом по той же причине: пары нет, потому что
    // живость не доказана (барьер внутри окна), и переход-читатель остаётся БЕЗ предиката.
    // Проверка та же: пара сломана и причина названа, а не проглочена.
    expect(
      внутри.refusals.map((item) => item.reason).join(' '),
      'осиротевший переход обязан отказать по имени',
    ).toContain('пришло не из сравнения');
  });

  it('САЙТ СКЛЕЙКИ СТРОК: три носителя проверки плюс копирование, размер — СУММА байтов', () => {
    // Тот же сайт проверки предела, что у `память.выделить` (один контракт исчерпания), и тот же
    // счёт индексов: сайт выделения даёт +2 носителя, сайт склейки — +3. Ошибка в счёте увела бы
    // переход в блок отказа в чужое тело.
    const site = carrier(STRING_ARENA_CONCAT_CARRIER, [reg(0), reg(1), reg(2), imm(19), imm(2)]);
    const call = carrier('IR.invoke', [imm(3), reg(0), reg(0), imm(0), reg(1)]);
    const groups = arenaGroups([site, call], ['система.память.выделить'], 0);
    expect(groups.concatSites).toBe(1);
    expect(groups.sites).toBe(1);
    expect(groups.refusalIndex).toBe(1 + 2 + 2 * 1 + 3 * 1);
    const expanded = groups.groups.get(0);
    expect(expanded?.map((item) => item.mnemonic)).toEqual([
      ARENA_INIT_CARRIER,
      ARENA_ALLOC_CARRIER,
      'IR.le',
      'IR.jmp_if_not',
      STRING_ARENA_COPY_CARRIER,
    ]);
    expect(expanded?.[1]?.operands[0], 'выделяется ровно 19 + 2 = 21 байт').toEqual(imm(21));
    expect(expanded?.[3]?.operands[1], 'переход ведёт в блок отказа').toEqual(imm(groups.refusalIndex));
    expect(
      arenaCarrierInstructions(expanded![1]!),
      'команды выделения с числовым размером обязаны быть',
    ).toBeDefined();
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: сайт склейки не той формы НЕ расширяется — и это названо', () => {
    // Такой поток конвейер не собирает (операнды ставит планирование строк), но если носитель
    // пришёл не той формы, расширять его НЕЛЬЗЯ: выделение взяло бы размер из чужого места.
    const broken = carrier(STRING_ARENA_CONCAT_CARRIER, [imm(19), reg(1), reg(2), imm(19), imm(2)]);
    const groups = arenaGroups([broken], [], 0);
    // Заведение арены на месте (индекс 0 — точка входа), а САМ носитель остался как есть: расширять
    // его нечем, и понижение откажет по имени, а не выделит блок с чужим размером.
    expect(groups.groups.get(0)?.map((item) => item.mnemonic)).toEqual([
      ARENA_INIT_CARRIER,
      STRING_ARENA_CONCAT_CARRIER,
    ]);
    expect(groups.concatSites, 'но сосчитан: индекс отказа обязан учитывать место').toBe(1);
  });
});

describe('арена: границы решения', () => {
  it('арена стоит на СТРАНИЦЕ КУЧИ (0x111000), выше области записи, и отображена целиком', () => {
    // Смещение хвоста — 0x11000, а не 0x2000 (замер 2026-09-29, §3.91): область записи обязана
    // лежать на странице без кода, иначе запись в неё падает ACCERR, как только код войдёт в ту же
    // страницу. Свойство §3.88.4 сохранено: арена начинается ТАМ ЖЕ, где куча массивов, — поэтому
    // названная граница «арена и куча не разведены» остаётся верной.
    expect(ARENA_BASE).toBe(MINIMAL_BASE + IMAGE_TAIL_OFFSET);
    expect(ARENA_BASE, 'та же страница, что у кучи').toBe(ARENA_BASE - (ARENA_BASE % 0x1000));
    expect(ARENA_LIMIT - ARENA_BASE).toBe(ARENA_BYTES);
    expect(ARENA_EXTRA_MEMORY, 'арена отображена целиком').toBeGreaterThanOrEqual(ARENA_LIMIT - MINIMAL_BASE);
    expect(printAreaOf(ARENA_BASE), 'площадка печати — ниже арены, на своей странице').toBeLessThan(ARENA_BASE);
    expect(printAreaOf(ARENA_BASE) - (printAreaOf(ARENA_BASE) % 0x1000)).toBeLessThan(ARENA_BASE);
  });

  it('признак «образ пользуется ареной» берётся по имени вызова, а не по наличию инструкций', () => {
    const code = [carrier('IR.invoke', [imm(3), reg(0), reg(0), imm(0), reg(1)])];
    expect(usesArena(code, ['система.лог.вывести'])).toBe(false);
    expect(usesArena(code, ['система.память.выделить'])).toBe(true);
  });

  it('регистры состояния и ключ предиката зарезервированы, ключ в их числе', () => {
    expect(arenaReservedRegisters()).toEqual([ARENA_POINTER_BASE, ARENA_FLAG_REGISTER, ARENA_LIMIT_BASE]);
    expect(arenaReservedRegisters()).not.toContain(ARENA_LIMIT_BASE + 1);
  });

  it('код отказа наблюдаем 8-битным каналом', () => {
    expect(ARENA_REFUSAL_CODE).toBeLessThan(256);
    expect(ARENA_REFUSAL_CODE).toBe(231);
  });
});
