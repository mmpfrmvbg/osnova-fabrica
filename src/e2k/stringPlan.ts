/**
 * СТРОКИ В ОБРАЗЕ: ЧТО ЛЕЖИТ В ПАМЯТИ, ЧТО ЕДЕТ В РЕГИСТРАХ И ЧТО ОТКАЗЫВАЕТ.
 *
 * # Задача этого модуля
 *
 * Превратить поток носителей со строками в поток БЕЗ них: строковый литерал становится адресом
 * статических байтов, `длина` и `объединить` — носителями с числовыми пометками, по которым
 * раскладка (`src/e2k/twoPassLayout.ts`) и понижение считают ОДНИ И ТЕ ЖЕ команды. Разойтись
 * пометке и коду нечем: обе стороны зовут `src/e2k/stringRuntime.ts`.
 *
 * Склейка сверх статического буфера — ИСКЛЮЧЕНИЕ из «без носителей»: она становится носителем
 * `IR.arena_concat`, а расширяет его группа арены (`src/e2k/arenaRuntime.ts#arenaGroups`) — там же
 * проверка предела и блок отказа. Иначе у проверки исчерпания было бы два источника.
 *
 * # Где лежат байты
 *
 * Статическая область — **под площадкой печати**, в том же хвосте образа: площадка занимает
 * `[printArea, printArea + 32)`, а строковые блобы растут ВНИЗ от `printArea`. Поэтому сторож места
 * становится строже ровно на их размер: «код не доходит до статических байтов» вместо «до площадки».
 * Отдельной страницы под строки нет: склейка сверх буфера живёт в арене, а не в образе.
 *
 * # Что известно на сборке, а что в рантайме
 *
 * Строки статические: литерал пришёл из пула, склейка до 20 байт идёт в буфер фиксированного размера,
 * а склейка сверх — в блок, выделенный **ареной** (носитель `IR.arena_concat`). Поэтому на сборке
 * известны и адреса, и длины в байтах, — и `длина` считает кодпоинты КОДОМ по байтам (развёртка,
 * `stringLengthInstructions`), а не подставляет готовое число. Разница принципиальная: подстановка не
 * пережила бы появления памяти, а развёртка переживает — адрес приходит регистром, а не константой.
 */
import type { AsmInstruction, Operand } from './backend';
import { ARRAY_GET_CALL } from './arrayRuntime';
import { DATA_SEGMENT_BASE, spillBaseOf } from './elfMinimal';
import {  STRING_ARENA_CONCAT_CARRIER,
  STRING_BUFFER_BYTES,
  STRING_CALLS,
  STRING_DESCRIPTOR_BYTES,
  STRING_DESCRIPTOR_MARK,
  STRING_NEWLINE,
  STRING_SYMBOL_ENTRY_BYTES,
  STRING_TABLE_BYTES,
  codePointCount,
  codePointsOfBytes,
  concatFitsBuffer,
  continuationTable,
  stringDescriptorBytes,
  symbolTableBytesOf,
  utf8Bytes,
} from './stringRuntime';
import { foldNumericCarrier, isNumericCarrier } from './numberFacts';

const imm = (value: number): Operand => ({ kind: 'imm', value });

/**
 * КЛЮЧ БЛОБА ДЕСКРИПТОРА (TD-0001): `адрес − 16` от байтов значения, отдельным блобом.
 *
 * Отдельный ключ, а не «байты значения плюс шестнадцать»: два блоба по одному адресу — ровно тот
 * дефект, ради которого у таблицы кодов свой ключ (`⟨коды символов⟩` + ключ значения). Длина блоба —
 * {@link STRING_DESCRIPTOR_BYTES}; содержимое дозаполняется ПОСЛЕ раскладки адресов, когда известен
 * адрес таблицы кодов.
 */
export function descriptorKeyOf(valueKey: string): string {
  return `⟨дескриптор строки⟩\u0000${valueKey}`;
}

/**
 * Пометки, которые конвейер кладёт в носитель строковой операции — канал чисел к раскладке.
 *
 * **Шестая, а не пятая**: пятый операнд у печати ЧИСЛА занят числом сохраняемых регистров
 * (`PRINT_SAVE_COUNT_OPERAND`), и если бы строки писали туда же, печать числа с одним сохранённым
 * регистром выглядела бы как печать строки. Это уже случилось: запись `06-циклы-пока` получила отказ
 * «печать строки без длины» (поймал сторож корпуса `src/scripts/examplesE2k.audit.test.ts`).
 *
 * Порядок пометок: `[6] = первая длина, [7] = вторая (или адрес перевода строки), [8] = адрес буфера
 * (или число сохранённых)`. Разбирает их `stringMarksOf`, а по ним ОДНИ команды считают и раскладка
 * (форма), и понижение (байты).
 */
export const STRING_MARK_OPERAND = 6;

/**
 * МАРШРУТ «РАНТАЙМ-СКАН» ЗАКРЫТ ЗАМЕРОМ (2026-11-05, решение владельца) — здесь это записано, чтобы
 * следующий заход не начал его заново.
 *
 * Идея была: содержимое строки-параметра неизвестно сборке, поэтому длину и код символа считает
 * РАНТАЙМОВЫЙ блок (скан байтов до нуля), дописанный в хвост потока. Замер по таблицам форм показал,
 * что блок выразить НЕЧЕМ:
 *  - раскладка размещает ТОЛЬКО носители `IR.*`; голые команды (`movts`, `ldb`, `shrs`) в потоке
 *    разместить нельзя (`carrierFormOf` = false, «не носитель IR»);
 *  - байтовой загрузки среди носителей нет (`IR.load` — это `ldd`, восемь байт), сдвигов и масок нет
 *    вовсе, а байтовый шаг выразим только ВНУТРИ составного носителя;
 *  - составная ветвь строит свои команды сама (`stringRuntime`) и индексов потока не знает, поэтому
 *    ВНУТРЕННИЙ ПЕРЕХОД в ней невыразим, а переходы живут только носителями (`jumpCommands` строит
 *    `disp`+`ct` по смещению, которое считает раскладка).
 * Значит цикл скана потребовал бы нового носителя — то есть правки `src/e2k/twoPassLayout.ts`
 * (запрещена границей задачи) и `src/e2k/e2kRealRun.ts`.
 *
 * ВЗАМЕН: строковость берётся из ТИПА (операция ЗАКОННА), а ЗНАЧЕНИЕ — из ДОКАЗАТЕЛЬСТВА на сборке
 * (значения параметров по сайтам вызовов, нагрузка пары по тегу успеха). Не доказано — НАЗВАННЫЙ отказ.
 */

/**
 * СТРОКОВОСТЬ ИЗ ТИПА — то, чего в носителе нет и что обязан назвать конвейер (шаг 2.3, ATOM-06-02-02а).
 *
 * `procedureOffsets[i]` — индекс первого носителя процедуры `i` в ТОМ ЖЕ потоке, который разбирает
 * `planStrings`. Параметр `k` процедуры — это vreg `k`, закреплённый раскладкой, поэтому после
 * раскладки он живёт в клетке `k`; замер (`.tmp/a230-dump.ts`, HEAD 63bf36cd): у
 * `два(а: Число, с: Строка)` поток после раскладки читает `%b1` там, где в исходнике `с`.
 */
export interface StringTypeFacts {
  readonly procedureOffsets: readonly number[];
  /** Имена процедур — для ЧИТАЕМОСТИ отказа (правило проекта: отказ называет процедуру). */
  readonly procedureNames?: readonly string[];
  /** Клетки-параметры со типом `Строка`, по номеру процедуры. */
  readonly stringParams: readonly (readonly number[])[];
  /**
   * ДОКАЗАННЫЕ значения параметров: клетка → текст значения, по номеру процедуры.
   *
   * «Доказано» — это КАЖДЫЙ прямой вызов процедуры передаёт в этот аргумент одну и ту же строку,
   * известную плану (замер по сайтам вызовов). Нет доказательства — нет подстановки: длины и таблицы
   * кодов у сборки нет, а подставить чужую значило бы соврать числом.
   */
  readonly paramValues?: readonly ReadonlyMap<number, string>[];
  /**
   * МНОЖЕСТВА значений параметра: клетка → ВСЕ значения сайтов, по номеру процедуры (TD-0001).
   *
   * Здесь клетка, у которой КАЖДЫЙ прямой сайт вызова передаёт СВОЮ известную строку, и значения
   * РАЗОШЛИСЬ. Одного значения сборке не хватает, но МНОЖЕСТВА достаточно: длина и таблица кодов
   * приходят из дескриптора перед блобом (`src/e2k/stringRuntime.ts`, `STRING_DESCRIPTOR_MARK`), и
   * специализация на сайт не нужна. Клетка, у которой хоть один сайт неизвестен, сюда НЕ попадает —
   * там множество неполно, и остаётся названный отказ.
   */
  readonly paramChoices?: readonly ReadonlyMap<number, readonly string[]>[];
  /**
   * ЧИСЛОВЫЕ ЗНАЧЕНИЯ ПАРАМЕТРОВ (ATOM-06-02-02, 2026-11-06): клетка → ОДНО число, если так передают
   * ВСЕ её прямые сайты вызова.
   *
   * Зачем отдельным полем, а не `numbersOf`: тот наполняется СВЁРТКОЙ по потоку (`IR.const`, `IR.add`,
   * `IR.sub`), и число, приехавшее ПАРАМЕТРОМ, до свёртки не доходит. Замер (`.tmp/06-02-оракул-до.ts`,
   * пробы П7/П8): срез `подстрока(с, н, к)` в вызываемой отказывал «края среза известны только в
   * рантайме» ДАЖЕ при единственном сайте с литералами (1, 4) — доказательство было, моста к
   * числовому счёту плана не было.
   *
   * МНОЖЕСТВА здесь нет НАМЕРЕННО: у края среза обязано быть ОДНО значение, иначе подстановка была бы
   * выбором одного из многих, то есть догадкой (`1` на одном сайте и `4` на другом — это не «4»).
   */
  readonly paramNumbers?: readonly ReadonlyMap<number, number>[];
  /**
   * ДОКАЗАННЫЕ нагрузки пар `Результат<Строка, …>`: индекс носителя `IR.result_pick` → текст значения.
   * Источник — возвраты с ТЕГОМ УСПЕХА, связанные с вызовом; нагрузочный возврат с другим тегом несёт
   * поле ДРУГОГО типа (`Е`) и в доказательство не входит.
   */
  readonly resultValues?: ReadonlyMap<number, string>;
  // ВРЕМЕННАЯ ДИАГНОСТИЧЕСКАЯ ПРАВКА (замер цены пути (а) случая 76; откатывается `git checkout HEAD --`).
  readonly callValues?: ReadonlyMap<number, string>;
  /**
   * НАЗВАННАЯ ПРИЧИНА по САЙТУ нагрузки пары: индекс носителя `IR.result_pick` → текст.
   *
   * Нужна там, где нагрузка строкой НЕ является или её исход не доказан: `добыть("абв", 0)` отдаёт
   * `Неудача(7)`, и в той же клетке лежит поле ДРУГОГО типа (`Е`). Подставить туда длину успешного
   * возврата значило бы напечатать 1072 вместо отказа — тихая ложь, ровно тот класс, который закрывает
   * случай 73. Отказ обязан назвать, ЧТО именно не доказано, а не «аргумент не строка».
   */
  readonly resultReasons?: ReadonlyMap<number, string>;
  /**
   * ПРОЦЕДУРЫ, У КОТОРЫХ ОБЪЯВЛЕННЫЙ ВОЗВРАТ — `Строка` (ERR-0002, СТРАХОВКА ОТ ЛЖИ).
   *
   * ЭТО ТИП, А НЕ ЗНАЧЕНИЕ: он не даёт ни длины, ни таблицы кодов и потому НЕ разрешает ни одной
   * строковой операции. Он закрывает противоположную дыру — форму, у которой НЕТ ни значения, ни
   * типа. Такова `а + б`, где обе стороны — результаты вызова: `callValues` (случай 76) доказывает
   * результат только у вызова, возвращающего СВОЙ ПАРАМЕТР, поэтому приёмник вызова, возвращающего
   * ЛИТЕРАЛ, оставался клеткой без факта, и склейка уходила в АРИФМЕТИКУ: 0 отказов и печать суммы
   * двух адресов статики (`2228212`) — одиннадцатая тихая ложь проекта (замер: `.tmp/td62-модель.ts`).
   * С этим фактом клетка опознаётся как СТРОКА, и сторож случая 75 обязан НАЗВАТЬ отказ.
   */
  readonly stringReturns?: ReadonlySet<number>;
}

/**
 * Ключ статического блоба СТРОКИ ОТКАЗА АРЕНЫ (`src/e2k/arenaRuntime.ts`).
 *
 * Блоб планируется здесь же, вместе с прочими: его адрес выведен из конца образа (`printArea`),
 * и второй способ его считать разошёлся бы с первым. Строится он только тогда, когда образ
 * пользуется ареной, — у прочих программ статических байтов не прибавляется.
 */
export const ARENA_REFUSAL_BLOB_KEY = '⟨текст отказа арены⟩';

/**
 * Ключ блоба СТРОКИ ОТКАЗА КОЛЛЕКЦИЙ — СВОЙ У КАЖДОЙ ПРИЧИНЫ (случай 34 реестра проверяемости).
 *
 * Причин у коллекций три: граница блока, ёмкость при переезде и ответ `brk`. Строка у каждой своя, и
 * ключ обязан быть своим тоже: один ключ на три текста — это ровно тот дефект, из которого случай 34
 * и вырос (программа с ареной И коллекциями печатала текст арены на отказе коллекции).
 */
export function collectionRefusalBlobKey(at: number): string {
  return `⟨текст отказа коллекций ${String(at)}⟩`;
}

/**
 * ВЕРХ СТАТИЧЕСКОЙ ОБЛАСТИ — где кончаются статические байты (они растут ВНИЗ от него).
 *
 * Здесь только **читаемое**: литералы строк, таблица продолжений, перевод строки, текст отказа.
 * Читать из страницы, где лежит код, можно — поэтому статика и остаётся под кодом, в файле образа.
 * Писать сюда нельзя, и всё, что пишется, живёт в ОБЛАСТИ ЗАПИСИ на своей странице (§3.91):
 * буфер склейки — там же, а не среди блобов.
 *
 * # Почему верх — ГРАНИЦА СЕГМЕНТА ДАННЫХ (2026-10-23, §3.134)
 *
 * Прежняя величина (`0x101ec0` = смещение 7872 от `MINIMAL_BASE`) была **унаследована** от адреса
 * площадки печати до её переезда — и оказалась потолком кода в **7099 байт**: статика растёт вниз от
 * 7872, а код, дошедший до неё, получает названный отказ «код дорос до строк»
 * (`src/e2k/programImage.ts`, сторож статики). В этот потолок НЕ ВЛЕЗАЕТ лексер self-host: его код
 * **7472** байта — и он падает не по своей вине, а потому что два сторожа говорили РАЗНОЕ про одно и
 * то же место:
 *
 * | сторож | что говорит |
 * |---|---|
 * | сторож СТРАНИЦЫ (`programImage.ts`, §3.90.7) | код вправе занимать всё до страницы области записи — это `DATA_SEGMENT_BASE` = смещение `61440` |
 * | сторож СТАТИКИ (там же) | код не имеет права дойти до `7099` — потому что статика приколота к `7872` |
 *
 * Разрыв в **60 КиБ** между этими двумя ответами — и есть стена места. Теперь верх статики — САМА
 * граница сегмента данных, и оба сторожа называют одну и ту же величину: код растёт до статики, а
 * статика упирается в данные. Потолок кода становится `61440 − размер статики` вместо `7099`
 * (у лексера — 60667 вместо 7099: рост в **8.5 раза**).
 *
 * ЦЕНА названа и не замолчана: образ программы со строками стал ДЛИННЕЕ — он тянется до статики, и
 * промежуток между кодом и блобом лежит в файле нулями (у лексера ~60 КиБ вместо ~0.7). Образы БЕЗ
 * статики не меняются вовсе: у них ветка «нет блобов» выходит раньше, поэтому закреплённые числа
 * пяти ядер (458 / 53 / 511, байт образа 6856, FIR 181) этой правкой не двигаются. Убрать и нули
 * (своя `PT_LOAD` под статику) — отдельная работа: она трогает раскладку ELF, а не потолок кода.
 */
export const STATIC_AREA_TOP = DATA_SEGMENT_BASE;

/** Значение строки, как его видит конвейер: байты и их число плюс адрес (появляется при раскладке блobs). */
interface StringValue {  readonly bytes: readonly number[];
  readonly key: string;
  address?: number;
}

/** Что конвейер решил про конкретный носитель. */
type StringEdit =
  | { readonly kind: 'const'; readonly index: number; readonly poolIndex: number; readonly value: StringValue }
  /**
   * СТАТИЧЕСКИЙ СРЕЗ (ATOM-06-02-02): носитель ВЫЗОВА заменяется носителем `IR.const`, грузящим адрес
   * посчитанных сборкой байтов. Отдельный вид, а не `const`, ПОТОМУ ЧТО `const` МЕНЯЕТ ТОЛЬКО ОПЕРАНД:
   * он верен для литерала (у того мнемоника уже `IR.const`), а на вызове оставил бы `IR.invoke` с
   * подменённым операндом — и вызов ушёл бы в рантайм, который его не знает. Замер, которым это
   * поймано: `strings.code[#3]` оставался `IR.invoke` при готовом адресе блоба.
   */
  | { readonly kind: 'slice'; readonly index: number; readonly value: StringValue; readonly destination: number }
  | { readonly kind: 'length'; readonly index: number; readonly value: StringValue; readonly marks: number[] }
  | {
      readonly kind: 'symbol';
      readonly index: number;
      readonly value: StringValue;
      readonly marks: number[];
      /** Ключ блоба таблицы кодов: адрес подставляется ПОСЛЕ раскладки, как у таблицы продолжений. */
      readonly tableKey: string;
      /**
       * НОВОЕ ИМЯ ВЫЗОВА — только у ПОДМЕНЁННОГО носителя (случай 73, П3).
       *
       * Фронтенд выражает любую индексацию `база[и]` МАССИВНЫМ чтением, когда тип базы ему неизвестен.
       * Если база объявлена `Строка`, а значение доказано, верный носитель — строковый, и его имя
       * подставляется здесь; без этого массивное чтение вернуло бы содержимое памяти (0) вместо кода
       * знака. У строкового носителя, пришедшего от фронтенда, поля нет — имя уже верное.
       */
      readonly rename?: number;
    }
  | {
      /**
       * ДЛИНА ПО ДЕСКРИПТОРУ (TD-0001): значение на сборке НЕ известно, известно только МНОЖЕСТВО.
       *
       * Отдельный вид, а не `length` с пустой пометкой: у `length` пометка — ЧИСЛО БАЙТОВ, и её
       * отсутствие обязано остаться признаком дефекта планирования («носитель не несёт длину»).
       * Здесь носитель помечен `STRING_DESCRIPTOR_MARK`, и это единственное, что нужно раскладке:
       * форма последовательности от длины не зависит вовсе (шесть команд).
       */
      readonly kind: 'length_runtime';
      readonly index: number;
      readonly marks: number[];
    }
  | {
      /** КОД СИМВОЛА ПО ДЕСКРИПТОРУ (TD-0001): число кодпоинтов и таблица приходят из памяти. */
      readonly kind: 'symbol_runtime';
      readonly index: number;
      readonly marks: number[];
      /** НОВОЕ ИМЯ ВЫЗОВА — у подменённого носителя (см. `symbol`): без него вернулось бы содержимое памяти. */
      readonly rename?: number;
    }
  | { readonly kind: 'concat'; readonly index: number; readonly first: StringValue; readonly second: StringValue; readonly marks: number[]; readonly payload: number; readonly fromAdd: boolean }
  | {
      readonly kind: 'arena_concat';
      readonly index: number;
      readonly first: StringValue;
      readonly second: StringValue;
      readonly destination: number | undefined;
    }
  | { readonly kind: 'print'; readonly index: number; readonly value: StringValue; readonly marks: number[] }
  | { readonly kind: 'none'; readonly index: number; readonly reason: string };

/** Итог планирования: переписанный поток, расширенный пул, блобы и где они лежат. */
export interface StringPlan {
  readonly code: readonly AsmInstruction[];
  readonly constants: readonly unknown[];
  /** Имена вызовов: к ним добавлена `объединить`, если склейка пришла знаком `+`. */
  readonly invokeNames: readonly string[];
  readonly blobs: readonly { readonly address: number; readonly bytes: readonly number[] }[];
  /** Адрес первого статического байта: код обязан кончиться ДО него. */
  readonly staticStart: number;
  readonly problems: readonly string[];
  /** Сколько строковых операций и печатей строк распознано — для отчёта и оракулов. */
  readonly counts: {
    readonly lengths: number;
    /**
     * Сколько раз спрошен КОД СИМВОЛА (`с[и]` по строке, `система.строка.символ`).
     *
     * Отдельно от `lengths`: у этих операций разные развёртки, и общий счётчик скрыл бы, что образ
     * пользуется таблицей кодов (§3.133).
     */
    readonly symbols: number;
    readonly concats: number;
    readonly prints: number;
    readonly strings: number;
    /**
     * Сколько склеек ушло В АРЕНУ (сумма байтов больше статического буфера).
     *
     * По этому числу конвейер понимает, что образ пользуется ареной, даже если
     * `система.память.выделить` в программе нет (`src/e2k/programImage.ts`): арене нужны пролог,
     * блок отказа и закреплённые регистры — без них выделение взяло бы мусор.
     */
    readonly arenaConcats: number;
    /**
     * СТАТИЧЕСКИЕ СРЕЗЫ (`система.строка.подстрока`, ATOM-06-02-02): сколько срезов сборка посчитала
     * САМА — строка доказана, оба края — константы, и результат лёг статическим блобом.
     *
     * НЕ ПУТАТЬ СО СКЛЕЙКОЙ (`concat`/`arenaConcats`): срез НИЧЕГО не собирает и буфера склейки не
     * требует — его байты суть непрерывный отрезок уже лежащего блоба. Поле необязательное, чтобы
     * счётчик не ломал потребителей, которые собирают `counts` сами.
     */
    readonly slices?: number;
  };
  /**
   * Где лежит строка отказа арены и сколько в ней байт (`undefined` — образ ареной не пользуется).
   *
   * Ставится по запросу конвейера: арена заводится в прологе, и блок отказа обязан знать адрес
   * ДО раскладки — иначе блоб и переход разошлись бы (класс `docs/hardware-debt.md` §3.35).
   */
  readonly arenaRefusal?: { readonly address: number; readonly byteLength: number };
  /**
   * Где лежат СТРОКИ ОТКАЗА КОЛЛЕКЦИЙ — по одной на причину, в ТОМ ЖЕ порядке, в каком их попросили.
   *
   * Порядок — контракт, а не деталь: по нему конвейер сопоставляет блоб причине, и разойдись он —
   * переход вёл бы к чужому тексту (класс §3.35: «соглашение, держащееся совпадением»).
   */
  readonly collectionRefusals?: readonly { readonly address: number; readonly byteLength: number }[];
  /**
   * Адрес СТАТИЧЕСКОГО БУФЕРА СКЛЕЙКИ, если он объявлен (`undefined` — все склейки ушли в арену).
   *
   * Нужен наружу ровно затем, что это **место записи**: буфер лежит среди статических байтов, а
   * писать можно только туда, где нет кода (граница — страница, замер `src/e2k/programImage.ts`).
   */
  readonly bufferAddress?: number;
}

/**
 * СПЛАНИРОВАТЬ СТРОКИ.
 *
 * @param code носители ПОСЛЕ раскладки регистров: значения строк живут в физических регистрах
 * @param constants пул констант модуля (строки — его элементы)
 * @param invokeNames имена вызовов образа оболочки
 * @param heapAddress адрес кучи: от него считается хвост образа
 */
export function planStrings(
  code: readonly AsmInstruction[],
  constants: readonly unknown[],
  invokeNames: readonly string[],
  heapAddress: number,
  /**
   * Строка отказа арены, если образ ею пользуется (`src/e2k/arenaRuntime.ts#ARENA_REFUSAL_TEXT`).
   * Адрес блоба возвращается в {@link StringPlan.arenaRefusal}.
   */
  options: {
    readonly arenaRefusal?: string;
    /**
     * Строки отказа КОЛЛЕКЦИЙ — по одной на причину (`src/e2k/collectionsRuntime.ts`,
     * `COLLECTION_REFUSAL_TEXTS`). Порядок входа = порядок {@link StringPlan.collectionRefusals}.
     */
    readonly collectionRefusals?: readonly string[];
    /**
     * СТРОКОВОСТЬ ИЗ ТИПА (шаг 2.3). Нет фактов — параметр `Строка` в строковой операции остаётся
     * НАЗВАННЫМ отказом, как было: догадка «наверное, строка» тут недопустима, потому что содержимое
     * такой строки на сборке неизвестно и операцию обязан делать рантайм.
     */
    readonly types?: StringTypeFacts;
  } = {},
): StringPlan {
  const names = [...invokeNames];
  const concatPayload = ((): number => {
    const at = names.indexOf(STRING_CALLS.concat);
    return at >= 0 ? at : names.push(STRING_CALLS.concat) - 1;
  })();
  /**
   * ИМЯ СТРОКОВОГО СИМВОЛА — для ПОДМЕНЫ носителя (случай 73, П3): фронтенд выразил индексацию
   * массивным чтением, а верный носитель — строковый. Имя берётся из того же списка, что уходит в
   * образ (`names`), а не подставляется числом: у раскладки и понижения имя — индекс в этом списке.
   */
  const symbolNameIndex = (): number => {
    const at = names.indexOf(STRING_CALLS.symbol);
    return at >= 0 ? at : names.push(STRING_CALLS.symbol) - 1;
  };
  const byRegister = new Map<number, StringValue>();
  /**
   * ЧИСЛА, известные на сборке, по регистрам: только чтобы ОТКАЗАТЬ по имени на константном выходе
   * за границу. Значения кодов из этого не подставляются — выбор всё равно делает рантайм.
   */
  const numbersOf = new Map<number, number>();
  /**
   * ЧИСЛО, ЕСЛИ ОНО ДОКАЗАНО: либо непосредственный операнд, либо регистр со известным значением.
   *
   * Одна точка правды для всех потребителей плана (край среза, константный индекс символа): пока
   * разбор был записан в двух местах, свёртка арифметики могла появиться в одном и пропасть в другом.
   */
  const constantNumber = (operand: Operand | undefined): number | undefined =>
    operand === undefined
      ? undefined
      : operand.kind === 'imm'
        ? operand.value
        : operand.kind === 'reg'
          ? numbersOf.get(operand.index)
          : undefined;
  /**
   * ТИП ГОВОРИТ «СТРОКА» — И ЭТО СНИМАЕТ ОТКАЗ, НО НЕ ДАЁТ ЗНАЧЕНИЯ (шаг 2.3, ATOM-06-02-02а).
   *
   * Прежняя причина отказа («аргумент не строка») для `Строка`-параметра была НЕВЕРНОЙ: строка там
   * есть, её просто нет на сборке. Длина в кодпоинтах и таблица кодов берутся только из ЗНАЧЕНИЯ, а
   * значение доказано сборке лишь тогда, когда конвейер его предъявил (`StringTypeFacts.paramValues` —
   * значения параметров по сайтам вызовов, `resultValues` — нагрузка пары по тегу успеха).
   *
   * Отсюда ДВА разных отказа, и они обязаны различаться: «типа нет вовсе» (как было) и «тип есть,
   * значения нет» — второе НАЗЫВАЕТ причину честно, а не выдаёт отсутствие развёртки за отсутствие типа.
   *
   * Пересев — на границе процедуры: клетка `%b[1]` есть параметр `Строка` в СВОЕЙ процедуре и чужое
   * значение в соседней, переносить факт через границу нельзя (тот же класс, что `kill`, случай 46).
   */
  const typeFacts = options.types;
  const typedRegisters = new Set<number>();
  const typedValues = new Map<number, string>();
  /** МНОЖЕСТВА значений клетки (TD-0001): все сайты известны, значения разные — см. `StringTypeFacts`. */
  const typedChoices = new Map<number, readonly string[]>();
  /** ПРИЧИНА «почему строка не развёрнута» для клетки — когда она НАЗВАНА конвейером (пара). */
  const typedReasons = new Map<number, string>();
  let typedProcedure = 0;
  /**
   * КЛЕТКИ, ЧИСЛО КОТОРЫХ ПОСЕЯНО ИМЕННО ЗДЕСЬ (ATOM-06-02-02).
   *
   * Номер клетки (`%b[1]` и соседние) есть в КАЖДОЙ процедуре, а `numbersOf` границу процедуры не
   * замечает вовсе (его чистит только `kill` по записанной клетке). Поэтому посеянное число обязано
   * умереть на входе в следующую процедуру: иначе число параметра одной процедуры стало бы «числом»
   * ЧУЖОЙ клетки в соседней — молча, то есть тихой ложью. Снимаются ровно СВОИ клетки: чужие записи
   * `numbersOf` (свёртки по потоку) ведут себя как вели, и эта правка их не трогает.
   */
  let seededNumbers: number[] = [];
  const seedTyped = (procedure: number): void => {
    typedRegisters.clear();
    typedValues.clear();
    typedChoices.clear();
    typedReasons.clear();
    for (const register of seededNumbers) numbersOf.delete(register);
    seededNumbers = [];
    if (typeFacts === undefined) return;
    for (const register of typeFacts.stringParams[procedure] ?? []) typedRegisters.add(register);
    for (const [register, value] of typeFacts.paramNumbers?.[procedure] ?? []) {
      numbersOf.set(register, value);
      seededNumbers.push(register);
    }
    for (const [register, text] of typeFacts.paramValues?.[procedure] ?? []) {
      typedRegisters.add(register);
      typedValues.set(register, text);
    }
    for (const [register, texts] of typeFacts.paramChoices?.[procedure] ?? []) {
      // МНОЖЕСТВО — только там, где доказательство значения НЕ состоялось: иначе одна клетка звалась бы
      // и доказанной, и «выбери из списка», и два пути разошлись бы в пользу второго (он дешевле).
      if (texts.length < 2 || typedValues.has(register)) continue;
      typedRegisters.add(register);
      typedChoices.set(register, texts);
    }
  };
  seedTyped(0);
  const nameOfProcedure = (procedure: number): string =>
    typeFacts?.procedureNames?.[procedure] ?? `#${String(procedure)}`;
  const values = new Map<string, StringValue>();
  /** Значения, собранные ареной: статических байтов у них нет и в образ они не кладутся. */
  const arenaValues = new Set<string>();
  const edits = new Map<number, StringEdit>();
  /**
   * ТАБЛИЦЫ КОДОВ СИМВОЛОВ — по одной на ЗНАЧЕНИЕ строки, которую индексируют.
   *
   * Ключ = `⟨коды символов⟩` + ключ значения: у строк «абв» и «abc» байты разные, и таблицы разные.
   * Ключ НЕ равен ключу байтов значения — иначе раскладка положила бы два разных блоба по одному
   * адресу (байты значения совпали бы с таблицей кодов, и рантайм прочитал бы не то).
   */
  const symbolTables = new Map<string, number[]>();
  /**
   * ЗНАЧЕНИЯ, ПЕРЕД БЛОБОМ КОТОРЫХ ЛЕЖИТ ДЕСКРИПТОР (TD-0001): ключ значения.
   *
   * Ставится только теми операциями, у которых значения на сборке НЕТ, а есть множество сайтов. У
   * программ без таких операций множество пусто, и статика не меняется НИ НА БАЙТ — это и держит
   * закреплённые числа, корпус и байты кита.
   */
  const descriptorValues = new Set<string>();
  /** ЗНАЧЕНИЯ, ЧЬЯ ТАБЛИЦА КОДОВ ЕДЕТ В СЛОВО 1 ДЕСКРИПТОРА: без неё `символ` по дескриптору читал бы ноль. */
  const descriptorTables = new Set<string>();
  const problems: string[] = [];
  let lengths = 0;
  /** Сколько длин считается ПО ДЕСКРИПТОРУ: им таблица продолжений не нужна вовсе. */
  let descriptorLengths = 0;
  let symbols = 0;
  let concats = 0;
  let staticConcats = 0;
  let arenaConcats = 0;
  let prints = 0;
  /** СТАТИЧЕСКИЕ СРЕЗЫ (ATOM-06-02-02): считаны сборкой, а не рантаймом. */
  let staticSlices = 0;

  const valueOf = (text: string): StringValue => {
    const existing = values.get(text);
    if (existing !== undefined) return existing;
    const bytes = utf8Bytes(text);
    const created: StringValue = { bytes, key: text };
    values.set(text, created);
    return created;
  };
  const registerOf = (operand: Operand | undefined): StringValue | undefined =>
    operand !== undefined && operand.kind === 'reg' ? byRegister.get(operand.index) : undefined;
  /** ЗНАЧЕНИЕ, ДОКАЗАННОЕ ТИПОМ И ДОКАЗАТЕЛЬСТВОМ: только оно даёт длину и таблицу кодов. */
  const provenValueOf = (operand: Operand | undefined): StringValue | undefined => {
    if (operand === undefined || operand.kind !== 'reg') return undefined;
    const text = typedValues.get(operand.index);
    return text === undefined ? undefined : valueOf(text);
  };
  /** ТИП ЕСТЬ, ЗНАЧЕНИЯ НЕТ — и отказ обязан назвать именно это, а не «аргумент не строка». */
  const typedWithoutValue = (operand: Operand | undefined): boolean =>
    operand !== undefined && operand.kind === 'reg' && typedRegisters.has(operand.index);
  /**
   * МНОЖЕСТВО ЗНАЧЕНИЙ КЛЕТКИ — если оно есть, значение берётся из ДЕСКРИПТОРА перед блобом (TD-0001).
   *
   * Возвращает значения (блобы) ТОЛЬКО когда КАЖДЫЙ сайт передаёт ЛИТЕРАЛ из пула: список пришёл из
   * доказательства, а туда попадают одни записи пула. Значение, собранное в рантайме (склейка в буфере
   * или в арене, нагрузка пары), в этот список не входит — у него нет блоба, а значит нет и дескриптора,
   * и читать `addr − 16` там значило бы читать чужие байты. Вызов `valueOf` для каждого текста ЗАВОДИТ
   * блоб: без него значение не получило бы ни байтов, ни (ниже) дескриптора.
   */
  const choiceValuesOf = (operand: Operand | undefined): readonly StringValue[] | undefined => {
    if (operand === undefined || operand.kind !== 'reg') return undefined;
    const texts = typedChoices.get(operand.index);
    // НУЛЬ-БАЙТ В ТЕКСТЕ — стоп: ключом СКЛЕЙКИ служит `<первый>\u0000<второй>`, и литерал с нулём
    // внутри столкнулся бы с ключом склейки, то есть получил бы адрес буфера вместо своего блоба.
    if (texts === undefined || texts.some((text) => text.includes('\u0000'))) return undefined;
    return texts.map((text) => valueOf(text));
  };
  /**
   * ТЕКСТ ПРИЧИНЫ для клетки: НАЗВАННАЯ конвейером (пара: неудача либо непроверенный тег) — она, иначе
   * общая причина «значение известно не для всех вызовов». Разные причины — разные дефекты, и слить их
   * в одну значило бы потерять, что именно не доказано.
   */
  const reasonOfTyped = (operand: Operand | undefined, procedure: number): string => {
    const named = operand !== undefined && operand.kind === 'reg' ? typedReasons.get(operand.index) : undefined;
    if (named !== undefined) return named;
    return (
      `содержимое строки-параметра известно не для всех вызовов (процедура «${nameOfProcedure(procedure)}») — ` +
      'значение не доказано, содержимое неизвестно: развёртка рантайма не сделана'
    );
  };
  const nameOf = (carrier: AsmInstruction): string | undefined => {
    const payload = carrier.operands[3];
    if (payload === undefined || payload.kind !== 'imm') return undefined;
    return invokeNames[payload.value];
  };
  /**
   * ПРИЁМНИК НОСИТЕЛЯ — регистр, в который он пишет, если вообще пишет.
   *
   * Соглашение оболочки (`src/e2k/emitterShell.ts#lowerInstruction`): у `IR.const`, `IR.move`,
   * арифметики и сравнений приёмник — ПЕРВЫЙ операнд-регистр, а у вызова (`IR.invoke`/`IR.call`) —
   * ПЯТЫЙ и только под флагом «есть приёмник» (бит 0 операнда `flags`); у переходов и `вернуть`
   * приёмника НЕТ — и это не придирка: у `IR.jmp_if`/`IR.jmp_if_not` первый регистровый операнд
   * есть УСЛОВИЕ, и убить его значило бы потерять живую строку.
   */
  const writtenRegisterOf = (carrier: AsmInstruction): number | undefined => {
    if (
      carrier.mnemonic === 'IR.jmp' ||
      carrier.mnemonic === 'IR.jmp_if' ||
      carrier.mnemonic === 'IR.jmp_if_not' ||
      carrier.mnemonic === 'IR.ret'
    )
      return undefined;
    if (carrier.mnemonic === 'IR.invoke' || carrier.mnemonic === 'IR.call') {
      const flags = carrier.operands[0];
      const destination = carrier.operands[4];
      if (flags === undefined || flags.kind !== 'imm' || (flags.value & 1) !== 1) return undefined;
      return destination !== undefined && destination.kind === 'reg' ? destination.index : undefined;
    }
    const first = carrier.operands[0];
    return first !== undefined && first.kind === 'reg' ? first.index : undefined;
  };
  /**
   * ПЕРЕОПРЕДЕЛЕНИЕ РЕГИСТРА (kill, случай 46).
   *
   * Карта `byRegister` — линейная: она держит ПОСЛЕДНЕЕ известное строковое значение регистра. Пока
   * регистры не переиспользуются (поток ДО раскладки — у каждого значения свой номер), этого
   * достаточно. ПОСЛЕ раскладки один и тот же физический регистр несёт разные значения в разное
   * время, и запись ЧИСЛА не стирала старую строку: следующая склейка читала МЁРТВУЮ строку и
   * считала «фантомную конкатенацию» — 25 склеек сверх буфера там, где их нет.
   *
   * Поэтому всякий носитель, записавший в регистр что-то, обязан СНЯТЬ прежнее значение с обоих
   * счетов: и строку (`byRegister`), и число (`numbersOf`, иначе мёртвый литерал дал бы ложный отказ
   * о константном индексе за границей). Носители, которые пишут СТРОКУ, ставят значение ПОСЛЕ этого
   * снятия, — убийство идёт первым, поэтому живые строки (литералы, пересылки, склейки) не страдают.
   */
  const kill = (register: number | undefined): void => {
    if (register === undefined) return;
    byRegister.delete(register);
    numbersOf.delete(register);
    // МНОЖЕСТВО ЗНАЧЕНИЙ УМИРАЕТ ВМЕСТЕ СО ЗНАЧЕНИЕМ (TD-0001). Это не осторожность, а условие
    // верности: по множеству рантайм читает дескриптор по `адрес − 16`, и оставленное у клетки, куда
    // легло ДРУГОЕ число, множество заставило бы читать память по чужому адресу — тихая ложь вместо
    // отказа. Тип (`typedRegisters`) при этом СОХРАНЯЕТСЯ: он-то и назовёт отказ честно.
    typedChoices.delete(register);
  };
  /**
   * ЧИСЛОВОЙ РЕЗУЛЬТАТ СТИРАЕТ СТРОКОВОСТЬ КЛЕТКИ, А НЕ ТОЛЬКО ЗНАЧЕНИЕ (TD-0003, 2026-11-05).
   *
   * `kill` нарочно СОХРАНЯЕТ тип: на сходении путей клетка ДЕЙСТВИТЕЛЬНО держит строку (какую именно —
   * сборка не знает), и тип обязан дожить до строковой операции, чтобы та отказала ПО ИМЕНИ. Но когда
   * носитель ЗАПИСАЛ В КЛЕТКУ ЧИСЛО, в ней лежит число, а не строка, — прежний тип становится ЛОЖЬЮ.
   *
   * Замер, которым это поймано (правка печати недоказанной строки, оракул `src/e2k/stringFactsControlFlow`):
   * в пробе Б1 регистр `reg[2]` нёс литерал «абв» (аргумент вызова), затем в НЕГО ЖЕ легла длина (#11
   * `IR.invoke … reg[2]`), а `byRegister.delete(destination)` у длины снял только значение. Печать
   * (`#12`) взяла `reg[2]` со СТАРЫМ типом «Строка» и отказала на ЧИСЛЕ — ложный отказ там, где прежде
   * печаталось верное число. Ошибка была невидима ровно потому, что до этой правки тип читали только
   * строковые операции, а они у числового результата и так отказывали.
   */
  const killTyped = (register: number | undefined): void => {
    if (register === undefined) return;
    kill(register);
    typedRegisters.delete(register);
    typedValues.delete(register);
    typedReasons.delete(register);
  };
  /**
   * НАЧАЛО ПРОЦЕДУРЫ: тип — в `typedRegisters` (нужен для ЧЕСТНОГО отказа), ДОКАЗАННОЕ ЗНАЧЕНИЕ — в
   * `byRegister` (оно одно даёт длину и таблицу кодов). Значение кладётся тем же путём, что литерал:
   * дальше его несёт ОБЫЧНАЯ пересылка, и отдельного механизма для копии параметра не нужно вовсе.
   */
  const applyTypedProcedure = (procedure: number): void => {
    seedTyped(procedure);
    if (typeFacts === undefined) return;
    for (const [register, text] of typeFacts.paramValues?.[procedure] ?? []) {
      byRegister.set(register, valueOf(text));
    }
  };
  applyTypedProcedure(0);

  /**
   * СХОЖДЕНИЕ ПУТЕЙ: ЗНАЧЕНИЯ, ЗАПИСАННЫЕ ВНУТРИ ВЕТВИ, ЗДЕСЬ УМИРАЮТ (TD-0003).
   *
   * `byRegister` линейна (см. `kill` выше): она держит последнее значение В ПОРЯДКЕ НОСИТЕЛЕЙ, а не в
   * порядке исполнения. В прямолинейной процедуре это одно и то же, но на СХОЖДЕНИИ путей — нет: клетка,
   * которой разные ветви дали РАЗНОЕ значение, получит от линейного прохода значение ТОЙ ветви, чьи
   * носители лежат позже, и чтение после схождения подставит чужие байты. Замер (оракул TD-0003,
   * `src/e2k/stringFactsControlFlow.test.ts`, проба Б5: обе ветви пишут одну клетку, значения разные) —
   * печаталось `х`, то есть значение, записанное ДО ветви: тихая ложь.
   *
   * Здесь это снимается: на ЦЕЛИ перехода убиваются значения всех клеток, записанных между переходом и
   * целью (это ровно тела ветвей, ведущих к цели). ЦЕНА НАЗВАНА: значение, ОДИНАКОВОЕ на всех путях,
   * тоже теряется (проба Б4) — это оставшаяся половина долга, и она не закрывается без счёта значений по
   * путям ЗДЕСЬ, в плане. Отказов это не добавляет: клетка лишь перестаёт считаться доказанной.
   */
  const mergeKills = new Map<number, Set<number>>();
  code.forEach((carrier, index) => {
    if (carrier.mnemonic !== 'IR.jmp' && carrier.mnemonic !== 'IR.jmp_if' && carrier.mnemonic !== 'IR.jmp_if_not') {
      return;
    }
    const operand = carrier.mnemonic === 'IR.jmp' ? carrier.operands[0] : carrier.operands[1];
    const target = operand !== undefined && operand.kind === 'imm' ? operand.value : undefined;
    if (target === undefined || target <= index || target > code.length) return;
    const killed = mergeKills.get(target) ?? new Set<number>();
    for (let at = index + 1; at < target; at += 1) {
      const inner = code[at];
      if (inner === undefined) break;
      const register = writtenRegisterOf(inner);
      if (register !== undefined) killed.add(register);
    }
    if (killed.size > 0) mergeKills.set(target, killed);
  });

  code.forEach((carrier, index) => {
    // ГРАНИЦА ПРОЦЕДУРЫ: факты «строковость из типа» живут ВНУТРИ своей процедуры. Пересев идёт по
    // смещениям процедур того же потока, что разбирается: второй карты смещений не заводится.
    if (typeFacts !== undefined && typeFacts.procedureOffsets.length > 0) {
      while (
        typedProcedure + 1 < typeFacts.procedureOffsets.length &&
        (typeFacts.procedureOffsets[typedProcedure + 1] ?? Number.POSITIVE_INFINITY) <= index
      ) {
        typedProcedure += 1;
        applyTypedProcedure(typedProcedure);
      }
    }
    // СХОЖДЕНИЕ ПУТЕЙ: карта линейна, поэтому здесь умирают значения, записанные ветвями (см. `mergeKills`).
    const mergeKilled = mergeKills.get(index);
    if (mergeKilled !== undefined) for (const cell of mergeKilled) kill(cell);
    // Пул констант: строковый литерал — это строка, всё остальное — числа.
    if (carrier.mnemonic === 'IR.const') {
      const destination = carrier.operands[0];
      const poolIndex = carrier.operands[1];
      if (destination?.kind !== 'reg' || poolIndex?.kind !== 'imm') return;
      const raw = constants[poolIndex.value];
      if (typeof raw !== 'string') {
        // Не строка — значит число: запоминается ТОЛЬКО ради проверки константного индекса
        // (выход за границу обязан быть отказом на СБОРКЕ, когда индекс — литерал).
        // ПРИЁМНИК УМИРАЕТ: в этом регистре могла лежать строка, и число её убивает (случай 46).
        kill(destination.index);
        if (typeof raw === 'number') numbersOf.set(destination.index, raw);
        return;
      }
      numbersOf.delete(destination.index);
      const value = valueOf(raw);
      byRegister.set(destination.index, value);
      edits.set(index, { kind: 'const', index, poolIndex: poolIndex.value, value });
      return;
    }
    // Пересылка: значение строки едет вместе с регистром.
    if (carrier.mnemonic === 'IR.move') {
      const destination = carrier.operands[0];
      const source = carrier.operands[1];
      if (destination?.kind !== 'reg') return;
      const value = registerOf(source);
      if (value === undefined) byRegister.delete(destination.index);
      else byRegister.set(destination.index, value);
      // СТРОКОВОСТЬ ИЗ ТИПА ЕДЕТ ПЕРЕСЫЛКОЙ: `пусть т = с` — та же строка. Значение (`registerOf`
      // выше) уже проехало пересылкой, если оно было ДОКАЗАНО; тип едет отдельно — он нужен, чтобы
      // отказ на недоказанном назвал причину честно, а не «аргумент не строка».
      if (source !== undefined && source.kind === 'reg' && typedRegisters.has(source.index)) {
        typedRegisters.add(destination.index);
        const reason = typedReasons.get(source.index);
        if (reason === undefined) typedReasons.delete(destination.index);
        else typedReasons.set(destination.index, reason);
      } else {
        typedRegisters.delete(destination.index);
        typedReasons.delete(destination.index);
      }
      // МНОЖЕСТВО ЗНАЧЕНИЙ ЕДЕТ ПЕРЕСЫЛКОЙ (TD-0001) — ровно так же, как тип и значение.
      //
      // Это не украшение, а НЕОБХОДИМОЕ звено: фронтенд выражает параметр не самой его клеткой, а
      // КОПИЕЙ (`IR.move b8 b0` — замер потока), и строковая операция берёт аргументом копию. Без
      // переноса множества по пересылке доказательство «сайты передают разные строки» до операции не
      // доезжает, и она отказывает — то есть механизм был бы мёртв ровно там, ради чего заведён.
      const sourceChoices = source !== undefined && source.kind === 'reg' ? typedChoices.get(source.index) : undefined;
      if (sourceChoices === undefined) typedChoices.delete(destination.index);
      else typedChoices.set(destination.index, sourceChoices);
      // Число едет тем же путём — иначе константный индекс, проехавший пересылкой, не опознался бы.
      const number = source !== undefined && source.kind === 'reg' ? numbersOf.get(source.index) : undefined;
      if (number === undefined) numbersOf.delete(destination.index);
      else numbersOf.set(destination.index, number);
      return;
    }
    // НАГРУЗКА ПАРЫ `Результат<Строка, …>`: тип нагрузки взят у ОБЪЯВЛЕННОГО возврата вызываемой
    // (`typeArgs[0]`), а ЗНАЧЕНИЕ — у возвратов с ТЕГОМ УСПЕХА, связанных с этим вызовом. Карту
    // «индекс носителя → текст значения» считает конвейер (`src/e2k/programImage.ts`): здесь нет ни
    // имён процедур, ни их типов, ни тегов возвратов.
    if (carrier.mnemonic === 'IR.result_pick') {
      const destination = writtenRegisterOf(carrier);
      // СНЯТИЕ ЗНАЧЕНИЯ — ОБЩЕЕ ДЛЯ ВСЕХ ВЕТВЕЙ; ТИП СНИМАЕТСЯ ТОЛЬКО ТАМ, ГДЕ ОН НЕ ПОДТВЕРЖДЁН.
      kill(destination);
      const proof = typeFacts?.resultValues?.get(index);
      const reason = typeFacts?.resultReasons?.get(index);
      if (destination !== undefined && proof !== undefined) {
        byRegister.set(destination, valueOf(proof));
        typedRegisters.add(destination);
      } else if (destination !== undefined && reason !== undefined) {
        // ИСХОД ПАРЫ ДОКАЗАН НЕ УСПЕХОМ (или не доказан вовсе): клетка СТРОКОЙ ПО ТИПУ остаётся, но
        // значение подставлять НЕЛЬЗЯ — отказ назовёт причину пары, а не «аргумент не строка».
        typedRegisters.add(destination);
        typedReasons.set(destination, reason);
      } else if (destination !== undefined) {
        // НИ ЗНАЧЕНИЯ, НИ ПРИЧИНЫ — ЧТО ИМЕННО ВЫБРАНО, НЕИЗВЕСТНО, И СТАРЫЙ ТИП ОБЯЗАН УМЕРЕТЬ
        // (2026-11-05). Разбор пары кладёт в приёмник то ТЕГ, то НАГРУЗКУ, и приёмником легко
        // оказывается клетка, в которой РАНЬШЕ лежал строковый ЛИТЕРАЛ (замер П1 оракула
        // `src/e2k/resultStringDepth.test.ts`: `#11 IR.const reg[0] imm(3) imm(2)` = «абв», затем
        // `#16 IR.result_pick reg[0] reg[4]`). `kill` тип СОХРАНЯЕТ — и «Строка» оставалась в силе для
        // ТЕГА, то есть для ЧИСЛА: правка печати недоказанной строки ловила по типу и отказывала на
        // числе. Поймано ШЛЮЗОМ (П1), а не глазом.
        killTyped(destination);
      }
      return;
    }
    // ВОЗВРАТ ИЗ ВЫЗОВА — ДВА СЛУЧАЯ, И ОБА ОБЯЗАНЫ БЫТЬ НАЗВАНЫ ЧЕСТНО (случай 76 + ERR-0002).
    //
    //   • ЗНАЧЕНИЕ доказано (случай 76, возврат-сквозь-параметр) — приёмник получает ЗНАЧЕНИЕ И ТИП;
    //   • ЗНАЧЕНИЯ нет, но объявленный возврат вызываемой — `Строка` (ERR-0002) — приёмник получает
    //     ТОЛЬКО ТИП. Этого мало для подстановки и ДОСТАТОЧНО, чтобы строковая операция отказала по
    //     имени: без этой ветви `а + б` из двух результатов вызова уходила в арифметику и печатала
    //     СУММУ АДРЕСОВ (`2228212`, 0 отказов) — одиннадцатая тихая ложь проекта.
    if (carrier.mnemonic === 'IR.call') {
      const destination = writtenRegisterOf(carrier);
      kill(destination);
      const proof = typeFacts?.callValues?.get(index);
      const callee = carrier.operands[3];
      const returnsString =
        callee !== undefined && callee.kind === 'imm' && (typeFacts?.stringReturns?.has(callee.value) ?? false);
      if (destination !== undefined && proof !== undefined) {
        byRegister.set(destination, valueOf(proof));
        typedRegisters.add(destination);
      } else if (destination !== undefined && returnsString) {
        typedRegisters.add(destination);
      } else if (destination !== undefined) {
        // НИ ЗНАЧЕНИЯ, НИ ОБЪЯВЛЕННОГО ВОЗВРАТА `Строка` — ЗНАЧИТ, В КЛЕТКЕ НЕ СТРОКА.
        //
        // ТРЕТИЙ И ПОСЛЕДНИЙ ИЗ НАЙДЕННЫХ ШЛЮЗОМ СЛУЧАЕВ СТАРОГО ТИПА (2026-11-05, проба П1 оракула
        // `src/e2k/resultStringDepth.test.ts`): `kill` тип СОХРАНЯЕТ, а вызов пишет в приёмник ЧТО УГОДНО
        // (здесь — ПАРУ `Результат<Строка, Ошибка>`). Замер носителями: `#19 IR.move reg[2] reg[0]`
        // (копия литерала «абв», тип ЗАКОННО «Строка»), затем `#24 IR.call … reg[2]` кладёт в ТУ ЖЕ
        // клетку пару — тип оставался, и печать ТЕГА/нагрузки-числа отказывала как печать строки.
        // Тип у пары ставит РАЗБОР ПАРЫ (`IR.result_pick` — с причиной), и на нём же держится отказ
        // `длина нагрузка` по имени причины; вызову тип пары не нужен вовсе.
        killTyped(destination);
      }
      return;
    }
    // НОСИТЕЛЬ СТРОКОЙ НЕ ПРИЗНАН: если он пишет в регистр, лежавшая там строка УМИРАЕТ. Это и есть
    // починка случая 46: без неё арифметика, сравнения и вызовы не стирали прежнее значение, и после
    // раскладки (регистры переиспользуются) карта держала МЁРТВУЮ строку.
    if (carrier.mnemonic !== 'IR.invoke' && carrier.mnemonic !== 'IR.add') {
      // ── СВЁРТКА АРИФМЕТИКИ НАД ИЗВЕСТНЫМИ ЧИСЛАМИ (`IR.sub`, `IR.mul`) ────────────────────────────
      //
      // Замер `.tmp/td62-край-минус.ts`: у `подстрока("абвгде", -2, 6)` край `-2` — не литерал, а
      // `IR.sub reg[3] = reg[4](0) − reg[5](2)`, то есть ВЫЧИСЛЕННЫЙ носитель над двумя константами.
      // Без свёртки ОТРИЦАТЕЛЬНЫЙ край (законный случай языка: отсчёт от конца, эталон
      // `codePointSlice`) отказывал бы на сборке, хотя значение известно ТОЧНО.
      //
      // МЕСТО ВЫБРАНО ЗАМЕРОМ, А НЕ НА ГЛАЗ: первая редакция свёртки стояла ВЫШЕ по обходу, до разбора
      // склейки, и `IR.add` со двумя строками умирал в ней — `+` начинал складывать АДРЕСА, то есть
      // возвращалась одиннадцатая тихая ложь (поймано прогонами: `printPrimitivesQemu`,
      // `stringConcatRuntime` Ф1–Ф9, `booleanLiterals`). Поэтому свёртка живёт ЗДЕСЬ — там, где уже
      // доказано, что носитель не `IR.invoke` и не `IR.add`, то есть строковой операции в нём нет.
      //
      // Арифметика берётся из ОДНОГО места (`src/e2k/numberFacts.ts`): тот же вопрос задаёт рантайм
      // массивов, и две свёртки, разошедшись, ответили бы на одно число по-разному.
      if (isNumericCarrier(carrier.mnemonic)) {
        const left = constantNumber(carrier.operands[1]);
        const right = constantNumber(carrier.operands[2]);
        const куда = writtenRegisterOf(carrier);
        // ПРИЁМНИК УМИРАЕТ: в нём могла лежать строка (случай 46), и число её убивает.
        kill(куда);
        if (куда !== undefined && left !== undefined && right !== undefined) {
          numbersOf.set(куда, foldNumericCarrier(carrier.mnemonic, left, right));
        }
        return;
      }
      kill(writtenRegisterOf(carrier));
      return;
    }
    const name = carrier.mnemonic === 'IR.add' ? STRING_CALLS.concat : nameOf(carrier);
    // ── ПОДМЕНА НОСИТЕЛЯ: МАССИВНОЕ ЧТЕНИЕ → СТРОКОВЫЙ СИМВОЛ (шаг 2.3, случай 73, проба П3) ──────
    //
    // Фронтенд выражает ЛЮБУЮ индексацию `база[и]` массивным чтением, когда тип базы ему НЕ выведен, —
    // а `нагрузка` пары `Результат<Строка, Е>` именно такова: её тип объявлен в ВОЗВРАТЕ процедуры, а
    // не в месте чтения. Массивное чтение вернуло бы содержимое памяти по адресу байтов (замер: 0), и
    // это была бы ТИХАЯ ЛОЖЬ. Поэтому носитель ПОДМЕНЯЕТСЯ на строковый — но ТОЛЬКО когда тип
    // (`typedRegisters`) и ЗНАЧЕНИЕ (`byRegister`, доказанное с тегом успеха) уже предъявлены: иначе
    // подмена была бы догадкой, и отказ ниже назовёт «тип есть, значения нет».
    const arrayBase = carrier.operands[1];
    const stringIndexed =
      carrier.mnemonic === 'IR.invoke' &&
      name === ARRAY_GET_CALL &&
      arrayBase !== undefined &&
      arrayBase.kind === 'reg' &&
      typedRegisters.has(arrayBase.index) &&
      byRegister.has(arrayBase.index);
    const operation = stringIndexed ? STRING_CALLS.symbol : name;
    const rename = stringIndexed ? symbolNameIndex() : undefined;
    // Приёмник — по соглашению оболочки (`writtenRegisterOf`): у `IR.add` это первый регистр,
    // у `IR.invoke` — пятый под флагом «есть приёмник» (там операнд 0 — число).
    const destination = writtenRegisterOf(carrier);
    // СКЛЕЙКА `+` — ТЕМ ЖЕ ПУТЁМ (канон §2.1). Оболочка на `"а" + "б"` выдаёт `IR.add` с двумя
    // строковыми регистрами (измерено, `.tmp/osnova-strings-plus.ts`): типа у носителя нет, и
    // арифметикой он сложил бы АДРЕСА — это и было видно как «2112890». Раз строки известны здесь,
    // здесь и решается, что это склейка: носитель переписывается в вызов `объединить` с пометками.
    const concatLike = carrier.mnemonic === 'IR.add' ? registerOf(carrier.operands[1]) !== undefined && registerOf(carrier.operands[2]) !== undefined : false;
    if (carrier.mnemonic === 'IR.add' && !concatLike) {
      // СКЛЕЙКА, ГДЕ ОДНА СТОРОНА ДОКАЗАНА, А ДРУГАЯ ИЗВЕСТНА ТОЛЬКО В РАНТАЙМЕ (случай 46, шаг 2).
      //
      // `concatLike` требует ОБЕИХ сторон известными: только тогда склейку можно переписать в вызов
      // `объединить` с пометками. Но язык типизирован (`Число + Строка` не компилируется), поэтому
      // если одна сторона — ДОКАЗАННО строка, вторая тоже строка, а её ДЛИНА неизвестна. Арифметика
      // сложила бы здесь АДРЕСА и молча выдала мусор вместо склейки — значит, отказ обязан быть
      // НАЗВАН. Раньше такие места «спасал» только фантом: мёртвая строка в переиспользованном
      // регистре делала вторую сторону «известной», и отказ рождался лишь в потоке ПОСЛЕ раскладки
      // (измерено `.tmp/a504-three-prov.ts`: в потоке ДО раскладки старый план признаёт 0 из 4 склеек
      // пробы `с_токеном`). Kills снял фантом — и отказ переехал сюда, в место, где он обоснован.
      const first = registerOf(carrier.operands[1]);
      const second = registerOf(carrier.operands[2]);
      // ── СЛУЧАЙ 75 (TD-0002): ОБЕ СТОРОНЫ — СТРОКА ПО ТИПУ, НО НИ ОДНО ЗНАЧЕНИЕ НЕ ДОКАЗАНО ────────
      //
      // Прежняя проверка требовала, чтобы ровно ОДНА сторона была доказана, и на `а + б` из двух
      // Строка-параметров МОЛЧАЛА: `concatLike` тоже ложен (обе стороны без значения), поэтому носитель
      // доходил до арифметики и складывал ДВА АДРЕСА. Замер 2026-11-05 (`.tmp/td75-зонд.ts`, ПОСЛЕ
      // TD-0001): `процедура склейка(а: Строка, б: Строка) / вернуть а + б` при сайтах
      // `склейка("абв","где")` и `склейка("аб","вг")` — **0 отказов**, печать `2228206` и `2228188`.
      // Это десятая тихая ложь проекта: программа собирается, число неверное.
      //
      // Почему здесь НАЗВАННЫЙ ОТКАЗ, а не «правильный конкат» (развилка приказа владельца
      // «либо правильный конкат, либо названный отказ»): склейка значений, известных только в
      // рантайме, требует КОПИРОВАНИЯ с рантаймовой длиной, то есть ЦИКЛА с переходом. Переходы у цели
      // существуют ТОЛЬКО как носители, а носители строятся в `src/e2k/twoPassLayout.ts` — это ровно
      // та граница, которую владелец закрыл («VLIW/ABI/раскладку не трогать»). Дескриптор TD-0001
      // здесь не спасает по другой причине: он даёт число КОДПОИНТОВ, а копировать надо БАЙТЫ, и на
      // вопрос «какая из строк пришла» он не отвечает — ответ знает только сайт вызова, а сборка нет.
      // Догадка тут была бы хуже отказа, поэтому отказ называет и операцию, и причину.
      const строкаПоТипу = (operand: Operand | undefined): boolean =>
        operand !== undefined && operand.kind === 'reg' && typedRegisters.has(operand.index);
      const однаИзвестна = (first === undefined) !== (second === undefined);
      const обеСтрокиБезЗначения =
        first === undefined && second === undefined && строкаПоТипу(carrier.operands[1]) && строкаПоТипу(carrier.operands[2]);
      if (однаИзвестна || обеСтрокиБезЗначения) {
        problems.push(
          `#${String(index)} ${STRING_CALLS.concat}: ` +
            (однаИзвестна
              ? 'одна сторона — строка, другая известна только в рантайме — длину брать не от чего'
              : 'обе стороны — Строка по типу, но значения не доказаны — байты и длину брать не от чего'),
        );
        edits.set(index, { kind: 'none', index, reason: 'склейка со значением из рантайма' });
      }
      // Числовое сложение: приёмник — ЧИСЛО, строка в нём (если была) умирает. ЗДЕСЬ ЖЕ СВЁРТЫВАЕТСЯ
      // ДОКАЗАННАЯ СУММА: `подстрока("абвгде", 1 + 1, 4)` приезжает этим носителем (две константы), и
      // без записи числа край среза снова стал бы «рантаймовым» — то есть свёртка обязана быть и в ветви
      // `IR.add`, но ТОЛЬКО после того, как склейка строк исключена (`concatLike` ложен).
      const слева = constantNumber(carrier.operands[1]);
      const справа = constantNumber(carrier.operands[2]);
      kill(destination);
      if (destination !== undefined && слева !== undefined && справа !== undefined) {
        numbersOf.set(destination, foldNumericCarrier('IR.add', слева, справа));
      }
      return;
    }
    if (process.env.TD1_DEBUG === '1') {
      const argument = carrier.operands[1];
      console.error(
        `[TD1] #${String(index)} длина: proc=${String(typedProcedure)}` +
          `(${nameOfProcedure(typedProcedure)}) reg=${String(argument?.kind === 'reg' ? argument.index : -1)}` +
          ` hasValue=${String((registerOf(argument) ?? provenValueOf(argument)) !== undefined)}` +
          ` typed=${String(typedWithoutValue(argument))} values={${[...typedValues.keys()].join(',')}}` +
          ` choices={${[...typedChoices.keys()].join(',')}} params={${(typeFacts?.stringParams[typedProcedure] ?? []).join(',')}}` +
          ` facts={${[...(typeFacts?.paramChoices?.[typedProcedure]?.keys() ?? [])].join(',')}}`,
      );
    }
    if (operation === STRING_CALLS.length) {
      const argument = carrier.operands[1];
      const value = registerOf(argument) ?? provenValueOf(argument);
      if (value === undefined) {
        // МНОЖЕСТВО САЙТОВ — ЗНАЧЕНИЕ ПРИХОДИТ ИЗ ПАМЯТИ (TD-0001). Прежде здесь был только отказ: взять
        // длину было не от чего. Теперь её берут из дескриптора перед блобом, и специализация на сайт
        // не нужна — ровно то, что разрешил владелец 2026-11-05.
        const choices = choiceValuesOf(argument);
        if (choices !== undefined) {
          for (const choice of choices) descriptorValues.add(choice.key);
          killTyped(destination); // результат — ЧИСЛО (тип «Строка» обязан умереть, см. `killTyped`)
          lengths += 1;
          descriptorLengths += 1;
          edits.set(index, { kind: 'length_runtime', index, marks: [STRING_DESCRIPTOR_MARK, 0] });
          return;
        }
        // ДВА РАЗНЫХ ОТКАЗА, и путать их нельзя. Тип `Строка` есть — значит причина не «не строка»,
        // а «значение не доказано сборке»: длину в кодпоинтах взять не от чего, развёртки рантайма
        // нет (маршрут закрыт замером, см. шапку файла). Типа нет — прежняя причина, как была.
        problems.push(
          typedWithoutValue(argument)
            ? `#${String(index)} ${name}: ${reasonOfTyped(argument, typedProcedure)} — ` +
              'длину в кодпоинтах взять не от чего'
            : `#${String(index)} ${name}: аргумент не строка — длину в кодпоинтах взять не от чего`,
        );
        edits.set(index, { kind: 'none', index, reason: 'аргумент не строка' });
        kill(destination);
        return;
      }
      killTyped(destination); // результат — ЧИСЛО (тип «Строка» обязан умереть, см. `killTyped`)
      lengths += 1;
      edits.set(index, { kind: 'length', index, value, marks: [value.bytes.length] });
      return;
    }
    if (operation === STRING_CALLS.symbol) {
      // КОД СИМВОЛА: `с[и]` по строке (§3.133). Значение строки известно здесь — значит известны и
      // коды её кодпоинтов, и таблица кодов кладётся статическим блобом. Индекс при этом остаётся
      // РАНТАЙМОВЫМ: выбирает рантайм.
      const value = registerOf(carrier.operands[1]) ?? provenValueOf(carrier.operands[1]);
      const indexOperand = carrier.operands[2];
      if (value === undefined) {
        // КОД СИМВОЛА ПО ДЕСКРИПТОРУ (TD-0001): число кодпоинтов и адрес таблицы приходят из памяти.
        // Таблица кодов заводится ЗДЕСЬ, на КАЖДОЕ возможное значение: её адрес уезжает в слово 1
        // дескриптора, а дескриптор лежит перед блобом своей строки — то есть у каждого значения своя.
        const choices = choiceValuesOf(carrier.operands[1]);
        if (choices !== undefined) {
          for (const choice of choices) {
            descriptorValues.add(choice.key);
            descriptorTables.add(choice.key);
            const tableKey = `⟨коды символов⟩\u0000${choice.key}`;
            if (!symbolTables.has(tableKey)) symbolTables.set(tableKey, symbolTableBytesOf(choice.bytes));
          }
          killTyped(destination); // результат — ЧИСЛО (тип «Строка» обязан умереть, см. `killTyped`)
          symbols += 1;
          edits.set(index, {
            kind: 'symbol_runtime',
            index,
            marks: [STRING_DESCRIPTOR_MARK, 0],
            ...(rename === undefined ? {} : { rename }),
          });
          return;
        }
        // Тот же разбор причины, что у длины: «тип есть, значения нет» — это НЕ «не строка».
        problems.push(
          typedWithoutValue(carrier.operands[1])
            ? `#${String(index)} ${name}: ${reasonOfTyped(carrier.operands[1], typedProcedure)} — ` +
              'код символа взять не от чего'
            : `#${String(index)} ${name}: аргумент не строка — код символа взять не от чего`,
        );
        edits.set(index, { kind: 'none', index, reason: 'аргумент не строка' });
        kill(destination);
        return;
      }
      const points = codePointsOfBytes(value.bytes);
      // КОНСТАНТНЫЙ ИНДЕКС ЗА ГРАНИЦЕЙ — ОТКАЗ НА СБОРКЕ, а не «-1 в рантайме»: у цели нет
      // исключений, но литерал виден сборке, и молчать там, где ответ известен, незачем.
      const constant =
        indexOperand === undefined
          ? undefined
          : indexOperand.kind === 'imm'
            ? indexOperand.value
            : indexOperand.kind === 'reg'
              ? numbersOf.get(indexOperand.index)
              : undefined;
      if (constant !== undefined && (constant < 0 || constant >= points.length)) {
        problems.push(
          `#${String(index)} ${name}: индекс ${String(constant)} вне длины ${String(points.length)} — ` +
            'выход за границу назван отказом (у цели индекс за концом дал бы −1)',
        );
        edits.set(index, { kind: 'none', index, reason: 'константный индекс за границей' });
        kill(destination);
        return;
      }
      killTyped(destination); // результат — ЧИСЛО (тип «Строка» обязан умереть, см. `killTyped`)
      // Таблица кодов — СВОЙ блоб на каждое ЗНАЧЕНИЕ строки: у двух строк с разными буквами и коды
      // разные. Ключ не совпадает с ключом байтов значения, иначе два блоба слились бы в один адрес.
      const tableKey = `⟨коды символов⟩\u0000${value.key}`;
      if (!symbolTables.has(tableKey)) symbolTables.set(tableKey, symbolTableBytesOf(value.bytes));
      symbols += 1;
      edits.set(index, {
        kind: 'symbol',
        index,
        value,
        marks: [points.length, 0],
        tableKey,
        // ИМЯ НОВОГО НОСИТЕЛЯ — только у ПОДМЕНЁННОГО: у строкового носителя от фронтенда имя уже верное.
        ...(rename === undefined ? {} : { rename }),
      });
      return;
    }
    // ── СРЕЗ СТАТИЧЕСКИЙ (`система.строка.подстрока`, ATOM-06-02-02) ──────────────────────────────
    //
    // Слово v3 `подстрока(строка, начало, конец)` (`src/compiler-v3/parser.ts#СТРОКОВЫЕ_СЛОВА`) до
    // этой правки не понижалось НИ НА КАКОЙ ГЛУБИНЕ: таблица операций рантайма (`src/e2k/
    // arrayRuntime.ts`) отказывает по имени, потому что рантайм-срез обязан КОПИРОВАТЬ с рантаймовой
    // длиной, то есть нужен ЦИКЛ с переходом, а переходы у цели существуют только как носители,
    // строящиеся в `src/e2k/twoPassLayout.ts` (та же граница, что у рантайм-склейки, строки 778–785).
    //
    // ЗДЕСЬ РЕШАЕТСЯ ЧАСТЬ, КОТОРАЯ ЦИКЛА НЕ ТРЕБУЕТ: строка ДОКАЗАНА, оба края — КОНСТАНТЫ, значит
    // результат известен сборке ЦЕЛИКОМ, и его байты — непрерывный отрезок блоба исходной строки.
    // Отдельного вида правки не заводится: значение регистрируется в `values` (его байты положит
    // раскладка блобов, строка 999), адрес даст тот же `kind: 'const'`, что у литерала, а `poolIndex`
    // у среза нет — адрес приходит из `value.address` (поле читается ТОЛЬКО у литерала).
    //
    // СЕМАНТИКА ВЗЯТА У ЭТАЛОНА, а не придумана: `codePointSlice` обеих VM (`src/runtime/vm/
    // stringUnits.ts`) — счёт по КОДОВЫМ ТОЧКАМ, отрицательный край от конца, выход за границы
    // обрезается, `конец <= начало` даёт ПУСТУЮ строку. Пробы ОБ1/ОБ2 оракула это и держат.
    if (name === 'система.строка.подстрока') {
      // ПОЗИЦИИ АРГУМЕНТОВ — НЕ «ПО НОМЕРУ ВЫЗОВА»: у `IR.invoke` раскладка
      // `[флаги, arg0, arg1, payload, приёмник, src3]` (`src/e2k/liveness.ts`, `src/e2k/shell.ts`),
      // где `payload` (операнд 3) — ИНДЕКС ИМЕНИ вызова, а не третий аргумент, и `src3` (операнд 5) —
      // как раз ТРЕТИЙ аргумент. Замер (`.tmp/td62-срез.ts`, `TD62_SLICE=1`): у `подстрока(с, 1, 3)`
      // носитель нёс `[imm 7, reg с, reg 1, imm 0, reg приёмник, reg 3]` — то есть конец лежал в
      // операнде 5, а операнд 3 был именем. Первая редакция читала конец из операнда 3 и получала
      // «конец = 0», то есть срез «ничего» — на этом и поймано.
      const source = registerOf(carrier.operands[1]);
      const from = constantNumber(carrier.operands[2]);
      const to = constantNumber(carrier.operands[5]);
      if (source === undefined || from === undefined || to === undefined) {
        // ОТКАЗ НАЗЫВАЕТ, ЧЕГО ИМЕННО НЕТ: у срезов две РАЗНЫЕ причины, и «аргумент не строка» на
        // них обе неверна (строка тут как раз есть — по типу).
        const почему =
          source === undefined
            ? typedWithoutValue(carrier.operands[1])
              ? `${reasonOfTyped(carrier.operands[1], typedProcedure)} — срез взять не от чего`
              : 'аргумент не строка — срез взять не от чего'
            : 'края среза известны только в рантайме — рантайм-срез не понижен (нужны цикл копирования и арена, §3.138.4)';
        problems.push(`#${String(index)} ${name}: ${почему}`);
        edits.set(index, { kind: 'none', index, reason: 'срез со значением из рантайма' });
        kill(destination);
        return;
      }
      const points = codePointsOfBytes(source.bytes);
      // Те же края, что у эталона (`codePointSlice`), и та же единица счёта — КОДОВЫЕ ТОЧКИ.
      const normal = (raw: number, fallback: number): number => {
        if (Number.isNaN(raw)) return 0;
        if (!Number.isFinite(raw)) return fallback;
        const whole = Math.trunc(raw);
        return whole < 0 ? Math.max(points.length + whole, 0) : Math.min(whole, points.length);
      };
      const start = normal(from, 0);
      const end = normal(to, points.length);
      const text = end <= start ? '' : String.fromCodePoint(...points.slice(start, end));
      const sliced = valueOf(text);
      if (destination === undefined) {
        // ЗНАЧЕНИЕ ПОСЧИТАНО, А ОТДАТЬ ЕГО НЕКУДА: молча выбросить носитель значило бы «срез есть, а
        // результата нет» — отказ, а не тишина.
        problems.push(
          `#${String(index)} ${name}: у среза нет приёмника — результат некуда положить (срез «${text}» посчитан сборкой)`,
        );
        edits.set(index, { kind: 'none', index, reason: 'у среза нет приёмника' });
        return;
      }
      byRegister.set(destination, sliced);
      staticSlices += 1;
      edits.set(index, { kind: 'slice', index, value: sliced, destination });
      return;
    }
    if (name === STRING_CALLS.concat) {
      const first = registerOf(carrier.operands[1]);
      const second = registerOf(carrier.operands[2]);
      if (first === undefined || second === undefined) {
        problems.push(
          `#${String(index)} ${name}: склеивать нечего — ${first === undefined ? 'первый' : 'второй'} аргумент не строка`,
        );
        edits.set(index, { kind: 'none', index, reason: 'аргумент не строка' });
        kill(destination);
        return;
      }
      const joined = values.get(`${first.key}\u0000${second.key}`);
      const result: StringValue =
        joined ?? { bytes: [...first.bytes, ...second.bytes], key: `${first.key}\u0000${second.key}` };
      values.set(result.key, result);
      if (destination !== undefined) byRegister.set(destination, result);
      concats += 1;
      // СКЛЕЙКА СВЕРХ СТАТИЧЕСКОГО БУФЕРА — ЧЕРЕЗ АРЕНУ (решение владельца, 2026-09-29).
      // Не «влезло/не влезло» решает раскладка, а вот это место: длины известны только здесь.
      // Носитель один, а расширяется он группой арены — там же проверка предела и блок отказа.
      if (!concatFitsBuffer(first.bytes.length, second.bytes.length)) {
        arenaConcats += 1;
        arenaValues.add(result.key);
        edits.set(index, { kind: 'arena_concat', index, first, second, destination });
        return;
      }
      staticConcats += 1;
      edits.set(index, {
        kind: 'concat',
        index,
        first,
        second,
        marks: [first.bytes.length, second.bytes.length],
        payload: concatPayload,
        fromAdd: carrier.mnemonic === 'IR.add',
      });
      return;
    }
    // Печать строки: аргумент — строка (у числа аргумент числовой, и сюда он не попадает).
    if (name === 'система.лог.вывести') {
      const argument = carrier.operands[1];
      const value = registerOf(argument);
      if (value === undefined) {
        // ── ПЕЧАТЬ НЕДОКАЗАННОЙ СТРОКИ — НАЗВАННЫЙ ОТКАЗ, А НЕ АДРЕС ЧИСЛОМ (TD-0003, 2026-11-05) ────
        //
        // Здесь стояло `kill(destination); return;` — носитель оставался обычным вызовом печати, и
        // программа, просившая напечатать СТРОКУ, печатала АДРЕС её байтов ЧИСЛОМ при НУЛЕ отказов
        // (замер: Б4/Б5/Б6 оракула `src/e2k/stringFactsControlFlow.test.ts` — `1114110`; В1/В2 оракула
        // `src/e2k/stringCallResultRuntime.test.ts` — то же). Это тихая ложь того же класса, что
        // одиннадцатая (`2228212` суммой адресов), только мягче: чужого ТЕКСТА не печаталось, но
        // печаталось ЧУЖОЕ ЧИСЛО. Правило владельца — «правильная склейка ЛИБО названный отказ» —
        // оставляет здесь ровно отказ.
        //
        // ОТКАЗ — ТОЛЬКО ПРИ ИЗВЕСТНОМ ТИПЕ `Строка`: у числового аргумента значения тоже нет, и
        // отказывать ему значило бы сломать ВСЮ числовую печать. Тип берётся из тех же счетов, что у
        // строковых операций (`typedRegisters` — объявленный/доказанный тип, `typedChoices` — множество
        // сайтов TD-0001), и НАЗЫВАЕТСЯ причина из `typedReasons`, если она записана.
        // Печатать рантаймовую строку нечем: у языка нет печати строки из рантайма (её нет и у цели —
        // длину рантаймовой строки не несёт ABI, TD-0004), поэтому честный ответ — отказ, а не число.
        //
        // ВТОРАЯ ПОПРАВКА, НАЙДЕННАЯ ШЛЮЗОМ (пробы П1/П2 оракула `src/e2k/resultStringDepth.test.ts`):
        // `typedReasons` СТАВИТСЯ РОВНО ПАРЕ, ЧЬЯ НАГРУЗКА — НЕ СТРОКА. Её ставит только `IR.result_pick`
        // (и пересылка переносит), а причина там буквально «поле типа «Е», не «Строка»» или «тег не
        // доказан». Первая редакция правки отказывала и на этих клетках — то есть запрещала печатать
        // ЧИСЛО там, где как раз число и надо (и где прежде печаталось верное число). Поэтому причина
        // пары — исключение: тип «не Строка» отказом «печать строки» не прикрывается.
        const typed =
          argument !== undefined && argument.kind === 'reg' &&
          !typedReasons.has(argument.index) &&
          (typedRegisters.has(argument.index) || typedChoices.has(argument.index));
        if (typed) {
          kill(destination);
          problems.push(
            `#${String(index)} ${name}: печать строки, значение которой не доказано` +
              ` (процедура «${nameOfProcedure(typedProcedure)}») — ` +
              (typedReasons.get(argument.index) ??
                'напечатать текст нечем: печати рантаймовой строки у языка нет (TD-0003, TD-0004)'),
          );
          return;
        }
        kill(destination);
        return;
      }
      prints += 1;
      edits.set(index, { kind: 'print', index, value, marks: [value.bytes.length] });
    }
    // СЮДА ПРИХОДИТ ВЫЗОВ, ЗНАЧЕНИЯ КОТОРОГО СБОРКА НЕ ЗНАЕТ (например, возвращающий строку
    // `подстрока`): если у него есть приёмник, прежнее значение в нём умирает — «не знаю» обязано
    // означать «забыть», а не «помнить прежнее». Иначе после раскладки мёртвая строка ожила бы
    // в переиспользованном регистре (случай 46). Обработчики, признавшие носитель строковым,
    // вышли выше через `return`, — поэтому до этой строки доживают только «не признанные».
    kill(writtenRegisterOf(carrier));
  });

  // ── Раскладка статических блобов: снизу вверх от площадки печати ──────────────────────────────
  // Таблица продолжений нужна только СБОРОЧНОЙ длине: длина по дескриптору байтов не читает вовсе,
  // и объявлять под неё 256 байт значило бы платить за неиспользуемое (у таких программ статика
  // выросла бы на четверть килобайта ни за что).
  const needsTable = lengths > descriptorLengths;
  // Буфер нужен, только если в него кто-то пишет: у склейки сверх статического буфера байты едут в
  // арену, и объявлять под неё статические 20 байт значило бы платить за неиспользуемое.
  const needsBuffer = staticConcats > 0;
  const needsNewline = prints > 0;
  const ordered: {
    readonly key: string;
    readonly bytes: readonly number[];
    readonly align?: number;
    readonly alignStart?: number;
  }[] = [];
  if (needsTable) ordered.push({ key: '⟨таблица продолжений⟩', bytes: continuationTable() });
  /** Байты дескрипторов: тот же массив, что уйдёт в `blobs`, — дозаполняется ПОСЛЕ раскладки адресов. */
  const descriptorBlobs = new Map<string, number[]>();
  for (const value of values.values()) {
    // Буфер склейки — значение того же вида, что литерал: его байты лежат статически.
    // СКЛЕЙКА ЧЕРЕЗ АРЕНУ в образ НЕ кладётся: её байты собираются в выделенном блоке в рантайме,
    // и статическая копия была бы и лишней, и опасной — образ рос бы на всю длину строки.
    if (arenaValues.has(value.key)) continue;
    const described = descriptorValues.has(value.key);
    ordered.push({
      key: value.key,
      bytes: value.bytes,
      // НАЧАЛО БЛОБА — НА ГРАНИЦУ ВОСЬМИ: дескриптор лежит по `адрес − 16` и читается `ldd`, а она
      // требует кратности восьми (§3.133: невыровненное чтение — исключение выравнивания и таймаут).
      // Выравнивание «до вычитания длины» здесь не годится: блоб строки не кратен восьми, и начало
      // уехало бы с границы — поэтому у выравнивания НАЧАЛА своё поле (`alignStart`).
      ...(described ? { alignStart: STRING_SYMBOL_ENTRY_BYTES } : {}),
    });
    if (described) {
      const bytes = new Array<number>(STRING_DESCRIPTOR_BYTES).fill(0);
      descriptorBlobs.set(value.key, bytes);
      ordered.push({ key: descriptorKeyOf(value.key), bytes, align: STRING_SYMBOL_ENTRY_BYTES });
    }
  }
  // БУФЕР СКЛЕЙКИ — НЕ БЛОБ: он лежит в ОБЛАСТИ ЗАПИСИ и объявляется адресом, а не байтами.
  // Прежде он стоял среди статических байтов, то есть на странице, где может быть код, и запись в
  // него падала бы так же, как запись разрядов (замер `docs/hardware-debt.md` §3.90.7). Место —
  // младшие 32 байта блока площадки печати (`[площадка + 32, площадка + 64)`), которые не заняты:
  // разрядник занимает первые 32.
  // ТАБЛИЦЫ КОДОВ СИМВОЛОВ — те же статические байты, что и прочее: их читает рантайм, пишет сборка.
  //
  // ВЫРАВНИВАНИЕ — не украшение, а условие работы: таблицу читает `ldd` (загрузка двойного слова), а
  // она требует кратности восьми. Замер: у программы `"абв"[0]` таблица легла на `0x101F02` — блоб
  // отодвинул курсор на шесть байт строки, — и модель встала (код 206 / утверждение порта), потому
  // что чтение по нечётному адресу даёт исключение выравнивания. Байтовые блобы (`ldb` у длины и
  // склейки) кратности не требуют, поэтому выравнивание объявлено у ОДНОГО вида блоба, а не у всех.
  for (const [key, bytes] of symbolTables) ordered.push({ key, bytes, align: STRING_SYMBOL_ENTRY_BYTES });
  if (needsNewline) ordered.push({ key: '⟨перевод строки⟩', bytes: [STRING_NEWLINE] });
  // СТРОКА ОТКАЗА АРЕНЫ — тем же порядком, что прочие блобы: адрес выведен из конца образа.
  const refusalBytes = options.arenaRefusal === undefined ? undefined : utf8Bytes(options.arenaRefusal);
  if (refusalBytes !== undefined) ordered.push({ key: ARENA_REFUSAL_BLOB_KEY, bytes: refusalBytes });
  // СТРОКИ ОТКАЗА КОЛЛЕКЦИЙ — каждый со СВОИМ ключом: причин три, и текст у каждой свой.
  const collectionRefusalKeys = (options.collectionRefusals ?? []).map((text, at) => {
    const key = collectionRefusalBlobKey(at);
    ordered.push({ key, bytes: utf8Bytes(text) });
    return key;
  });

  // СТАТИКА — ПОД КОДОМ, В ФАЙЛЕ: читать из страницы кода можно, писать — нет. Поэтому якорь
  // статики не связан с кучей: он остаётся там, где был, и размеры образов от переезда области
  // записи НЕ двигаются (§3.91).
  let cursor = STATIC_AREA_TOP;
  const addresses = new Map<string, number>();
  const blobs: { address: number; bytes: readonly number[] }[] = [];
  for (const blob of ordered) {
    // ВЫРАВНИВАНИЕ БЛОБА: курсор опускается до кратности ПЕРЕД вычитанием длины — блоб занимает
    // байты [адрес, адрес + длина), и его НАЧАЛО обязано попасть на границу. У таблицы кодов длина
    // кратна восьми, поэтому этого достаточно; у блоба строки длина любая, и начало выравнивается
    // ВТОРЫМ полем (`alignStart`) — уже ПОСЛЕ вычитания длины. Промежуток между блобами не теряется
    // для читателя: адреса берутся из этой же карты.
    const align = blob.align ?? 1;
    if (align > 1) cursor -= cursor % align;
    cursor -= blob.bytes.length;
    const alignStart = blob.alignStart ?? 1;
    if (alignStart > 1) cursor -= cursor % alignStart;
    addresses.set(blob.key, cursor);
    blobs.push({ address: cursor, bytes: blob.bytes });
  }
  // ── СЛОВА ДЕСКРИПТОРОВ — ПОСЛЕ АДРЕСОВ ──────────────────────────────────────────────────────────
  //
  // Адрес таблицы кодов известен только теперь: она лежит НИЖЕ дескриптора, и её адрес — из этой же
  // карты. Молчаливый ноль здесь был бы порчей, а не отказом: `символ` по дескриптору читал бы память
  // по адресу 0, а `длина` вернула бы 0 вместо числа кодпоинтов. Поэтому несходство адресов — НАЗВАННАЯ
  // причина в `problems`, а инвариант «дескриптор ровно за шестнадцать байт до байтов» проверяется тут
  // же: он и есть договор между раскладкой и рантаймом.
  for (const [key, bytes] of descriptorBlobs) {
    const value = values.get(key);
    const valueAddress = addresses.get(key);
    const descriptorAddress = addresses.get(descriptorKeyOf(key));
    const tableKey = `⟨коды символов⟩\u0000${key}`;
    const tableAddress = descriptorTables.has(key) ? addresses.get(tableKey) : 0;
    if (
      value === undefined ||
      valueAddress === undefined ||
      descriptorAddress === undefined ||
      tableAddress === undefined ||
      descriptorAddress !== valueAddress - STRING_DESCRIPTOR_BYTES
    ) {
      problems.push(
        `#дескриптор значения «${key}»: адреса блоба, дескриптора и таблицы кодов не сошлись ` +
          `(блоб ${String(valueAddress)}, дескриптор ${String(descriptorAddress)}, таблица ${String(tableAddress)}) — ` +
          'дефект планирования строк: значение читалось бы из чужих байтов',
      );
      continue;
    }
    const words = stringDescriptorBytes(codePointsOfBytes(value.bytes).length, tableAddress);
    words.forEach((byte, at) => {
      bytes[at] = byte;
    });
  }
  const bufferAddress = needsBuffer ? spillBaseOf(heapAddress) - STRING_BUFFER_BYTES : undefined;
  // Адрес значения: у литерала — его собственные байты, у статической склейки — буфер (результат
  // живёт там). У склейки ЧЕРЕЗ АРЕНУ адреса нет и быть не может: он появляется в рантайме, и
  // значение живёт в регистре-приёмнике выделения.
  for (const value of values.values()) {
    const isJoined = value.key.includes('\u0000');
    const address = isJoined ? bufferAddress : addresses.get(value.key);
    if (address !== undefined) value.address = address;
  }

  // ── Применение правок: пометки — числовые, ПОСЛЕ раскладки блобов (адреса уже известны) ───────
  const pool = [...constants];
  const tableAddress = addresses.get('⟨таблица продолжений⟩') ?? 0;
  const newlineAddress = addresses.get('⟨перевод строки⟩') ?? 0;
  const rewritten = code.map((carrier, index) => {
    const edit = edits.get(index);
    if (edit === undefined || edit.kind === 'none') return carrier;
    if (edit.kind === 'slice') {
      const address = edit.value.address;
      if (address === undefined) {
        problems.push(
          `#${String(index)} ${carrier.mnemonic}: у среза «${edit.value.key}» не оказалось адреса — дефект планирования`,
        );
        return carrier;
      }
      // АДРЕС — В ПУЛ, КАК У ЛИТЕРАЛА: пул и статическая область работают парой и разойтись не могут
      // (адрес блоба выведен из конца образа, пул — из своей длины). Носитель ЗАМЕНЯЕТСЯ ЦЕЛИКОМ:
      // у среза от вызова не остаётся ничего, и рантайм его больше не увидит.
      pool.push(address);
      return {
        ...carrier,
        // `as const` — не украшение: без него литерал расширяется до `string`, и весь массив носителей
        // перестаёт быть `readonly AsmInstruction[]` (поймано `tsc` в этом же срезе).
        mnemonic: 'IR.const' as const,
        operands: [{ kind: 'reg' as const, index: edit.destination }, imm(pool.length - 1)],
      };
    }
    if (edit.kind === 'const') {
      const address = edit.value.address;
      if (address === undefined) {
        problems.push(`#${String(index)} IR.const: у строки «${edit.value.key}» не оказалось адреса — дефект планирования`);
        return carrier;
      }
      pool.push(address);
      const operands = [...carrier.operands];
      operands[1] = imm(pool.length - 1);
      return { ...carrier, operands };
    }
    const operands = [...carrier.operands];
    if (edit.kind === 'length') {
      operands[STRING_MARK_OPERAND] = imm(edit.marks[0]!);
      operands[STRING_MARK_OPERAND + 1] = imm(tableAddress);
    } else if (edit.kind === 'length_runtime' || edit.kind === 'symbol_runtime') {
      // ДЕСКРИПТОР: обе пометки — ОДНА величина (`−1`) и ноль. Ни длины, ни адреса таблицы у сборки
      // нет, и подставить сюда любое из них значило бы соврать числом; ноль на втором месте — не
      // «адрес ноль», а «второй пометки не нужно»: раскладка читает только первую.
      if (edit.kind === 'symbol_runtime' && edit.rename !== undefined) operands[3] = imm(edit.rename);
      operands[STRING_MARK_OPERAND] = imm(edit.marks[0]!);
      operands[STRING_MARK_OPERAND + 1] = imm(edit.marks[1] ?? 0);
    } else if (edit.kind === 'symbol') {
      // Помечаются ДВЕ величины: сколько кодпоинтов (= размер каждой плоскости таблицы) и где сама
      // таблица. Как и у длины, это ЧИСЛА в операндах: у носителя нет ни типа, ни адреса.
      const table = addresses.get(edit.tableKey);
      if (table === undefined) {
        problems.push(`#${String(index)} ${STRING_CALLS.symbol}: таблица кодов не получила адреса — дефект планирования строк`);
        return carrier;
      }
      // ПОДМЕНА: у носителя, пришедшего от фронтенда массивным чтением, имя вызова меняется на
      // строковое — иначе раскладка и понижение увидят прежнюю операцию и вернут содержимое памяти.
      if (edit.rename !== undefined) operands[3] = imm(edit.rename);
      operands[STRING_MARK_OPERAND] = imm(edit.marks[0]!);
      operands[STRING_MARK_OPERAND + 1] = imm(table);
    } else if (edit.kind === 'arena_concat') {
      // СКЛЕЙКА СВЕРХ СТАТИЧЕСКОГО БУФЕРА: носитель СМЕНЁН, а не помечен. Пометки здесь не годятся:
      // у операции меняется не одна длина, а способ — «выделить блок у арены и скопировать байты».
      // Приёмник — тот же регистр, что был у операции: у `IR.invoke` он четвёртый, у `IR.add` — первый.
      const destination = carrier.mnemonic === 'IR.add' ? carrier.operands[0] : carrier.operands[4];
      if (edit.destination === undefined || destination === undefined || destination.kind !== 'reg') {
        problems.push(
          `#${String(index)} ${STRING_CALLS.concat}: склейка сверх статического буфера без приёмника — ` +
            'арена выделяет блок В ПРИЁМНИК, и положить его некуда',
        );
        return carrier;
      }
      return {
        mnemonic: STRING_ARENA_CONCAT_CARRIER,
        channel: carrier.channel,
        operands: [
          carrier.operands[1]!,
          carrier.operands[2]!,
          destination,
          imm(edit.first.bytes.length),
          imm(edit.second.bytes.length),
        ],
      };
    } else if (edit.kind === 'concat') {
      if (edit.fromAdd) {
        const args = [carrier.operands[1], carrier.operands[2], carrier.operands[0]];
        return {
          mnemonic: 'IR.invoke',
          channel: carrier.channel,
          // Пометки — на СВОИХ местах (6, 7, 8): пятый операнд занят числом сохраняемых
          // регистров у печати числа, и занимать его строки не вправе (см. STRING_MARK_OPERAND).
          operands: [
            imm(5),
            args[0]!,
            args[1]!,
            imm(edit.payload),
            args[2]!,
            imm(0),
            imm(edit.marks[0]!),
            imm(edit.marks[1]!),
            imm(bufferAddress ?? 0),
          ],
        };
      }
      operands[STRING_MARK_OPERAND] = imm(edit.marks[0]!);
      operands[STRING_MARK_OPERAND + 1] = imm(edit.marks[1]!);
      // Буфер объявлен у статической склейки всегда (`needsBuffer` = есть хоть одна такая): ноль
      // здесь означал бы дефект планирования, а не «буфера нет» — и раскладка отказала бы по имени.
      operands[STRING_MARK_OPERAND + 2] = imm(bufferAddress ?? 0);
    } else {
      operands[STRING_MARK_OPERAND] = imm(edit.marks[0]!);
      operands[STRING_MARK_OPERAND + 1] = imm(newlineAddress);
    }
    return { ...carrier, operands };
  });

  const refusalAddress = addresses.get(ARENA_REFUSAL_BLOB_KEY);
  // Блобы коллекций — ПО ТОМУ ЖЕ ПОРЯДКУ, в каком их попросили: сопоставление «причина → адрес»
  // делает вызывающий, и порядок здесь — единственное, чем он может это сделать.
  const collectionRefusals = collectionRefusalKeys.map((key) => {
    const address = addresses.get(key);
    const bytes = ordered.find((blob) => blob.key === key)?.bytes;
    if (address === undefined || bytes === undefined) {
      // Дефект планирования, а не программы: блоб только что положен в `ordered` и обязан быть в карте.
      problems.push(`строка отказа коллекций «${key}» не получила адреса — дефект планирования строк`);
      return undefined;
    }
    return { address, byteLength: bytes.length };
  });
  const collectionBlobs = collectionRefusals.every((blob) => blob !== undefined)
    ? (collectionRefusals as { address: number; byteLength: number }[])
    : undefined;
  return {
    code: rewritten,
    constants: pool,
    invokeNames: names,
    blobs,
    staticStart: cursor,
    problems,
    counts: { lengths, symbols, concats, prints, strings: ordered.length, arenaConcats, slices: staticSlices },
    ...(needsBuffer ? { bufferAddress } : {}),
    ...(refusalAddress === undefined || refusalBytes === undefined
      ? {}
      : { arenaRefusal: { address: refusalAddress, byteLength: refusalBytes.length } }),
    ...(collectionBlobs === undefined || collectionBlobs.length === 0
      ? {}
      : { collectionRefusals: collectionBlobs }),
  };
}

/**
 * Сколько байт занимает статическая область целиком (для сторожа места и отчёта).
 *
 * Считается как ОТРЕЗОК от младшего блоба до старшего, а не как сумма длин: у выровненных блобов
 * между соседями остаётся промежуток (таблица кодов кратна восьми), и сумма длин дала бы буфер
 * короче области — запись статики уехала бы за его конец (`RangeError: offset is out of bounds`).
 * Без промежутков отрезок равен сумме, то есть прежнее число не сдвигается.
 */
export function staticBytesOf(plan: StringPlan): number {
  if (plan.blobs.length === 0) return 0;
  const start = Math.min(...plan.blobs.map((blob) => blob.address));
  const end = Math.max(...plan.blobs.map((blob) => blob.address + blob.bytes.length));
  return end - start;
}

/** Нужны ли образу статические байты вовсе. */
export function hasStaticBytes(plan: StringPlan): boolean {
  return plan.blobs.length > 0;
}

/**
 * Проверка «строка помечена как печатаемая»: у печати числа шестой пометки нет.
 *
 * ПОМЕТКА НОЛЬ — ТОЖЕ ПОМЕТКА (найдено ATOM-06-02-02, 2026-11-05). Прежнее условие `mark.value > 0`
 * считало ПУСТУЮ строку непомеченной, печать уходила по числовому пути — и на модель печатался АДРЕС
 * блоба числом: `вывести ""` давало `1114112`, `вывести подстрока("абвгде", 3, 1)` — `1114100`, при
 * нуле отказов и коде 0. Это тихая ложь (класс «программа исполняется, а число неверное»), и она
 * жила ДО среза: проверено на HEAD теми же пробами. Числовая печать пометки не ставит вовсе —
 * операнд у неё `undefined`, а не ноль, поэтому «ноль» однозначно означает «строка длины ноль».
 */
export function isStringPrint(carrier: AsmInstruction): boolean {
  const mark = carrier.operands[STRING_MARK_OPERAND];
  return carrier.mnemonic === 'IR.invoke' && mark !== undefined && mark.kind === 'imm' && mark.value >= 0;
}

/** Причина отказа строковой операции, если пометок нет, а имя строковое. */
export function stringMarksOf(carrier: AsmInstruction): readonly number[] {
  const marks: number[] = [];
  for (let at = STRING_MARK_OPERAND; at < carrier.operands.length; at++) {
    const operand = carrier.operands[at];
    if (operand === undefined || operand.kind !== 'imm') break;
    marks.push(operand.value);
  }
  return marks;
}

void STRING_TABLE_BYTES;
void codePointCount;
