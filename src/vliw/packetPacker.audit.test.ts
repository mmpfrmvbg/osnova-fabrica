/**
 * АУДИТ: инъекция дефектов упаковщика не выходит за пределы негативного контроля.
 *
 * `PackDefects` существует ровно для одной цели: доказать, что gate упаковки
 * краснеет, когда правило снято. Если такой флаг появится в рабочем пути
 * (компилятор, VM, CLI), дефект станет настройкой, и gate перестанет что-либо
 * доказывать.
 *
 * Этот аудит — grep по исходникам: имена флагов допустимы только в перечисленных
 * файлах. Он же защищает от «тихой» передачи флага через объект опций: имя флага
 * встречается в исходнике буквально.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";

const SRC = path.resolve(__dirname, "..");

/** Файлы, которым разрешено упоминать флаги дефектов. */
const ALLOWED = new Set([
  path.join("vliw", "packetPacker.ts"), // определение
  path.join("vliw", "packGate.test.ts"), // негативный контроль в CI
  path.join("scripts", "pack-gate-negative.ts"), // негативный контроль по корпусу
]);

const FLAGS = ["ignoreRegisters", "ignoreSlots", "ignoreControlTransfer", "ignoreEntryPoints"];

function allSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      allSources(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("аудит: инъекция дефектов упаковщика ограничена негативным контролем", () => {
  const sources = allSources(SRC);

  it("источники вообще найдены", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it("флаги дефектов упоминаются только в разрешённых файлах", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const rel = path.relative(SRC, file);
      if (rel === path.join("vliw", "packetPacker.audit.test.ts")) continue; // сам этот файл
      if (ALLOWED.has(rel)) continue;
      const text = fs.readFileSync(file, "utf-8");
      for (const flag of FLAGS) {
        if (text.includes(flag)) offenders.push(`${rel}: ${flag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("каждый флаг определён ровно в одном месте — в типе PackDefects", () => {
    const packer = fs.readFileSync(path.join(SRC, "vliw", "packetPacker.ts"), "utf-8");
    for (const flag of FLAGS) {
      const definitions = packer.split("\n").filter((line) => line.trim().startsWith(`${flag}?:`));
      expect(definitions, `флаг ${flag}`).toHaveLength(1);
    }
  });

  it("упаковщик ещё не подключён к рабочему пути продукта", () => {
    // Сейчас `packInstructions` вызывает только инструмент измерений (`packGate`)
    // и тесты. Когда упаковка войдёт в компилятор или VM, этот аудит упадёт — и
    // это правильный момент, чтобы решить, где именно она включается и по какому
    // флагу. Молчаливое подключение было бы нежелательно.
    const productDirs = ["runtime", "compiler", "cli", "center", "pipeline-llm", "oracle"];
    const offenders: string[] = [];
    for (const file of sources) {
      const rel = path.relative(SRC, file);
      const top = rel.split(path.sep)[0]!;
      if (!productDirs.includes(top)) continue;
      if (fs.readFileSync(file, "utf-8").includes("packInstructions")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
