/**
 * ОРАКУЛ РЕАЛЬНОЙ КОДИРОВКИ e2k (`src/e2k/e2k-real.ts`).
 *
 * # Что проверяется
 *
 * 1. **Второй бэкенд существует и отличим от оболочки.** `getEncoder("e2k")` — реальная
 *    кодировка со статусом `ФАКТ`; `getEncoder("e2k-stub")` — прежняя заглушка со статусом
 *    `НЕТ В ДОКУМЕНТЕ`, не тронутая (`src/e2k/e2k.ts`).
 * 2. **Round-trip на всех операциях, которые есть в источнике**: `encode` → `decode` возвращает
 *    ту же инструкцию (мнемоника, канал, все операнды).
 * 3. **Байты совпадают с раскладкой источника, а не с нашей выдумкой.** Для каждой операции
 *    проверяется вручную посчитанное слово слога: `cop[30:24]` = код операции из таблицы МЦСТ,
 *    `src1[23:16]`, `src2[15:8]`, `dst[7:0]`, заголовочный слог `al`/`ale`/`mdl`/`lng`.
 *    Это **независимая** проверка кодировщика: ожидание считается в тесте из номеров битов, а не
 *    берётся из реализации.
 * 4. **Отказы названы.** Операции вне реализованных форм, чужие каналы, чужие регистры и
 *    подмена бита в невыразимом поле — отвергаются; молчаливой выдачи байтов нет.
 * 5. **Шлюз `auditEncoder` на короткой форме.** Реальная кодировка проходит контракт слоя
 *    (размер, round-trip, устойчивость, инъективность, чувствительность к подмене бита) на
 *    короткой форме. **Длинная форма шлюзом не покрыта** — поле `instructionSize` одно, а
 *    длинная форма занимает 16 байт; это записано в паспорте и проверяется отдельно.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что байты примет MCST-objdump, QEMU-e2k или железо: ни один из них в окружении не собран
 * (`docs/e2k-qemu-build.md` §2). Совпадение с **исходниками** четырёх описаний — свидетельство,
 * но не замер.
 */

import { describe, it, expect } from "vitest";
import {
  EncodingRefusedError,
  auditEncoder,
  getEncoder,
  sameInstruction,
  toHex,
  type AsmInstruction,
  type Operand,
} from "./backend";
import { E2K_DESCRIPTION } from "./e2k";
import {
  ALES_WORD_SOURCE,
  REAL_E2K_DESCRIPTION,
  REAL_LONG_FORM_SIZE,
  REAL_OPCODES,
  REAL_SHORT_FORM_SIZE,
  realOpcode,
} from "./e2k-real";

const reg = (index: number): Operand => ({ kind: "reg", index });
const pred = (index: number): Operand => ({ kind: "pred", index });
const real = getEncoder("e2k");

/** Образец инструкции: операнды — регистры 1, 2, 3 в порядке формы; приёмник-предикат — `%pred3`. */
function sample(mnemonic: string, channel: number): AsmInstruction {
  const entry = realOpcode(mnemonic)!;
  const operands = entry.operands.map((slot, index) => (slot === "pdst" ? pred(index + 1) : reg(index + 1)));
  return { mnemonic, channel, operands };
}

/** Все образцы: каждая операция на каждом разрешённом канале. */
const SAMPLES: readonly AsmInstruction[] = REAL_OPCODES.flatMap((entry) =>
  entry.channels.map((channel) => sample(entry.mnemonic, channel)),
);

/** Короткая форма: слог ALS без полуслога ALES. */
const SHORT_SAMPLES: readonly AsmInstruction[] = REAL_OPCODES.filter((entry) => entry.form !== "ALF11").flatMap(
  (entry) => entry.channels.map((channel) => sample(entry.mnemonic, channel)),
);

// ── Независимый расчёт ожидаемых байтов ──────────────────────────────────────
// Номера битов взяты из источников, а не из реализации:
//   слог ALS: spec[31], cop[30:24], src1[23:16], src2[15:8], dst[7:0]
//   HS: mdl[3:0], lng[6:4], al[31:26], ale[25:20]
const ALES_OPCE_NONE = 0xc0;
const ALES_OPC2_EXT = 0x01;

function expectedWords(instruction: AsmInstruction): number[] {
  const entry = realOpcode(instruction.mnemonic)!;
  const values: Record<string, number> = { src1: 0, src2: 0, src3: 0, dst: 0, pdst: 0 };
  entry.operands.forEach((slot, index) => {
    const operand = instruction.operands[index]!;
    if (slot === "pdst") {
      // Приёмник сравнения — предикат: поле pdst[4:0], а не поле регистра.
      if (operand.kind !== "pred") throw new Error("приёмник сравнения обязан быть предикатом");
      values.pdst = operand.index;
      return;
    }
    if (operand.kind !== "reg") throw new Error("образец обязан быть регистровым");
    values[slot] = operand.index;
  });
  const long = entry.form === "ALF11";
  const src1 = entry.form === "ALF2" ? ALES_OPCE_NONE : values.src1!;
  const als =
    entry.form === "ALF7"
      ? (entry.opc << 24) |
        ((src1 & 0xff) << 16) |
        ((values.src2! & 0xff) << 8) |
        (((entry.cmpOpce ?? 0) & 0x7) << 5) |
        (values.pdst! & 0x1f)
      : entry.form === "ALF3"
        ? // ALF3: младший байт — `src3`, а не приёмник (`qemu/target/e2k/syllab-format.h:47-49`).
          (entry.opc << 24) | ((src1 & 0xff) << 16) | ((values.src2! & 0xff) << 8) | (values.src3! & 0xff)
        : (entry.opc << 24) | ((src1 & 0xff) << 16) | ((values.src2! & 0xff) << 8) | (values.dst! & 0xff);
  const words = long ? REAL_LONG_FORM_SIZE / 4 : REAL_SHORT_FORM_SIZE / 4;
  const lng = words / 2 - 1;
  const hs =
    ((lng & 0x7) << 4) |
    1 |
    (((entry.implicitNops ?? 0) & 0x7) << 7) |
    ((1 << instruction.channel) << 26) |
    (long ? (1 << instruction.channel) << 20 : 0);
  if (!long) return [hs >>> 0, als >>> 0];
  // Полуслог ALES0/1/3/4 занимает СТАРШУЮ половину слова 2
  // (gas/config/tc-e2k.c:9392-9399; qemu/target/e2k/instr-bits.h:137-146),
  // слово 3 — выравнивание команды на границу 8 байт.
  return [hs >>> 0, als >>> 0, (((ALES_OPC2_EXT << 8) | ALES_OPCE_NONE) << 16) >>> 0, 0];
}

function expectedBytes(instruction: AsmInstruction): string {
  const words = expectedWords(instruction);
  const bytes: number[] = [];
  for (const word of words) {
    bytes.push(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff);
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

describe("реальная кодировка e2k: реестр", () => {
  it("getEncoder(\"e2k\") — реальная кодировка, getEncoder(\"e2k-stub\") — прежняя заглушка", () => {
    expect(real.description.id).toBe("e2k");
    expect(real.description.status).toBe("ФАКТ");
    expect(real.description.instructionSize).toBe(REAL_SHORT_FORM_SIZE);
    const stub = getEncoder("e2k-stub");
    expect(stub.description.id).toBe(E2K_DESCRIPTION.id);
    expect(stub.description.status).toBe("НЕТ В ДОКУМЕНТЕ");
    expect(stub.description.instructionSize).toBeNull();
    // Заглушка не тронута: она по-прежнему отказывает.
    expect(() => stub.encode(sample("adds", 0))).toThrow(EncodingRefusedError);
  });

  it("таблица операций непуста и у каждой записи назван источник", () => {
    expect(REAL_OPCODES.length).toBeGreaterThanOrEqual(20);
    for (const entry of REAL_OPCODES) {
      expect(entry.source, `${entry.mnemonic}: нет источника`).toMatch(/^opcodes\/e2k-opc\.h:\d+$/);
      expect(entry.formSource, `${entry.mnemonic}: нет источника раскладки`).toMatch(/\.(h|td):\d+/);
      expect(entry.channels.length, `${entry.mnemonic}: нет каналов`).toBeGreaterThan(0);
    }
    expect(ALES_WORD_SOURCE).toMatch(/e2k\.h:68|e2k\.h:93/);
  });
});

describe("реальная кодировка e2k: байты по раскладке источника", () => {
  it("каждая операция на каждом разрешённом канале кодируется ожидаемыми байтами", () => {
    const problems: string[] = [];
    for (const instruction of SAMPLES) {
      const actual = toHex(real.encode(instruction));
      const expected = expectedBytes(instruction);
      if (actual !== expected) {
        problems.push(`${instruction.mnemonic}/${instruction.channel}: получено ${actual}, ожидалось ${expected}`);
      }
    }
    expect(problems, `проверено ${SAMPLES.length} образцов`).toEqual([]);
  });

  it("длина: короткая форма 8 байт, длинная 16", () => {
    for (const instruction of SAMPLES) {
      const entry = realOpcode(instruction.mnemonic)!;
      const expected = entry.form === "ALF11" ? REAL_LONG_FORM_SIZE : REAL_SHORT_FORM_SIZE;
      expect(real.encode(instruction).length, `${instruction.mnemonic}`).toBe(expected);
    }
  });

  it("round-trip: encode → decode возвращает ту же инструкцию", () => {
    const problems: string[] = [];
    for (const instruction of SAMPLES) {
      const back = real.decode(real.encode(instruction));
      if (!sameInstruction(back, instruction)) {
        problems.push(
          `${instruction.mnemonic}/${instruction.channel}: получено «${back.mnemonic}» с ${back.operands.length} операндами`,
        );
      }
    }
    expect(problems, `проверено ${SAMPLES.length} образцов`).toEqual([]);
  });

  it("устойчивость: повторное кодирование даёт те же байты", () => {
    for (const instruction of SAMPLES) {
      const once = toHex(real.encode(instruction));
      const twice = toHex(real.encode(real.decode(real.encode(instruction))));
      expect(twice, `${instruction.mnemonic}/${instruction.channel}`).toBe(once);
    }
  });
});

describe("реальная кодировка e2k: отказы названы, а не молчаливы", () => {
  it("мнемоники, которых нет в источнике, отвергаются с текстом «НЕТ В ИСТОЧНИКЕ»", () => {
    for (const mnemonic of ["ADDs/d", "PADD*", "IR.add", "madd", "несуществующая"]) {
      expect(() => real.encode({ mnemonic, channel: 0, operands: [reg(1), reg(2), reg(3)] }), mnemonic).toThrow(
        /НЕТ В ИСТОЧНИКЕ/,
      );
    }
  });

  it("каналы 6..23 и запрещённые каналы длинной формы отвергаются", () => {
    expect(() => real.encode({ mnemonic: "adds", channel: 6, operands: [reg(1), reg(2), reg(3)] })).toThrow(
      /канал/,
    );
    // У «muls» источник разрешает каналы 0, 1, 3, 4 (allowed_channels {1, 1, 0, 1, 1, 0}).
    expect(() => real.encode({ mnemonic: "muls", channel: 2, operands: [reg(1), reg(2), reg(3)] })).toThrow(
      /запрещён источником/,
    );
    expect(() => real.encode({ mnemonic: "muls", channel: 5, operands: [reg(1), reg(2), reg(3)] })).toThrow(
      /запрещён источником/,
    );
    expect(() => real.encode({ mnemonic: "muls", channel: 1, operands: [reg(1), reg(2), reg(3)] })).not.toThrow();
  });

  it("регистры вне поля и неверное число операндов отвергаются", () => {
    expect(() => real.encode({ mnemonic: "adds", channel: 0, operands: [reg(1), reg(2), reg(64)] })).toThrow(
      /регистр/,
    );
    expect(() => real.encode({ mnemonic: "adds", channel: 0, operands: [reg(1), reg(2)] })).toThrow(/операндов/);
    expect(() => real.encode({ mnemonic: "movts", channel: 0, operands: [reg(1), reg(2), reg(3)] })).toThrow(
      /операндов/,
    );
  });

  it("разбор отвергает чужую длину, чужие поля и чужой код операции", () => {
    const good = real.encode(sample("adds", 0));
    // Чужая длина.
    expect(() => real.decode(new Uint8Array(10))).toThrow(EncodingRefusedError);
    expect(() => real.decode(new Uint8Array(10))).toThrow(/НЕТ В ИСТОЧНИКЕ/);
    // SS-слог (бит 12 HS) интерфейсом не выражается.
    const withSs = Uint8Array.from(good);
    withSs[1] = withSs[1]! | 0x10;
    expect(() => real.decode(withSs)).toThrow(/SS/);
    // Спекулятивный режим (бит 31 слога ALS).
    const speculative = Uint8Array.from(good);
    speculative[7] = speculative[7]! | 0x80;
    expect(() => real.decode(speculative)).toThrow(/спекулятивн/);
    // Чужой код операции.
    const alien = Uint8Array.from(good);
    alien[7] = 0x7e;
    expect(() => real.decode(alien)).toThrow(EncodingRefusedError);
    // Два слога ALS в команде: бит ALS1 поднят рядом с ALS0.
    const two = Uint8Array.from(good);
    two[3] = two[3]! | 0x08;
    expect(() => real.decode(two)).toThrow(EncodingRefusedError);
  });

  it("длинная форма: ненулевое выравнивание и чужой полуслог ALES отвергаются", () => {
    const muls = Uint8Array.from(real.encode(sample("muls", 1)));
    expect(muls.length).toBe(REAL_LONG_FORM_SIZE);
    expect((muls[8]! | (muls[9]! << 8)) === 0).toBe(true);
    const padding = Uint8Array.from(muls);
    padding[12] = 1;
    expect(() => real.decode(padding)).toThrow(/выравнивания/);
    const ales = Uint8Array.from(muls);
    ales[10] = 0xc1;
    expect(() => real.decode(ales)).toThrow(/ALES/);
  });
});

describe("реальная кодировка e2k: шлюз слоя замены", () => {
  it("короткая форма проходит контракт: готов, ни одного замечания", () => {
    const report = auditEncoder(real, SHORT_SAMPLES);
    expect(report.id).toBe("e2k");
    expect(report.status).toBe("ФАКТ");
    expect(report.outcome).toBe("готов");
    expect(report.notes).toEqual([]);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("длинная форма шлюзом не покрыта — это названо в паспорте", () => {
    const long = SAMPLES.filter((instruction) => realOpcode(instruction.mnemonic)!.form === "ALF11");
    expect(long.length).toBeGreaterThan(0);
    // Размер в паспорте один (короткая форма), поэтому образцы длинной формы его нарушают.
    const report = auditEncoder(real, long);
    expect(report.outcome).toBe("нарушение");
    expect(report.checks.find((check) => check.name === "размер")?.note).toMatch(/заявлено 8 байт/);
    expect(REAL_E2K_DESCRIPTION.limitation).toMatch(/длинная форма занимает 16 байт/);
  });

  it("негативный контроль: подмена кода операции не проходит незамеченной", () => {
    // Меняем кодировщик так, что код операции не попадает в байты: шлюз обязан это увидеть.
    const broken = {
      description: { ...REAL_E2K_DESCRIPTION, id: "broken-real" },
      encode: (instruction: AsmInstruction): Uint8Array => {
        const bytes = Uint8Array.from(real.encode(instruction));
        bytes[7] = bytes[7]! & 0x80; // стираем биты 30:24
        return bytes;
      },
      decode: (bytes: Uint8Array) => real.decode(bytes),
    };
    const report = auditEncoder(broken, SHORT_SAMPLES);
    expect(report.outcome).toBe("нарушение");
  });
});
