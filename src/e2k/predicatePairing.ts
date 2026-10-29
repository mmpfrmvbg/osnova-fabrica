/**
 * СОПОСТАВЛЕНИЕ ПАРЫ «СРАВНЕНИЕ → УСЛОВНЫЙ ПЕРЕХОД».
 *
 * # Зачем отдельный проход
 *
 * `IR.jmp_if_not` несёт условие **регистром-значением**, а `ct` читает **предикат**
 * (`SS.ctcond.psrc[4:0]`). Значение предикатом не является — предикат даёт только сравнение
 * (`cmp*`, форма ALF7: `pdst[4:0]`). Значит понижение возможно лишь тогда, когда сравнение и
 * переход стоят в потоке **парой**: сравнение кладёт результат в предикат, переход его читает.
 *
 * # Предпосылка проверяется здесь, а не предполагается
 *
 * Измерено на пяти ядрах: результат каждого из 14 сравнений читает **только** следующий за ним
 * условный переход, лишних читателей — 0 из 14. Но это факт про **этот** корпус, а не свойство
 * IR. Поэтому проход проверяет живость и **отказывает с причиной**, когда предпосылка не
 * выполняется:
 *
 * | случай | что делает проход |
 * |---|---|
 * | у результата есть другой читатель (кроме одного перехода) | пара + **материализация** значения (§ниже) |
 * | читателей нет вовсе | отказ: предикат некуда деть |
 * | читателей-переходов несколько | материализация: предикат один, переходы получают свой отказ |
 * | условие перехода пришло не из сравнения | материализация (пара не составляется) |
 * | в промежутке операции с неизвестными операндами | отказ: живость не доказана |
 * | значение живо на РЕБРЕ ВЗЯТОГО перехода (не «склейка») | пара + **материализация** значения |
 * | «склейка» короткого замыкания расходится | отказ: один `ct` не выражает два ребра |
 *
 * # Значение в регистре: новая форма носителя (срез A4-5а, 2026-10-29)
 *
 * `cmp*` пишет **только** предикат: значения сравнения в регистре нет вовсе. Поэтому случай «значение
 * нужно ещё и как значение» решается не отказом, а **материализацией**: понижение кладёт рядом с
 * сравнением два переноса под предикатом (`movts 1` / `movts 0`, форма `16` байт каждый — измерено
 * ассемблером МЦСТ), и значение сравнения живёт в регистре как обычное число 0/1. Пара при этом
 * **сохраняется**: `ct` по-прежнему скачет по предикату того же сравнения.
 *
 * Помеченное здесь сравнение узнаёт понижение ({@link isMaterializingComparison}) — и раскладка
 * ({@link import("./twoPassLayout").layoutOf}), которой длину носителя надо знать ЗАРАНЕЕ и БЕЗ
 * плоскости (§3.135). Пометка — **тождество носителя** (`WeakSet`), а не поле: так она не течёт ни в
 * отчёты, ни в сериализацию, ни в сравнения форм, и не может разойтись с потоком, который понижается.
 *
 * Отказы, которые при этом НЕ снимаются: «склейка» расходится (материализация не спасает мир
 * предиката), значение мертво/никем не читается, живость не доказана. Материализация снимает ровно
 * те отказы, причина которых — «значение обязано жить в регистре».
 *
 * # Ребро взятого перехода: окно живости — ЛИНЕЙНОЕ, а значение течёт и по ребру (K5, 2026-10-29)
 *
 * Окно живости выше считается по ЛИНЕЙНОМУ потоку: жизнь значения кончается на следующей записи
 * того же регистра. Для РЕБРА ВЗЯТОГО перехода это неверно: инструкции между переходом и его целью
 * на этом ребре **не исполняются**, поэтому регистр приходит на цель со значением, записанным ДО
 * перехода. Измерено на модели: `если а >= 10 и а <= 20` при `а = 5` возвращало **7** вместо **3** —
 * отказов 0, образ собран, число неверное (худший класс, `AGENTS.md`). Механизм: пара
 * «`IR.ge` → `jmp_if_not`» выбрасывала значение, а цель перехода читала тот же регистр.
 *
 * Поэтому у КАЖДОЙ составленной пары проверяется ребро взятого перехода: если цель (или поток от неё)
 * читает регистр-результат раньше, чем его перепишут, пара не составляется и оба носителя получают
 * НАЗВАННЫЙ отказ. Исключение — «склейка» короткого замыкания (цель сама есть условный переход,
 * состоящий в паре): там чтение регистра **намеренно**, и пара звучит ровно тогда, когда решения
 * двух миров совпадают (см. {@link takenEdgeProblem}). Измерено: `пока A и B`, `если A или B`,
 * `пока A или B` — звучат (пять ядер и корпус железа не затронуты), а `если A и B` — НЕ звучит.
 *
 * # Полярность: вывод, а не подбор
 *
 * `ct` передаёт управление, когда предикат **истинен**: `? %predN` — `CTCOND_PRED = 0x40`,
 * `? ~%predN` — `CTCOND_NEG_PRED = 0x60` (`gas/config/tc-e2k.c:4589-4591`,
 * `opcodes/e2k-dis.c:1584-1640`). Предикат — результат **самого сравнения**, поэтому
 * `jmp_if_not` инвертирует его, а `ge`/`gt`/`ne` — ещё раз: условий «больше» и «больше или равно»
 * в наборе `cmp*` **нет** (`opcodes/e2k-opc.h:989-1064`, набор `o,b,e,be,s,p,l,le`).
 *
 * ```
 * inverted = (переход — jmp_if_not) XOR (сравнение — ge/gt/ne)
 * condition = (inverted ? 0x60 : 0x40) | predicate
 * ```
 *
 * Проверка на пяти ядрах: 13 пар дают `0x60` и **одна** (`ge` в `convolution`) — `0x40`.
 */

import type { AsmInstruction } from "./backend";
import { LOWERING_CODES, type LoweringRefusalCode } from "./loweringRefusal";
import { ARRAY_REGISTERS } from "./arrayRuntime";
import { callArgumentOperands } from "./shell";
import { LOAD_CARRIER, STORE_CARRIER } from "./memoryAccess";
import { ARENA_LIMIT_BASE, ARENA_POINTER_BASE } from "./procedureCall";
import { REFUSAL_CARRIER } from "./refusalBlock";
import { COLLECTION_ALLOC_CARRIER, COLLECTION_FRAME_REGISTERS } from "./collectionsRuntime";
import { STRING_REGISTERS } from "./stringRuntime";

/** Номер предиката, отданный парам: пары не переплетаются, поэтому одного достаточно. */
export const PREDICATE_FOR_PAIRS = 0;

/**
 * Сравнения, значение которых обязано лечь в РЕГИСТР (материализация) — помечены по тождеству.
 *
 * Ставит пометку {@link pairPredicates} (единственное место, где решается судьба пары), читают
 * понижение и раскладка. Тождество, а не поле носителя: поток, который считает раскладка, — тот же
 * самый массив объектов, что понижается (`planned`), поэтому пометка не может «отстать» от потока,
 * а в отчёты и сериализацию не попадает вовсе.
 */
const MATERIALIZING = new WeakSet<AsmInstruction>();

/** Материализует ли понижение значение этого сравнения в регистр (см. {@link MATERIALIZING}). */
export function isMaterializingComparison(instruction: AsmInstruction): boolean {
  return MATERIALIZING.has(instruction);
}

/** Код условия «по предикату» (`CTC OND_PRED`): передать, когда предикат истинен. */
export const CTCOND_PRED = 0x40;

/** Код условия «по инверсному предикату» (`CTCOND_NEG_PRED`). */
export const CTCOND_NEG_PRED = 0x60;

/** Источник кодов условий — для отчётов и ссылок. */
export const CTCOND_SOURCE =
  "gas/config/tc-e2k.c:4589-4591 (CTCOND_PRED = 64, CTCOND_NEG_PRED = 96); " +
  "opcodes/e2k-dis.c:1584-1640 (cond_type); qemu/target/e2k/syllab-format.h:196 (SS_CTCOND.psrc[4:0])";

/**
 * Мнемоника сравнения e2k по операции IR — и «переворачивает» ли она предикат.
 *
 * `flipped: true` означает, что IR-условие есть **отрицание** условия таблицы: `ge` — не «меньше»
 * (`cmplsb`), `gt` — не «не больше» (`cmplesb`), `ne` — не «равно» (`cmpesb`). Условий
 * «больше»/«больше или равно» в наборе `cmp*` нет, поэтому иначе их не выразить.
 */
export function comparisonMnemonicOf(op: string): { mnemonic: string; flipped: boolean } | undefined {
  switch (op) {
    case "IR.lt":
      return { mnemonic: "cmplsb", flipped: false };
    case "IR.le":
      return { mnemonic: "cmplesb", flipped: false };
    case "IR.eq":
      return { mnemonic: "cmpesb", flipped: false };
    case "IR.ge":
      return { mnemonic: "cmplsb", flipped: true };
    case "IR.gt":
      return { mnemonic: "cmplesb", flipped: true };
    case "IR.ne":
      return { mnemonic: "cmpesb", flipped: true };
    default:
      return undefined;
  }
}

/** Условные переходы IR: только они читают предикат. */
export const CONDITIONAL_JUMPS: readonly string[] = ["IR.jmp_if", "IR.jmp_if_not"];

/** Носитель, результат которого можно положить в предикат. */
export interface PredicatePair {
  readonly comparisonIndex: number;
  readonly jumpIndex: number;
  readonly comparison: string;
  readonly jump: string;
  readonly cmpMnemonic: string;
  readonly predicate: number;
  /** Код условия `ct`: `0x40` (по предикату) или `0x60` (по инверсному). */
  readonly condition: number;
}

/**
 * Отказ сопоставления с причиной И КОДОМ.
 *
 * Код у всех отказов сопоставления один — `OSN-LOW-004` (раскладка): предикат ставит раскладка, и
 * «пара не составилась» значит, что раскладка не может выдать команду сравнения. Разные причины
 * внутри этого кода различимы текстом, но личность у них одна — и это честнее, чем семь кодов
 * на семь формулировок одной и той же невозможности.
 */
export interface PairingRefusal {
  readonly index: number;
  readonly code: LoweringRefusalCode;
  readonly reason: string;
}

/** Результат прохода. */
export interface PairingResult {
  readonly pairs: readonly PredicatePair[];
  readonly refusals: readonly PairingRefusal[];
}

/**
 * Что инструкция пишет и что читает — по раскладке операндов носителя.
 *
 * Раскладка наша и живёт в эмиттере оболочки (`src/e2k/emitterShell.ts`): бинарные операции и
 * сравнения несут `(dst, a, b)`, `move`/`not` — `(dst, a)`, `const` — `(dst, k, type)`,
 * `call`/`invoke` — `(flags, src1, src2, imm, dst)` (приёмник пятый, а источников ровно `flags >> 1`),
 * `ret` — `(флаг, значение)`, `jmp_if`/`jmp_if_not` — `(cond, off)`, `jmp` — `(off)`, вытеснение в
 * память (`src/vliw/spill.ts`) — `spill_ld` `(адрес, приёмник, слот)`, `spill_st` `(значение, адрес, слот)`.
 *
 * `known: false` — операция, у которой приёмник и источники нам неизвестны; такая инструкция в
 * промежутке делает живость недоказанной, и пара отвергается (отказ, а не догадка).
 *
 * Носители вытеснения здесь описаны **обязательно**: они вставляются в поток между сравнением и
 * условным переходом, и пока они были «неизвестны», промежуток обрывался на них, а читателем
 * сравнения начинала считаться любая инструкция с тем же номером регистра дальше по потоку — то
 * есть пара отвергалась по ложной причине (измерено: `корреляция`, `.tmp/pair-refusal-debug.ts`).
 */
export function registersOf(instruction: AsmInstruction): { known: boolean; reads: number[]; writes: number[] } {
  const regs = (operands: readonly { kind: string; index?: number }[]): number[] =>
    operands.filter((operand) => operand.kind === "reg").map((operand) => operand.index!);
  const operands = instruction.operands;
  const known = (reads: number[], writes: number[]): { known: boolean; reads: number[]; writes: number[] } => ({
    known: true,
    reads,
    writes,
  });
  switch (instruction.mnemonic) {
    case "IR.spill_ld":
      // `movtd` + `ldd`: читается регистр адреса, пишется приёмник.
      return known(regs([operands[0]!]), regs([operands[1]!]));
    case "IR.spill_st":
      // `movtd` + `std`: читаются и значение, и регистр адреса; приёмника нет.
      return known(regs([operands[0]!, operands[1]!]), []);
    case "IR.const":
      return known([], regs([operands[0]!]));
    case "IR.move":
    case "IR.not":
      return known(regs([operands[1]!]), regs([operands[0]!]));
    case "IR.add":
    case "IR.sub":
    case "IR.mul":
    case "IR.div":
    case "IR.rem":
    case "IR.eq":
    case "IR.ne":
    case "IR.lt":
    case "IR.le":
    case "IR.gt":
    case "IR.ge":
    case "IR.and":
    case "IR.or":
      return known(regs([operands[1]!, operands[2]!]), regs([operands[0]!]));
    case "IR.jmp_if":
    case "IR.jmp_if_not":
      return known(regs([operands[0]!]), []);
    case "IR.jmp":
      return known([], []);
    case "IR.ret":
      return known(regs([operands[1]!]), []);
    case "IR.call":
    case "IR.invoke": {      // Аргументов ровно `argc = flags >> 1`: слот НЕсуществующего аргумента эмиттер всё равно несёт
      // (пятый операнд — приёмник, четвёртый — payload), и там лежит заполнитель вида `%b[0]`.
      // Считать его чтением нельзя: именно так сравнение в встроенной свёртке получало «второго
      // читателя» (`#54 IR.invoke` при `argc = 1` читал `%r0` — регистр результата `IR.lt #42`) и
      // пара отвергалась по ложной причине (измерено, `.tmp/convolution-callers.ts`).
      //
      // АРГУМЕНТЫ БЕРУТСЯ ОДНИМ ИСТОЧНИКОМ: третий аргумент лежит в поле `src3`, а не следом за
      // вторым, — прежняя арифметика `1 + index` прочла бы на argc = 3 нагрузку-число.
      const argv = callArgumentOperands(instruction).filter((operand) => operand !== undefined);
      return known(regs(argv), regs([operands[4]!]));
    }
    // АРЕНА (`src/e2k/arenaRuntime.ts`): регистры состояния — физические и в операндах не названы.
    // Без этих ветвей носители арены попадали в `known: false` — то есть в **барьер**, и сравнение
    // сайта получало «читателей» из всех последующих сайтов: предикат не составлялся вовсе
    // (измерено: «результат читают 2 инструкций (#9 IR.jmp_if_not, #18 IR.jmp_if_not)»).
    // ДОСТУП ПО АДРЕСУ-РЕГИСТРУ (`src/e2k/memoryAccess.ts`): роли операндов обратны общему случаю
    // `[d, a, b]`, поэтому умолчание объявило бы адрес определением, а приёмник — чтением.
    case LOAD_CARRIER: // [адрес, приёмник]
      return known(regs([operands[0]!]), regs([operands[1]!]));
    case STORE_CARRIER: // [значение, адрес]
      return known(regs([operands[0]!, operands[1]!]), []);
    case "IR.arena_init":
      return known([], [ARENA_POINTER_BASE, ARENA_LIMIT_BASE]);
    case "IR.arena_alloc": {
      const size = operands[0];
      const destination = operands[1];
      const use = size !== undefined && size.kind === "reg" ? [size.index] : [];
      const def = destination !== undefined && destination.kind === "reg" ? [destination.index] : [];
      return known([...use, ARENA_POINTER_BASE], [...def, ARENA_POINTER_BASE]);
    }
    case "IR.arena_pointer":
      return known([ARENA_POINTER_BASE], regs([operands[0]!]));
    case "IR.arena_limit":
      return known([ARENA_LIMIT_BASE], regs([operands[0]!]));
    case REFUSAL_CARRIER:
      return known([], []);
    // ВЫХОД РАБОТЫ (`IR.exit`): читает значение, если оно есть, и не пишет ничего.
    //
    // ЗАЧЕМ ЭТА ВЕТВЬ — ЗАМЕР, А НЕ АККУРАТНОСТЬ. Без неё носитель попадал в умолчание
    // (`known: false`), то есть в **БАРЬЕР**, и окно сравнения ВЫРОЖДАЛОСЬ: конец окна оставался
    // `instructions.length`, и «читателями» результата становились все переходы с тем же ключом
    // дальше по потоку. Замер (2026-10-03): у сайта `расширить` сравнение получило «читателей»
    // `#12 jmp_if` и `#26 jmp_if_not` — вторым был переход ЦИКЛА КОПИРОВАНИЯ, стоящего за выходом
    // точки входа; пара не составилась, и проба отказала `OSN-LOW-004`. Это ровно тот класс, что
    // держал восемь заходов на арене (§3.89.3): там барьером были носители арены, здесь — выход.
    case "IR.exit": {
      const values = operands
        .filter((operand) => operand.kind === "reg")
        .map((operand) => operand.index!);
      return known(values, []);
    }
    // РАСШИРЕНИЕ КУЧИ ПОД КОЛЛЕКЦИЮ (`src/e2k/collectionsRuntime.ts`): носитель называет ДВА
    // регистра-операнда (ёмкость и приёмник), но пишет ещё и регистры кадра системного вызова —
    // ОТВЕТ `brk` и ЗАПРОШЕННУЮ ГРАНИЦУ: их читает следующее за носителем сравнение. Без этой ветви
    // носитель был бы БАРЬЕРОМ (`known: false`), и проверка ответа не составила бы пару с переходом.
    case COLLECTION_ALLOC_CARRIER: {
      const capacity = operands[0];
      const destination = operands[1];
      const use = capacity !== undefined && capacity.kind === "reg" ? [capacity.index] : [];
      const def = destination !== undefined && destination.kind === "reg" ? [destination.index] : [];
      return known([...use, ...COLLECTION_FRAME_REGISTERS], [...def, ...COLLECTION_FRAME_REGISTERS]);
    }
    // СКЛЕЙКА В АРЕНЕ (`src/e2k/stringRuntime.ts`): сайт до расширения `[первая, вторая, приёмник,
    // байтов, байтов]` и копирование после `[первая, вторая, блок, байтов, байтов]`. Без этих ветвей
    // оба носителя стали бы БАРЬЕРОМ (`known: false`) — и сравнение сайта получило бы «читателей» из
    // последующих сайтов: ровно тот отказ, что держал восемь заходов (§3.89.3). Копирование пишет
    // временные `%b[10]`, `%b[11]` и единицу рантайма `%b[13]` — это названо, а не умолчано.
    case "IR.arena_concat":
      return known(regs([operands[0]!, operands[1]!]), regs([operands[2]!]));
    case "IR.string_arena_copy":
      return known(
        regs([operands[0]!, operands[1]!, operands[2]!]),
        [STRING_REGISTERS.first, STRING_REGISTERS.second, ARRAY_REGISTERS.one],
      );
    default:
      return { known: false, reads: [], writes: [] };
  }
}

/** Номер регистра, по которому инструкция читается как условие перехода. */
function conditionRegisterOf(instruction: AsmInstruction): number | undefined {
  if (!CONDITIONAL_JUMPS.includes(instruction.mnemonic)) return undefined;
  const operand = instruction.operands[0];
  return operand !== undefined && operand.kind === "reg" ? operand.index : undefined;
}

/**
 * Составить пары «сравнение → условный переход» и назвать причины, по которым пара не составилась.
 *
 * Каждая инструкция потока получает не больше одного отказа; для инструкций, к паре не
 * относящихся (например, безусловного `IR.jmp`), отказов нет вовсе.
 */
export function pairPredicates(instructions: readonly AsmInstruction[]): PairingResult {
  const pairs: PredicatePair[] = [];
  const refusals: PairingRefusal[] = [];
  const pairedJump = new Set<number>();
  /** Индексы сравнений, значение которых обязано лечь в регистр (см. §«Значение в регистре»). */
  const materialize = new Set<number>();
  /**
   * Отказ сопоставления: КОД один и назван здесь, а не у каждой формулировки.
   *
   * `OSN-LOW-004` — раскладка: предикат-приёмник ставит она, и сопоставление — её проход
   * (`src/e2k/loweringRefusal.ts`). Меняется только текст причины, личность — нет.
   */
  const refuse = (index: number, reason: string): void => {
    refusals.push({ index, code: LOWERING_CODES.layout, reason });
  };

  instructions.forEach((instruction, index) => {
    const comparison = comparisonMnemonicOf(instruction.mnemonic);
    if (comparison === undefined) return;
    const result = registersOf(instruction).writes[0];
    if (result === undefined) {
      refuse(index, `«${instruction.mnemonic}» #${index}: у сравнения нет регистра-результата`);
      return;
    }
    // Конец жизни значения: следующая инструкция, которая пишет тот же регистр.
    let end = instructions.length;
    let barrier: number | undefined;
    for (let next = index + 1; next < instructions.length; next++) {
      const info = registersOf(instructions[next]!);
      if (!info.known) {
        barrier = next;
        break;
      }
      if (info.writes.includes(result)) {
        end = next;
        break;
      }
    }
    const readers: number[] = [];
    for (let next = index + 1; next < end; next++) {
      if (registersOf(instructions[next]!).reads.includes(result)) readers.push(next);
    }
    if (barrier !== undefined && readers.length === 0) {
      refuse(
        index,
        `«${instruction.mnemonic}» #${index}: в промежутке (#${barrier} ${instructions[barrier]!.mnemonic}) ` +
          "операция с неизвестными операндами — живость результата не доказана",
      );
      return;
    }
    if (readers.length === 0) {
      refuse(index, `«${instruction.mnemonic}» #${index}: результат никем не читается — предикат некуда деть`);
      return;
    }
    // ПАРА СОСТАВЛЯЕТСЯ ТОЛЬКО С ОДНИМ ПЕРЕХОДОМ: предикат у пары один. Читатели, которые не
    // условие перехода, значения не отменяют — их обслуживает материализация (см. заголовок).
    const jumpReaders = readers.filter((at) => conditionRegisterOf(instructions[at]!) === result);
    if (jumpReaders.length !== 1) {
      // Ни одного перехода-читателя либо их несколько: пары нет. Сравнение всё равно понижаемо —
      // оно обязано положить значение в регистр. Переходы-читатели (если они есть) получат СВОЙ
      // названный отказ ниже, в общем проходе.
      materialize.add(index);
      return;
    }
    // У результата есть читатель-ЗНАЧЕНИЕ (кроме перехода): одной пары мало — сравнение обязано
    // ещё и положить значение в регистр, иначе цель прочтёт мусор (тихая ложь среза 5).
    if (readers.length > 1) materialize.add(index);
    const jumpIndex = jumpReaders[0]!;
    const jump = instructions[jumpIndex]!;
    const inverted = (jump.mnemonic === "IR.jmp_if_not") !== comparison.flipped;
    pairs.push({
      comparisonIndex: index,
      jumpIndex,
      comparison: instruction.mnemonic,
      jump: jump.mnemonic,
      cmpMnemonic: comparison.mnemonic,
      predicate: PREDICATE_FOR_PAIRS,
      condition: (inverted ? CTCOND_NEG_PRED : CTCOND_PRED) | PREDICATE_FOR_PAIRS,
    });
    pairedJump.add(jumpIndex);
  });

  // ── ЗВУЧНОСТЬ НА РЕБРЕ ВЗЯТОГО ПЕРЕХОДА (K5) ─────────────────────────────────────────────────
  //
  // Составленная пара ещё не значит верная: если цель перехода читает регистр-результат, значение
  // течёт по ребру, а предикат его не несёт. Проверка идёт ПОСЛЕ составления (нужны условия ВСЕХ
  // пар: «склейка» сравнивает два мира) и ДО перехода осиротевших — отвергнутый переход обязан
  // получить свой отказ ниже, а не остаться молча непонижённым.
  //
  // ЦИКЛ ДО НЕПОДВИЖНОЙ ТОЧКИ: снятая пара перестаёт быть «склейкой», и пара, которая на неё
  // опиралась, обязана быть перепроверена. Пар становится меньше на каждом обходе, поэтому цикл
  // конечен. (Замер: без этого цепочка `#256 → #257` глушила проверку `#250 → #251` — 2 пары
  // оставались незвучными, и это видно в `.tmp/k5-precise-impact.ts`.)
  const pairByJump = new Map(pairs.map((pair) => [pair.jumpIndex, pair]));
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const pair of [...pairs]) {
      const problem = takenEdgeProblem(instructions, pair, pairByJump);
      if (problem === undefined) continue;
      // ЗНАЧЕНИЕ, нужное КАК ЗНАЧЕНИЕ: пара не снимается — сравнение материализует результат.
      // Иначе на ребре взятого перехода цель читала бы мусор (срез 5: `7` вместо `3`).
      if (problem.kind === "value") {
        materialize.add(pair.comparisonIndex);
        continue;
      }
      pairs.splice(pairs.indexOf(pair), 1);
      pairByJump.delete(pair.jumpIndex);
      pairedJump.delete(pair.jumpIndex);
      refuse(pair.comparisonIndex, `«${pair.comparison}» #${pair.comparisonIndex}: ${problem.reason}`);
      dropped = true;
    }
  }

  // ПОМЕТКА МАТЕРИАЛИЗАЦИИ — отсюда и только отсюда: до этого места судьба пары ещё менялась
  // (цикл неподвижной точки), и пометка на снятой паре разошлась бы с отказом.
  for (const at of materialize) {
    const instruction = instructions[at];
    if (instruction !== undefined) MATERIALIZING.add(instruction);
  }

  // Условный переход без пары: условие пришло не из сравнения — предиката взять неоткуда.
  instructions.forEach((instruction, index) => {
    if (!CONDITIONAL_JUMPS.includes(instruction.mnemonic) || pairedJump.has(index)) return;
    const condition = conditionRegisterOf(instruction);
    refuse(
      index,
      `«${instruction.mnemonic}» #${index}: условие %r${String(condition)} пришло не из сравнения ` +
        "(или сравнение отвергнуто) — предикат взять неоткуда",
    );
  });

  refusals.sort((a, b) => a.index - b.index);
  return { pairs, refusals };
}

/**
 * Чем плоха пара на РЕБРЕ ВЗЯТОГО перехода — или `undefined`, если пара звучит.
 *
 * # Почему линейного окна живости мало
 *
 * Инструкции между переходом и его ЦЕЛЬЮ на взятом ребре **не исполняются**, поэтому на цель регистр
 * приходит со значением, записанным ДО перехода. Линейное окно этого не видит: жизнь значения
 * объявляется конченой на следующей записи — а на ребре эта запись пропущена.
 *
 * # Два случая
 *
 * 1. **Значение нужно как значение** (`kind: "value"`). Цель (или поток от неё) читает регистр не
 *    как условие перехода, а как операнд (`IR.ret`, `IR.exit`, `IR.move`, аргумент вызова…). Пара
 *    **остаётся**, а сравнение помечается материализующим: понижение кладёт значение в регистр
 *    (форма `cmp*` + predicated `movts 0/1`), поэтому мусора здесь больше нет.
 * 2. **«Склейка» короткого замыкания** (`kind: "join"`). Цель сама есть условный переход, состоящий в
 *    паре со СВОИМ
 *    сравнением. Чтение регистра там намеренно (оба ребра сходятся на одном `ct`), и пара звучит
 *    ровно тогда, когда решения двух миров совпадают:
 *
 *    - предикатный мир: сравнение 1 оставило предикат `v` (`0x40` → 1, `0x60` → 0), и `ct` склейки
 *      скачет по НЕМУ;
 *    - мир значений: в регистре лежит БУЛЕВО значение сравнения 1 — `v`, а у «перевёрнутых» условий
 *      (`ge`/`gt`/`ne` — отрицаний в наборе `cmp*` нет) его отрицание; `ct` склейки скачет по НЕМУ.
 *
 *    Расходятся — один и тот же `ct` на двух рёбрах означает РАЗНОЕ. Измерено на модели:
 *    `если A и B` при ложном `A` возвращало `7` вместо `3` (`A` = `IR.ge` → `0x40`, склейка `0x60`),
 *    тогда как `пока A и B` (тот же `0x40`-набор, но `jmp_if_not` с `IR.lt` → `0x60`), `если A или B`
 *    и `пока A или B` — звучат: пять ядер (закреплённые числа) не затронуты, корпус железа тоже.
 */
function takenEdgeProblem(
  instructions: readonly AsmInstruction[],
  pair: PredicatePair,
  pairByJump: ReadonlyMap<number, PredicatePair>,
): { readonly kind: "value" | "join"; readonly reason: string } | undefined {
  const result = registersOf(instructions[pair.comparisonIndex]!).writes[0];
  const target = instructions[pair.jumpIndex]!.operands[1];
  if (result === undefined || target === undefined || target.kind !== "imm") return undefined;
  for (let at = target.value; at < instructions.length; at++) {
    const info = registersOf(instructions[at]!);
    // Неизвестные операнды: чтения не видно — за это не отказываем (иначе отказ был бы шире
    // доказательства). Барьер в промежутке ДО перехода закрыт выше, своим отказом.
    if (!info.known) return undefined;
    if (info.writes.includes(result)) return undefined; // значение переписано — на ребре оно мертво
    if (!info.reads.includes(result)) continue;
    const join = at === target.value ? pairByJump.get(at) : undefined;
    if (join === undefined) {
      // ВИД `value`: значение нужно КАК ЗНАЧЕНИЕ. Пара при этом остаётся в силе — понижение обязано
      // ПОЛОЖИТЬ значение в регистр (материализация, `cmp*` + predicated `movts` 0/1).
      return {
        kind: "value",
        reason:
          `значение живо на ребре перехода: цель #${String(at)} (${instructions[at]!.mnemonic}) читает ` +
          `%r${String(result)} как ЗНАЧЕНИЕ — предикат значения не несёт`,
      };
    }
    const predicateValue = pair.condition === CTCOND_PRED ? 1 : 0;
    const inverted = comparisonMnemonicOf(pair.comparison)!.flipped;
    const booleanValue = inverted ? 1 - predicateValue : predicateValue;
    const valueWorldJumps = join.jump === "IR.jmp_if" ? booleanValue !== 0 : booleanValue === 0;
    const predicateWorldJumps = join.condition === CTCOND_PRED ? predicateValue !== 0 : predicateValue === 0;
    if (valueWorldJumps === predicateWorldJumps) return undefined;
    return {
      kind: "join",
      reason:
        `значение живо на ребре перехода: цель #${String(at)} — «склейка» ${join.jump}, и на двух её ` +
        `рёбрах предикат означает РАЗНОЕ (мир значений: скачок=${String(valueWorldJumps)}, ` +
        `предикатный=${String(predicateWorldJumps)}) — один ct не выражает оба ребра`,
    };
  }
  return undefined;
}
