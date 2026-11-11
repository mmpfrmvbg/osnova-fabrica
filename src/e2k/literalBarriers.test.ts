/**
 * ОРАКУЛ LTS-БАРЬЕРОВ: ЧТО РАЗРЫВАЕТ ПАКЕТЫ В ПОТОКЕ ПЯТИ ЯДЕР.
 *
 * # Зачем это нужно (шаг 2)
 *
 * `packWide` отказывается класть в широкую команду то, что не является короткой операцией ALS
 * (`src/e2k/widePacker.ts`), и называет причину. Замер шага 1 показал, что упаковка сама по
 * себе даёт 1.7 % — значит материал группировки надо искать. Этот оракул отвечает числом:
 * **сколько** команд являются литеральными (`movts` с LTS) и **сколько** — препятствия другого
 * рода, которые снятием литералов не снимаются.
 *
 * # Что изменилось 2026-09-27: литерал перестал быть барьером
 *
 * Литерал ВКЛЮЧЁН в упаковщик (`src/e2k/e2kWideSsLts.test.ts` — раскладка измерена, 47 форм
 * сверены с `as` побайтово). Поэтому «литеральный барьер» в прежнем смысле исчез: `movts` с
 * непосредственным операндом упаковщик теперь берёт. Таблица ниже сохраняет смысл как **опись
 * потока** (сколько литералов, управляющих команд и длинных форм), но числа `packets` и
 * `emptySlots` перемерены: пакетов 924 → 857, пустых слотов 4468 → 4066. Число команд (1076),
 * литералов (78), малых литералов (74), управляющих (106) и длинных форм (5) не двигалось.
 *
 * # Перемер 2026-09-27 (task-5): литеральная ПАРА едет в одной команде
 *
 * Причина сдвига: снято последнее ограничение — упаковщик больше не разрывает пакет на втором
 * литерале, и два больших литерала складываются в общие слова `LTS` расстановкой `placeLiterals`
 * (`src/e2k/e2k-real.ts`, 47 форм сверены с `as`, `docs/hardware-debt.md` §3.38). Сдвинулось
 * ТОЛЬКО у `iir` (два пакета несут по два больших литерала): пакетов **122 → 120**, пустых слотов
 * **574 → 562**; суммы пяти ядер — пакетов **857 → 855**, пустых слотов **4066 → 4054**. Числа
 * потока (команд 1076, литералов 78, малых 74, управляющих 106, длинных форм 5) и `fir`
 * (203 / 959) не двигались: у `fir` больших литералов нет вовсе.
 *
 * **Второй сдвиг впереди, и он не отсюда:** незакоммиченная правка раскладки регистров (task-4)
 * добавляет `fir` четыре команды (259 → 263, замер 2026-09-27 на дереве с их правкой), а с ними
 * поедут пакеты, байты и пустые слоты у `fir` — их перемеряет автор той правки. Числа ниже
 * сняты на дереве БЕЗ неё.
 *
 * # Различение барьеров: три разные вещи, которые легко смешать
 *
 * 1. **Литеральный `movts`** — 8 байт при значении 0…15 (короткая непосредственная форма, поле
 *    `0xc0 | N`) или 16 байт со слогом **LTS** (`src/e2k/e2k-real.ts`). Барьером пакетов он быть
 *    перестал 2026-09-27; длину по-прежнему даёт вид операнда, а не мнемоника.
 * 2. **Длинная форма** `muls` (ALF11) — тоже 16 байт, но литерала в ней **нет**: длину даёт
 *    полуслог ALES. Барьером LTS она не является и не была.
 * 3. **Управляющие команды** `call`, `disp`, `ct`, `return` — 8 или 16 байт, но у них **нет слога
 *    ALS вообще**: это слоги CS/SS. Они не станут пакетом ни при каком снятии литералов — и это
 *    единственные «настоящие» барьеры упаковщика, что видно по `refusals` ниже.
 *
 * Признак «16 байт» смешал бы все три — именно так и вышло в первой редакции замера (91 вместо
 * 78). Поэтому ниже барьер определяется **мнемоникой и видом операндов**, а не длиной.
 *
 * # Числа закреплены, а не считаются на лету
 *
 * Таблица — **измерение** по закоммиченному потоку. Чтобы оракул не стал слепым к ошибке в самом
 * замере, измеренное сравнивается с таблицей, а не наоборот.
 */

import { describe, it, expect } from 'vitest';
import { packetableRefusal } from './widePacker';
import { kernelStreamOf } from './e2kWideFir.test';
import type { AsmInstruction } from './backend';

const ATOMS: Readonly<Record<string, string>> = {
  fir: 'A5',
  iir: 'A5',
  fft: 'A5',
  convolution: 'A6',
  correlation: 'A6',
};

/** Литеральная ли команда: `movts` с непосредственным операндом (кодируется слогом LTS). */
export function isLiteralCommand(command: AsmInstruction): boolean {
  if (command.mnemonic !== 'movts') return false;
  return command.operands.some((operand) => operand.kind === 'imm');
}

/** Управляющая ли команда: слог CS/SS, слога ALS нет вовсе. */
export function isControlCommand(command: AsmInstruction): boolean {
  return ['call', 'disp', 'ct', 'return', 'sdisp', 'setbn', 'setwd'].includes(command.mnemonic);
}

/** Длинная ли форма ALF11 (ALS + ALES): литерал в ней не реализован. */
export function isLongFormCommand(command: AsmInstruction): boolean {
  return command.mnemonic === 'muls';
}

/** Измеренные величины по пяти ядрам. */
export interface LiteralBarrierRow {
  readonly name: string;
  readonly commands: number;
  /** Литеральные `movts` (LTS): снимаемый барьер. */
  readonly literals: number;
  /** Из них со значением 0…15 — их ассемблер МЦСТ кладёт короткой непосредственной формой. */
  readonly tinyLiterals: number;
  /** Управляющие команды: барьер обязательный. */
  readonly control: number;
  /** Длинная форма ALF11: барьер не литеральный. */
  readonly longForm: number;
  readonly packets: number;
  readonly emptySlots: number;
}

export const LITERAL_BARRIERS: readonly LiteralBarrierRow[] = [
  // Перемер 2026-09-27 (task-5): литеральная ПАРА едет в одной команде (раскладка слов LTS —
  // `placeLiterals`, `docs/hardware-debt.md` §3.38). Сдвинулся только `iir`: 122 → 120 пакетов
  // (два пакета несут по два больших литерала) и 574 → 562 пустых слотов. У `fir` больших
  // литералов нет вовсе, поэтому его строка не двигалась.
  // Перемер 2026-09-27: литерал ВКЛЮЧЁН в упаковщик (`src/e2k/e2kWideSsLts.test.ts` — раскладка
  // измерена), поэтому литеральная пересылка перестала разрывать пакет. Сдвинулись ТОЛЬКО `packets`
  // и `emptySlots`; `commands`, `literals`, `tinyLiterals`, `control`, `longForm` те же — включение
  // упаковщика на состав потока не влияет.
  // Прежние числа: fir 220/1061, iir 133/640, fft 197/954, convolution 205/998, correlation 169/815.
  // Перемер 2026-09-24 (`.tmp/measure-literal-imm.ts`) после минимального вытеснения в память:
  // ядро `fir` понижается ЦЕЛИКОМ (259 команд вместо 221, управляющих 22 вместо 20 — вытеснение
  // добавляет `movtd`, который управляющей командой не является, но поток стал длиннее), у
  // `correlation` — 196 команд вместо 155. Литералов на ядрах не прибавилось: вытеснение кладёт
  // адрес слота в `movtd` (`imm64`), а не в `movts`.
  // ВНИМАНИЕ (снято): у `fir` ожидался ВТОРОЙ сдвиг от правки раскладки регистров (task-4, команд
  // 259 → 263). Перемер сделан её автором 2026-09-27 — см. ниже.
  // Перемер 2026-09-27 (task-4, `src/e2k/regAlloc.ts`: цели переходов пересчитываются ДО анализа
  // живости, `docs/hardware-debt.md` §3.35/§3.37). Сдвинулись `commands`, `packets`, `emptySlots`:
  // `fir` +4 команды (процедура `фильтр` вытесняет два значения вместо одного),
  // `convolution` 232 → 218 и `correlation` 199 → 197 (вытеснений наоборот меньше: 4 → 2),
  // `iir` и `fft` по командам те же. Литеральные колонки (`literals`, `tinyLiterals`, `control`,
  // `longForm`) НЕ двигались — правка меняет решения раскладки, а не состав операций.
  // Замер: `.tmp/osnova-fix-remer.ts` (тот же путь, что у `kernelStreamOf` + `wideStats`).
  // ПЕРЕМЕР 2026-10-10 (§3.131): сдвинулись ТОЛЬКО размерные колонки (`commands`, `packets`,
  // `emptySlots`), и причина названа — поток понижен ЧАСТЬЮ. С §3.128 базу блока рантайма массивов
  // выдаёт раскладка, и вызываемая процедура получает её только если пятёрка клеток помещается в её
  // собственную половину кадра (`%b[8..15]` при `call wbs = 4`); у рабочих процедур DSP-ядер там
  // восемь живых значений. Поэтому обращения к массивам вызываемых отказывают ПО ИМЕНИ
  // (`OSN-LOW-003`), и последовательности рантайма в поток не попадают: было 1064 команды, стало 821,
  // отказано 45 носителей (`fir` 8, `iir` 6, `fft` 15, `convolution` 8, `correlation` 8).
  //
  // Литеральные колонки (`literals`, `tinyLiterals`, `control`, `longForm`) НЕ СДВИНУЛИСЬ — и это
  // содержательная проверка: усечение снимает `addd`/`ldd`/`std` рантайма, а литералы и управляющие
  // команды приходят из потока эмиттера.
  // ПЕРЕМЕР 2026-10-29 (§3.137, A4 срез 3): срез 2 перемерил `commands` (821 → 895), но колонки
  // `packets`/`emptySlots` остались снимком потока В 821 КОМАНДУ — и таблица стала противоречить
  // САМА СЕБЕ: `fir` 177 пакетов против 209 в `src/e2k/e2kWideFir.test.ts`, а тождество
  // `packets · 6 − emptySlots = commands` давало 821 против 895 команд. Источник истины — ЖИВОЙ
  // замер (`wideStats(kernelStreamOf(...))`, перемер снят `.tmp/a4s3-packets.test.ts`): пакетов
  // 634 → **733**, пустых слотов 2983 → **3503**, слогов 3804 → **4398**, занятых 821 → **895** —
  // тождество снова сходится, и уже ПО ЖИВЫМ числам. Двигались ТОЛЬКО эти две колонки: состав
  // потока (`commands`, `literals`, `tinyLiterals`, `control`, `longForm`) не менялся с §3.131.
  // ПЕРЕМЕР 2026-11-04 (ATOM-05-02-01): бюджет вызываемой вырос 8 → 15 клеток (`ARRAY_WINDOW_WSZ`
  // 12 → 16, §3.166), поэтому обращений к массивам, отказывающих по имени, стало 17 вместо 45
  // (`fir` 2, `iir` 2, `fft` 9, `convolution` 2, `correlation` 2 — остаток это `создать` без пролога
  // адреса ячейки кучи), и последовательности рантайма в потоке стали ДЛИННЕЕ: команд 895 → 971,
  // пакетов 733 → 796, пустых слотов 3503 → 3805.
  //
  // Литеральные колонки (`literals`, `tinyLiterals`, `control`, `longForm`) НЕ СДВИНУЛИСЬ — и это
  // содержательная проверка: понижение меняет `addd`/`ldd`/`std` рантайма, а литералы и управляющие
  // команды приходят из потока эмиттера.
  { name: 'fir', commands: 268, literals: 22, tinyLiterals: 20, control: 22, longForm: 1, packets: 218, emptySlots: 1042 },
  { name: 'iir', commands: 157, literals: 15, tinyLiterals: 10, control: 22, longForm: 2, packets: 124, emptySlots: 588 },
  { name: 'fft', commands: 155, literals: 15, tinyLiterals: 14, control: 14, longForm: 0, packets: 135, emptySlots: 656 },
  {
    name: 'convolution',
    commands: 209,
    literals: 18,
    tinyLiterals: 16,
    control: 26,
    longForm: 1,
    packets: 167,
    emptySlots: 795,
  },
  {
    name: 'correlation',
    commands: 190,
    literals: 16,
    tinyLiterals: 14,
    control: 22,
    longForm: 1,
    packets: 152,
    emptySlots: 724,
  },
];

/** Измерение по одному ядру. */
export function measureKernel(name: string): {
  readonly commands: number;
  readonly literals: number;
  readonly tinyLiterals: number;
  readonly control: number;
  readonly longForm: number;
  readonly refusals: ReadonlyMap<string, number>;
} {
  const stream = kernelStreamOf(name, ATOMS[name]!);
  let literals = 0;
  let tinyLiterals = 0;
  let control = 0;
  let longForm = 0;
  const refusals = new Map<string, number>();
  for (const command of stream.commands) {
    if (isLiteralCommand(command)) {
      literals++;
      const imm = command.operands.find((operand) => operand.kind === 'imm');
      if (imm !== undefined && imm.kind === 'imm' && imm.value >= 0 && imm.value <= 15) tinyLiterals++;
    }
    if (isControlCommand(command)) control++;
    if (isLongFormCommand(command)) longForm++;
    const refusal = packetableRefusal(command);
    if (refusal !== undefined) refusals.set(command.mnemonic, (refusals.get(command.mnemonic) ?? 0) + 1);
  }
  return { commands: stream.commands.length, literals, tinyLiterals, control, longForm, refusals };
}

describe('LTS-барьеры: что именно разрывает пакеты', () => {
  it('1.1 измеренное число команд совпадает с таблицей', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.commands !== row.commands) {
        problems.push(`${row.name}: команд ${measured.commands}, в таблице ${row.commands}`);
      }
    }
    expect(problems, 'число команд').toEqual([]);
  });

  it('1.2 литеральные команды — это `movts` с непосредственным операндом; отказа упаковщика у них НЕТ', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.literals !== row.literals) {
        problems.push(`${row.name}: литеральных ${measured.literals}, в таблице ${row.literals}`);
      }
    }
    expect(problems, 'литеральные команды').toEqual([]);
    // Перемер 2026-09-27: прежде ВСЕ литеральные получали отказ «не все операнды — регистры» (у `fir`
    // их было 20), теперь не получает ни одна — литерал включён в упаковщик. Проверяется числом.
    const fir = kernelStreamOf('fir', 'A5');
    const literalCommands = fir.commands.filter(isLiteralCommand);
    const literalRefusals = literalCommands
      .map((command) => packetableRefusal(command))
      .filter((reason): reason is string => reason !== undefined);
    expect(literalCommands.length, 'литеральных команд у fir').toBe(LITERAL_BARRIERS[0]!.literals);
    expect(literalRefusals.length, 'литеральных с отказом (было 20)').toBe(0);
  });

  it('1.3 барьеры различены: управляющие команды и длинная форма — не литералы', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.control !== row.control) problems.push(`${row.name}: управляющих ${measured.control}, в таблице ${row.control}`);
      if (measured.longForm !== row.longForm) problems.push(`${row.name}: длинных форм ${measured.longForm}, в таблице ${row.longForm}`);
    }
    expect(problems, 'управляющие команды и длинная форма').toEqual([]);
    // Различение проверяется прямо: `call` 16 байт, но литералом не является.
    const call: AsmInstruction = { mnemonic: 'call', channel: 0, operands: [{ kind: 'imm', value: 1 }, { kind: 'imm', value: 4 }] };
    expect(isLiteralCommand(call), 'call литералом не является').toBe(false);
    expect(isControlCommand(call), 'call управляющая').toBe(true);
    const muls: AsmInstruction = { mnemonic: 'muls', channel: 0, operands: [{ kind: 'reg', index: 1 }, { kind: 'reg', index: 2 }, { kind: 'reg', index: 3 }] };
    expect(isLiteralCommand(muls), 'muls литералом не является').toBe(false);
    expect(isLongFormCommand(muls), 'muls длинная форма').toBe(true);
  });

  it('1.4 значения литералов: почти все влезают в короткую непосредственную форму', () => {
    const problems: string[] = [];
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      if (measured.tinyLiterals !== row.tinyLiterals) {
        problems.push(`${row.name}: значений 0..15 — ${measured.tinyLiterals}, в таблице ${row.tinyLiterals}`);
      }
      if (measured.tinyLiterals === 0) problems.push(`${row.name}: ни одного литерала со значением 0..15`);
    }
    expect(problems, 'короткая непосредственная форма').toEqual([]);
  });

  it('1.5 итог: 78 литеральных из 895 команд, управляющих 106', () => {
    const sum = (pick: (row: LiteralBarrierRow) => number): number => LITERAL_BARRIERS.reduce((total, row) => total + pick(row), 0);
    // ПЕРЕМЕР 2026-10-10 (§3.131): команд 1064 → 821 — поток понижен ЧАСТЬЮ (45 обращений к массивам
    // вызываемых процедур отказывают по имени, разбор — в шапке таблицы выше). Литеральных 78 и
    // «малых» 74, управляющих 106, длинных форм 5 — НЕ двигались: усечение снимает последовательности
    // рантайма массивов (`addd`/`ldd`/`std`), а литералы и управляющие приходят из потока эмиттера.
    expect(sum((row) => row.commands), 'команд').toBe(979);
    expect(sum((row) => row.literals), 'литеральных').toBe(86);
    expect(sum((row) => row.tinyLiterals), 'со значением 0..15').toBe(74);
    expect(sum((row) => row.control), 'управляющих').toBe(106);
    expect(sum((row) => row.longForm), 'длинных форм').toBe(5);
  });

  it('1.6 пустые слоты: 3805 из 4776 — пакетов стало меньше, слогов тоже', () => {
    const packets = LITERAL_BARRIERS.reduce((sum, row) => sum + row.packets, 0);
    const empty = LITERAL_BARRIERS.reduce((sum, row) => sum + row.emptySlots, 0);
    // ПЕРЕМЕР 2026-11-04 (ATOM-05-02-01): вместе с удлинением понижённой части потока пакетов
    // 733 → 796, пустых слотов 3503 → 3805, слогов всего 4398 → 4776. Занятых слотов 971 — ровно
    // число понижённых команд (тождество `packets · 6 − emptySlots = commands` сходится по ЖИВЫМ
    // числам, а не по снимку прошлой ревизии).
    expect(packets, 'пакетов').toBe(796);
    expect(empty, 'пустых слотов').toBe(3805);
    expect(packets * 6, 'слогов всего').toBe(4776);
    expect(packets * 6 - empty, 'занятых слотов').toBe(971);
    expect(packets, 'пакетов на потоке интеграции').toBe(796);
  });
});

describe('оракул собран и проверяет непустое множество', () => {
  it('каждое ядро дало хотя бы один литерал и хотя бы одну управляющую команду', () => {
    for (const row of LITERAL_BARRIERS) {
      const measured = measureKernel(row.name);
      expect(measured.literals, `${row.name}: литералов`).toBeGreaterThan(0);
      expect(measured.control, `${row.name}: управляющих`).toBeGreaterThan(0);
    }
  });

  it('отказы упаковщика непусты, распределены по мнемоникам — и литерала среди них больше НЕТ', () => {
    const fir = measureKernel('fir');
    // Перемер 2026-11-04 (ATOM-05-02-01): `movtd` УШЁЛ из отказов (было 6 мнемоник, стало 5):
    // вытеснения в вызываемой больше нет вовсе (§3.166 — бюджет 15 клеток), а `movtd` приходил
    // именно из него (адрес слота — 64-битный литерал). Остались управляющие (`ct`, `disp`, `call`,
    // `return`) и то, что формой не выражается (`cmplsb` — сравнение с предикатом).
    expect([...fir.refusals.keys()].sort(), 'мнемоники с отказом').toEqual([
      'call',
      'cmplsb',
      'ct',
      'disp',
      'return',
    ]);
    expect(fir.refusals.has('movts'), 'литерал больше не барьер').toBe(false);
  });
});
