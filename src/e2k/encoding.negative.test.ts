/**
 * НЕГАТИВНЫЙ КОНТРОЛЬ КОДИРОВКИ: три дефекта и пять отказов декодирования.
 *
 * # Зачем отдельный файл
 *
 * Round-trip сам по себе ничего не доказывает, пока не показано, что он **способен
 * краснеть**. Здесь дефекты вносятся в байты, и проверяется, что кодировщик их замечает
 * либо расхождением после повторного кодирования, либо отказом декодирования.
 *
 * # Три дефекта (по заданию владельца)
 *
 * 1. **Бит в коде операции** — декодируется как другая операция, а повторное кодирование
 *    даёт другие байты: `encode(decode(broken)) !== broken`.
 * 2. **Бит в поле регистра** — декодируется как другая инструкция (другой номер регистра).
 * 3. **Лишний или потерянный байт** — декодирование отказывает с ошибкой длины.
 *
 * Плюс пять отказов декодирования: усечение, неизвестный код операции, установленный
 * резервный бит, зарезервированная форма, номер канала вне диапазона.
 *
 * # Чего контроль НЕ доказывает
 *
 * Соответствия битов железу e2k: кодировки e2k в руководстве нет
 * (`docs/e2k-encoding-raw.md`). Проверяется согласованность нашей оболочки с самой собой.
 */

import { describe, it, expect } from "vitest";
import { FORMS, INSTRUCTION_SIZE, WIDTHS, decode, encode, type E2kInstruction } from "./encoding";

const SAMPLE: E2kInstruction = {
  opcode: 0x01,
  mnemonic: "ADDs/d",
  form: FORMS.REG3,
  channel: 6,
  dst: 5,
  src1: 7,
  src2: 9,
  width: WIDTHS.HALF,
  imm: -1234,
};

describe("негативный контроль кодировки: три дефекта", () => {
  it("дефект 1: бит в коде операции ловится по ИНСТРУКЦИИ, а не по байтам", () => {
    const good = encode(SAMPLE);
    const broken = Uint8Array.from(good);
    broken[0] = 0x02; // SUBs/d вместо ADDs/d
    const decoded = decode(broken);
    // ВАЖНО: испорченные байты остаются ЛЕГАЛЬНОЙ инструкцией — просто другой.
    // Поэтому `encode(decode(broken)) === broken` сохраняется, и round-trip по байтам
    // такой дефект НЕ ловит. Ловит его сравнение инструкции с исходной.
    expect(Array.from(encode(decoded)), "байты перестали быть легальной инструкцией").toEqual(Array.from(broken));
    expect(decoded.mnemonic, "декодирование не заметило подмену кода операции").toBe("SUBs/d");
    expect(decoded.mnemonic).not.toBe(SAMPLE.mnemonic);
    // И байты испорченной инструкции больше не равны байтам исходной.
    expect(Array.from(good), "испорченные байты совпали с исходными").not.toEqual(Array.from(broken));
  });

  it("дефект 2: бит в поле регистра ловится расхождением значения", () => {
    const good = encode(SAMPLE);
    const broken = Uint8Array.from(good);
    broken[2] = (broken[2]! ^ 0x01) & 0xff; // младший бит регистра-приёмника
    const decoded = decode(broken);
    expect(decoded.dst, "декодирование не заметило подмену регистра").toBe(SAMPLE.dst! ^ 0x01);
    expect(decoded.dst).not.toBe(SAMPLE.dst);
    // И обратное кодирование подтверждает, что это другой регистр, а не исходный.
    expect(encode(decoded)[2]).toBe(decoded.dst);
  });

  it("дефект 3: лишний или потерянный байт ловится отказом декодирования", () => {
    const good = encode(SAMPLE);
    const short = Uint8Array.from(good.slice(0, INSTRUCTION_SIZE - 1));
    const long = Uint8Array.from([...good, 0x00]);
    expect(() => decode(short), "потерянный байт не отвергнут").toThrow(/ожидалось 10 байт/);
    expect(() => decode(long), "лишний байт не отвергнут").toThrow(/ожидалось 10 байт/);
  });
});

describe("негативный контроль кодировки: пять отказов декодирования", () => {
  const good = encode(SAMPLE);

  it("1. усечённые байты отвергаются", () => {
    expect(() => decode(good.slice(0, INSTRUCTION_SIZE - 1))).toThrow(/ожидалось 10 байт/);
  });

  it("2. неизвестный код операции отвергается", () => {
    const broken = Uint8Array.from(good);
    broken[0] = 0xff;
    expect(() => decode(broken)).toThrow(/неизвестный код операции/);
  });

  it("3. установленный резервный бит отвергается", () => {
    const broken = Uint8Array.from(good);
    broken[2] = broken[2]! | 0x40;
    expect(() => decode(broken)).toThrow(/резервные биты установлены в поле dst/);
  });

  it("4. зарезервированная форма отвергается", () => {
    const broken = Uint8Array.from(good);
    broken[1] = (broken[1]! & 0xf8) | 0x07;
    expect(() => decode(broken)).toThrow(/зарезервированная форма/);
  });

  it("5. номер канала вне диапазона отвергается", () => {
    const broken = Uint8Array.from(good);
    broken[1] = (broken[1]! & 0x07) | (28 << 3);
    expect(() => decode(broken)).toThrow(/номер канала вне диапазона/);
  });

  it("кодировщик отвергает инструкцию, несовместимую с таблицей операций", () => {
    // Форма перехода для арифметической операции: отказ на кодировании.
    expect(() => encode({ ...SAMPLE, form: FORMS.BRANCH })).toThrow(/недопустима/);
    // И несовпадение мнемоники и кода операции.
    expect(() => encode({ ...SAMPLE, mnemonic: "MULs/d" })).toThrow(/принадлежит/);
  });
});
