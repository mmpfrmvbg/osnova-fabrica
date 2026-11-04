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
import { DATA_SEGMENT_BASE, spillBaseOf } from './elfMinimal';
import {  STRING_ARENA_CONCAT_CARRIER,
  STRING_BUFFER_BYTES,
  STRING_CALLS,
  STRING_NEWLINE,
  STRING_SYMBOL_ENTRY_BYTES,
  STRING_TABLE_BYTES,
  codePointCount,
  codePointsOfBytes,
  concatFitsBuffer,
  continuationTable,
  symbolTableBytesOf,
  utf8Bytes,
} from './stringRuntime';

const imm = (value: number): Operand => ({ kind: 'imm', value });

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
  | { readonly kind: 'length'; readonly index: number; readonly value: StringValue; readonly marks: number[] }
  | {
      readonly kind: 'symbol';
      readonly index: number;
      readonly value: StringValue;
      readonly marks: number[];
      /** Ключ блоба таблицы кодов: адрес подставляется ПОСЛЕ раскладки, как у таблицы продолжений. */
      readonly tableKey: string;
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
  } = {},
): StringPlan {
  const names = [...invokeNames];
  const concatPayload = ((): number => {
    const at = names.indexOf(STRING_CALLS.concat);
    return at >= 0 ? at : names.push(STRING_CALLS.concat) - 1;
  })();
  const byRegister = new Map<number, StringValue>();
  /**
   * ЧИСЛА, известные на сборке, по регистрам: только чтобы ОТКАЗАТЬ по имени на константном выходе
   * за границу. Значения кодов из этого не подставляются — выбор всё равно делает рантайм.
   */
  const numbersOf = new Map<number, number>();
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
  const problems: string[] = [];
  let lengths = 0;
  let symbols = 0;
  let concats = 0;
  let staticConcats = 0;
  let arenaConcats = 0;
  let prints = 0;

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
  };

  code.forEach((carrier, index) => {
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
      // Число едет тем же путём — иначе константный индекс, проехавший пересылкой, не опознался бы.
      const number = source !== undefined && source.kind === 'reg' ? numbersOf.get(source.index) : undefined;
      if (number === undefined) numbersOf.delete(destination.index);
      else numbersOf.set(destination.index, number);
      return;
    }
    // НОСИТЕЛЬ СТРОКОЙ НЕ ПРИЗНАН: если он пишет в регистр, лежавшая там строка УМИРАЕТ. Это и есть
    // починка случая 46: без неё арифметика, сравнения и вызовы не стирали прежнее значение, и после
    // раскладки (регистры переиспользуются) карта держала МЁРТВУЮ строку.
    if (carrier.mnemonic !== 'IR.invoke' && carrier.mnemonic !== 'IR.add') {
      kill(writtenRegisterOf(carrier));
      return;
    }
    const name = carrier.mnemonic === 'IR.add' ? STRING_CALLS.concat : nameOf(carrier);
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
      if ((first === undefined) !== (second === undefined)) {
        problems.push(
          `#${String(index)} ${STRING_CALLS.concat}: одна сторона — строка, другая известна только в рантайме — длину брать не от чего`,
        );
        edits.set(index, { kind: 'none', index, reason: 'склейка со значением из рантайма' });
      }
      // Числовое сложение: приёмник — ЧИСЛО, строка в нём (если была) умирает.
      kill(destination);
      return;
    }
    if (name === STRING_CALLS.length) {
      const value = registerOf(carrier.operands[1]);
      if (value === undefined) {
        problems.push(`#${String(index)} ${name}: аргумент не строка — длину в кодпоинтах взять не от чего`);
        edits.set(index, { kind: 'none', index, reason: 'аргумент не строка' });
        kill(destination);
        return;
      }
      if (destination !== undefined) byRegister.delete(destination); // результат — ЧИСЛО
      lengths += 1;
      edits.set(index, { kind: 'length', index, value, marks: [value.bytes.length] });
      return;
    }
    if (name === STRING_CALLS.symbol) {
      // КОД СИМВОЛА: `с[и]` по строке (§3.133). Значение строки известно здесь — значит известны и
      // коды её кодпоинтов, и таблица кодов кладётся статическим блобом. Индекс при этом остаётся
      // РАНТАЙМОВЫМ: выбирает рантайм.
      const value = registerOf(carrier.operands[1]);
      const indexOperand = carrier.operands[2];
      if (value === undefined) {
        problems.push(`#${String(index)} ${name}: аргумент не строка — код символа взять не от чего`);
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
      if (destination !== undefined) byRegister.delete(destination); // результат — ЧИСЛО
      // Таблица кодов — СВОЙ блоб на каждое ЗНАЧЕНИЕ строки: у двух строк с разными буквами и коды
      // разные. Ключ не совпадает с ключом байтов значения, иначе два блоба слились бы в один адрес.
      const tableKey = `⟨коды символов⟩\u0000${value.key}`;
      if (!symbolTables.has(tableKey)) symbolTables.set(tableKey, symbolTableBytesOf(value.bytes));
      symbols += 1;
      edits.set(index, { kind: 'symbol', index, value, marks: [points.length, 0], tableKey });
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
      const value = registerOf(carrier.operands[1]);
      if (value === undefined) {
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
  const needsTable = lengths > 0;
  // Буфер нужен, только если в него кто-то пишет: у склейки сверх статического буфера байты едут в
  // арену, и объявлять под неё статические 20 байт значило бы платить за неиспользуемое.
  const needsBuffer = staticConcats > 0;
  const needsNewline = prints > 0;
  const ordered: { readonly key: string; readonly bytes: readonly number[]; readonly align?: number }[] = [];
  if (needsTable) ordered.push({ key: '⟨таблица продолжений⟩', bytes: continuationTable() });
  for (const value of values.values()) {
    // Буфер склейки — значение того же вида, что литерал: его байты лежат статически.
    // СКЛЕЙКА ЧЕРЕЗ АРЕНУ в образ НЕ кладётся: её байты собираются в выделенном блоке в рантайме,
    // и статическая копия была бы и лишней, и опасной — образ рос бы на всю длину строки.
    if (arenaValues.has(value.key)) continue;
    ordered.push({ key: value.key, bytes: value.bytes });
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
    // байты [адрес, адрес + длина), и его начало обязано попасть на границу. Промежуток между
    // блобами не теряется для читателя: адреса берутся из этой же карты.
    const align = blob.align ?? 1;
    if (align > 1) cursor -= cursor % align;
    cursor -= blob.bytes.length;
    addresses.set(blob.key, cursor);
    blobs.push({ address: cursor, bytes: blob.bytes });
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
    } else if (edit.kind === 'symbol') {
      // Помечаются ДВЕ величины: сколько кодпоинтов (= размер каждой плоскости таблицы) и где сама
      // таблица. Как и у длины, это ЧИСЛА в операндах: у носителя нет ни типа, ни адреса.
      const table = addresses.get(edit.tableKey);
      if (table === undefined) {
        problems.push(`#${String(index)} ${STRING_CALLS.symbol}: таблица кодов не получила адреса — дефект планирования строк`);
        return carrier;
      }
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
    counts: { lengths, symbols, concats, prints, strings: ordered.length, arenaConcats },
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

/** Проверка «строка помечена как печатаемая»: у печати числа шестой пометки нет. */
export function isStringPrint(carrier: AsmInstruction): boolean {
  const mark = carrier.operands[STRING_MARK_OPERAND];
  return carrier.mnemonic === 'IR.invoke' && mark !== undefined && mark.kind === 'imm' && mark.value > 0;
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
