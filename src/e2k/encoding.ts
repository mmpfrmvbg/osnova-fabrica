/**
 * Кодировщик и декодировщик подмножества e2k — ВНУТРЕННЯЯ ОБОЛОЧКА ПРОЕКТА.
 *
 * # Это НЕ кодировка e2k
 *
 * Руководство МЦСТ **не содержит бинарной кодировки** инструкций: поиск по всем формам
 * («формат команды», «опкод», «opcode», «размер/длина команды», «формат кодирования»)
 * даёт нулевые вхождения — см. `docs/e2k-encoding-raw.md`. Документ даёт ассемблерную
 * форму операций и слоговую структуру широкой команды.
 *
 * Поэтому здесь реализована **своя оболочка**, помеченная в спецификации как
 * **ДОПУЩЕНИЕ** (`docs/e2k-encoding.md` §2.1). Она нужна, чтобы построить и проверить
 * конвейер «регистровый модуль + разметка атомов → байты → декодирование → round-trip»
 * **до** появления настоящей кодировки. Код, собранный этим кодеком, **нельзя** выдать на
 * реальный e2k: соответствие битов железу не проверено и не известно.
 *
 * Когда появится настоящая кодировка (ISA-справочник, дизассемблер, железо), заменяется
 * только этот файл: интерфейс `encode`/`decode` и оракулы остаются.
 *
 * # Раскладка оболочки (11 байт)
 *
 * | смещение | поле |
 * |---|---|
 * | 0 | `opcode` |
 * | 1 | биты 0–2 `form`, биты 3–7 `channel` |
 * | 2 | биты 0–5 `dst`, биты 6–7 резерв (0) |
 * | 3 | биты 0–5 `src1`, биты 6–7 резерв (0) |
 * | 4 | биты 0–5 `src2`, биты 6–7 резерв (0) |
 * | 5 | биты 0–1 `width`, биты 2–7 резерв (0) |
 * | 6–9 | `imm` — int32, little-endian |
 *
 * | 10 | биты 0–5 `src3`, биты 6–7 резерв (0) |
 *
 * Резервные биты введены намеренно: они дают негативному контролю проверяемое условие.
 *
 * # Почему запись выросла с 10 байт до 11 (2026-10-02)
 *
 * Регистровых полей было три — `dst`, `src1`, `src2`, — и вызову с **тремя аргументами** четвёртого
 * не хватало: `IR.invoke` кладёт в `src1`/`src2` два аргумента и в `dst` приёмник. Измерено:
 * `EmitterRefusalError: invoke: аргументов 3, носитель несёт не больше 2` — программа с таким
 * вызовом не компилировалась **вовсе**, а у цели (DF) действия гномов имеют 3–5 аргументов.
 *
 * Поле `src3` добавлено **своим байтом**, а не вырезано из резервных битов чужих полей: резервные
 * биты — условие негативного контроля, и занять их данными значило бы отдать контроль за место.
 * Байт `src3` стоит ПОСЛЕ `imm`, а не рядом с `src1`/`src2`, намеренно: прежние поля сохранили свои
 * позиции — иначе поехали бы все собранные руками носители, а вместе с ними доверие к форме.
 *
 * Документированные операции оболочки третьего источника не несут (их формы дают не больше `REG3`),
 * поэтому у них байт 10 обязан быть нулевым — правило «не терять поле молча» действует и здесь.
 *
 * # Мнемоники
 *
 * Мнемоники **скопированы** из извлечения (`docs/e2k-encoding-raw.md`) посимвольно, включая
 * звёздочку у семейств: `PADD*` означает «семейство `PADD*`, конкретный вариант документом
 * не раскрыт». Придумывать варианты (`PADDSB` и подобные) запрещено — правило проекта.
 */

/** Размер инструкции оболочки в байтах. 11 = 10 + поле `src3` (третий аргумент вызова). */
export const INSTRUCTION_SIZE = 11;

/** Максимальный номер канала: каналов 24 (стр. 54–56). */
export const MAX_CHANNEL = 23;

/**
 * Максимальный индекс регистра в поле.
 *
 * 6 бит — **наше следствие** из документированного «пространство регистров окна
 * определяется кодировкой операций и равно 64 регистрам» (стр. 144). Ширину поля документ
 * не называет.
 */
export const MAX_REGISTER = 63;

/** Формы операций оболочки. */
export const FORMS = {
  REG3: 0,
  REG_IMM: 1,
  BRANCH: 2,
  PACKED: 3,
  CALL: 4,
  RETURN: 5,
  MEMORY: 6,
} as const;

/** Разрядности, документированные для упакованных устройств (стр. 56): 8, 16, 32 бита. */
export const WIDTHS = { BYTE: 0, HALF: 1, WORD: 2, DOUBLE: 3 } as const;

/** Ошибка кодирования или декодирования. */
export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodingError";
  }
}

/** Описание операции в таблице оболочки. */
export interface OpcodeEntry {
  /** Код операции (наш, не e2k). */
  opcode: number;
  /** Мнемоника, скопированная из извлечения посимвольно (у семейств — со звёздочкой). */
  mnemonic: string;
  /** Допустимые формы. */
  forms: number[];
  /** Есть ли у операции приёмник результата. */
  hasDst: boolean;
}

/**
 * Таблица операций оболочки. Мнемоники — из `docs/e2k-encoding-raw.md` (стр. 196, 162–164,
 * 171); коды операций — наши (ДОПУЩЕНИЕ).
 */
export const OPCODES: readonly OpcodeEntry[] = [
  { opcode: 0x01, mnemonic: "ADDs/d", forms: [FORMS.REG3, FORMS.REG_IMM], hasDst: true },
  { opcode: 0x02, mnemonic: "SUBs/d", forms: [FORMS.REG3, FORMS.REG_IMM], hasDst: true },
  { opcode: 0x03, mnemonic: "AND", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x04, mnemonic: "OR", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x05, mnemonic: "XOR", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x06, mnemonic: "MERGE", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x07, mnemonic: "MULs/d", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x08, mnemonic: "SMULHd", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x09, mnemonic: "UMULHd", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x0a, mnemonic: "SXT", forms: [FORMS.REG_IMM], hasDst: true },
  { opcode: 0x0b, mnemonic: "MOVTs/d/q", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x0c, mnemonic: "SHLs/d", forms: [FORMS.REG3, FORMS.REG_IMM], hasDst: true },
  { opcode: 0x0d, mnemonic: "SHRs/d", forms: [FORMS.REG3, FORMS.REG_IMM], hasDst: true },
  { opcode: 0x0e, mnemonic: "SARs/d", forms: [FORMS.REG3, FORMS.REG_IMM], hasDst: true },
  { opcode: 0x0f, mnemonic: "SCLs/d", forms: [FORMS.REG3, FORMS.REG_IMM], hasDst: true },
  { opcode: 0x10, mnemonic: "SCR", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x11, mnemonic: "LDB", forms: [FORMS.MEMORY], hasDst: true },
  { opcode: 0x12, mnemonic: "LDH", forms: [FORMS.MEMORY], hasDst: true },
  { opcode: 0x13, mnemonic: "LDW", forms: [FORMS.MEMORY], hasDst: true },
  { opcode: 0x14, mnemonic: "LDD", forms: [FORMS.MEMORY], hasDst: true },
  { opcode: 0x15, mnemonic: "STB", forms: [FORMS.MEMORY], hasDst: false },
  { opcode: 0x16, mnemonic: "STH", forms: [FORMS.MEMORY], hasDst: false },
  { opcode: 0x17, mnemonic: "STW", forms: [FORMS.MEMORY], hasDst: false },
  { opcode: 0x18, mnemonic: "STD", forms: [FORMS.MEMORY], hasDst: false },
  { opcode: 0x19, mnemonic: "MOVAD", forms: [FORMS.REG_IMM], hasDst: true },
  { opcode: 0x1a, mnemonic: "PADD*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x1b, mnemonic: "PSUB*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x1c, mnemonic: "PMIN*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x1d, mnemonic: "PMAX*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x1e, mnemonic: "PAVG*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x1f, mnemonic: "PCMP*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x20, mnemonic: "PAND*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x21, mnemonic: "POR*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x22, mnemonic: "PXOR*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x23, mnemonic: "PSL*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x24, mnemonic: "PSR*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x25, mnemonic: "PSHUF*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x26, mnemonic: "PMADDH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x27, mnemonic: "PMADDUBSH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x28, mnemonic: "PMULHRSH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x29, mnemonic: "PSADBW", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x2a, mnemonic: "PHMINPOSUH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x2b, mnemonic: "PFADDs/d", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x2c, mnemonic: "PFSUBs/d", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x2d, mnemonic: "PFMULs/d", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x2e, mnemonic: "PFMUL_(ADD/SUB/RSUB)(s/d)", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x2f, mnemonic: "ct", forms: [FORMS.BRANCH], hasDst: false },
  { opcode: 0x30, mnemonic: "call", forms: [FORMS.CALL], hasDst: true },
  { opcode: 0x31, mnemonic: "return", forms: [FORMS.RETURN], hasDst: false },
  // Операции продвижения счётчиков и указателя (стр. 162, 180–181): мнемоники скопированы.
  { opcode: 0x59, mnemonic: "abn", forms: [FORMS.REG_IMM], hasDst: false },
  { opcode: 0x5a, mnemonic: "staa incr", forms: [FORMS.MEMORY], hasDst: false },
  // --- остальные операции спецификации (мнемоники скопированы из извлечения) ---
  { opcode: 0x32, mnemonic: "ANDN", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x33, mnemonic: "ORN", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x34, mnemonic: "XORN", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x35, mnemonic: "INC*", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x36, mnemonic: "DEC*", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x37, mnemonic: "UMULX", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x38, mnemonic: "SMULX", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x39, mnemonic: "UDIVs/x", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x3a, mnemonic: "LZCNTs/d", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x3b, mnemonic: "POPCNTs/d", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x3c, mnemonic: "BITREVs/d", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x3d, mnemonic: "GETF", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x3e, mnemonic: "INSF", forms: [FORMS.REG3], hasDst: true },
  { opcode: 0x3f, mnemonic: "MOVAB", forms: [FORMS.REG_IMM], hasDst: true },
  { opcode: 0x40, mnemonic: "MOVAH", forms: [FORMS.REG_IMM], hasDst: true },
  { opcode: 0x41, mnemonic: "MOVAW", forms: [FORMS.REG_IMM], hasDst: true },
  { opcode: 0x42, mnemonic: "MOVAQ", forms: [FORMS.REG_IMM], hasDst: true },
  { opcode: 0x43, mnemonic: "PUNPCK*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x44, mnemonic: "PACK*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x45, mnemonic: "PMOV*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x46, mnemonic: "PMERGE", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x47, mnemonic: "PEXTRH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x48, mnemonic: "PINSH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x49, mnemonic: "PSIGN*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x4a, mnemonic: "PHADD*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x4b, mnemonic: "PHSUB*", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x4c, mnemonic: "PMULHH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x4d, mnemonic: "PMULLH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x4e, mnemonic: "PMULUBHH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x4f, mnemonic: "MPSADBH", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x50, mnemonic: "PFHADDs", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x51, mnemonic: "PFHSUBs", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x52, mnemonic: "PFADDSUBs", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x53, mnemonic: "PFMIN(s/d)", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x54, mnemonic: "PFMAX(s/d)", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x55, mnemonic: "PFCMP(s/d)", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x56, mnemonic: "PFMUL_(HADD/HSUB/ADDSUB)s", forms: [FORMS.PACKED], hasDst: true },
  { opcode: 0x57, mnemonic: "PF(ADD/SUB)_(ADD/SUB/RSUB)(s/d)", forms: [FORMS.PACKED], hasDst: true },
  {
    opcode: 0x58,
    mnemonic: "PF(HADD/HSUB/ADDSUB)_(HADD/HSUB/ADDSUB)s",
    forms: [FORMS.PACKED],
    hasDst: true,
  },
];

/**
 * Мнемоники, для которых кодировки в документе нет и которые **не реализуются** в оболочке.
 *
 * Это не «забытые» операции: у них нет документированной кодировки, а придумывать битовые
 * поля запрещено. Каждая проверяется на то, что она действительно встречается в извлечении.
 */
export const NOT_ENCODABLE: readonly string[] = [
  // Деление и остаток: кодировки в документе нет, в ядрах DSP не нужны (§2.1 спецификации).
  "SDIVs/x",
  "UMODx",
  // Операции над предикатами: размещаются в PLS-слогах (стр. 168–169), где операция с
  // конкретным номером занимает фиксированное место; битовая раскладка слога документом не
  // описана, а результат уходит в предикатный файл, а не в числовой регистр — форма оболочки
  // для них не определена.
  "CMPs/d",
  "CMPANDs/d",
  "FCMPs/d",
  "CMP*",
  // Упоминания в ОТРИЦАНИИ: этих операций в документе НЕТ, они названы только для того,
  // чтобы сказать «такого нет». В таблицу кодировщика они не попадают намеренно.
  "MADD",
  "MULADD",
];

/** Операция в терминах оболочки. */
export interface E2kInstruction {
  opcode: number;
  mnemonic: string;
  form: number;
  channel: number;
  dst?: number;
  src1?: number;
  src2?: number;
  width?: number;
  imm?: number;
}

/** Найти операцию по коду. */
export function opcodeEntry(opcode: number): OpcodeEntry | undefined {
  return OPCODES.find((o) => o.opcode === opcode);
}

/** Найти операцию по мнемонике. */
export function mnemonicEntry(mnemonic: string): OpcodeEntry | undefined {
  return OPCODES.find((o) => o.mnemonic === mnemonic);
}

function checkRange(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new EncodingError(`${name} вне диапазона 0..${max}: ${value}`);
  }
}

/** Закодировать одну инструкцию в 10 байт оболочки. */
export function encode(instruction: E2kInstruction): Uint8Array {
  const entry = opcodeEntry(instruction.opcode);
  if (entry === undefined) throw new EncodingError(`неизвестный код операции: ${instruction.opcode}`);
  if (entry.mnemonic !== instruction.mnemonic) {
    throw new EncodingError(`код ${instruction.opcode} принадлежит «${entry.mnemonic}», а не «${instruction.mnemonic}»`);
  }
  if (!entry.forms.includes(instruction.form)) {
    throw new EncodingError(`форма ${instruction.form} недопустима для «${entry.mnemonic}»`);
  }
  checkRange("channel", instruction.channel, MAX_CHANNEL);
  const dst = instruction.dst ?? 0;
  const src1 = instruction.src1 ?? 0;
  const src2 = instruction.src2 ?? 0;
  const width = instruction.width ?? WIDTHS.WORD;
  checkRange("dst", dst, MAX_REGISTER);
  checkRange("src1", src1, MAX_REGISTER);
  checkRange("src2", src2, MAX_REGISTER);
  checkRange("width", width, WIDTHS.DOUBLE);
  const imm = instruction.imm ?? 0;
  if (!Number.isInteger(imm) || imm < -0x80000000 || imm > 0x7fffffff) {
    throw new EncodingError(`imm вне диапазона int32: ${imm}`);
  }

  const bytes = new Uint8Array(INSTRUCTION_SIZE);
  bytes[0] = instruction.opcode;
  bytes[1] = (instruction.form & 0x07) | ((instruction.channel & 0x1f) << 3);
  bytes[2] = dst & 0x3f;
  bytes[3] = src1 & 0x3f;
  bytes[4] = src2 & 0x3f;
  bytes[5] = width & 0x03;
  bytes[6] = imm & 0xff;
  bytes[7] = (imm >>> 8) & 0xff;
  bytes[8] = (imm >>> 16) & 0xff;
  bytes[9] = (imm >>> 24) & 0xff;
  // Поле `src3` у документированных операций пусто: их формы дают не больше трёх регистров
  // (`dst`, `src1`, `src2`). Байт пишется явным нулём, а не остаётся «как вышло»: `Uint8Array`
  // обнулён, но правило «не терять поле молча» требует, чтобы это было видно в коде.
  bytes[10] = 0;
  return bytes;
}

/** Декодировать одну инструкцию из 10 байт оболочки. */
export function decode(bytes: Uint8Array): E2kInstruction {
  if (bytes.length !== INSTRUCTION_SIZE) {
    throw new EncodingError(`ожидалось ${INSTRUCTION_SIZE} байт, получено ${bytes.length}`);
  }
  const entry = opcodeEntry(bytes[0]!);
  if (entry === undefined) throw new EncodingError(`неизвестный код операции: ${bytes[0]}`);
  const form = bytes[1]! & 0x07;
  const channel = (bytes[1]! >> 3) & 0x1f;
  if (channel > MAX_CHANNEL) throw new EncodingError(`номер канала вне диапазона 0..${MAX_CHANNEL}: ${channel}`);
  if (form === 0x07) throw new EncodingError("зарезервированная форма 7");
  if (!entry.forms.includes(form)) {
    throw new EncodingError(`форма ${form} недопустима для «${entry.mnemonic}»`);
  }
  for (const [name, index] of [["dst", 2], ["src1", 3], ["src2", 4]] as const) {
    if ((bytes[index]! & 0xc0) !== 0) throw new EncodingError(`резервные биты установлены в поле ${name}`);
  }
  if ((bytes[5]! & 0xfc) !== 0) throw new EncodingError("резервные биты установлены в поле width");
  // Третий источник у документированных операций не выражается их формами: ненулевой байт 10 —
  // это поле, которого шаблон не несёт, и молча принять его значило бы ослепить второй уровень
  // контроля (тот же класс, что «IR.const молча терял поле src1»).
  if (bytes[10]! !== 0) {
    throw new EncodingError(
      `поле src3 = ${bytes[10]!}, но ни одна документированная форма оболочки его не несёт — декодирование отвергнуто`,
    );
  }
  const dst = bytes[2]! & 0x3f;
  const src1 = bytes[3]! & 0x3f;
  const src2 = bytes[4]! & 0x3f;
  const width = bytes[5]! & 0x03;
  const imm = (bytes[6]! | (bytes[7]! << 8) | (bytes[8]! << 16) | (bytes[9]! << 24)) | 0;

  return { opcode: entry.opcode, mnemonic: entry.mnemonic, form, channel, dst, src1, src2, width, imm };
}

/** Явный статус: кодировка e2k документом не описана, оболочка — наше допущение. */
export const ENCODING_STATUS =
  "ДОПУЩЕНИЕ: внутренняя оболочка проекта, НЕ кодировка e2k (в руководстве МЦСТ бинарной кодировки нет)";
