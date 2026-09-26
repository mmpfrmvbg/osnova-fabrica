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
import { createHash } from "node:crypto";
import { readExamples } from "./examplesIndex";
import { SHIM_REASON, buildElfImage, runOnE2k, shimAvailable } from "./e2kProgramRun";

const ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLES = path.join(ROOT, "examples");

/**
 * ХЕШ ОБРАЗА ПРИМЕРА №1 — СНЯТ С АРТЕФАКТА ОРАКУЛА ВЛАДЕЛЬЦА.
 *
 * `src/e2k/e2kArraysQemu.test.ts` (проверка «FIR целиком: 181») собирает образ
 * своим конвейером и пишет его в `.tmp/e2k-heap-fir.elf`. Мой оракул корпуса
 * собирает образ СВОИМ конвейером — копией, потому что `src/e2k/**` заморожен.
 * Два пути сборки обязаны давать ОДИН образ; расхождение здесь означает тихое
 * расхождение образов, а не «другой, но правильный» путь.
 *
 * Замер: `npm run gate:qemu` (11 файлов, 58 проверок) → sha256 артефакта
 * A75774DCB72FB6EC0B27651173106D90E8015EA670E53CD317920094864315AC.
 *
 * Когда владелец вынесет конвейер в `src/e2k/programImage.ts`, эта проверка
 * заменяется прямым импортом, а копия конвейера удаляется: сверять станет нечего.
 */
const EXPECTED_FIR_IMAGE_SHA256 = "a75774dcb72fb6ec0b27651173106d90e8015ea670e53cd317920094864315ac";

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

/** Хеш образа ELF, собранного моим конвейером. */
function imageHash(source: string): string {
  return createHash("sha256").update(buildElfImage(source)).digest("hex");
}

describe("корпус на цели: объявленное исполняется в модели", () => {
  it("конвейер корпуса и конвейер владельца дают ОДИН образ (пример №1)", () => {
    // Страховка от расхождения двух путей сборки: сверяется хеш, снятый с
    // артефакта оракула владельца. Красное здесь — не «другой образ», а признак
    // того, что один из конвейеров изменился, и оба числа требуют перемера.
    const source = fs.readFileSync(path.join(EXAMPLES, "01-свёртка-fir", "main.osnova"), "utf-8");
    expect(imageHash(source), "образ примера №1, собранный конвейером корпуса").toBe(
      EXPECTED_FIR_IMAGE_SHA256,
    );
  });

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
