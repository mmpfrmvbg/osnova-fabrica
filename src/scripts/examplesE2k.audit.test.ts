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

/**
 * ПРЕДЕЛ КАНАЛА НАБЛЮДЕНИЯ: код возврата процесса несёт **только младший байт**.
 *
 * Измерено 2026-09-27: тело `70000 div 10 = 7000` даёт код возврата **88** = 7000 mod 256
 * (`docs/hardware-debt.md` §3.31). Значит эталон ≥ 256 через этот оракул пройти **не может**:
 * он сравнивает `run.status` (то, что вернул WEXITSTATUS) с числом из `expected.txt` напрямую.
 *
 * Почему это отказ, а не тихое сравнение: сегодня таких записей в списке исполняемых нет, но
 * появиться они могут — и тогда `expected.txt` со значением 2350 «пройдёт» при коде возврата 46,
 * если 2350 ≡ 46 (mod 256) не выполнится... а если выполнится, пройдёт ложно. Оба исхода —
 * сравнение 8-битного канала с 24-битным эталоном, и оно обязано быть названо отказом, а не
 * зелёным. Настоящий канал для широких чисел — печать (`write`), пример `42` (978).
 */
class ObservationChannelRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObservationChannelRefusal';
  }
}

/** Проверить, что эталон наблюдаем через канал возврата; иначе — названный отказ. */
function checkObservable(dir: string, expected: string): void {
  const value = Number(expected);
  if (!Number.isInteger(value)) return; // нечисловой эталон сверяется как текст
  if (value >= 0 && value <= 255) return;
  throw new ObservationChannelRefusal(
    `«${dir}»: эталон ${String(value)} не наблюдается через код возврата — канал несёт только младший ` +
      `байт, и ${String(value)} неотличимо от ${String(value % 256)}. Нужен канал, отдающий число целиком ` +
      `(печать, \`write\`), либо статус записи обязан остаться «нет» ` +
      `(docs/hardware-debt.md §3.31: тело \`70000 div 10\` даёт код 88)`,
  );
}

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

  it("сторож канала наблюдения: широкий эталон через код возврата отвергается с причиной", () => {
    // НЕГАТИВНЫЙ КОНТРОЛЬ сторожа: если бы он молчал, запись с эталоном 2350 однажды «прошла» бы
    // по младшему байту. Проверяются обе стороны: широкий эталон отвергается, узкий — пропускается.
    expect(() => checkObservable("проба-широкая", "2350"), "эталон ≥ 256 обязан быть отвергнут").toThrow(
      ObservationChannelRefusal,
    );
    expect(() => checkObservable("проба-широкая", "2350")).toThrow(/младший байт/u);
    expect(() => checkObservable("проба-узкая", "181")).not.toThrow();
    expect(() => checkObservable("проба-граница", "255")).not.toThrow();
    expect(() => checkObservable("проба-за-границей", "256")).toThrow(ObservationChannelRefusal);
  });

  for (const e of declared) {
    it(`цель: ${e.dir} — ${expectedOf(e.dir)}`, () => {
      if (!available) return;
      const source = fs.readFileSync(path.join(EXAMPLES, e.dir, entryOf(e.dir)), "utf-8");
      const run = runOnE2k(source, `e2k-corpus-${e.dir}.elf`);
      expect(run.refused, `непонижённые носители: ${run.refused.join("; ")}`).toEqual([]);
      const expected = expectedOf(e.dir);
      // Отказ идёт ПЕРВЫМ: сравнение 8-битного канала с широким эталоном не должно доходить до
      // сверки, иначе оно либо ложно пройдёт (совпадение по модулю 256), либо упадёт без причины.
      checkObservable(e.dir, expected);
      expect(run.status, `код возврата ${e.dir} (эталон ${expected})`).toBe(Number(expected));
    });
  }
});
