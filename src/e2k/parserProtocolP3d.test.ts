/**
 * ШАГ P3d: сравнения и `нацело` — теги и ЧИСЛА с модели.
 *
 * Спрашивается не «собирается ли», а что модель считает: `если 5 > 0 … иначе …` даёт 1,
 * `7 нацело 2` даёт 3, все шесть сравнений сразу дают 6. Числа взяты двумя прогонами каждое.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseV3 } from "../compiler-v3";
import { loweredProgram } from "../e2k/lowered";
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from "../e2k/elfMinimal";
import { runInQemu } from "../scripts/e2kQemuExec";
import {
  ИСХОДНИК_P3D_ЕСЛИ_V3,
  ИСХОДНИК_P3D_НАЦЕЛО_V3,
  ИСХОДНИК_P3D_СРАВНЕНИЯ_V3,
  СВОБОДНЫЕ_СЛОТЫ_P3D,
  ТЕГИ_P3B,
  ТЕГИ_P3D,
  ТЕГИ_P3D_ВСЕ,
  ФАЙЛ_P3D,
} from "../compiler-v3/parser-protocol-probe";

function опустить(источник: string) {
  const разбор = parseV3(источник, ФАЙЛ_P3D);
  expect(разбор.errors, "источник обязан разбираться").toEqual([]);
  return loweredProgram(источник, {
    filename: ФАЙЛ_P3D,
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

describe("шаг P3d: теги сравнений и целочисленное деление", () => {
  it("теги: 27 из 32 слотов, `КОНЕЦ` не занят, свободны 27..31", () => {
    // В дереве у P3b ДВАДЦАТЬ тегов (не 23, как в тексте атома) — число проверяется, а не
    // переписывается: правило «семь новых тегов» важнее чужой арифметики.
    expect(Object.keys(ТЕГИ_P3B)).toHaveLength(20);
    expect(Object.keys(ТЕГИ_P3D)).toHaveLength(27);
    expect(ТЕГИ_P3D_ВСЕ).toHaveLength(27);
    expect(new Set(ТЕГИ_P3D_ВСЕ).size, "значения тегов не повторяются").toBe(27);
    expect(ТЕГИ_P3D.КОНЕЦ).toBe(23);
    expect(ТЕГИ_P3D.РАВНО).toBe(19);
    expect(ТЕГИ_P3D.НАЦЕЛО).toBe(26);
    for (const слот of СВОБОДНЫЕ_СЛОТЫ_P3D) expect(ТЕГИ_P3D_ВСЕ).not.toContain(слот);
  });

  it("`если 5 > 0 … иначе … конец если` даёт 1 (два прогона модели)", () => {
    expect(запустить(ИСХОДНИК_P3D_ЕСЛИ_V3, "p3d-if.elf")).toBe(1);
    expect(запустить(ИСХОДНИК_P3D_ЕСЛИ_V3, "p3d-if.elf")).toBe(1);
  });

  it("`7 нацело 2` даёт 3 (два прогона модели)", () => {
    expect(запустить(ИСХОДНИК_P3D_НАЦЕЛО_V3, "p3d-idiv.elf")).toBe(3);
    expect(запустить(ИСХОДНИК_P3D_НАЦЕЛО_V3, "p3d-idiv.elf")).toBe(3);
  });

  it("все шесть сравнений дают 6 — `==`, `!=`, `<`, `<=`, `>`, `>=` считаются", () => {
    expect(запустить(ИСХОДНИК_P3D_СРАВНЕНИЯ_V3, "p3d-cmp.elf")).toBe(6);
  });
});
