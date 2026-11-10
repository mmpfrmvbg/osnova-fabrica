/**
 * ШАГ P4c-fix: ОСТАТОК БЕЗ `%` — `a - (a нацело b)*b` (2026-11-10).
 *
 * 1. ФОРМА: в источнике P4c НЕТ ни одного `%`, есть `нацело 65536` В ТОЧКЕ ВХОДА и остаток
 *    `пара - ток2 * 65536`; `нацело` стоит до вызова хвоста, а не в вызываемой.
 * 2. AST = ЭТАЛОН: лента 85 клеток совпадает целиком; два прогона на модели дают код 0.
 *    `loweredProgram` — 0 отказов; замер бюджета (настоящий конвейер, `.tmp/p4c-fix.ts`):
 *    вход `peakLive 11`, `used 10`, пул 10, 0 отказов; `IR.idiv` 4, `IR.rem` 0.
 *
 * N = 2: (1) форма/`%`/`нацело` во входе; (2) исполнение + AST. Откат на `%` краснит ОБА:
 * источник получает `%`, и понижение отказывает (наблюдаемо 2/2 красных; это не тихая подмена).
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseV3 } from "../compiler-v3";
import { loweredProgram } from "../e2k/lowered";
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from "../e2k/elfMinimal";
import { runInQemu } from "../scripts/e2kQemuExec";
import {
  ИСХОДНИК_P4B_ПУСТЬ,
  ФАЙЛ_P4C,
  программаПротоколаP4cПоОстатку,
  эталоннаяЛента,
} from "../compiler-v3/parser-protocol-probe";

function опустить(источник: string) {
  const разбор = parseV3(источник, ФАЙЛ_P4C);
  expect(разбор.errors, "проба обязана разбираться").toEqual([]);
  return loweredProgram(источник, {
    filename: ФАЙЛ_P4C,
    parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
  });
}

describe("шаг P4c-fix: `%` → `a - (a нацело b)*b`", () => {
  it("форма: `%` нет, `нацело` в точке входа, остаток — `пара - ток2*65536`", () => {
    const источник = программаПротоколаP4cПоОстатку();
    expect(источник).not.toMatch(/%/);
    expect(источник).toMatch(/пусть ток2 = пара нацело 65536/);
    expect(источник).toMatch(/пусть кон2 = пара - ток2 \* 65536/);
    const вход = источник.slice(источник.indexOf("действие главная"));
    expect(вход, "`нацело` обязано быть в точке входа").toMatch(/нацело 65536/);
    expect(вход).toMatch(/инд = выписать_пусть_хвост\(лента, инд, ток2 \* 65536 \+ кон2\)/);
  });

  it("AST=эталон (85), модель 2 прогона, код 0, 0 отказов", () => {
    const эталон = эталоннаяЛента(ИСХОДНИК_P4B_ПУСТЬ, ФАЙЛ_P4C);
    expect(эталон).toHaveLength(85);
    const итог = опустить(программаПротоколаP4cПоОстатку());
    expect(итог.ок, итог.ок ? "" : String(итог.отказ.отказы[0]?.причина)).toBe(true);
    if (!итог.ок) return;
    const файл = path.resolve(".tmp", "p4c-fix-model.elf");
    fs.writeFileSync(
      файл,
      buildElfFromCode(итог.значение.bytes, MINIMAL_BASE, {
        writable: true,
        extraMemory: WRITE_ZONE_EXTRA_MEMORY,
      }).bytes,
    );
    for (const прогон of [1, 2]) {
      const запуск = runInQemu(файл, { shim: true, timeoutMs: 60_000 });
      expect(запуск?.status, `прогон ${String(прогон)}: код 0`).toBe(0);
      const получено = String(запуск?.stdout ?? "")
        .split(/\r?\n/)
        .filter((с) => с.trim() !== "")
        .map((с) => Number(с.trim()));
      expect(получено, `прогон ${String(прогон)}: лента клетка в клетку`).toEqual(эталон);
    }
  });
});
