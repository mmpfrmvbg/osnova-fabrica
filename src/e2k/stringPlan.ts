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
import { printAreaOf } from './printPrimitives';
import {
  STRING_ARENA_CONCAT_CARRIER,
  STRING_BUFFER_BYTES,
  STRING_CALLS,
  STRING_NEWLINE,
  STRING_TABLE_BYTES,
  codePointCount,
  concatFitsBuffer,
  continuationTable,
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

/** Значение строки, как его видит конвейер: байты и их число плюс адрес (появляется при раскладке блobs). */
interface StringValue {
  readonly bytes: readonly number[];
  readonly key: string;
  address?: number;
}

/** Что конвейер решил про конкретный носитель. */
type StringEdit =
  | { readonly kind: 'const'; readonly index: number; readonly poolIndex: number; readonly value: StringValue }
  | { readonly kind: 'length'; readonly index: number; readonly value: StringValue; readonly marks: number[] }
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
  options: { readonly arenaRefusal?: string } = {},
): StringPlan {
  const names = [...invokeNames];
  const concatPayload = ((): number => {
    const at = names.indexOf(STRING_CALLS.concat);
    return at >= 0 ? at : names.push(STRING_CALLS.concat) - 1;
  })();
  const byRegister = new Map<number, StringValue>();
  const values = new Map<string, StringValue>();
  /** Значения, собранные ареной: статических байтов у них нет и в образ они не кладутся. */
  const arenaValues = new Set<string>();
  const edits = new Map<number, StringEdit>();
  const problems: string[] = [];
  let lengths = 0;
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
  const destinationOf = (carrier: AsmInstruction): number | undefined => {
    const flags = carrier.operands[0];
    const destination = carrier.operands[4];
    if (flags === undefined || flags.kind !== 'imm' || (flags.value & 1) !== 1) return undefined;
    return destination !== undefined && destination.kind === 'reg' ? destination.index : undefined;
  };

  code.forEach((carrier, index) => {
    // Пул констант: строковый литерал — это строка, всё остальное — числа.
    if (carrier.mnemonic === 'IR.const') {
      const destination = carrier.operands[0];
      const poolIndex = carrier.operands[1];
      if (destination?.kind !== 'reg' || poolIndex?.kind !== 'imm') return;
      const raw = constants[poolIndex.value];
      if (typeof raw !== 'string') return;
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
      return;
    }
    if (carrier.mnemonic !== 'IR.invoke' && carrier.mnemonic !== 'IR.add') return;
    const name = carrier.mnemonic === 'IR.add' ? STRING_CALLS.concat : nameOf(carrier);
    // У `IR.add` приёмник — ПЕРВЫЙ операнд-регистр (у `IR.invoke` его место ищет `destinationOf`
    // по флагам: там операнд 0 — число).
    const destination =
      carrier.mnemonic === 'IR.add'
        ? carrier.operands[0]?.kind === 'reg'
          ? carrier.operands[0].index
          : undefined
        : destinationOf(carrier);
    // СКЛЕЙКА `+` — ТЕМ ЖЕ ПУТЁМ (канон §2.1). Оболочка на `"а" + "б"` выдаёт `IR.add` с двумя
    // строковыми регистрами (измерено, `.tmp/osnova-strings-plus.ts`): типа у носителя нет, и
    // арифметикой он сложил бы АДРЕСА — это и было видно как «2112890». Раз строки известны здесь,
    // здесь и решается, что это склейка: носитель переписывается в вызов `объединить` с пометками.
    const concatLike = carrier.mnemonic === 'IR.add' ? registerOf(carrier.operands[1]) !== undefined && registerOf(carrier.operands[2]) !== undefined : false;
    if (carrier.mnemonic === 'IR.add' && !concatLike) return;
    if (name === STRING_CALLS.length) {
      const value = registerOf(carrier.operands[1]);
      if (value === undefined) {
        problems.push(`#${String(index)} ${name}: аргумент не строка — длину в кодпоинтах взять не от чего`);
        edits.set(index, { kind: 'none', index, reason: 'аргумент не строка' });
        return;
      }
      if (destination !== undefined) byRegister.delete(destination); // результат — ЧИСЛО
      lengths += 1;
      edits.set(index, { kind: 'length', index, value, marks: [value.bytes.length] });
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
      if (value === undefined) return;
      prints += 1;
      edits.set(index, { kind: 'print', index, value, marks: [value.bytes.length] });
    }
  });

  // ── Раскладка статических блобов: снизу вверх от площадки печати ──────────────────────────────
  const needsTable = lengths > 0;
  // Буфер нужен, только если в него кто-то пишет: у склейки сверх статического буфера байты едут в
  // арену, и объявлять под неё статические 20 байт значило бы платить за неиспользуемое.
  const needsBuffer = staticConcats > 0;
  const needsNewline = prints > 0;
  const ordered: { readonly key: string; readonly bytes: readonly number[] }[] = [];
  if (needsTable) ordered.push({ key: '⟨таблица продолжений⟩', bytes: continuationTable() });
  for (const value of values.values()) {
    // Буфер склейки — значение того же вида, что литерал: его байты лежат статически.
    // СКЛЕЙКА ЧЕРЕЗ АРЕНУ в образ НЕ кладётся: её байты собираются в выделенном блоке в рантайме,
    // и статическая копия была бы и лишней, и опасной — образ рос бы на всю длину строки.
    if (arenaValues.has(value.key)) continue;
    ordered.push({ key: value.key, bytes: value.bytes });
  }
  if (needsBuffer) ordered.push({ key: '⟨буфер склейки⟩', bytes: new Array<number>(STRING_BUFFER_BYTES).fill(0) });
  if (needsNewline) ordered.push({ key: '⟨перевод строки⟩', bytes: [STRING_NEWLINE] });
  // СТРОКА ОТКАЗА АРЕНЫ — тем же порядком, что прочие блобы: адрес выведен из конца образа.
  const refusalBytes = options.arenaRefusal === undefined ? undefined : utf8Bytes(options.arenaRefusal);
  if (refusalBytes !== undefined) ordered.push({ key: ARENA_REFUSAL_BLOB_KEY, bytes: refusalBytes });

  const area = printAreaOf(heapAddress);
  let cursor = area;
  const addresses = new Map<string, number>();
  const blobs: { address: number; bytes: readonly number[] }[] = [];
  for (const blob of ordered) {
    cursor -= blob.bytes.length;
    addresses.set(blob.key, cursor);
    blobs.push({ address: cursor, bytes: blob.bytes });
  }
  // Адрес значения: у литерала — его собственные байты, у статической склейки — буфер (результат
  // живёт там). У склейки ЧЕРЕЗ АРЕНУ адреса нет и быть не может: он появляется в рантайме, и
  // значение живёт в регистре-приёмнике выделения.
  for (const value of values.values()) {
    const isJoined = value.key.includes('\u0000');
    const address = isJoined ? addresses.get('⟨буфер склейки⟩') : addresses.get(value.key);
    if (address !== undefined) value.address = address;
  }

  // ── Применение правок: пометки — числовые, ПОСЛЕ раскладки блобов (адреса уже известны) ───────
  const pool = [...constants];
  const tableAddress = addresses.get('⟨таблица продолжений⟩') ?? 0;
  const bufferAddress = addresses.get('⟨буфер склейки⟩') ?? 0;
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
            imm(bufferAddress),
          ],
        };
      }
      operands[STRING_MARK_OPERAND] = imm(edit.marks[0]!);
      operands[STRING_MARK_OPERAND + 1] = imm(edit.marks[1]!);
      operands[STRING_MARK_OPERAND + 2] = imm(bufferAddress);
    } else {
      operands[STRING_MARK_OPERAND] = imm(edit.marks[0]!);
      operands[STRING_MARK_OPERAND + 1] = imm(newlineAddress);
    }
    return { ...carrier, operands };
  });

  const refusalAddress = addresses.get(ARENA_REFUSAL_BLOB_KEY);
  return {
    code: rewritten,
    constants: pool,
    invokeNames: names,
    blobs,
    staticStart: cursor,
    problems,
    counts: { lengths, concats, prints, strings: ordered.length, arenaConcats },
    ...(needsBuffer ? { bufferAddress } : {}),
    ...(refusalAddress === undefined || refusalBytes === undefined
      ? {}
      : { arenaRefusal: { address: refusalAddress, byteLength: refusalBytes.length } }),
  };
}

/** Сколько байт занимает статическая область целиком (для сторожа места и отчёта). */
export function staticBytesOf(plan: StringPlan): number {
  return plan.blobs.reduce((sum, blob) => sum + blob.bytes.length, 0);
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
