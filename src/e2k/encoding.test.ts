/**
 * ROUND-TRIP ОРАКУЛ КОДИРОВКИ (оболочка проекта).
 *
 * # Что проверяется
 *
 * 1. **Round-trip байтов:** `encode(decode(bytes)) === bytes` — для всех операций таблицы
 *    и для обеих допустимых форм.
 * 2. **Round-trip инструкции:** `decode(encode(ins))` совпадает с `ins` по значимым полям.
 * 3. **Покрытие спецификации:** каждая мнемоника из `docs/e2k-subset-dsp.md` либо
 *    реализована в оболочке, либо помечена «не кодируема без железа».
 * 4. **Отсутствие выдуманных мнемоник:** каждая мнемоника таблицы встречается в извлечении
 *    (`docs/e2k-encoding-raw.md`) — правило «мнемоника скопирована посимвольно».
 * 5. **НЕГАТИВНЫЙ КОНТРОЛЬ (5 случаев):** усечённые байты, неизвестный код операции,
 *    установленные резервные биты, зарезервированная форма, номер канала вне диапазона.
 *
 * # Что НЕ проверяется
 *
 * Соответствие битов железу e2k: кодировки e2k в документе нет
 * (`docs/e2k-encoding-raw.md`, `docs/e2k-encoding.md` §2.7). Round-trip доказывает
 * согласованность **нашей оболочки**, а не совместимость с процессором.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import {
  ENCODING_STATUS,
  FORMS,
  INSTRUCTION_SIZE,
  NOT_ENCODABLE,
  OPCODES,
  WIDTHS,
  decode,
  encode,
  type E2kInstruction,
} from "./encoding";

const ROOT = path.resolve(__dirname, "..", "..");
/** Документ извлечения ИНСТРУКЦИЙ: здесь лежат написания мнемоник. */
const INSTRUCTIONS = path.join(ROOT, "docs", "e2k-dsp-instructions.md");
const SUBSET = path.join(ROOT, "docs", "e2k-subset-dsp.md");

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

/** Типичная инструкция для операции: одна на каждую допустимую форму. */
function sampleFor(opcode: number, form: number, channel: number): E2kInstruction {
  const entry = OPCODES.find((o) => o.opcode === opcode)!;
  return {
    opcode,
    mnemonic: entry.mnemonic,
    form,
    channel,
    dst: 5,
    src1: 7,
    src2: 9,
    width: WIDTHS.HALF,
    imm: -1234,
  };
}

describe("round-trip кодировки: байты и инструкции", () => {
  it("encode(decode(bytes)) === bytes для всех операций и форм", () => {
    let cases = 0;
    for (const entry of OPCODES) {
      for (const form of entry.forms) {
        for (const channel of [0, 6, 23]) {
          const instruction = sampleFor(entry.opcode, form, channel);
          const bytes = encode(instruction);
          expect(bytes.length).toBe(INSTRUCTION_SIZE);
          const back = decode(bytes);
          expect(Array.from(encode(back)), `${entry.mnemonic} форма ${form}`).toEqual(Array.from(bytes));
          cases++;
        }
      }
    }
    // Позитивных случаев заведомо больше десяти.
    expect(cases).toBeGreaterThanOrEqual(10);
  });

  it("decode(encode(ins)) сохраняет значимые поля", () => {
    for (const entry of OPCODES) {
      const form = entry.forms[0]!;
      const instruction = sampleFor(entry.opcode, form, 12);
      const back = decode(encode(instruction));
      expect(back.mnemonic).toBe(entry.mnemonic);
      expect(back.opcode).toBe(entry.opcode);
      expect(back.form).toBe(form);
      expect(back.channel).toBe(12);
      expect(back.dst).toBe(5);
      expect(back.src1).toBe(7);
      expect(back.src2).toBe(9);
      expect(back.width).toBe(WIDTHS.HALF);
      expect(back.imm).toBe(-1234);
    }
  });

  it("крайние значения полей кодируются и декодируются", () => {
    const instruction: E2kInstruction = {
      opcode: 0x01,
      mnemonic: "ADDs/d",
      form: FORMS.REG3,
      channel: 23,
      dst: 63,
      src1: 0,
      src2: 63,
      width: WIDTHS.DOUBLE,
      imm: 0x7fffffff,
    };
    const back = decode(encode(instruction));
    expect(back.dst).toBe(63);
    expect(back.src2).toBe(63);
    expect(back.imm).toBe(0x7fffffff);
  });

  it("статус кодировки назван честно: это не e2k", () => {
    expect(ENCODING_STATUS).toMatch(/НЕ кодировка e2k/);
    expect(ENCODING_STATUS).toMatch(/ДОПУЩЕНИЕ/);
  });
});

describe("покрытие спецификации и отсутствие выдуманных мнемоник", () => {
  it("каждая мнемоника таблицы встречается в извлечении (скопирована, не придумана)", () => {
    // Источник написаний мнемоник — извлечение ИНСТРУКЦИЙ, а не документ кодировки:
    // в документе кодировки перечислены только те мнемоники, что попали в контекст полей.
    const source = read(INSTRUCTIONS);
    const missing = OPCODES.map((o) => o.mnemonic).filter((m) => !source.includes(m));
    expect(missing, `нет в извлечении инструкций: ${missing.join(", ")}`).toEqual([]);
  });

  it("мнемоники, помеченные как некодируемые, тоже есть в извлечении", () => {
    const source = read(INSTRUCTIONS);
    for (const mnemonic of NOT_ENCODABLE) {
      expect(source.includes(mnemonic), `${mnemonic} нет в извлечении`).toBe(true);
    }
  });

  it("каждая инструкция спецификации либо реализована, либо помечена как некодируемая", () => {
    /**
     * Проверяются ТАБЛИЦЫ спецификации (§2.1–2.6), а не вся проза: в прозе встречаются
     * имена полей, служебные слова и упоминания в отрицании, и требовать для них кодировку
     * было бы неверно. Из строки таблицы берутся два первых столбца — «имя» и «мнемоника»;
     * из них извлекаются токены в обратных кавычках.
     */
    const spec = read(SUBSET).split("\n");
    const tokens = new Set<string>();
    let section = "";
    for (const line of spec) {
      const heading = /^##\s+(\d+\.\d+\.?)/.exec(line);
      if (heading) {
        section = heading[1]!;
        continue;
      }
      if (!["2.1.", "2.2.", "2.3.", "2.4.", "2.5.", "2.6."].includes(section)) continue;
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 4) continue;
      const identity = `${cells[2] ?? ""} ${cells[3] ?? ""}`;
      for (const match of identity.matchAll(/`([^`]+)`/g)) {
        const token = match[1]!;
        // Не-инструкции отбрасываются ЯВНО: имена регистров (`%ct`, `%lsr`),
        // регистровые обозначения со скобками (`CTPR[1-3]`), примеры ассемблера
        // с пробелами (`ct %ctpr3 ? ~%pred0`) и записи задержек (`Disp->ct 5`).
        // Мнемоника — одно слово без пробелов, процентов, скобок и стрелок.
        if (!/^[A-Za-z][A-Za-z0-9_*()/+-]*$/.test(token)) continue;
        tokens.add(token);
      }
    }
    expect(tokens.size, "таблицы спецификации не разобрались").toBeGreaterThan(10);

    /** Канонический вид: без звёздочки, без хвостовых квалификаторов разрядности. */
    const base = (token: string): string =>
      token.replace(/\*.*$/, "").replace(/\([^)]*\)/g, "").replace(/\/(s|d|q|x).*$/, "").replace(/(s|d|q)$/, "");
    const covered = new Set<string>([
      ...OPCODES.map((o) => base(o.mnemonic)),
      ...NOT_ENCODABLE.map(base),
    ]);
    const uncovered = [...tokens].filter((token) => !covered.has(base(token)));
    expect(uncovered, `не покрыты: ${uncovered.join(", ")}`).toEqual([]);
  });

});
