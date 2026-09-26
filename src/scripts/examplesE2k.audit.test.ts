/**
 * ОРАКУЛ ЦЕЛИ ДЛЯ КОРПУСА ПРИМЕРОВ: тот же эталон, но на e2k.
 *
 * # Зачем отдельный файл
 *
 * Требование к корпусу: программа, **объявленная исполняемой на e2k**, обязана
 * исполняться на e2k — против ТОГО ЖЕ `expected.txt`, что и на VM. Две
 * независимые реализации дают одно число, одна из них — на цели. Это и есть
 * сквозная проверка, из которой строится пайплайн.
 *
 * # Почему в шлюзе `gate:qemu`, а не в полном прогоне
 *
 * Файл зависит от внешнего ресурса (`qemu-e2k` под шимом): в полном прогоне
 * такой оракул иногда падает, его падение перестаёт означать дефект и вместе с
 * ним обесценивается весь полный прогон (`docs/verification-debt.md`, случай 12).
 * Тот же случай, что у оракулов цели владельца.
 *
 * # Что здесь НЕ проверяется
 *
 * Что так поведёт себя железо: QEMU — модель. И что программа без объявления
 * «e2k: работает» исполнится на цели: нет объявления — нет и проверки.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { readExamples } from "./examplesIndex";
import { SHIM_REASON, runOnE2k, shimAvailable } from "./e2kProgramRun";

const ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLES = path.join(ROOT, "examples");

/** Примеры, объявленные исполняемыми на цели. */
const declared = readExamples(ROOT).filter((e) => e.meta.e2k.status === "работает");

/** Эталон примера: строка, с которой сверяется код возврата. */
function expectedOf(dir: string): string {
  const raw = fs.readFileSync(path.join(EXAMPLES, dir, "expected.txt"), "utf-8");
  return raw.split("\n").map((l) => l.replace(/\s+$/u, "")).filter((l) => l !== "").join("\n");
}

/** Точка входа: `main.osnova` либо единственный файл каталога. */
function entryOf(dir: string): string {
  const files = fs.readdirSync(path.join(EXAMPLES, dir)).filter((f) => f.endsWith(".osnova"));
  return files.includes("main.osnova") ? "main.osnova" : files[0]!;
}

const available = shimAvailable();

describe("корпус на цели: объявленное исполняется в модели", () => {
  it("шим и модель доступны — или причина названа", () => {
    if (!available) {
      // Причина называется, а не замалчивается: без неё «зелено» читалось бы
      // как «проверено», хотя не проверено ничего.
      expect(SHIM_REASON.length).toBeGreaterThan(10);
      return;
    }
    expect(available).toBe(true);
  });

  for (const e of declared) {
    it(`цель: ${e.dir} — ${expectedOf(e.dir)}`, () => {
      if (!available) return;
      const source = fs.readFileSync(path.join(EXAMPLES, e.dir, entryOf(e.dir)), "utf-8");
      const run = runOnE2k(source, `e2k-corpus-${e.dir}.elf`);
      expect(run.refused, `непонижённые носители: ${run.refused.join("; ")}`).toEqual([]);
      expect(run.status, `код возврата ${e.dir} (эталон ${expectedOf(e.dir)})`).toBe(
        Number(expectedOf(e.dir)),
      );
    });
  }
});
