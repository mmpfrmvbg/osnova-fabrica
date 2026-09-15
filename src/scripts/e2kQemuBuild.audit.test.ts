/**
 * ОРАКУЛ СБОРКИ QEMU-e2k.
 *
 * # Что проверяется
 *
 * Постановка требует одного из двух: либо `qemu-e2k` собран (тогда — путь, версия, CPU), либо в
 * отчёте записана **точная** причина, почему нет. Тест проверяет именно эту развилку, а не текст:
 *
 * 1. **Если бинарь есть** — он обязан отвечать на `--version`, а документ обязан называть его
 *    путь и версию; иначе проверка красная.
 * 2. **Если бинаря нет** — документ обязан содержать причину с указанием шага, на котором
 *    остановилось, и точной команды. Кроме того проверяется, что причина **не устарела**: если
 *    в окружении появились `sh`, C-компилятор и `make`, тест краснеет и требует перепроверить
 *    сборку, а не повторять старое «не собралось».
 * 3. **Дерево порта e2k** (когда копия есть) — сверяется с документом: версия QEMU, цель
 *    `e2k-linux-user`, список CPU из `target/e2k/cpu.c`.
 *
 * # Негативный контроль
 *
 * Проверяльщик «собранного бинаря» прогоняется на несуществующем пути и на файле, который
 * `--version` не отвечает.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const ROOT = path.resolve(__dirname, "..", "..");
const DOC = path.join(ROOT, "docs", "e2k-qemu-build.md");
const SOURCES = path.join(ROOT, ".tmp", "e2k-sources");
const TREE = path.join(SOURCES, "qemu-e2k", "qemu");
const ARCHIVE = path.join(SOURCES, "qemu-e2k.tar.gz");

/** Ожидаемый путь собранного бинаря — он же назван в документе. */
export const BINARY = path.join(SOURCES, "qemu-e2k", "build", "qemu-e2k");

/** Есть ли в PATH исполняемая программа (без падения, если её нет). */
function toolPresent(name: string): boolean {
  const probe = process.platform === "win32" ? "where.exe" : "which";
  try {
    execFileSync(probe, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Проверить собранный бинарь: существует и отвечает на `--version`. */
export function checkBuiltBinary(file: string): { ok: boolean; version?: string; problem?: string } {
  if (!fs.existsSync(file)) return { ok: false, problem: `бинарника нет: ${file}` };
  try {
    const output = execFileSync(file, ["--version"], { encoding: "utf-8", timeout: 30_000 });
    const version = output.split(/\r?\n/)[0]?.trim() ?? "";
    if (version === "") return { ok: false, problem: "бинарь не ответил на --version" };
    return { ok: true, version };
  } catch (error) {
    return { ok: false, problem: `бинарь не запускается: ${error instanceof Error ? error.message : String(error)}` };
  }
}

describe("сборка QEMU-e2k", () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf-8") : "";

  it("документ существует и называет путь бинаря", () => {
    expect(fs.existsSync(DOC), "нет docs/e2k-qemu-build.md").toBe(true);
    expect(doc).toContain(".tmp/e2k-sources/qemu-e2k/build/qemu-e2k");
  });

  it("развилка «собран / не собран» разрешена: путь, версия или точная причина", () => {
    const built = checkBuiltBinary(BINARY);
    if (built.ok) {
      expect(doc, "бинарь собран, а путь не записан").toContain(BINARY.replace(/\\/g, "/"));
      expect(doc, "бинарь собран, а версия не записана").toContain("qemu-e2k version");
      return;
    }
    // Не собран: причина обязана быть записана шагом и командой.
    expect(doc, "нет отметки «НЕ СОБРАН»").toMatch(/НЕ СОБРАН/);
    expect(doc, "не назван шаг, на котором остановилось").toMatch(/Шаг, на котором остановилось/);
    expect(doc, "не записана точная команда").toContain("./configure --target-list=e2k-linux-user --disable-docs");
    expect(doc, "не названа отсутствующая POSIX-оболочка").toMatch(/`sh`\s*\|\s*\*\*НЕТ\*\*/);
    expect(doc, "нет ссылки на требование meson.build к sh").toMatch(/meson\.build:78/);
  });

  it("причина не устарела: инструментов сборки в окружении по-прежнему нет", () => {
    if (checkBuiltBinary(BINARY).ok) return;
    const tools = ["sh", "gcc", "cc", "clang", "make", "meson"].filter(toolPresent);
    expect(
      tools,
      `инструменты появились (${tools.join(", ")}) — причину «не собралось» нужно перепроверить, а не повторять`,
    ).toEqual([]);
  });

  it("дерево порта e2k совпадает с документом", () => {
    if (!fs.existsSync(TREE)) {
      const archivePresent = fs.existsSync(ARCHIVE);
      expect(doc).toContain("qemu-e2k.tar.gz");
      if (!archivePresent) return; // копии нет — проверять нечего, и это сказано документом
      throw new Error("архив есть, а дерево не распаковано — документ описывает не то состояние");
    }
    const version = fs.readFileSync(path.join(TREE, "VERSION"), "utf-8").trim();
    expect(doc).toContain(version);
    const target = fs.readFileSync(path.join(TREE, "configs", "targets", "e2k-linux-user.mak"), "utf-8");
    expect(target).toContain("TARGET_ARCH=e2k");
    const cpu = fs.readFileSync(path.join(TREE, "target", "e2k", "cpu.c"), "utf-8");
    const models = [...cpu.matchAll(/DEFINE_E2K_CPU_TYPE\("([a-z0-9-]+)"/g)].map((match) => match[1]!);
    expect(models).toEqual([
      "elbrus-v2",
      "elbrus-v3",
      "elbrus-v4",
      "elbrus-v5",
      "elbrus-v6",
      "elbrus-v7",
    ]);
    for (const model of models) expect(doc, `модель ${model} не названа`).toContain(model);
  });

  it("файлы порта, названные в документе, существуют", () => {
    if (!fs.existsSync(TREE)) return;
    const named = [
      "target/e2k/syllab-format.h",
      "target/e2k/instr-bits.h",
      "target/e2k/opcode-tables.h",
      "target/e2k/mas-format.h",
      "target/e2k/decoder.c",
      "target/e2k/disas.c",
      "target/e2k/cpu.c",
    ];
    const missing = named.filter((file) => !fs.existsSync(path.join(TREE, file)));
    expect(missing).toEqual([]);
  });

  it("негативный контроль: выдуманный бинарь не проходит", () => {
    const fake = checkBuiltBinary(path.join(SOURCES, "qemu-e2k", "build", "нет-такого-qemu"));
    expect(fake.ok).toBe(false);
    expect(fake.problem).toMatch(/бинарника нет/);

    const notExecutable = checkBuiltBinary(path.join(SOURCES, "qemu-e2k.tar.gz"));
    if (process.platform === "win32") {
      // Архив как «бинарь»: Windows либо откажет в запуске, либо запустит не то — в любом
      // случае ответа «qemu-e2k version …» нет, и проверяльщик обязан это заметить.
      expect(notExecutable.ok).toBe(false);
    }
  });
});
