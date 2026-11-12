/**
 * ШАГ P3b НА МОДЕЛИ: протокол AST для `пусть`/присваивания/арифметики и сама программа.
 *
 * Здесь спрашивается ЧИСЛО у QEMU: проба обязана напечатать ровно эталонную ленту (85 клеток) и
 * вернуть 0, а исходная программа — вернуть 8 (`+`), 14 (`-` и `*`). Деление `/` на цели — названный
 * отказ `OSN-LOW-001` (`IR.div` формы не имеет); это фиксируется, а не обходится.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseV3 } from "../compiler-v3";
import { loweredProgram } from "../e2k/lowered";
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from "../e2k/elfMinimal";
import { runInQemu } from "../scripts/e2kQemuExec";
import {
  ИСХОДНИК_P3B,
  ИСХОДНИК_P3B_2_V3,
  ИСХОДНИК_P3B_3_V3,
  ИСХОДНИК_P3B_V3,
  ФАЙЛ_P3B,
  программаПротоколаP3b,
  эталоннаяЛента,
} from "../compiler-v3/parser-protocol-probe";

function опустить(источник: string) {
  const разбор = parseV3(источник, ФАЙЛ_P3B);
  expect(разбор.errors, "источник обязан разбираться").toEqual([]);
  return loweredProgram(источник, {
    filename: ФАЙЛ_P3B,
    parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
  });
}

function запустить(источник: string, имя: string): number | undefined {
  const итог = опустить(источник);
  expect(итог.ок, итог.ок ? "" : String(итог.отказ.отказы[0]?.причина)).toBe(true);
  if (!итог.ок) return undefined;
  const файл = path.resolve(".tmp", имя);
  fs.writeFileSync(
    файл,
    buildElfFromCode(итог.значение.bytes, MINIMAL_BASE, {
      writable: true,
      extraMemory: WRITE_ZONE_EXTRA_MEMORY,
    }).bytes,
  );
  return runInQemu(файл, { shim: true, timeoutMs: 30_000 })?.status;
}

describe("шаг P3b: протокол AST и исполнение", () => {
  it("проба печатает эталонную ленту (85 клеток) и возвращает 0", () => {
    const источник = программаПротоколаP3b(ИСХОДНИК_P3B, ФАЙЛ_P3B);
    const итог = опустить(источник);
    expect(итог.ок, итог.ок ? "" : String(итог.отказ.отказы[0]?.причина)).toBe(true);
    if (!итог.ок) return;
    const файл = path.resolve(".tmp", "p3b-probe.elf");
    fs.writeFileSync(
      файл,
      buildElfFromCode(итог.значение.bytes, MINIMAL_BASE, {
        writable: true,
        extraMemory: WRITE_ZONE_EXTRA_MEMORY,
      }).bytes,
    );
    const прогон = runInQemu(файл, { shim: true, timeoutMs: 30_000 });
    expect(прогон?.status, "проба обязана завершиться кодом 0").toBe(0);
    const получено = (прогон?.stdout ?? "")
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter((значение) => Number.isFinite(значение));
    expect(получено).toEqual(эталоннаяЛента(ИСХОДНИК_P3B, ФАЙЛ_P3B));
  });

  it("исходная программа: `+` даёт 8, `-` и `*` дают 14", () => {
    expect(запустить(ИСХОДНИК_P3B_V3, "p3b-plus.elf")).toBe(8);
    expect(запустить(ИСХОДНИК_P3B_2_V3, "p3b-minus-mul.elf")).toBe(14);
  });

  it("деление `/` — названный отказ IR.div, а не тихий неверный ответ", () => {
    const итог = опустить(ИСХОДНИК_P3B_3_V3);
    expect(итог.ок).toBe(false);
    if (итог.ок) return;
    expect(итог.отказ.отказы.map((запись) => запись.код)).toContain("OSN-LOW-001");
    expect(итог.отказ.отказы.map((запись) => запись.причина).join(" ")).toMatch(/IR\.div/);
  });
});
