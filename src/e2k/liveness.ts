/**
 * ЖИЗНЬ ЗНАЧЕНИЙ (LIVENESS) В ПОТОКЕ НОСИТЕЛЕЙ e2k.
 *
 * # Зачем
 *
 * Регистров мало: свободно `%b[0..9]` — десять (`%b[10..15]` держит рантайм массивов), окно
 * больше не расширяется (`setwd` отложен, `docs/e2k-setwd-memory.md`). Значит vreg'ы нужно
 * раскладывать по **интервалам жизни**, а не по номеру.
 *
 * # Что считается
 *
 * Интервал — `[определение, последнее чтение]` по **линейному** порядку носителей. Переопределение
 * vreg'а **закрывает** прежний интервал и открывает новый: значение — не безымянная ячейка, а
 * результат конкретной команды. Так же читается и `peak` — наибольшее число интервалов, живых
 * одновременно, то есть нижняя граница числа нужных регистров.
 *
 * # Откуда известно, что носитель читает и что пишет
 *
 * Не из догадки: раскладка операндов носителя зафиксирована эмиттером оболочки —
 * `src/e2k/emitterShell.ts:205-298`:
 *
 * | носитель | операнды | пишет | читает |
 * |---|---|---|---|
 * | `IR.const` | `[d, индекс пула, тип]` | 0 | — |
 * | `IR.move`, `IR.not` | `[d, a]` | 0 | 1 |
 * | `IR.jmp` | `[смещение]` | — | — |
 * | `IR.jmp_if`, `IR.jmp_if_not` | `[условие, смещение]` | — | 0 |
 * | `IR.call`, `IR.invoke` | `[флаги, arg0, arg1, payload, приёмник]` | 4 (если `флаги & 1`) | `arg0…` (`флаги >> 1` штук) |
 * | `IR.ret` | `[есть значение, регистр]` | — | 1 (если флаг) |
 * | `IR.arena_init` | `[база, предел]` | регистры состояния арены | — |
 * | `IR.arena_alloc` | `[размер, приёмник]` | 1 и указатель арены | 0 и указатель арены |
 * | `IR.arena_pointer`, `IR.arena_limit` | `[приёмник]` | 0 | регистр состояния арены |
 * | прочие (арифметика, сравнения) | `[d, a, b]` | 0 | 1, 2 |
 *
 * Групповые носители (`IR.gt`, `IR.add`, …) идут по последней строке: их раскладка в эмиттере
 * общая — «остальные операции с носителем».
 *
 * # Чего здесь нет
 *
 * Нет анализа потока управления: порядок носителей берётся линейным, как их выдаёт эмиттер
 * (переходы уже разложены двухпроходной раскладкой, а тела процедур идут подряд). Для циклов это
 * даёт **более длинные** интервалы, чем нужно, то есть оценка консервативна: если раскладка
 * удалась на таких интервалах, она корректна и на точных.
 */

import type { AsmInstruction } from './backend';
import { cfgLiveSets, cfgRanges } from '../vliw/cfg';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { callArgumentOperands } from './shell';
import { LOAD_CARRIER, STORE_CARRIER } from './memoryAccess';
import { ARENA_LIMIT_BASE, ARENA_POINTER_BASE } from './procedureCall';
import { REFUSAL_CARRIER } from './refusalBlock';
import { STRING_ARENA_CONCAT_CARRIER, STRING_ARENA_COPY_CARRIER, STRING_REGISTERS } from './stringRuntime';

/** Что носитель пишет и что читает (номера vreg'ов). */
export interface DefUse {
  readonly def: readonly number[];
  readonly use: readonly number[];
}

/** Интервал жизни значения: `[start, end]` — индексы носителей в списке. */
export interface LiveInterval {
  readonly vreg: number;
  readonly start: number;
  readonly end: number;
}

/** Результат анализа: интервалы и наибольшее число одновременно живых. */
export interface Liveness {
  readonly intervals: readonly LiveInterval[];
  /**
   * Нижняя граница числа регистров **по раскладке**: столько интервалов-объединений живут
   * одновременно. Так считает linear scan (один регистр на vreg), поэтому именно это число решает,
   * влезает раскладка или нет.
   */
  readonly peak: number;
  /** Где этот момент: индекс носителя. */
  readonly peakAt: number;
  /**
   * Точная нижняя граница: максимум живых на выходе инструкции по **настоящему** анализу жизни
   * (обратный обход с учётом переходов). Меньше неё не обойтись ни одной раскладке, даже если
   * каждому отрезку жизни давать свой регистр: в этот момент все они живы одновременно.
   */
  readonly peakLive: number;
  /** Где точный максимум: индекс носителя. */
  readonly peakLiveAt: number;
}

/**
 * Преемники носителя: следующий по порядку и цель перехода.
 *
 * Без этого анализ жизни был бы **небезопасен**: в цикле значение, живое на входе в тело, обязано
 * считаться живым и на обратном ребре. Цели переходов — те же индексы, что у раскладки: смещения
 * считает `src/e2k/twoPassLayout.ts`, а носитель несёт готовый номер инструкции.
 */
export function successorsOf(instructions: readonly AsmInstruction[], at: number): number[] {
  const next = at + 1 < instructions.length ? [at + 1] : [];
  const instruction = instructions[at];
  if (instruction === undefined) return next;
  if (instruction.mnemonic === 'IR.jmp' || instruction.mnemonic === 'IR.jmp_if' || instruction.mnemonic === 'IR.jmp_if_not') {
    const offset = instruction.mnemonic === 'IR.jmp' ? instruction.operands[0] : instruction.operands[1];
    if (offset !== undefined && offset.kind === 'imm' && offset.value >= 0 && offset.value < instructions.length) {
      return [...next, offset.value];
    }
  }
  return next;
}

/**
 * Живые на входе и на выходе каждой инструкции — обратный анализ до неподвижной точки.
 *
 * Это то, что просит постановка §2.1, и это же даёт **точную** нижнюю границу числа регистров:
 * максимум `|liveOut|` по потоку.
 */
export function liveSetsOf(instructions: readonly AsmInstruction[]): {
  readonly liveIn: readonly (readonly number[])[];
  readonly liveOut: readonly (readonly number[])[];
} {
  const liveIn = instructions.map(() => new Set<number>());
  const liveOut = instructions.map(() => new Set<number>());
  let changed = true;
  while (changed) {
    changed = false;
    for (let at = instructions.length - 1; at >= 0; at--) {
      const { def, use } = defUseOf(instructions[at]!);
      const out = new Set<number>();
      for (const successor of successorsOf(instructions, at)) {
        for (const vreg of liveIn[successor]!) out.add(vreg);
      }
      const inSet = new Set<number>(use);
      for (const vreg of out) if (!def.includes(vreg)) inSet.add(vreg);
      const same =
        out.size === liveOut[at]!.size &&
        inSet.size === liveIn[at]!.size &&
        [...out].every((vreg) => liveOut[at]!.has(vreg)) &&
        [...inSet].every((vreg) => liveIn[at]!.has(vreg));
      if (!same) {
        liveOut[at] = out;
        liveIn[at] = inSet;
        changed = true;
      }
    }
  }
  return {
    liveIn: liveIn.map((set) => [...set].sort((a, b) => a - b)),
    liveOut: liveOut.map((set) => [...set].sort((a, b) => a - b)),
  };
}

/** Номер регистра-операнда, если он там есть. */
function registerAt(instruction: AsmInstruction, index: number): number | undefined {
  const operand = instruction.operands[index];
  return operand !== undefined && operand.kind === 'reg' ? operand.index : undefined;
}

const registers = (...values: (number | undefined)[]): number[] =>
  values.filter((value): value is number => value !== undefined);

/** Что носитель пишет и читает. Раскладка — `src/e2k/emitterShell.ts:205-298`. */
export function defUseOf(instruction: AsmInstruction): DefUse {
  const operands = instruction.operands;
  switch (instruction.mnemonic) {
    // Носители вытеснения в память (`src/vliw/spill.ts`): читают слот и пишут слот. У них уже
    // ФИЗИЧЕСКИЕ регистры (они вставляются после раскладки), но def-use у них тот же, и он нужен
    // тем, кто читает поток дальше: расписанию, графу зависимостей, широкой упаковке.
    // `IR.spill_ld [адрес, приёмник, слот]` — читает регистр адреса, пишет приёмник.
    case 'IR.spill_ld':
      return { def: registers(registerAt(instruction, 1)), use: registers(registerAt(instruction, 0)) };
    // `IR.spill_st [значение, адрес, слот]` — читает и значение, и регистр адреса.
    case 'IR.spill_st':
      return {
        def: [],
        use: registers(registerAt(instruction, 0), registerAt(instruction, 1)),
      };
    // ДОСТУП ПО АДРЕСУ-РЕГИСТРУ (`src/e2k/memoryAccess.ts`). Ветви обязательны: у этих носителей
    // ДВА операнда, и порядок ролей обратный общему случаю `[d, a, b]` — умолчание прочло бы
    // приёмник чтения как определение адреса, то есть объявило бы значением то, что является адресом.
    // `IR.load [адрес, приёмник]` — читает адрес, пишет приёмник.
    case LOAD_CARRIER:
      return { def: registers(registerAt(instruction, 1)), use: registers(registerAt(instruction, 0)) };
    // `IR.store [значение, адрес]` — читает и значение, и адрес; не пишет ничего.
    case STORE_CARRIER:
      return { def: [], use: registers(registerAt(instruction, 0), registerAt(instruction, 1)) };
    case 'IR.const':
      return { def: registers(registerAt(instruction, 0)), use: [] };
    // АРЕНА (`src/e2k/arenaRuntime.ts`): регистры состояния — ФИЗИЧЕСКИЕ и в операндах не названы,
    // поэтому их обязан назвать этот разбор. Иначе сайт печати не увидит их живыми и затрёт
    // указатель арены своей развёрткой (`%b[0..11]`) — это класс «тихая ложь», а не мелочь.
    // `IR.arena_init [база, предел]` — заведение: пишет оба регистра состояния.
    case 'IR.arena_init':
      return { def: [ARENA_POINTER_BASE, ARENA_LIMIT_BASE], use: [] };
    // `IR.arena_alloc [размер, приёмник]` — читает размер и СТАРЫЙ указатель, пишет приёмник и новый.
    case 'IR.arena_alloc':
      return {
        def: registers(registerAt(instruction, 1), ARENA_POINTER_BASE),
        use: registers(registerAt(instruction, 0), ARENA_POINTER_BASE),
      };
    case 'IR.arena_pointer':
      return { def: registers(registerAt(instruction, 0)), use: [ARENA_POINTER_BASE] };
    case 'IR.arena_limit':
      return { def: registers(registerAt(instruction, 0)), use: [ARENA_LIMIT_BASE] };
    // Блок отказа: адрес и длина — литералы, регистров нет (аргументы `write` — оконные слоты кадра).
    // Носитель ОБЩИЙ у арены и у коллекций (`src/e2k/refusalBlock.ts`) — имя больше не арены.
    case REFUSAL_CARRIER:
      return { def: [], use: [] };
    // САЙТ СКЛЕЙКИ В АРЕНЕ (`src/e2k/stringRuntime.ts#STRING_ARENA_CONCAT_CARRIER`) — до расширения:
    // `[первая, вторая, приёмник, байтов, байтов]`. Регистры состояния арены здесь НЕ трогаются:
    // ими заведует выделение, в которое этот носитель и разворачивается.
    case STRING_ARENA_CONCAT_CARRIER:
      return {
        def: registers(registerAt(instruction, 2)),
        use: registers(registerAt(instruction, 0), registerAt(instruction, 1)),
      };
    // КОПИРОВАНИЕ В БЛОК АРЕНЫ — после расширения: `[первая, вторая, блок, байтов, байтов]`. База
    // (регистр блока) ЧИТАЕТСЯ, а временные `%b[10]`, `%b[11]` и единица рантайма `%b[13]` пишутся —
    // их обязан назвать этот разбор, иначе сайт печати не увидит живыми тех, что живут в них.
    case STRING_ARENA_COPY_CARRIER:
      return {
        def: [STRING_REGISTERS.first, STRING_REGISTERS.second, ARRAY_REGISTERS.one],
        use: registers(registerAt(instruction, 0), registerAt(instruction, 1), registerAt(instruction, 2)),
      };
    case 'IR.move':
    case 'IR.not':
      return { def: registers(registerAt(instruction, 0)), use: registers(registerAt(instruction, 1)) };
    case 'IR.jmp':
      return { def: [], use: [] };
    case 'IR.jmp_if':
    case 'IR.jmp_if_not':
      return { def: [], use: registers(registerAt(instruction, 0)) };
    case 'IR.ret': {
      const flag = operands[0];
      const hasValue = flag !== undefined && flag.kind === 'imm' && flag.value === 1;
      return { def: [], use: hasValue ? registers(registerAt(instruction, 1)) : [] };
    }
    // ВОЗВРАТ ПАРЫ `Результат<Т, Е>` (`docs/abi-v3-draft.md` §10.2): носитель
    // `IR.ret_result [тег, нагрузка]` ЧИТАЕТ оба регистра и не пишет ничего. Умолчание прочло бы
    // тег как ОПРЕДЕЛЕНИЕ, то есть объявило бы значение неживым ровно перед возвратом.
    case 'IR.ret_result':
      return {
        def: [],
        use: registers(registerAt(instruction, 0), registerAt(instruction, 1)),
      };
    // ЧТЕНИЕ НАГРУЗКИ ПАРЫ ИЗ КАНАЛА ВЫЗОВА: `IR.result_pick [приёмник, якорь]` — пишет приёмник,
    // читает ЯКОРЬ (приёмник тега того же вызова). Якорь здесь не источник данных, а зависимость
    // порядка: без него планировщик вправе поднять чтение канала выше самого вызова.
    case 'IR.result_pick':
      return {
        def: registers(registerAt(instruction, 0)),
        use: registers(registerAt(instruction, 1)),
      };
    case 'IR.call':
    case 'IR.invoke': {
      const flag = operands[0];
      const hasDestination = flag !== undefined && flag.kind === 'imm' && (flag.value & 1) === 1;
      // Аргументы — ОДНИМ источником: третий лежит в поле `src3`, а не следом за вторым, поэтому
      // прежняя арифметика `1 + index` прочла бы нагрузку и объявила бы ЧТЕНИЕМ число.
      const use: number[] = [];
      for (const operand of callArgumentOperands(instruction)) {
        if (operand.kind === 'reg') use.push(operand.index);
      }
      return { def: hasDestination ? registers(registerAt(instruction, 4)) : [], use };
    }
    default:
      // Остальные носители эмиттера — `[d, a, b]` (арифметика, сравнения).
      return {
        def: registers(registerAt(instruction, 0)),
        use: registers(registerAt(instruction, 1), registerAt(instruction, 2)),
      };
  }
}

/**
 * КЛЕТКИ ВЫЗЫВАЮЩЕГО, КОТОРЫЕ УНИЧТОЖАЕТ ВЫЗОВ ШИРИНОЙ `wbs` — то самое «порча окна», которой в
 * модели живости не было (случай 86, решение D35).
 *
 * # Откуда правило
 *
 * Спецификация ABI (`vendor/relcc2/spec/abi/calling-convention.md:167`, закреплённая копия; подтверждено
 * ЖЕЛЕЗОМ на 4C, 8C2 и 2C3 пробой `tagempty.c`): вызываемая получает окно, сдвинутое на `2·wbs`, то
 * есть её `%b[n]` — это клетка вызывающего `%b[n + 2·wbs]`; lcc отдаёт **4 пары** параметров, поэтому
 * при `wbs = 4` вызываемая распоряжается клетками вызывающего `%b[8..15]`, её `%b[0]` (куда она кладёт
 * ОТВЕТ) — это `%b[8]`, а приобретённые сверх отданных пар клетки на всех трёх машинах держат ПУСТОЕ
 * значение (0 с тегом 5). Отданные клетки вызывающего на время вызова не сохраняются — таблицы порчи
 * в спецификации сообщества нет, это наш замер и наша находка.
 *
 * # Почему это функция, а не пометка в `defUseOf`
 *
 * `defUseOf` говорит номерами **vreg'ов** (они до раскладки), а порча — свойство **физических клеток**
 * окна; отображение «vreg → клетка» появляется только ПОСЛЕ раскладки. Поэтому объявление живёт здесь
 * (это факт о вызове, а не об отдельном носителе), а исполняет его раскладка: значения, живущие ЧЕРЕЗ
 * вызов, в эти клетки не выдаются (`src/e2k/regAlloc.ts#allocateSegments`).
 *
 * # Замер, которым правило доказано
 *
 * `src/e2k/spillAcrossCall.test.ts`: значение, живое через вызов и попавшее в `%b[8]`, подменялось
 * ОТВЕТОМ вызываемой — предсказание «эталон − значение + ОТВЕТ» сошлось на пяти независимых замерах
 * (ответы 2 / 1 / 999 → 38 / 37 / 1035; все единицы → 10; степени двойки → 257). До правки n9 = 38
 * вместо 45, n14 = 98 вместо 105.
 *
 * # Почему клеток ровно столько, сколько аргументов (и одна под ответ)
 *
 * Отданная область — все 4 пары, но портится в ней не всё: эмиттер кладёт аргументы `movts` в
 * `%b[2·wbs + i]` (`src/e2k/e2kRealRun.ts`, ветвь `IR.call`), а ответ вызываемая оставляет в своём
 * `%b[0]` = `%b[2·wbs]` вызывающего. Остальные клетки отданной области принадлежат параметрам, которых
 * у этого вызова нет, и по нашему соглашению вызываемая их не трогает (её собственный пул начинается с
 * её `%b[8]`, то есть с `%b[16]` вызывающего). Замер это подтверждает: при `argc = 1` клетка `%b[9]`
 * вызов переживала (лестница с 10 значениями теряла только `п8`).
 *
 * Поэтому запрет ставится на клетки, которые вызов ГАРАНТИРОВАННО пишет: аргументы плюс ответ.
 * Проверять «а вдруг вызываемая вырастет и затрёт остальное» здесь нечем — рост зависит от ТЕЛА
 * вызываемой, а раскладка видит только свою процедуру; эта сторона названа долгом в случае 86.
 */
export function callClobberedCells(wbs: number, argc: number): readonly number[] {
  const first = 2 * wbs;
  const count = Math.max(argc, 1);
  return Array.from({ length: count }, (_, index) => first + index);
}

/** Интервалы жизни и пик одновременной жизни. */
export function liveIntervalsOf(instructions: readonly AsmInstruction[]): Liveness {
  // Интервал — **от первого определения до последнего чтения** (постановка, §2.2). Один vreg —
  // один интервал: переименование значений (SSA) в этом слое не делается, а раскладка обязана
  // выражаться отображением «vreg → регистр» (`applyAllocation`).
  const firstDef = new Map<number, number>();
  const lastUse = new Map<number, number>();
  const touch = (vreg: number, at: number, isUse: boolean): void => {
    if (!firstDef.has(vreg)) firstDef.set(vreg, at);
    if (isUse) lastUse.set(vreg, at);
    else if (!lastUse.has(vreg)) lastUse.set(vreg, at);
  };
  instructions.forEach((instruction, at) => {
    const { def, use } = defUseOf(instruction);
    // Чтение обрабатывается ДО записи: у `IR.move d, a` значение `a` читается раньше, чем пишется
    // `d`, и если это один и тот же vreg, команда обязана попасть в его интервал.
    for (const vreg of new Set(use)) touch(vreg, at, true);
    for (const vreg of new Set(def)) touch(vreg, at, false);
  });

  const intervals: LiveInterval[] = [...firstDef.entries()].map(([vreg, start]) => ({
    vreg,
    start,
    end: lastUse.get(vreg) ?? start,
  }));

  let peak = 0;
  let peakAt = -1;
  for (let at = 0; at < instructions.length; at++) {
    const live = intervals.filter((interval) => interval.start <= at && at <= interval.end).length;
    if (live > peak) {
      peak = live;
      peakAt = at;
    }
  }
  // Точная граница — по живым на выходе каждой инструкции (обратный анализ с переходами):
  // меньше этого числа не обойтись никакой раскладке, даже если каждому отрезку жизни дать свой
  // регистр — в этот момент все они живы одновременно.
  const sets = liveSetsOf(instructions);
  let peakLive = 0;
  let peakLiveAt = -1;
  sets.liveOut.forEach((live, at) => {
    if (live.length > peakLive) {
      peakLive = live.length;
      peakLiveAt = at;
    }
  });
  return { intervals, peak, peakAt, peakLive, peakLiveAt };
}

/**
 * Отрезки жизни: непрерывные участки, на которых vreg жив.
 *
 * Отличаются от интервалов тем, что **рвутся смертью значения**: если vreg переопределён или между
 * двумя чтениями значения нет, регистр на этом промежутке свободен для других значений. Именно это
 * даёт раскладке уложиться, когда интервалов-объединений не хватает.
 */
export function liveSegmentsOf(instructions: readonly AsmInstruction[]): LiveInterval[] {
  const { liveIn, liveOut } = liveSetsOf(instructions);
  const segments: LiveInterval[] = [];
  const open = new Map<number, number>();
  instructions.forEach((instruction, at) => {
    const alive = new Set<number>([...liveIn[at]!, ...liveOut[at]!, ...defUseOf(instruction).def]);
    for (const [vreg, start] of [...open]) {
      if (!alive.has(vreg)) {
        segments.push({ vreg, start, end: at - 1 });
        open.delete(vreg);
      }
    }
    for (const vreg of alive) if (!open.has(vreg)) open.set(vreg, at);
  });
  const last = instructions.length - 1;
  for (const [vreg, start] of open) segments.push({ vreg, start, end: Math.max(start, last) });
  return segments;
}

/**
 * Слить отрезки жизни, переносящие значение через ДУГУ.
 *
 * Отрезок жизни — величина линейная, и раскладка считает два отрезка неконфликтующими, если они не
 * пересекаются по индексам. Через дугу это неверно, и дыра тут была ОДНА — дуга ОБРАТНАЯ:
 *
 * * **обратная дуга (цикл):** значение, живое в заголовке, живо на каждом витке, поэтому регистр,
 *   отданный другому значению внутри тела, затирает его между двумя чтениями. Измерено
 *   (`docs/e2k-regalloc-debt.md`): цикл по массиву возвращал 8 вместо 36, цикл суммы зависал.
 * * **прямая дуга (короткое замыкание `и`, любое ветвление вперёд):** отрезки одного vreg разделены
 *   пропущенным промежутком, потому что на пути ПРЫЖКА значение там мертво. Раскладка вправе дать таким
 *   отрезкам РАЗНЫЕ клетки — они не пересекаются! — а цель читает клетку, которую пишет ПРОПУЩЕННАЯ
 *   ветвь: тихая ложь (K8 давал 58 вместо 10 при нуле отказов; §3.142.3, случай 55).
 *
 * Поэтому правило одно на обе дуги: **значение, приходящее на цель по дуге, обязано лежать в клетке,
 * которую цель прочтёт**. Для прямой дуги это значит: отрезок, накрывающий ПЕРЕХОД, и отрезок,
 * накрывающий ЦЕЛЬ, обязаны быть одним отрезком — для каждого vreg, ЧИТАЕМОГО на цели (у цели в
 * `use`). Слияние только нужных отрезков, а не всей пропущенной области, — намеренно: давление растёт
 * ровно там, где иначе теряется значение.
 *
 * Прямая дуга смотрит на `use` цели, а не только на живость: если цель vreg не читает, значение через
 * эту дугу никому не нужно, и сливать нечего (иначе «на всякий случай» слились бы почти все ветвления
 * корпуса). Цикл же остаётся прежним, широким: там значение живо на КАЖДОМ витке, и сузить правило до
 * одного чтения значило бы сломать FIR (замер `.tmp/cfg-experiment.ts`: без слияния FIR 8 вместо 181).
 */
export function mergeLoopCarriedSegments(
  segments: readonly LiveInterval[],
  instructions: readonly AsmInstruction[],
  codeOffset = 0,
  /**
   * Живые на входе каждой инструкции — по ГРАФУ (`src/vliw/cfg.ts#cfgLiveSets`). Необязательны: не
   * передали — считаются здесь же. Раскладка передаёт свои (`cfgSegmentsOf` их уже посчитал), чтобы не
   * считать живость дважды на одной процедуре.
   */
  liveIn?: readonly (readonly number[])[],
): LiveInterval[] {
  const loops: { readonly from: number; readonly to: number }[] = [];
  /**
   * Прямые дуги: переход `at` → цель `target`, и ЧТО НУЖНО НА ЦЕЛИ.
   *
   * # Почему `liveIn[target]`, а не `use` целевой КОМАНДЫ (срез 5д, случай 60)
   *
   * Прежняя редакция смотрела на `defUseOf(instructions[target]).use` — то есть сшивала отрезки, только
   * если цель читает vreg НА САМОЙ ПЕРВОЙ КОМАНДЕ. Это не то же самое, что «значение нужно на цели»:
   * переменная, определённая ВНУТРИ ветви и прочитанная ПОСЛЕ неё, целевой команды не касается вовсе,
   * её отрезки остаются разъехавшимися, и цель читает клетку, где на ребре «тело пропущено» лежит
   * ДРУГОЕ значение. Измерено (проба E, `.tmp/a5g-lie5-hunt.ts`): модель **107** при эталоне 100,
   * отказов НОЛЬ, утечка равна первому терму. Сторож — `src/e2k/domination.ts`.
   *
   * Живость на входе цели — ровно «значение нужно на этом пути»: `liveIn = use ∪ (liveOut − def)`,
   * поэтому она включает и `use` целевой команды (прежнее поведение — частный случай), и чтения
   * дальше по пути. Шире прежнего правило НЕ становится по последствиям: новый отрезок появляется
   * только там, где отрезки РАЗЪЕХАЛИСЬ (там, где один отрезок накрывает и переход, и цель, слияние
   * ничего не меняет). Замер: в корпусе таких мест **ноль** (`docs/hardware-debt.md` §3.144), у
   * лексера — два.
   */
  const forward: { readonly at: number; readonly target: number }[] = [];
  instructions.forEach((instruction, at) => {
    if (instruction.mnemonic !== 'IR.jmp' && instruction.mnemonic !== 'IR.jmp_if' && instruction.mnemonic !== 'IR.jmp_if_not') return;
    const operand = instruction.operands[instruction.mnemonic === 'IR.jmp' ? 0 : 1];
    if (operand === undefined || operand.kind !== 'imm' || !Number.isInteger(operand.value)) return;
    const target = operand.value - codeOffset;
    if (target < 0 || target >= instructions.length || target === at) return;
    if (target < at) {
      loops.push({ from: target, to: at });
      return;
    }
    forward.push({ at, target });
  });
  if (loops.length === 0 && forward.length === 0) return [...segments];
  // Ставим «что нужно на цели» ПОСЛЕ обхода: живость нужна, только если прямые дуги вообще есть.
  const живыеНаВходе = liveIn ?? (forward.length === 0 ? undefined : cfgLiveSets(instructions, { defUse: defUseOf }).liveIn);
  const needed = forward.map((edge) => ({
    ...edge,
    used: живыеНаВходе?.[edge.target] ?? defUseOf(instructions[edge.target]!).use,
  }));
  const byVreg = new Map<number, LiveInterval[]>();
  for (const segment of segments) {
    const list = byVreg.get(segment.vreg) ?? [];
    list.push(segment);
    byVreg.set(segment.vreg, list);
  }
  const merged: LiveInterval[] = [];
  for (const [vreg, list] of [...byVreg].sort((a, b) => a[0] - b[0])) {
    const carried = list.filter((segment) => loops.some((loop) => segment.start <= loop.to && loop.to <= segment.end));
    const crossesForward = needed.some((edge) => edge.used.includes(vreg));
    if (carried.length === 0 && !crossesForward) {
      merged.push(...list);
      continue;
    }
    let current = list.map((segment) => ({ ...segment }));
    let changed = true;
    while (changed) {
      changed = false;
      for (const loop of loops) {
        const covering = current.filter((segment) => segment.start <= loop.to && loop.from <= segment.end);
        const atBackEdge = covering.filter((segment) => segment.start <= loop.to && loop.to <= segment.end);
        if (atBackEdge.length === 0) continue;
        const start = Math.min(...covering.map((segment) => segment.start), loop.from);
        const end = Math.max(...covering.map((segment) => segment.end), loop.to);
        if (covering.length === 1 && covering[0]!.start === start && covering[0]!.end === end) continue;
        current = current.filter((segment) => !covering.includes(segment));
        current.push({ vreg, start, end });
        changed = true;
      }
      for (const edge of needed) {
        if (!edge.used.includes(vreg)) continue;
        // Сливаем ровно два отрезка: накрывающий ПЕРЕХОД (значение, уносимое дугой) и накрывающий ЦЕЛЬ
        // (клетка, которую цель прочтёт). Промежуток между ними в объединение входит — иначе не выйдет
        // одного отрезка, — но ничего сверх этого не захватывается.
        const covering = current.filter(
          (segment) =>
            (segment.start <= edge.at && edge.at <= segment.end) ||
            (segment.start <= edge.target && edge.target <= segment.end),
        );
        const atTarget = covering.some((segment) => segment.start <= edge.target && edge.target <= segment.end);
        if (!atTarget || covering.length <= 1) continue;
        const start = Math.min(...covering.map((segment) => segment.start));
        const end = Math.max(...covering.map((segment) => segment.end));
        // Здесь стояла проверка `covering.length === 1 && …` — НЕДОСТИЖИМАЯ: выше `covering.length <= 1`
        // уже продолжает цикл, поэтому длина здесь всегда ≥ 2, и условие не могло выполниться никогда.
        // Убрана в 5г (задача 4) вместе с перемером приёмки; долг «недостижимая строка» закрыт —
        // `docs/verification-debt.md`. Замена её на `>` или на `atTarget` была бы ПОСЛАБЛЕНИЕМ, а не
        // уборкой: мёртвое условие не защищало ничего.
        current = current.filter((segment) => !covering.includes(segment));
        current.push({ vreg, start, end });
        changed = true;
      }
    }
    merged.push(...current);
  }
  return merged;
}

/**
 * Отрезки жизни по **графу потока управления** — точная модель, и множества живости рядом.
 *
 * Отличие от {@link liveSegmentsOf} только в одном, но решающем: анализ идёт по графу
 * (`src/vliw/cfg.ts`), а не по линейному порядку, поэтому значение, определённое в теле цикла и
 * прочитанное в его заголовке, живо **на выходе своего определения** — а не «нигде», как в
 * линейной модели.
 *
 * Слияние отрезков через дугу (`mergeLoopCarriedSegments`) этим **не отменяется**: отрезки
 * позиционные, и переносимое через дугу значение накрывается двумя разными отрезками, которым
 * нельзя дать разные регистры. Замер `.tmp/cfg-experiment.ts`, вариант 1 (без слияния): FIR
 * сломался — 8 вместо 181. Живость по графу даёт точный пик, но не отменяет позиционность.
 *
 * `liveOut` возвращается рядом как справочная величина: раскладка им не пользуется (правило
 * «приёмник занимает регистр умирающего чтения» замерено бесполезным — `.tmp/cfg-experiment3.ts`).
 */
export function cfgSegmentsOf(instructions: readonly AsmInstruction[]): {
  readonly segments: readonly LiveInterval[];
  readonly liveOut: readonly (readonly number[])[];
  /**
   * Живые на входе инструкций — рядом с отрезками, чтобы слияние через дугу (mergeLoopCarriedSegments)
   * не считало живость ВТОРОЙ раз на той же процедуре (срез 5д: правило слияния спрашивает живость цели).
   */
  readonly liveIn: readonly (readonly number[])[];
} {
  const sets = cfgLiveSets(instructions, { defUse: defUseOf });
  return { segments: cfgRanges(instructions, { defUse: defUseOf }), liveOut: sets.liveOut, liveIn: sets.liveIn };
}

/**
 * Пересекаются ли интервалы. Соприкосновение на одной команде считается пересечением: если одно
 * значение определяется там, где другое читается, регистр обязан быть разным (иначе чтение
 * получит новое значение).
 */
export function overlaps(a: LiveInterval, b: LiveInterval): boolean {
  return a.start <= b.end && b.start <= a.end;
}
