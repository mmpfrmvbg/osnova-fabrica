/**
 * ИНТЕРФЕЙС ЗАМЕНЫ КОДИРОВКИ (backend layer).
 *
 * # Зачем этот слой
 *
 * Руководство МЦСТ **не содержит бинарной кодировки** инструкций (`docs/e2k-encoding-raw.md`).
 * Поэтому весь машинный код, который проект способен построить сейчас, — это код на
 * **внутренней оболочке проекта** со статусом **ДОПУЩЕНИЕ** (`src/e2k/encoding.ts`).
 *
 * Значит, формулировка «эмиттер выдаёт машинный код e2k» **неверна**. Верная:
 * «эмиттер выдаёт код на внутренней оболочке, которая заменяется реальной кодировкой e2k,
 * когда она появится»; всё, что построено на оболочке, — **гипотеза о e2k, а не e2k**
 * (`docs/e2k-backend.md` §4.1).
 *
 * Отсюда требование: оболочка должна быть **swap-ready** — не «приделаем потом», а явный
 * интерфейс, за которым стоит либо оболочка (`src/e2k/shell.ts`), либо реальная кодировка.
 * Реальная кодировка e2k **появилась** 2026-09-15: она извлечена из открытых источников
 * (`src/e2k/e2k-real.ts`, ключ `e2k`), а прежняя заглушка `src/e2k/e2k.ts` сохранена под
 * ключом `e2k-stub`. Потребитель (эмиттер) по-прежнему видит **только этот файл**.
 *
 * # Тип обмена — документированная ассемблерная форма
 *
 * Обмен идёт не в терминах оболочки (у неё свои коды операций и формы), а в терминах того,
 * что документ действительно описывает (стр. 19): «Большинство операций имеют формат
 * `<мнемоника>,<канал> <аргумент>, <аргумент>, . . . , <результат>`». Отсюда `AsmInstruction`:
 * мнемоника, канал, список операндов (результат — последним). Ни кода операции, ни формы,
 * ни разрядности отдельным полем в типе нет: разрядность документ выражает **мнемоникой**
 * («Арифметические операции имеют разные мнемоники для типов и разрядностей аргументов»,
 * стр. 20), а код операции и форму документ не описывает вовсе.
 *
 * **Соответствие «список операндов ↔ поля кодировки» документ не задаёт — это наше
 * соглашение** (`docs/e2k-backend.md` §4.3).
 *
 * # Что обязан доказать бэкенд
 *
 * Контракт проверяется шлюзом `auditEncoder` (§4.4–4.5 документа). Ключевое требование —
 * не только round-trip, но и **инъективность**: подмена одного бита кодировки не имеет права
 * декодироваться в **ту же** инструкцию. Причина: подмена бита кода операции даёт легальную
 * **другую** инструкцию, и `encode(decode(bytes)) === bytes` такой дефект не ловит
 * (`src/e2k/encoding.negative.test.ts`, дефект 1).
 *
 * Три исхода шлюза: `готов` (контракт выполнен), `отказывает` (реализация заявлена, но
 * кодировать нечем — законный исход для e2k), `нарушение` (в том числе «статус
 * НЕТ В ДОКУМЕНТЕ, но байты выдаются» — молчаливая подмена).
 */

import { createShellEncoder } from "./shell";
import { createE2kEncoder } from "./e2k";
import { createRealE2kEncoder } from "./e2k-real";

/**
 * Файл регистров операнда-регистра.
 *
 * `base` — базовый файл, `%b[N]` (поле слота `0x00 | N`); `window` — оконный, `%r[N]`
 * (поле `0x80 | N`). Различие принципиальное, а не косметическое: при начальном `WD.base_d = 0`
 * оконный `r0` — это `rf.window[0]`, а `%b[0]` — `rf.global[0]`, то есть **разные регистры**
 * (`binutils-gdb/opcodes/e2k-dis.c:416-419` — раскладка поля; `qemu/target/e2k/reg-index.h:79,117` —
 * какие ячейки за ними стоят).
 */
export type RegisterFile = "base" | "window";

/**
 * Операнд в документированной ассемблерной форме.
 *
 * Три вида: регистр (`%b[N]`/`%rN` — файл различает поле `file`), непосредственное значение
 * (`#N`) и **предикат** (`%predN`). Предикат — отдельный вид намеренно, а не регистр с пометкой
 * файла: `%pred0` и `%b[0]` лежат в **разных** файлах, и молчаливая подстановка одного вместо
 * другого была бы подменой поля. Пробел «предикат нечем выразить» записан долгом
 * (`docs/hardware-debt.md` §3.7); поля предикатов — `pdst[4:0]` формы ALF7 (приёмник сравнения)
 * и слог-условие ALU-команды (`CDS`, формат `CDF1_RLP`: `pred[6:0]` — номер, биты 9:7 — отрицание).
 * `%pred0` и `%pcnt0` — **разные** записи одного поля, и это различие кодируется битами `pred[6:5]`.
 *
 * `negated` относится только к предикату-условию (`psrc`): ассемблер пишет его `? ~%predN`, и
 * раскладка поля от этого меняется. У предиката-приёмника (`pdst`) отрицания не бывает — там оно
 * отвергается источником («negated predicate is irrelevant in dst2», `gas/config/tc-e2k.c:5134`).
 */
export type Operand =
  | { readonly kind: "reg"; readonly index: number; readonly file?: RegisterFile }
  | { readonly kind: "imm"; readonly value: number }
  | { readonly kind: "imm64"; readonly value: bigint }
  | { readonly kind: "pred"; readonly index: number; readonly negated?: boolean };

/** Файл регистров операнда; явно не названный — базовый (так поле читалось до этой правки). */
export function registerFileOf(operand: Extract<Operand, { kind: "reg" }>): RegisterFile {
  return operand.file ?? "base";
}

/**
 * Инструкция в терминах документа (стр. 19):
 * `<мнемоника>,<канал> <аргумент>, …, <результат>` — результат последним.
 */
export interface AsmInstruction {
  /** Мнемоника, скопированная из извлечения посимвольно (у семейств — со звёздочкой). */
  readonly mnemonic: string;
  /** Номер канала выдачи: 0–23 (24 канала, стр. 54–56). */
  readonly channel: number;
  /**
   * Операнды в порядке документа: аргументы, затем результат.
   * У операций без результата результата в списке нет.
   */
  readonly operands: readonly Operand[];
  /**
   * Форма **широкой команды**, если эта инструкция — не одна операция, а контейнер слогов.
   *
   * Нужна раскладке: у широкой команды нет записи в таблице форм по носителю, потому что она
   * собирается из нескольких команд, и её длину задаёт структура (HS + слоги ALS по 4 байта +
   * полуслоги ALES по 2 байта с добивкой до чётного слова). Считает её
   * {@link import("./twoPassLayout").sizeOfWideGroup}.
   *
   * Поле необязательное и аддитивное: поток одиночных команд его не несёт, и раскладка для них
   * работает как раньше — по сумме размеров команд формы.
   */
  readonly wideGroup?: WideGroupShape;
  /**
   * Управляющий слог, который едет в **той же** широкой команде, что и эта операция ALS.
   *
   * # Зачем это поле, а не отдельная мнемоника
   *
   * `mas` у команды памяти принадлежит не потоку, а **широкой команде**: порт сбрасывает
   * `mas_valid` на каждой команде (`qemu/target/e2k/decoder.c:41`) и читает значение из слога
   * той же команды (`qemu/target/e2k/tcg/translate-mem.c:1081` — `instr_decoded->mas[ch]`).
   * Отдельная 8-байтовая `setmas` следующую загрузку поэтому не меняет (измерено,
   * `docs/hardware-debt.md` §3.32.2). Ассемблер МЦСТ выражает это формой `mas=` **у самой
   * команды памяти** — `ldw,2 %db[14], %db[12], %db[10], mas=0x7` — то есть одной инструкцией с
   * двумя слогами. Здесь то же самое выражено полем, а не второй мнемоникой.
   *
   * # Границы
   *
   * Поддержаны формы управления, чей слог занимает **ровно одно слово** и не тянет за собой ни
   * `SS`, ни литерал (`setbn`, `setmas` — обе CS1); прочие названы отказом
   * (`wideControlSyllableOf`). Поле необязательное: без него инструкция кодируется как раньше —
   * ни байты, ни отказы существующих потоков не меняются.
   */
  readonly control?: AsmInstruction;
}

/**
 * Форма широкой команды в объёме, нужном для размера: сколько слогов и сколько из них длинных.
 *
 * Ни мнемоник, ни каналов здесь нет намеренно: размер от них не зависит
 * (`src/e2k/widePacker.ts:110-144`), а лишние поля пришлось бы поддерживать в согласованном виде.
 */
export interface WideGroupShape {
  /** Число слогов ALS в команде: 1…6 (`E2K_ALS_NUM`, `qemu/target/e2k/syllab-format.h:219`). */
  readonly slots: number;
  /** Сколько из этих слогов несут полуслог ALES (длинная форма: `muls` — ALF11). */
  readonly ales: number;
}

/** Статус знания о кодировке. `ФАКТ` требует источника со страницей. */
export type EncodingStatus = "ФАКТ" | "ДОПУЩЕНИЕ" | "НЕТ В ДОКУМЕНТЕ";

/** Паспорт реализации: что она кодирует, на каком основании и чего не может. */
export interface EncoderDescription {
  /** Идентификатор реализации. Строка, а не перечисление: сторонний бэкенд не требует правки этого файла. */
  readonly id: string;
  /** Человекочитаемое название. */
  readonly title: string;
  /** Статус знания о кодировке. */
  readonly status: EncodingStatus;
  /** Размер инструкции в байтах; `null` — кодировки нет и размер неизвестен. */
  readonly instructionSize: number | null;
  /** Откуда взято знание: документ и страница — либо `НЕТ В ДОКУМЕНТЕ: …` с перечнем поиска. */
  readonly source: string;
  /** Что реализация может и чего не может. Ограничение обязано быть названо. */
  readonly limitation: string;
}

/** Реализация кодировки, которую видит потребитель (эмиттер). */
export interface Encoder {
  readonly description: EncoderDescription;
  encode(instruction: AsmInstruction): Uint8Array;
  decode(bytes: Uint8Array): AsmInstruction;
}

/**
 * Отказ кодировать: у реализации нет кодировки.
 *
 * Это **не** ошибка входных данных. Отказ — законный ответ заглушки e2k: кодировка в
 * руководстве не описана, придумывать битовые поля запрещено (правило проекта).
 */
export class EncodingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodingRefusedError";
  }
}

/**
 * Идентификаторы реализаций, которые знает реестр.
 *
 * `e2k` — **реальная кодировка**, извлечённая из открытых источников (`src/e2k/e2k-real.ts`).
 * `e2k-stub` — прежняя заглушка (`src/e2k/e2k.ts`), оставленная **без изменений**: её статус
 * `НЕТ В ДОКУМЕНТЕ` описывает руководство МЦСТ, в котором кодировки нет, и это утверждение
 * остаётся верным. Заглушка не удалена и не переписана — она переехала под свой ключ.
 */
export const ENCODER_IDS = ["internal-shell", "e2k", "e2k-stub"] as const;

/** Идентификатор реализации из реестра. */
export type EncoderId = (typeof ENCODER_IDS)[number];

let shellSingleton: Encoder | undefined;
let e2kSingleton: Encoder | undefined;
let e2kStubSingleton: Encoder | undefined;

/**
 * Получить реализацию по идентификатору.
 *
 * **Значения по умолчанию нет намеренно:** потребитель обязан назвать бэкенд явно и записать
 * его идентификатор в артефакт (провенанс выхода). Иначе код на оболочке однажды уйдёт под
 * именем e2k молча — ровно та подмена, ради которой этот слой и разделён.
 */
export function getEncoder(id: EncoderId): Encoder {
  if (id === "internal-shell") return (shellSingleton ??= createShellEncoder());
  if (id === "e2k-stub") return (e2kStubSingleton ??= createE2kEncoder());
  return (e2kSingleton ??= createRealE2kEncoder());
}

/** Сравнение инструкций: совпадение мнемоники, канала и всех операндов. */
export function sameInstruction(a: AsmInstruction, b: AsmInstruction): boolean {
  if (a.mnemonic !== b.mnemonic || a.channel !== b.channel) return false;
  if (a.operands.length !== b.operands.length) return false;
  return a.operands.every((operand, i) => sameOperand(operand, b.operands[i]!));
}

function sameOperand(a: Operand, b: Operand): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "reg" && b.kind === "reg") {
    // Файл регистров сравнивается наравне с номером: `%b[0]` и `%r0` — разные регистры.
    return a.index === b.index && registerFileOf(a) === registerFileOf(b);
  }
  if (a.kind === "imm" && b.kind === "imm") return a.value === b.value;
  // 64-битный литерал сравнивается как bigint: в number он не представим.
  if (a.kind === "imm64" && b.kind === "imm64") return a.value === b.value;
  // Предикат сравнивается по номеру И по отрицанию; смешать его с регистром не даёт проверка вида.
  // Отрицание — не украшение: `? %pred1` и `? ~%pred1` дают разные байты (бит 7 поля `pred`),
  // и разбор, забывший его сверить, вернул бы другую инструкцию под тем же именем.
  if (a.kind === "pred" && b.kind === "pred") {
    return a.index === b.index && (a.negated ?? false) === (b.negated ?? false);
  }
  return false;
}

/** Байты в hex — для сообщений о расхождении. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Одна проверка контракта. */
export interface EncoderCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly note: string;
}

/** Исход аудита реализации. */
export type EncoderOutcome = "готов" | "отказывает" | "нарушение";

/** Результат аудита: машиночитаемый, без ссылок на живые объекты. */
export interface EncoderAudit {
  readonly id: string;
  readonly status: EncodingStatus;
  readonly outcome: EncoderOutcome;
  readonly checks: readonly EncoderCheck[];
  readonly notes: readonly string[];
}

function label(instruction: AsmInstruction): string {
  const operands = instruction.operands
    .map((o) => {
      if (o.kind === "reg") return `r${o.index}`;
      if (o.kind === "pred") return `pred${o.index}`;
      if (o.kind === "imm64") return `f64:${o.value}`;
      return `#${o.value}`;
    })
    .join(", ");
  return `${instruction.mnemonic},${instruction.channel} ${operands}`;
}

function checkSize(encoder: Encoder, samples: readonly AsmInstruction[], size: number): EncoderCheck {
  for (const sample of samples) {
    let bytes: Uint8Array;
    try {
      bytes = encoder.encode(sample);
    } catch (error) {
      return { name: "размер", ok: false, note: `${label(sample)}: кодирование не состоялось — ${message(error)}` };
    }
    if (bytes.length !== size) {
      return {
        name: "размер",
        ok: false,
        note: `${label(sample)}: заявлено ${size} байт, получено ${bytes.length}`,
      };
    }
  }
  return { name: "размер", ok: true, note: `${samples.length} образцов по ${size} байт` };
}

function checkRoundTrip(encoder: Encoder, samples: readonly AsmInstruction[]): EncoderCheck {
  for (const sample of samples) {
    try {
      const back = encoder.decode(encoder.encode(sample));
      if (!sameInstruction(back, sample)) {
        return {
          name: "round-trip",
          ok: false,
          note: `${label(sample)}: после decode получено «${label(back)}»`,
        };
      }
    } catch (error) {
      return { name: "round-trip", ok: false, note: `${label(sample)}: ${message(error)}` };
    }
  }
  return { name: "round-trip", ok: true, note: `${samples.length} образцов возвращаются без потерь` };
}

function checkStable(encoder: Encoder, samples: readonly AsmInstruction[]): EncoderCheck {
  for (const sample of samples) {
    try {
      const once = encoder.encode(sample);
      const twice = encoder.encode(encoder.decode(once));
      if (toHex(once) !== toHex(twice)) {
        return { name: "устойчивость", ok: false, note: `${label(sample)}: повторное кодирование даёт другие байты` };
      }
    } catch (error) {
      return { name: "устойчивость", ok: false, note: `${label(sample)}: ${message(error)}` };
    }
  }
  return { name: "устойчивость", ok: true, note: "повторное кодирование совпадает с первым" };
}

function checkInjective(encoder: Encoder, samples: readonly AsmInstruction[]): EncoderCheck {
  const seen = new Map<string, AsmInstruction>();
  for (const sample of samples) {
    let key: string;
    try {
      key = toHex(encoder.encode(sample));
    } catch (error) {
      return { name: "инъективность", ok: false, note: `${label(sample)}: ${message(error)}` };
    }
    const previous = seen.get(key);
    if (previous !== undefined && !sameInstruction(previous, sample)) {
      return {
        name: "инъективность",
        ok: false,
        note: `«${label(previous)}» и «${label(sample)}» кодируются в одни байты (${key})`,
      };
    }
    seen.set(key, sample);
  }
  return { name: "инъективность", ok: true, note: `${samples.length} различных инструкций — различные байты` };
}

/**
 * Проверка «подмена одного бита не даёт ту же инструкцию».
 *
 * Это второй уровень контроля, добытый дефектом 1: подмена бита кода операции даёт легальную
 * другую инструкцию, поэтому самосогласованность кодека (`encode(decode(b)) === b`) её не
 * видит. Требование сильнее: **ни одна** подмена одного бита не должна декодироваться в ту же
 * инструкцию — допустимо либо отвергнуть байты, либо получить другую инструкцию.
 */
function checkBitFlipSensitivity(encoder: Encoder, samples: readonly AsmInstruction[]): EncoderCheck {
  let mutations = 0;
  for (const sample of samples) {
    const original = encoder.encode(sample);
    for (let i = 0; i < original.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const mutated = Uint8Array.from(original);
        mutated[i] = mutated[i]! ^ (1 << bit);
        mutations++;
        let back: AsmInstruction | undefined;
        try {
          back = encoder.decode(mutated);
        } catch {
          continue; // отказ — законный исход подмены
        }
        if (back !== undefined && sameInstruction(back, sample)) {
          return {
            name: "чувствительность к подмене бита",
            ok: false,
            note: `${label(sample)}: подмена бита ${bit} байта ${i} декодируется в ту же инструкцию`,
          };
        }
      }
    }
  }
  return {
    name: "чувствительность к подмене бита",
    ok: true,
    note: `${mutations} подмен одного бита: ни одна не дала ту же инструкцию`,
  };
}

/**
 * Аудит реализации против контракта.
 *
 * Без образцов аудит **не проходит**: «проверок не было» — это не «проверки пройдены».
 */
export function auditEncoder(encoder: Encoder, samples: readonly AsmInstruction[]): EncoderAudit {
  const { id, status, instructionSize } = encoder.description;
  const checks: EncoderCheck[] = [];
  const notes: string[] = [];

  if (samples.length === 0) {
    return {
      id,
      status,
      outcome: "нарушение",
      checks,
      notes: ["образцов нет: аудит без входных данных не проверяет ничего"],
    };
  }

  try {
    encoder.encode(samples[0]!);
  } catch (error) {
    if (error instanceof EncodingRefusedError) {
      if (status !== "НЕТ В ДОКУМЕНТЕ") {
        notes.push(`отказывается кодировать, но статус заявлен как «${status}»`);
      }
      if (instructionSize !== null) {
        notes.push(`отказывается кодировать, но заявляет размер инструкции ${instructionSize}`);
      }
      return { id, status, outcome: notes.length === 0 ? "отказывает" : "нарушение", checks, notes };
    }
    return { id, status, outcome: "нарушение", checks, notes: [`падает не отказом: ${message(error)}`] };
  }

  if (status === "НЕТ В ДОКУМЕНТЕ") {
    notes.push("статус «НЕТ В ДОКУМЕНТЕ», но байты выдаются — молчаливая подмена одного кодирования другим");
  }
  if (instructionSize === null) {
    notes.push("кодирование выполняется, но размер инструкции не заявлен");
  }
  if (notes.length > 0) return { id, status, outcome: "нарушение", checks, notes };

  checks.push(checkSize(encoder, samples, instructionSize!));
  checks.push(checkRoundTrip(encoder, samples));
  checks.push(checkStable(encoder, samples));
  checks.push(checkInjective(encoder, samples));
  checks.push(checkBitFlipSensitivity(encoder, samples));

  const failed = checks.filter((check) => !check.ok);
  for (const check of failed) notes.push(`${check.name}: ${check.note}`);
  return { id, status, outcome: failed.length === 0 ? "готов" : "нарушение", checks, notes };
}
