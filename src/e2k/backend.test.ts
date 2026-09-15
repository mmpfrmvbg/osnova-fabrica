/**
 * ОРАКУЛ СЛОЯ ЗАМЕНЫ КОДИРОВКИ.
 *
 * Проверяется три вещи:
 *
 * 1. **Контракт оболочки через интерфейс.** Потребитель не знает ни кодов операций, ни форм:
 *    он подаёт документированную ассемблерную форму (мнемоника, канал, операнды) и получает
 *    байты. Все мнемоники таблицы обязаны проходить интерфейс и возвращаться без потерь.
 * 2. **Три исхода шлюза.** Оболочка — `готов`; заглушка e2k — `отказывает`; подделки —
 *    `нарушение`.
 * 3. **Негативный контроль шлюза.** Шесть подделок обязаны быть пойманы, а положительный
 *    контроль (честная чужая реализация) — пройти, иначе шлюз был бы красен всегда и ничего
 *    не проверял.
 *
 * Чего этот тест не доказывает: что оболочка соответствует e2k. Соответствие битов железу
 * не проверено и не известно — см. `docs/e2k-backend.md` §4.7.
 */

import { describe, it, expect } from "vitest";
import {
  ENCODER_IDS,
  EncodingRefusedError,
  auditEncoder,
  getEncoder,
  sameInstruction,
  toHex,
  type AsmInstruction,
  type Encoder,
  type EncoderDescription,
  type Operand,
} from "./backend";
import { OPCODES, mnemonicEntry, type OpcodeEntry } from "./encoding";

const shell = getEncoder("internal-shell");
const e2k = getEncoder("e2k");
const e2kStub = getEncoder("e2k-stub");

const reg = (index: number): Operand => ({ kind: "reg", index });
const imm = (value: number): Operand => ({ kind: "imm", value });

function instruction(mnemonic: string, channel: number, operands: readonly Operand[]): AsmInstruction {
  return { mnemonic, channel, operands };
}

/**
 * Виды операндов, которые переходник обязан принять: перебираются по порядку до первого
 * принятого. Так образец строится **через интерфейс**, без знания форм оболочки.
 */
const CANDIDATE_OPERANDS: readonly (readonly Operand[])[] = [
  [reg(5), reg(7), reg(9)],
  [reg(5), imm(100), reg(9)],
  [imm(42), reg(9)],
  [reg(3), imm(16)],
  [imm(120)],
  [],
];

function sampleFor(entry: OpcodeEntry, channel: number): AsmInstruction {
  for (const operands of CANDIDATE_OPERANDS) {
    const candidate = instruction(entry.mnemonic, channel, operands);
    try {
      shell.encode(candidate);
      return candidate;
    } catch {
      // вид операндов не подошёл — пробуем следующий
    }
  }
  throw new Error(`ни один вид операндов не подошёл для «${entry.mnemonic}»`);
}

const ALL_SAMPLES: readonly AsmInstruction[] = OPCODES.map((entry, index) =>
  sampleFor(entry, index % 24),
);

describe("интерфейс: потребитель подаёт документированную форму, а не поля оболочки", () => {
  it("каждая мнемоника таблицы проходит интерфейс и возвращается без потерь", () => {
    const problems: string[] = [];
    for (const sample of ALL_SAMPLES) {
      try {
        const back = shell.decode(shell.encode(sample));
        if (!sameInstruction(back, sample)) {
          problems.push(`${sample.mnemonic}: получено «${back.mnemonic}» с ${back.operands.length} операндами`);
        }
      } catch (error) {
        problems.push(`${sample.mnemonic}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(problems, `мнемоник в таблице ${OPCODES.length}, расхождений ${problems.length}`).toEqual([]);
  });

  it("код операции берётся переходником из таблицы мнемоник, а не из интерфейса", () => {
    const entry = mnemonicEntry("ADDs/d")!;
    const bytes = shell.encode(instruction("ADDs/d", 3, [reg(5), reg(7), reg(9)]));
    expect(bytes[0]).toBe(entry.opcode);
    // В самом типе обмена кода операции нет — иначе он протёк бы наружу.
    const keys = Object.keys(instruction("ADDs/d", 3, [reg(5), reg(7), reg(9)]));
    expect(keys.sort()).toEqual(["channel", "mnemonic", "operands"]);
  });

  it("вид операндов закреплён: документированные формы принимаются, чужие отвергаются", () => {
    const accepted: readonly (readonly [string, readonly Operand[]])[] = [
      ["ADDs/d", [reg(5), reg(7), reg(9)]],
      ["ADDs/d", [reg(5), imm(100), reg(9)]],
      ["MOVAD", [imm(42), reg(9)]],
      ["SXT", [imm(7), reg(9)]],
      ["LDB", [reg(3), imm(16), reg(9)]],
      ["ct", [imm(120)]],
      ["call", [imm(64), reg(20)]],
      ["return", []],
      ["PADD*", [reg(1), reg(2), reg(3)]],
      ["abn", [reg(1), imm(1)]],
    ];
    for (const [mnemonic, operands] of accepted) {
      const sample = instruction(mnemonic, 1, operands);
      expect(sameInstruction(shell.decode(shell.encode(sample)), sample), `${mnemonic}`).toBe(true);
    }

    const rejected: readonly (readonly [string, readonly Operand[]])[] = [
      ["ADDs/d", [reg(1)]],
      ["ct", [reg(1)]],
      ["return", [reg(1)]],
      ["PADD*", [imm(1), imm(2), imm(3)]],
      ["MOVAD", [imm(1)]],
      ["неизвестная.операция", [reg(1)]],
    ];
    for (const [mnemonic, operands] of rejected) {
      expect(() => shell.encode(instruction(mnemonic, 1, operands)), `${mnemonic}`).toThrow();
    }
  });

  it("границы канала и регистра: 23 и 63 принимаются, 24 и 64 отвергаются", () => {
    expect(() => shell.encode(instruction("ADDs/d", 23, [reg(63), reg(63), reg(63)]))).not.toThrow();
    expect(() => shell.encode(instruction("ADDs/d", 24, [reg(1), reg(2), reg(3)]))).toThrow(/канал/);
    expect(() => shell.encode(instruction("ADDs/d", 1, [reg(1), reg(2), reg(64)]))).toThrow(/регистр/);
  });

  it("поля, которых интерфейс не выражает, обязаны быть нулевыми — иначе отказ", () => {
    // «ct» — переход: интерфейс несёт только смещение. Установленный регистр-приёмник
    // означает, что байты содержат то, чего интерфейс не выражает, — это должно отвергаться,
    // иначе подмена бита в этом поле вернула бы ту же инструкцию и осталась бы невидимой.
    const bytes = shell.encode(instruction("ct", 1, [imm(120)]));
    const withDst = Uint8Array.from(bytes);
    withDst[2] = 9;
    expect(() => shell.decode(withDst)).toThrow(/не выражает/);

    // Разрядность документ выражает мнемоникой, отдельного поля у интерфейса нет.
    const arith = Uint8Array.from(shell.encode(instruction("ADDs/d", 1, [reg(1), reg(2), reg(3)])));
    arith[5] = 3;
    expect(() => shell.decode(arith)).toThrow(/разрядность/);
  });
});

describe("шлюз: три исхода", () => {
  it("оболочка проходит контракт: готов, пять проверок, ни одного замечания", () => {
    const report = auditEncoder(shell, ALL_SAMPLES);
    expect(report.id).toBe("internal-shell");
    expect(report.status).toBe("ДОПУЩЕНИЕ");
    expect(report.notes).toEqual([]);
    expect(report.outcome).toBe("готов");
    expect(report.checks.map((check) => check.name)).toEqual([
      "размер",
      "round-trip",
      "устойчивость",
      "инъективность",
      "чувствительность к подмене бита",
    ]);
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("заглушка e2k-stub отказывает: это законный исход, а не нарушение", () => {
    const report = auditEncoder(e2kStub, ALL_SAMPLES);
    expect(report.id).toBe("e2k");
    expect(report.status).toBe("НЕТ В ДОКУМЕНТЕ");
    expect(report.outcome).toBe("отказывает");
    expect(report.notes).toEqual([]);
    expect(e2kStub.description.instructionSize).toBeNull();
    expect(() => e2kStub.encode(ALL_SAMPLES[0]!)).toThrow(EncodingRefusedError);
    expect(() => e2kStub.decode(new Uint8Array(10))).toThrow(/НЕТ В ДОКУМЕНТЕ/);
  });

  it("реестр знает три реализации: оболочка, реальная кодировка, заглушка", () => {
    // Изменение против прежней редакции: ключ «e2k» отдан РЕАЛЬНОЙ кодировке, извлечённой из
    // открытых источников (src/e2k/e2k-real.ts), а прежняя заглушка (src/e2k/e2k.ts) не удалена
    // и не переписана — она переехала под ключ «e2k-stub». Её статус «НЕТ В ДОКУМЕНТЕ» остаётся
    // верным: он про руководство МЦСТ, где кодировки действительно нет.
    expect([...ENCODER_IDS]).toEqual(["internal-shell", "e2k", "e2k-stub"]);
    expect(getEncoder("internal-shell").description.status).toBe("ДОПУЩЕНИЕ");
    expect(getEncoder("e2k").description.status).toBe("ФАКТ");
    expect(getEncoder("e2k-stub").description.status).toBe("НЕТ В ДОКУМЕНТЕ");
  });

  it("пространства имён разделены: реальная кодировка не знает мнемоник оболочки", () => {
    // Мнемоники оболочки скопированы из руководства (ADDs/d, PADD*, IR.*) — это ДРУГОЕ
    // пространство имён, чем таблица опкодов МЦСТ (adds, padds, ...). Реальная кодировка обязана
    // отвергать первые, иначе потребитель не отличил бы e2k от оболочки по мнемонике.
    for (const mnemonic of ["ADDs/d", "MULs/d", "IR.add"]) {
      expect(() => e2k.encode(instruction(mnemonic, 1, [reg(1), reg(2), reg(3)])), mnemonic).toThrow(
        EncodingRefusedError,
      );
    }
  });
});

describe("негативный контроль шлюза: подделки обязаны ловиться", () => {
  function fake(
    description: Partial<EncoderDescription> & { id: string; status: EncoderDescription["status"] },
    encode: (value: AsmInstruction) => Uint8Array,
    decode: (bytes: Uint8Array) => AsmInstruction,
  ): Encoder {
    return {
      description: {
        title: "подделка для негативного контроля",
        instructionSize: 10,
        source: "не документ",
        limitation: "нет",
        ...description,
      },
      encode,
      decode,
    };
  }

  const samples = [
    instruction("ADDs/d", 0, [reg(5), reg(7), reg(9)]),
    instruction("ADDs/d", 5, [reg(5), reg(7), reg(9)]),
    instruction("ADDs/d", 5, [reg(5), imm(100), reg(9)]),
    instruction("SUBs/d", 5, [reg(5), reg(7), reg(9)]),
  ];

  it("1. неверный размер: заявлено 10, выдано 9", () => {
    const broken = fake({ id: "size", status: "ДОПУЩЕНИЕ" }, (value) => shell.encode(value).slice(0, 9), (bytes) =>
      shell.decode(bytes),
    );
    const report = auditEncoder(broken, samples);
    expect(report.outcome).toBe("нарушение");
    expect(report.checks.find((check) => check.name === "размер")?.ok).toBe(false);
  });

  it("2. неинъективность: канал не попадает в байты", () => {
    const broken = fake(
      { id: "injective", status: "ДОПУЩЕНИЕ" },
      (value) => {
        const bytes = Uint8Array.from(shell.encode(value));
        bytes[1] = bytes[1]! & 0b00000111; // стираем биты канала
        return bytes;
      },
      (bytes) => shell.decode(bytes),
    );
    const report = auditEncoder(broken, samples);
    expect(report.outcome).toBe("нарушение");
    const check = report.checks.find((c) => c.name === "инъективность");
    expect(check?.ok).toBe(false);
    expect(check?.note).toMatch(/одни байты/);
  });

  it("3. немой декодер: непосредственное значение не возвращается", () => {
    const broken = fake(
      { id: "mute", status: "ДОПУЩЕНИЕ" },
      (value) => shell.encode(value),
      (bytes) => {
        const muted = Uint8Array.from(bytes);
        muted[6] = 0;
        muted[7] = 0;
        muted[8] = 0;
        muted[9] = 0;
        return shell.decode(muted);
      },
    );
    const report = auditEncoder(broken, samples);
    expect(report.outcome).toBe("нарушение");
    const check = report.checks.find((c) => c.name === "чувствительность к подмене бита");
    expect(check?.ok).toBe(false);
    expect(check?.note).toMatch(/ту же инструкцию/);
  });

  it("4. притворяющийся: статус «НЕТ В ДОКУМЕНТЕ», а байты выдаются", () => {
    const broken = fake({ id: "pretender", status: "НЕТ В ДОКУМЕНТЕ" }, (value) => shell.encode(value), (bytes) =>
      shell.decode(bytes),
    );
    const report = auditEncoder(broken, samples);
    expect(report.outcome).toBe("нарушение");
    expect(report.notes.join(" ")).toMatch(/молчаливая подмена/);
  });

  it("5. отказ при заявленном статусе «ФАКТ»", () => {
    const broken = fake(
      { id: "refuser", status: "ФАКТ", instructionSize: null },
      () => {
        throw new EncodingRefusedError("нет кодировки");
      },
      () => {
        throw new EncodingRefusedError("нет кодировки");
      },
    );
    const report = auditEncoder(broken, samples);
    expect(report.outcome).toBe("нарушение");
    expect(report.notes.join(" ")).toMatch(/статус заявлен как «ФАКТ»/);
  });

  it("6. падение, не являющееся отказом", () => {
    const broken = fake(
      { id: "crash", status: "ДОПУЩЕНИЕ" },
      () => {
        throw new TypeError("внутренняя ошибка");
      },
      (bytes) => shell.decode(bytes),
    );
    const report = auditEncoder(broken, samples);
    expect(report.outcome).toBe("нарушение");
    expect(report.notes.join(" ")).toMatch(/падает не отказом/);
  });

  it("7. пустой набор образцов: «проверок не было» — не «проверки пройдены»", () => {
    const report = auditEncoder(shell, []);
    expect(report.outcome).toBe("нарушение");
    expect(report.notes.join(" ")).toMatch(/образцов нет/);
  });

  it("положительный контроль: честная чужая реализация проходит шлюз", () => {
    // Минимальная реализация «чужой ISA»: два байта, три мнемоники, канал 0–3, регистр 0–3.
    // Нужна, чтобы шлюз не был красен всегда: иначе он ничего не проверял бы.
    const MNEMONICS = ["ADDs/d", "SUBs/d", "MULs/d"];
    const honest = fake(
      { id: "test-honest", status: "ФАКТ", instructionSize: 2, source: "вымышленный справочник, стр. 1" },
      (value) => {
        const index = MNEMONICS.indexOf(value.mnemonic);
        if (index < 0) throw new Error(`нет мнемоники ${value.mnemonic}`);
        const operand = value.operands[0];
        if (value.operands.length !== 1 || operand?.kind !== "reg") throw new Error("ожидался один регистр");
        if (value.channel > 3 || operand.index > 3) throw new Error("вне диапазона");
        return Uint8Array.from([index, (operand.index << 4) | (value.channel << 6)]);
      },
      (bytes) => {
        if (bytes.length !== 2) throw new Error("ожидалось 2 байта");
        if ((bytes[1]! & 0x0f) !== 0) throw new Error("зарезервированные биты");
        const mnemonic = MNEMONICS[bytes[0]!];
        if (mnemonic === undefined) throw new Error("неизвестная мнемоника");
        return instruction(mnemonic, (bytes[1]! >> 6) & 0x03, [reg((bytes[1]! >> 4) & 0x03)]);
      },
    );
    const report = auditEncoder(honest, [
      instruction("ADDs/d", 0, [reg(0)]),
      instruction("SUBs/d", 1, [reg(2)]),
      instruction("MULs/d", 3, [reg(3)]),
    ]);
    expect(report.notes).toEqual([]);
    expect(report.outcome).toBe("готов");
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("байты расхождения печатаются: сообщение пригодно для разбора", () => {
    const bytes = shell.encode(samples[0]!);
    expect(toHex(bytes)).toMatch(/^([0-9a-f]{2} ){9}[0-9a-f]{2}$/);
  });
});
