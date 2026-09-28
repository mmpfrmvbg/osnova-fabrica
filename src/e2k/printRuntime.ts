/**
 * РАНТАЙМ ПЕЧАТИ e2k: ЧИСЛО → ТЕКСТ → `write`.
 *
 * # СОСТОЯНИЕ: НЕ ДОВЕДЁН ДО ПЕЧАТИ. ЭТО КОНСТРУКЦИЯ, А НЕ ГОТОВЫЙ РАНТАЙМ.
 *
 * Модуль **не подключён к конвейеру** (на него никто не ссылается, кроме проб и этого текста) и
 * **не проходит сквозную проверку**: развёртка собирается и кодируется, но программа на 198
 * командах встаёт исключением модели на `subs` четвёртого разряда (`.tmp/probe-print.ts`:
 * `exception at IP = 0x100818`). Что уже измерено и верно — ниже; что осталось — в конце шапки.
 *
 * ## Что измерено и верно (не переделывать)
 *
 * | кирпич | замер |
 * |---|---|
 * | `write(fd, buf, count)` | работает: `buildHelloProgram`, «hello» выводится моделью |
 * | `sdivs` (канал 5) | `7/10 = 0`, `1000000/10 = 100000` — исполнено (`.tmp/probe-forms.ts`) |
 * | `muls`, `subs`, `adds` с литералом | `0*10 = 0`, `7+48 = 55` — исполнено там же |
 * | `ldd`/`std` по адресу-литералу | рабочий слот читается и пишется (`.tmp/probe-slot.ts`) |
 * | `shrs`, `shls` | `shrs(1000,2) = 250`, `shls(7,3) = 56` (`.tmp/probe-shift.ts`) |
 * | `disp` + `ct` безусловный | передача управления доходит (`.tmp/probe-branch.ts`) |
 * | **условный переход по предикату** | **исполняется**: пример `45-обратный-перебор` своим конвейером даёт 14 = эталон (`.tmp/probe-example-image.ts`) |
 * | пролог образа | `arrayPrologue` даёт `rsz = 7`; `setbn rsz=5` **сужает** область вращаемых регистров и ломает `%b[11]`/`%b[12]` — окно не переставлять (`.tmp/probe-cmp-pred.ts`) |
 *
 * ## ЗАКОН АДРЕСАЦИИ, НАЗВАННЫЙ ЗАМЕРОМ: основание и смещение — РАЗНЫЕ регистры
 *
 * `std [%b[N] + %b[N]]` — **основание и смещение в одном регистре — порт валит исключением** при
 * любом `N`. Это и был дефект, который три захода выглядел как «`%b[12]` ломает, `%b[11]` — нет»
 * (`.tmp/probe-basis-sweep.ts`, `.tmp/probe-basis-split.ts`):
 *
 * | опыт | результат |
 * |---|---|
 * | `std 55, [%b[12] + %b[12]]` | исключение |
 * | `std 55, [%b[13] + %b[13]]` | исключение |
 * | `std 55, [%b[12] + %b[11]]` | статус 0 |
 * | `std 55, [%b[13] + %b[15]]` | статус 0 («55») |
 * | адрес слота ±8 байт при `[%b[12] + %b[12]]` | исключение на том же `IP` |
 *
 * Решает не номер регистра и не величина адреса, а **совпадение**. `movtd` в тот же регистр сам по
 * себе проходит (`std` — единственная команда, которая падает), поэтому «`%b[12]` — это ноль, и его
 * нельзя трогать» было **неверной догадкой**: `%b[12]` — обычный вращаемый регистр, а ноль в нём
 * лишь удобная константа, поставленная прологом.
 *
 * Источник порта (`/root/qemu-src/qemu/target/e2k/reg-index.h:21-53`) говорит, что `%b[N]` считаются
 * **вращением**: `(wd_base_d + rbs_d + (rcur_d + idx) % rsz_full_d) % MAXSR_D`, где
 * `rsz_full_d = (rsz + 1) * 2`; при `rsz = 7` это 16, то есть `%b[0..15]` адресуемы все. Почему
 * совпадение валит порт — в заголовке не сказано: это **замер**, а не вывод из источника, и так и
 * записано.
 *
 * ## Чего в модели НЕТ — СНЯТО, ЭТО БЫЛ ДЕФЕКТ ПРОБЫ (проверено 2026-09-26)
 *
 * В первой редакции этой шапки стояло: «сравнение с предикатом не исполняется, условного перехода в
 * модели нет». **Это неверно, и вывод снят.** Противоречие было видно сразу: 24 программы корпуса с
 * циклами и условиями исполняются на цели, `gate:qemu` зелёный — условный переход там работает.
 *
 * Что было не так: проба вырванного сравнения выходила через свой дамп-хвост, который делал
 * системный вызов **без `setbn`** — окно ломалось, и порт падал утверждением, которое я принял за
 * отказ на сравнении. С исправленной обвязкой (`setbn` перед вызовом, как в «hello») тот же
 * `cmplsb` даёт статус 0 при любой глубине потока перед ним (`.tmp/probe-cmp-context.ts`), а
 * работающий пример `45-обратный-перебор` **своим же конвейером** даёт код возврата 14 = эталон
 * (`.tmp/probe-example-image.ts`). Значит условный переход в модели есть, и ветвиться есть чем.
 *
 * Урок записан в `.tmp/probe-cmp-vs-example.ts`: форма сравнения в рабочем конвейере и в пробе
 * **одна и та же** (`cmplsb`, ALF7, канал 0) — разница была не в команде, а в обвязке вокруг неё.
 *
 * ## Что при этом остаётся верным про развёртку
 *
 * Счёт разрядов сделан **без сравнений** — не потому, что их нет в модели, а потому что это дешевле
 * и короче: девять шагов «больше порога» через знак произведения (`shls(M−v, 3)` + `shrs(…, 31)`)
 * против ветвящегося каскада с девятью парами «сравнение + переход». Если понадобится ветвление в
 * других местах — оно доступно.
 *
 * ## Что осталось (следующему)
 *
 * Печать не доведена, но **причина отказа теперь названа**: в развёртке есть `std`, где основание и
 * смещение сходятся в один регистр (`%b[12]` был и адресом, и «нулём» — см. закон адресации выше).
 * Двухрегистровая схема (`%b[10]`, `%b[11]`; `%b[12]` — только ноль) уже собирается и **не падает**
 * ни на одном из значений 7, 0, 42, 978, −7: `.tmp/probe-print2.ts` даёт статус 0. Осталось
 * досчитать адрес и длину в хвосте: вывод пока пуст, потому что хвост считает их неверно.
 *
 * 1. Довести `writeTail` — при правиле «основание ≠ смещение»; хвост писать по одному шагу с дампом
 *    промежуточных значений, а не правками на ходу (три редакции подряд уже дали кашу).
 * 2. Подключить развёртку к конвейеру. Развёртка едет ОДНИМ носителем `IR.invoke`, а раскладка
 *    считает такой носитель длиной одной команды, — значит переход не имеет права пересекать
 *    печать: сторож для этого написан ({@link printCrossings}), осталось его вызвать.
 * 3. `checkPrintSequence` переписать под прямую развёртку.
 *
 * Приёмка та же: шесть программ `39`–`44` переезжают сменой статусов, `42` (978) делает класс
 * «модель» прямо наблюдаемым.
 *
 * # Зачем отдельный рантайм, а не понижение в одну команду
 *
 * `система.лог.вывести` в регистровом IR — обычный хост-вызов (`IR.invoke`): в регистровом IR
 * строки как значения нет, и семантику несёт **имя** вызова, а не код операции
 * (`src/e2k/emitterShell.ts:255-269`, `src/runtime/vm/invokeRegistry.ts`). Печать на цель
 * выражается не одной командой e2k, а **последовательностью**: разложить число на десятичные
 * разряды, записать их в буфер и отдать буфер ядру системным вызовом `write` — тем же, которым
 * измерен «hello» (`src/e2k/syscallRuntime.ts`, `docs/e2k-minimal-elf.md` §7). Это второй
 * экземпляр шаблона `arrayRuntime.ts`: имя вызова → серия настоящих команд.
 *
 * # Число разрядов: почему развёртка, а не цикл
 *
 * Цикл в этой плоскости упирается в отказ сопоставления предикатов: результат сравнения читают и
 * переход, и арифметика, а предикат у пары «сравнение + переход» один
 * (`src/e2k/predicatePairing.ts`). Поэтому разряды берутся **развёрткой**: ровно десять шагов
 * «делим на 10 — получаем разряд». Переходы в развёртке есть (ветвь знака и счёт разрядов), но они
 * **наши собственные** (`disp`/`ct` с посчитанным смещением) и живут внутри печати: раскладка в них
 * не участвует, а каждое сравнение читает ровно один переход — ровно так, как требует сопоставление.
 *
 * # Три регистра и ни одной ячейки «на потом»
 *
 * | регистр | что держит |
 * |---|---|
 * | `%b[10]` | значение: делимое, затем частное |
 * | `%b[11]` | произведение `v*10`, затем код цифры; в счёте длины — счётчик разрядов |
 * | `%b[12]` | постоянная 10, адрес записи и знак длины; **читается** как ноль рантайма массивов |
 *
 * Состояние рантайма массивов (`%b[13]` — единица, `%b[14]` — восемь, `%b[15]` — указатель кучи) не
 * трогается: оно живёт через всю программу и восстанавливается прологом образа один раз. Измерено
 * (`.tmp/syscall-keep.ts`), что системный вызов регистры сохраняет, — на этом стоит чтение `%b[12]`
 * после `write`.
 *
 * # Минус — это ещё один разряд
 *
 * Разряд `i` (считая от младшего) лежит в слоте `MAX_DIGITS - 1 - i`, а знак — в слоте **над**
 * старшим разрядом. Выводом становится отрезок `[знак?][разряды]`, поэтому при `d` разрядах
 *
 * * без минуса: `8 * d` байт от `buffer + 8 * (MAX_DIGITS - d)`;
 * * с минусом: те же `8 * (d + 1)` байт от того же адреса минус восемь.
 *
 * Отсюда: ведущие нули гасятся **адресом**, а не предикатной записью, и блок разрядов один на оба
 * знака.
 *
 * # Пять решений, каждое с причиной
 *
 * | решение | почему так, а не иначе |
 * |---|---|
 * | цифра — из `v*10 − (v*10/10)*10` | формы `IR.rem` нет (`src/e2k/e2kRealRun.ts:283`); умножение на 10 даёт и цифру, и делимое |
 * | код цифры — `adds …, 48` | ASCII-сдвиг одной командой, без таблицы |
 * | буфер — 8 байт на разряд | `std` пишет слово; по байту его пришлось бы вынимать арифметикой |
 * | длина — счёт сравнениями в регистре | девять вычитаний из десяти стоят одного `movts` на порог |
 * | окно — `setbn rsz=5` НЕ ставится | он **сужает** область вращаемых регистров с 16 единиц до 12, и `%b[11]`/`%b[12]` перестают адресоваться (`.tmp/probe-cmp-pred.ts`); пролога образа (`rsz = 7`) хватает |
 *
 * # Границы, названные, а не скрытые
 *
 * - **Только целое.** У аргумента другой формы (вещественное, строка, логическое, `пусто`) формы
 *   нет — отказ с причиной, а не печать чего попало.
 * - **Диапазон 32-битного знакового**: `sdivs` — 32/32→32.
 * - **Раскладка не знает размера печати.** Развёртка едет ОДНИМ носителем (`IR.invoke`), а
 *   двухпроходная раскладка считает такой носитель длиной одной команды. Значит **переход не имеет
 *   права пересекать печать**: смещение такого перехода посчиталось бы по неверной длине. Это
 *   проверяется ({@link printCrossings}), а не предполагается. В корпусе таких программ нет:
 *   печать там последний оператор.
 * - **Один вызов — одна развёртка**: десять вызовов дадут десять развёрток. Общая подпрограмма
 *   требует соглашения о вызове, которого в e2k-бэкенде ещё нет.
 * - **Своё `exit` развёртка не делает**: программу завершает общая последовательность выхода
 *   (`src/e2k/programImage.ts`), поэтому печатать после печати законно.
 *
 * # Что проверено прогоном в модели
 *
 * `src/e2k/printRuntime.test.ts` — различающие опыты на числах 7, 0, 42, −7, 978; корпус — в
 * `src/scripts/examplesE2k.audit.test.ts`. Что так поведёт себя железо, это не доказывает:
 * QEMU — модель.
 */

import { getEncoder, type AsmInstruction, type Operand } from './backend';
import { MINIMAL_BASE, spillBaseOf, SYSCALL_WBS } from './elfMinimal';
import { SYS_WRITE, STDOUT_FD, WINDOW_NUMBER_REGISTER } from './syscallRuntime';
import { ARRAY_REGISTERS } from './arrayRuntime';
import { CTCOND_NEG_PRED, CTCOND_PRED, PREDICATE_FOR_PAIRS } from './predicatePairing';

const reg = (index: number): Operand => ({ kind: 'reg', index });
const imm = (value: number): Operand => ({ kind: 'imm', value });
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Имя вызова, который умеет заменять этот рантайм. */
export const SUPPORTED_PRINT_CALLS: readonly string[] = ['система.лог.вывести'];

/** Десятичное основание. */
export const PRINT_BASE = 10;

/** ASCII-код нуля: код цифры — `48 + цифра`. */
export const ASCII_ZERO = 48;

/** ASCII-код минуса. */
export const ASCII_MINUS = 45;

/** Десятичных разрядов в развёртке: `2^31 < 10^10`, поэтому десяти хватает на любое 32-битное. */
export const MAX_DIGITS = 10;

/** Размер короткой формы (`movts`, `adds`, `subs`, `sdivs`, `std`, `disp`, `ct`). */
export const SHORT_FORM_BYTES = 8;

/** Код условия «передать всегда» (`CT_COND_ALWAYS`). */
export const CT_COND_ALWAYS = 0;

/** Код условия «по предикату» — тот же, что у сопоставления пар. */
export const CT_COND_PRED = CTCOND_PRED;

/** Код условия «по инверсному предикату». */
export const CT_COND_NEG_PRED = CTCOND_NEG_PRED;

/**
 * РАБОЧИЕ РЕГИСТРЫ РАЗВЁРТКИ — хвост окна, та же территория, что у рантайма массивов.
 *
 * Раскладка (`src/e2k/regAlloc.ts:104`) их не выдаёт никому, а **состояние** рантайма массивов
 * (`%b[12]` — ноль, `%b[13]` — единица, `%b[14]` — восемь, `%b[15]` — указатель кучи) не трогается:
 * оно живёт через всю программу и восстанавливается прологом образа один раз.
 */
export const PRINT_REGISTERS = {
  /** Значение: делимое, затем частное. */
  value: ARRAY_REGISTERS.scratch,
  /** Произведение, затем код цифры; в счёте длины — счётчик разрядов. */
  accumulator: ARRAY_REGISTERS.scratch2,
  /** Постоянная 10, адрес записи и знак длины. */
  base: 12,
} as const;

/** Ноль рантайма массивов: нулевое смещение адреса и вычитаемое для модуля. */
const ZERO_REGISTER = ARRAY_REGISTERS.zero;

/** Размер одного разряда в буфере: `std` пишет слово, а не байт. */
export const DIGIT_SLOT_BYTES = 8;

/** Слотов в буфере: десять разрядов, знак, счётчик разрядов и рабочий слот значения. */
export const PRINT_SLOTS = MAX_DIGITS + 3;

/** Размер области печати целиком. */
export const PRINT_AREA_BYTES = PRINT_SLOTS * DIGIT_SLOT_BYTES;

/**
 * Область печати при данном адресе кучи — адрес **буфера** (первый слот разрядов).
 *
 * Место выбрано так же, как у области слотов вытеснения ({@link spillBaseOf}): **под указателем
 * кучи** и **над кодом**. Куча растёт вверх, поэтому нижняя область не будет занята никогда, а
 * «в коде» её положить нельзя: запись в страницу кода кончается `QEMU internal SIGSEGV
 * {code=ACCERR}` (измерено, `src/e2k/e2kMemoryQemu.test.ts`).
 */
export function printBufferOf(heapAddress: number): number {
  return spillBaseOf(heapAddress) - PRINT_AREA_BYTES;
}

/** Адрес буфера при куче по конвенции образа (`MINIMAL_BASE + IMAGE_TAIL_OFFSET`). */
export const DEFAULT_PRINT_BUFFER = printBufferOf(MINIMAL_BASE + 0x2000);

/**
 * Адрес первого байта числа при `digits` разрядах — он же адрес, с которого начинается `write`.
 *
 * Слот `MAX_DIGITS - digits` — место старшего разряда; всё, что левее, — не часть числа.
 */
export function sliceAddress(buffer: number, digits: number): number {
  return buffer + (MAX_DIGITS - digits) * DIGIT_SLOT_BYTES;
}

/** Длина вывода в байтах при `digits` разрядах и знаке (или без него). */
export function outputBytesOf(digits: number, negative: boolean): number {
  return (digits + (negative ? 1 : 0)) * DIGIT_SLOT_BYTES;
}

/** Отказ рантайма печати: причина называется, а не замалчивается. */
export class PrintRuntimeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintRuntimeRefusal';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ФОРМЫ КОМАНД
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `movts,0 <литерал>, %b[N]` — короткая форма для 0…15, литеральная (16 байт) для прочих.
 *
 * Отдельной мнемоники пересылки регистр→регистр в таблице МЦСТ **нет**: `movts` несёт и литерал, и
 * регистр (`opcodes/e2k-opc.h:644`, ALF2), а вид операнда говорит, что именно переносится.
 */
const movts = (value: number, destination: number): AsmInstruction => ({
  mnemonic: 'movts',
  channel: 0,
  operands: [imm(value), reg(destination)],
});

/** `movts,0 %b[a], %b[d]` — та же форма, но переносится регистр. */
const movtsReg = (source: number, destination: number): AsmInstruction => ({
  mnemonic: 'movts',
  channel: 0,
  operands: [reg(source), reg(destination)],
});

/** Пересылка в **оконный** регистр (`%rN`): так `write` получает свои аргументы. */
const movtsWindow = (source: number, destination: number): AsmInstruction => ({
  mnemonic: 'movts',
  channel: 0,
  operands: [reg(source), window_(destination)],
});

const addsImm = (src: number, value: number, dst: number): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [reg(src), imm(value), reg(dst)],
});

/** `adds src1, src2, dst` — сложение регистров. */
const adds = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'adds',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

/**
 * `ldd база, смещение, приёмник` — адрес = сумма двух регистров.
 *
 * СНЯТО 2026-09-27: определение не использовалось ни в этом файле, ни вне него (проверено
 * поиском по дереву), а линтер считал его мёртвым. Действующая раскладка литералов живёт в
 * `src/e2k/printPrimitives.ts`, и дублировать её здесь незачем.
 */

const subs = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'subs',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

/** `muls` — младшая половина произведения, длинная форма ALF11. */
const muls = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'muls',
  channel: 0,
  operands: [reg(src1), reg(src2), reg(dst)],
});

/** `sdivs` — целочисленное деление; канал ТОЛЬКО пятый (`opcodes/e2k-opc.h:69`). */
const sdivs = (src1: number, src2: number, dst: number): AsmInstruction => ({
  mnemonic: 'sdivs',
  channel: 5, // измерено: носитель с каналом 0 кодировщик отвергает (`.tmp/idiv-channel.ts`)
  operands: [reg(src1), reg(src2), reg(dst)],
});

/** `std значение, база, смещение` — канал 2 или 5 (`opcodes/e2k-opc.h:969-984`). */
const std = (value: number, src1: number, src2: number): AsmInstruction => ({
  mnemonic: 'std',
  channel: 2,
  operands: [reg(value), reg(src1), reg(src2)],
});

/**
 * СНЯТО 2026-09-27: определение сравнения не использовалось ни в этом файле, ни вне него
 * (проверено поиском по дереву). Условные переходы печати не нужны: развёртка прямая,
 * без циклов, и предикат для пар читается не здесь.
 */

const encoder = getEncoder('e2k');

/**
 * Длина команды в байтах — **по кодировщику**, а не по догадке.
 *
 * Развёртка состоит из команд фиксированной длины, поэтому длину берёт у того, кто будет её
 * кодировать: смещение `disp` считается в восьмибайтных словах, и ошибка здесь — это переход не
 * туда. У `disp` смещение в длину не входит (форма та же, что у `disp` со смещением 0), поэтому
 * длина считается по образцу — это и проверяет оракул. Мнемонику, которой в кодировщике нет, он
 * отвергает сам, с названной причиной.
 */
export function commandBytes(instruction: AsmInstruction): number {
  return encoder.encode(instruction).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// СБОРЩИК: МЕТКИ И ЗАПЛАТКИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сборщик развёртки: команды, метки и **заплатки** переходов.
 *
 * Переходы в развёртке — её собственные (`disp` + `ct`), а не носители `IR.jmp`: цели лежат внутри
 * развёртки, и раскладке про них знать нечего — она считает длину блока, а не переходы внутри него.
 * Смещение встаёт на место, когда длина всего, что между переходом и целью, известна; до этого в
 * команде стоит ноль, а её индекс лежит в списке заплаток.
 */
export class PrintAssembly {
  readonly instructions: AsmInstruction[] = [];
  private readonly patches: { readonly at: number; readonly label: string }[] = [];
  private readonly labels = new Map<string, number>();
  private counter = 0;

  /** Объявить метку: её адрес — место, где она объявлена. */
  label(name: string): string {
    const unique = `${name}#${String(this.counter++)}`;
    this.labels.set(unique, this.instructions.length);
    return unique;
  }

  /**
   * Поставить уже объявленную метку на текущее место.
   *
   * Метка объявляется **до** тела, на которое ссылается переход: переход вперёд должен знать имя
   * раньше, чем тело написано. `mark` закрывает её там, где тело кончилось. Метка, объявленная и не
   * поставленная, указывала бы на саму себя — и `disp` со смещением 0 обратил бы отказ условия в
   * бесконечный цикл (измерено, `.tmp/probe-print-hang.ts`: вывод 0 байт, выход по времени 10 с).
   */
  mark(label: string): void {
    if (!this.labels.has(label)) {
      throw new PrintRuntimeRefusal(`печать: метка «${label}» не объявлена — ставить нечего`);
    }
    this.labels.set(label, this.instructions.length);
  }

  push(...instructions: AsmInstruction[]): void {
    this.instructions.push(...instructions);
  }

  /** Переход: `disp %ctpr1, <смещение>` + `ct` с данным кодом условия. */
  private branch(condition: number, label: string): void {
    this.push({ mnemonic: 'disp', channel: 0, operands: [imm(1), imm(0)] });
    this.push({ mnemonic: 'ct', channel: 0, operands: [imm(1), imm(condition)] });
    this.patches.push({ at: this.instructions.length - 2, label });
  }

  /** Переход всегда. */
  jump(label: string): void {
    this.branch(CT_COND_ALWAYS, label);
  }

  /** Переход по предикату `%pred0`, который положило последнее сравнение. */
  jumpIfTrue(label: string): void {
    this.branch(CT_COND_PRED | PREDICATE_FOR_PAIRS, label);
  }

  /** Переход по инверсному предикату. */
  jumpIfFalse(label: string): void {
    this.branch(CT_COND_NEG_PRED | PREDICATE_FOR_PAIRS, label);
  }

  /** Адреса команд (в байтах) — по кодировщику, тем же правилом, что у раскладки. */
  private addresses(): number[] {
    const out: number[] = [];
    let offset = 0;
    for (const instruction of this.instructions) {
      out.push(offset);
      offset += commandBytes(instruction);
    }
    return out;
  }

  /**
   * Проставить смещения и вернуть готовые команды.
   *
   * Смещение `disp` — в **восьмибайтных словах** и от **самой команды `disp`** до цели
   * (`qemu/target/e2k/tcg/translate-ctp.c:74-75`).
   */
  finish(): AsmInstruction[] {
    const addresses = this.addresses();
    const end =
      addresses.length === 0
        ? 0
        : addresses[addresses.length - 1]! + commandBytes(this.instructions[addresses.length - 1]!);
    for (const patch of this.patches) {
      const target = this.labels.get(patch.label);
      if (target === undefined) {
        throw new PrintRuntimeRefusal(`печать: метка «${patch.label}» не поставлена — смещение перехода взять неоткуда`);
      }
      const from = addresses[patch.at]!;
      const to = target >= addresses.length ? end : addresses[target]!;
      if ((to - from) % SHORT_FORM_BYTES !== 0) {
        throw new PrintRuntimeRefusal(
          `печать: смещение ${String(to - from)} не кратно восьми байтам — disp считает в восьмибайтных словах`,
        );
      }
      const command = this.instructions[patch.at]!;
      this.instructions[patch.at] = {
        ...command,
        operands: [command.operands[0]!, imm((to - from) / SHORT_FORM_BYTES)],
      };
    }
    return this.instructions;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// СБОРКА РАЗВЁРТКИ
// ─────────────────────────────────────────────────────────────────────────────

/** Слот выводной области, где лежит разряд `index` (считая от младшего). */
function digitSlot(buffer: number, index: number): number {
  return buffer + (MAX_DIGITS - 1 - index) * DIGIT_SLOT_BYTES;
}

/** Слот знака: **над** старшим разрядом — он же первый байт вывода для отрицательного числа. */
function signSlot(buffer: number): number {
  return buffer + MAX_DIGITS * DIGIT_SLOT_BYTES;
}

/** Слот счётчика разрядов: **над** слотом знака — в вывод он не попадает никогда. */
function countSlot(buffer: number): number {
  return buffer + (MAX_DIGITS + 1) * DIGIT_SLOT_BYTES;
}

/** Рабочий слот значения: **над** слотом счётчика — тоже вне вывода. */
function workSlot(buffer: number): number {
  return buffer + (MAX_DIGITS + 2) * DIGIT_SLOT_BYTES;
}

/**
 * ЗНАК: модуль в регистр, знак — в слот над старшим разрядом, **без ветвления**.
 *
 * Ветвиться нечем: сравнение модель не исполняет (см. {@link digitCount}). Поэтому знак берётся
 * арифметикой сдвига — тем же приёмом, что и счёт разрядов:
 *
 * | вычисление | что даёт |
 * |---|---|
 * | `shrs(v, 31)` | −1 у отрицательного, 0 у неотрицательного |
 * | `muls(то, 45)` | −45 или 0 |
 * | `adds(то, 45)` | 0 или 45 — **код знака** в слоте |
 * | `+ v * (1 + 2·(−1))` | модуль: у отрицательного `v − 2v = −v` |
 *
 * Модуль: `sign = −1` даёт `muls(v, 1 + 2·sign) = muls(v, −1) = −v`; при `sign = 0` множитель
 * равен единице, и значение не меняется.
 *
 * В неотрицательной ветви в слот знака идёт ноль: он за пределами вывода, лишнего байта `write` не
 * заберёт, а адрес начала числа сдвигается на этот ноль (см. {@link writeTail}).
 */
function signSteps(assembly: PrintAssembly, buffer: number, argument: number): void {
  const { value, accumulator, base } = PRINT_REGISTERS;
  const slot = signSlot(buffer);
  assembly.push(
    // Значение — в рабочий регистр: исходный регистр остаётся цел.
    movtsReg(argument, value),
    // `%b[11]` ← −1 (отрицательное) или 0: сдвиг на 31 оставляет знаковый бит.
    { mnemonic: 'shrs', channel: 0, operands: [reg(value), imm(31), reg(accumulator)] },
    // `%b[12]` ← код знака: `muls(shrs, 45) + 45` = 0 или 45.
    movts(ASCII_MINUS, base),
    muls(accumulator, base, base),
    addsImm(base, ASCII_MINUS, base),
    // Знак — в слот (адрес литералом в `%b[11]`, смещение — ноль рантайма массивов).
    movts(slot, accumulator),
    std(base, accumulator, ZERO_REGISTER),
    // Модуль: `muls(v, 1 + 2·sign)`.
    adds(accumulator, accumulator, accumulator), // 2·sign
    addsImm(accumulator, 1, accumulator), // 1 + 2·sign
    muls(value, accumulator, value), // v · (1 + 2·sign) — модуль
  );
}

/**
 * ДЕСЯТЬ РАЗРЯДОВ РАЗВЁРТКОЙ — без циклов и без вызова остатка.
 *
 * Значение живёт в регистре и на каждом шаге заменяется частным; память нужна только под сами
 * разряды. Цифра вынимается из произведения ДО того, как делимое понадобится снова:
 *
 * | шаг | команда | что получается |
 * |---|---|---|
 * | 1 | `muls %b[10], %b[11], %b[11]` | `v * 10` (произведение — в `%b[11]`) |
 * | 2 | `movts 10, %b[12]`, `sdivs %b[11], %b[12], %b[10]` | частное `= (v*10)/10` — в `%b[10]` |
 * | 3 | `movts 10, %b[12]`, `muls %b[10], %b[12], %b[10]` | `q * 10` |
 * | 4 | `subs %b[11], %b[10], %b[11]` | `v*10 − q*10` — цифра, умноженная на десять |
 * | 5 | `adds %b[11], 48`, `movts <слот>, %b[12]`, `std %b[11], %b[10], ноль` | код цифры в своём слоте |
 *
 * Ключ к шагу 2: делимое — это `v*10`, а не `v`. Деление на десять возвращает исходное значение, а
 * разность `v*10 − q*10` даёт цифру **без обращения к остатку** (формы `IR.rem` нет). Для
 * отрицательного входа то же самое: `v*10` и `q*10` сходятся к одной цифре, а знак берёт на себя
 * слот знака.
 */
/**
 * ДЕСЯТЬ РАЗРЯДОВ: ЗНАЧЕНИЕ ЖИВЁТ В ПАМЯТИ, регистры держат делимое и делитель разом.
 *
 * Рабочих регистров два (`%b[10]`, `%b[11]`), а шагу деления нужны **три** величины: делимое,
 * делитель и произведение. Держать значение в регистре при этом нельзя — оно и есть делимое.
 * Поэтому значение живёт в слоте памяти, а регистры на каждом шаге заняты только текущими двумя:
 *
 * | шаг | команда | что получается |
 * |---|---|---|
 * | 1 | `movts <слот>, %b[10]`, `ldd %b[10], ноль, %b[10]` | делимое `v` в `%b[10]` |
 * | 2 | `movts 10, %b[11]`, `sdivs %b[10], %b[11], %b[10]` | частное `q` — на месте делимого |
 * | 3 | `movts <слот>, %b[11]`, `std %b[10], %b[11], ноль` | `q` — в слот, для следующего шага |
 * | 4 | `movts 10, %b[11]`, `muls %b[10], %b[11], %b[11]` | `q * 10` |
 * | 5 | `subs %b[11], %b[10], %b[11]`, `adds %b[11], 48` | `v − q*10` — код цифры |
 * | 6 | `movts <слот разряда>, %b[10]`, `std %b[11], %b[10], ноль` | цифра в выводной области |
 *
 * Так `%b[10]` после шага 2 держит `q` — и оно же нужно шагу 5 как вычитаемое. Именно на этом
 * ломалась предыдущая редакция: делимое считалось как `v*10`, и произведение затирало значение
 * раньше, чем из него вычиталось (измерено, `.tmp/probe-print-hang.ts`, исключение ровно на
 * `subs` четвёртого разряда).
 */
function digitSteps(assembly: PrintAssembly, buffer: number, work: number): void {
  const { value, accumulator } = PRINT_REGISTERS;
  // `%b[12]` — НОЛЬ на всё время цикла: и `ldd`, и `std` адресуют по сумме двух регистров, и вторым
  // слагаемым обязан быть ноль. Поэтому делитель идёт в `%b[11]`, а не в `%b[12]`.
  for (let index = 0; index < MAX_DIGITS; index++) {
    assembly.push(
      movts(work, value),
      { mnemonic: 'ldd', channel: 0, operands: [reg(value), reg(ZERO_REGISTER), reg(value)] },
      movts(PRINT_BASE, accumulator),
      sdivs(value, accumulator, value),
      movts(work, accumulator),
      std(value, accumulator, ZERO_REGISTER),
      movts(PRINT_BASE, accumulator),
      muls(value, accumulator, accumulator),
      subs(accumulator, value, accumulator),
      addsImm(accumulator, ASCII_ZERO, accumulator),
      movts(digitSlot(buffer, index), value),
      std(accumulator, value, ZERO_REGISTER),
    );
  }
}

/**
 * СЧЁТ РАЗРЯДОВ — ПРЯМО, БЕЗ ВЕТВЛЕНИЙ: девять проверок через знак произведения.
 *
 * # Почему без ветвлений, хотя ветвление в модели ЕСТЬ
 *
 * Не потому, что условного перехода нет (он есть — см. шапку модуля: это был дефект пробы),
 * а потому что прямой счёт **короче и дешевле**: девять проверок — это 45 команд подряд, тогда как
 * ветвящийся каскад — девять пар «сравнение + переход» плюс девять ветвей с константами длины и
 * адреса. Заодно развёртка остаётся прямой, и раскладке не приходится считать переходы внутри неё.
 *
 * # Как проверяется «значение больше порога» без сравнения
 *
 * `muls`/`subs` дают **знак** разности, и этим знаком порог проверяется арифметикой:
 *
 * | вычисление | что даёт |
 * |---|---|
 * | `subs(M, v)` | `M − v` |
 * | `shls(то, 3)` | `8·(M − v)`: знак тот же, а переполнения нет, пока `\|M − v\| < 2^28` |
 * | `shrs(то, 31)` | 1, если `v > M`, иначе 0 |
 * | `adds(count, то, count)` | счёт разрядов |
 *
 * Пороги — `10^(d−1)` для `d = 10…2`; счёт начинается с единицы, поэтому ноль даёт «1» — ровно то,
 * что нужно примеру `40-печать-нуля` с эталоном «0». Степени десятки кладутся в регистр
 * **литералом** (`movts`), а не в операнде: литерал в операнде кодировщик отвергает.
 */
function digitCount(assembly: PrintAssembly, buffer: number): void {
  const { value, accumulator, base } = PRINT_REGISTERS;
  // `%b[11]` ← счётчик разрядов (начинаем с единицы: ноль — это один разряд).
  assembly.push(movts(1, accumulator));
  for (let digits = MAX_DIGITS; digits >= 2; digits--) {
    const threshold = PRINT_BASE ** (digits - 1);
    assembly.push(
      movts(threshold, base), // порог — литералом в `%b[12]`
      subs(base, value, base), // `M − v`
      { mnemonic: 'shls', channel: 0, operands: [reg(base), imm(3), reg(base)] }, // × 8
      { mnemonic: 'shrs', channel: 0, operands: [reg(base), imm(31), reg(base)] }, // знак → 0 или 1
      adds(accumulator, base, accumulator), // в счёт
    );
  }
  // Счёт уезжает в память: оба рабочих регистра нужны хвосту (знак и адрес), а после счёта они
  // свободны. Слот счётчика лежит **над** слотом знака, поэтому в вывод не попадает никогда.
  assembly.push(movts(countSlot(buffer), base), std(accumulator, base, ZERO_REGISTER));
}

/**
 * ХВОСТ РАЗВЁРТКИ: адрес и длина из числа разрядов и знака, затем `write`.
 *
 * Вывод строится «от слота знака налево»: слот знака лежит НАД старшим разрядом, поэтому
 *
 * * адрес вывода — `buffer + 8 * (MAX_DIGITS - разряды)`, а знак, если он есть, стоит на байт
 *   левее — и тогда адрес на байт меньше;
 * * длина — `8 * разрядов` плюс байт знака.
 *
 * Знак берётся из памяти и приводится к 0/1 сдвигом: код минуса 45 при сдвиге на три даёт 5, а
 * `subs(5, 5)` от него — ноль; у неотрицательного числа в слоте ноль, и там всё остаётся нулём.
 * Так обе величины считаются **прямо**, без единого перехода — так же, как счёт разрядов.
 */
function writeTail(assembly: PrintAssembly, buffer: number): void {
  const { value, accumulator, base } = PRINT_REGISTERS;
  assembly.push(
    // `%b[12]` ← разряды (из памяти: регистр под них занят).
    movts(countSlot(buffer), base),
    { mnemonic: 'ldd', channel: 0, operands: [reg(base), reg(ZERO_REGISTER), reg(base)] },
    // `%b[11]` ← `MAX_DIGITS − разряды` — сколько слотов ПРОПУСТИТЬ (ведущие нули).
    movts(MAX_DIGITS, accumulator),
    subs(accumulator, base, accumulator),
    // `%b[11]` ← то же в байтах, затем адрес: `buffer + 8 * (MAX_DIGITS - разряды)`.
    { mnemonic: 'shls', channel: 0, operands: [reg(accumulator), imm(3), reg(accumulator)] },
    movts(buffer, value),
    adds(value, accumulator, value),
    // Знак: из памяти, сдвиг на три и вычитание — 0 у неотрицательного, 8 у минуса.
    movts(signSlot(buffer), accumulator),
    { mnemonic: 'ldd', channel: 0, operands: [reg(accumulator), reg(ZERO_REGISTER), reg(accumulator)] },
    { mnemonic: 'shrs', channel: 0, operands: [reg(accumulator), imm(3), reg(accumulator)] },
    subs(accumulator, accumulator, accumulator),
    subs(value, accumulator, value),
    // `%b[12]` ← длина в байтах: `8 * разряды + 8 * знак`. Разряды берём снова из памяти: `%b[12]`
    // к этому месту уже занят знаком.
    movts(countSlot(buffer), base),
    { mnemonic: 'ldd', channel: 0, operands: [reg(base), reg(ZERO_REGISTER), reg(base)] },
    { mnemonic: 'shls', channel: 0, operands: [reg(base), imm(3), reg(base)] },
    adds(base, accumulator, base),
    movtsReg(base, accumulator),
    // `write(fd, buf, count)` — формы те же, что у «hello» (`src/e2k/syscallRuntime.ts`).
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_WRITE), window_(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(STDOUT_FD), window_(WINDOW_NUMBER_REGISTER + 1)] },
    movtsWindow(value, WINDOW_NUMBER_REGISTER + 2),
    movtsWindow(accumulator, WINDOW_NUMBER_REGISTER + 3),
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(0)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
  );
}

/**
 * Развернуть печать числа в команды e2k.
 *
 * @param argument физический регистр значения (его выдала раскладка)
 * @param heapAddress адрес кучи образа — от него считается область печати
 * @param _negative известно ли **на сборке**, что число отрицательное: знак решает сама развёртка,
 *   а этот параметр нужен оракулу — им проверяются обе ветви длины. В теле не читается намеренно,
 *   поэтому имя с подчёркиванием: контракт для вызывающих сохранён, а линтер не считает его мёртвым.
 */
export function printSequence(argument: number, heapAddress: number, _negative = false): AsmInstruction[] {
  const { value, accumulator, base } = PRINT_REGISTERS;
  if (argument === value || argument === accumulator || argument === base) {
    throw new PrintRuntimeRefusal(
      `«система.лог.вывести»: значение в %b[${String(argument)}], а этот регистр занят развёрткой ` +
        `(%b[${String(value)}], %b[${String(accumulator)}], %b[${String(base)}] — src/e2k/printRuntime.ts)`,
    );
  }
  const buffer = printBufferOf(heapAddress);
  const assembly = new PrintAssembly();
  signSteps(assembly, buffer, argument);
  digitSteps(assembly, buffer, workSlot(buffer));
  digitCount(assembly, buffer);
  writeTail(assembly, buffer);
  return assembly.finish();
}

/**
 * ПРОВЕРКА, КОТОРУЮ РАСКЛАДКА СДЕЛАТЬ НЕ МОЖЕТ: ПЕРЕХОД НЕ ПЕРЕСЕКАЕТ ПЕЧАТЬ.
 *
 * Двухпроходная раскладка считает `IR.invoke` длиной одной команды
 * (`src/e2k/twoPassLayout.ts`), а печать разворачивается в сотни байт: смещение перехода,
 * пересекающего печать, посчиталось бы по неверной длине. Такие переходы называются **отказом**,
 * а не чинятся догадкой.
 *
 * @param instructions поток носителей: печатающие `IR.invoke` и переходы с абсолютными целями
 * @returns причины отказа — по одной на переход
 */
export function printCrossings(
  instructions: readonly AsmInstruction[],
  invokeNames: readonly string[],
): string[] {
  const printing: number[] = [];
  instructions.forEach((instruction, index) => {
    if (instruction.mnemonic !== 'IR.invoke') return;
    const payload = instruction.operands[3];
    if (payload === undefined || payload.kind !== 'imm') return;
    const name = invokeNames[payload.value];
    if (name !== undefined && SUPPORTED_PRINT_CALLS.includes(name)) printing.push(index);
  });
  if (printing.length === 0) return [];
  const problems: string[] = [];
  instructions.forEach((instruction, index) => {
    const targetAt = instruction.mnemonic === 'IR.jmp' ? 0 : /^IR\.jmp_if/u.test(instruction.mnemonic) ? 1 : -1;
    if (targetAt < 0) return;
    const target = instruction.operands[targetAt];
    if (target === undefined || target.kind !== 'imm') return;
    for (const print of printing) {
      if ((index < print && target.value > print) || (index > print && target.value < print)) {
        problems.push(
          `#${String(index)} ${instruction.mnemonic} → #${String(target.value)}: переход пересекает печать ` +
            `(#${String(print)}) — её длина в раскладке неизвестна (src/e2k/printRuntime.ts:printCrossings)`,
        );
        break;
      }
    }
  });
  return problems;
}

/**
 * Сторож последовательности — по образцу `checkArraySequence`: проверяет **смысл** шагов, а не их
 * наличие. Он же материал негативного контроля: сними делитель, длину или запись — он покраснеет.
 */
export function checkPrintSequence(instructions: readonly AsmInstruction[]): string[] {
  const problems: string[] = [];
  const kinds = instructions.map((instruction) => instruction.mnemonic);
  const count = (mnemonic: string): number => kinds.filter((kind) => kind === mnemonic).length;
  if (count('sdivs') !== MAX_DIGITS) {
    problems.push(`печать: делений ${String(count('sdivs'))}, а разрядов ${String(MAX_DIGITS)}`);
  }
  if (count('std') < MAX_DIGITS) {
    problems.push(`печать: записей ${String(count('std'))} — нужны все ${String(MAX_DIGITS)} разрядов и знак`);
  }
  if (count('cmplesb') !== 1 + (MAX_DIGITS - 1)) {
    problems.push(
      `печать: сравнений ${String(count('cmplesb'))} — одно на знак и по одному на порог счёта ` +
        `(всего ${String(MAX_DIGITS)})`,
    );
  }
  if (count('call') !== 1) problems.push('печать: вызов ровно один — `write`');
  if (count('ct') < 2) problems.push('печать: переходов нет — ни знак, ни счёт разрядов не разветвлены');
  return problems;
}
