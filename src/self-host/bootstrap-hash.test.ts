/**
 * Оракул пересборки self-host: артефакт обязан совпадать со свежей сборкой.
 *
 * Повод: на момент аудита 22 из 24 коммитнутых `.osvbc.json` **разошлись** со
 * свежей сборкой — они были сгенерированы до появления поля `pure` в процедурах.
 * Это тот же класс ошибки, что «память врёт»: тесты грузили устаревший байткод и
 * проверяли не то, что производит текущий компилятор.
 *
 * Две проверки:
 * 1. **Детерминизм** — две сборки одного исходника дают одинаковый sha256.
 *    Без него хеш-оракул бессмыслен, а диффы артефактов шумят.
 * 2. **Отсутствие дрейфа** — sha256 свежей сборки равен sha256 файла на диске.
 *    Артефакты сериализуются так же, как `osnova compile`: `JSON.stringify(module,
 *    null, 2)`.
 *
 * Артефакты без парного `.osnova` (рукописные фикстуры) пропускаются: их
 * источник — не компилятор.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { compileSource } from "../compiler/compiler";

const DIR = __dirname;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Сборка исходника ровно в той сериализации, что пишет `osnova compile`. */
function build(sourcePath: string): string {
  // Имя файла передаётся намеренно: `osnova compile` зовёт компилятор с
  // `filename: path.basename(inputPath)`, и после БЛОК 3 (пункт 1, «файл =
  // модуль») это уже не деталь диагностики, а ИСТОЧНИК имени модуля. Без имени
  // файла исходник без шапки `модуль имя` собрался бы под именем «вход», и
  // артефакт разошёлся бы с тем, что пишет CLI, — причём молча.
  const compiled = compileSource(fs.readFileSync(sourcePath, "utf-8"), {
    filename: path.basename(sourcePath),
  });
  if (!compiled.module) {
    const errors = [
      ...compiled.lexerErrors,
      ...compiled.parserErrors,
      ...compiled.compilerErrors,
    ].map((e) => e.message);
    throw new Error(`${path.basename(sourcePath)}: не компилируется — ${errors.join("; ")}`);
  }
  return JSON.stringify(compiled.module, null, 2);
}

/** Пары «исходник + артефакт», где есть оба файла. */
const PAIRS = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".osnova"))
  .map((f) => ({ source: f, artifact: f.replace(/\.osnova$/, ".osvbc.json") }))
  .filter((p) => fs.existsSync(path.join(DIR, p.artifact)))
  .sort((a, b) => a.source.localeCompare(b.source));

describe("self-host: артефакт совпадает со свежей сборкой", () => {
  it("есть что проверять (пары найдены)", () => {
    expect(PAIRS.length).toBeGreaterThan(0);
  });

  it("повторная сборка детерминирована (sha256 до и после)", () => {
    const unstable: string[] = [];
    for (const { source } of PAIRS) {
      const p = path.join(DIR, source);
      if (sha256(build(p)) !== sha256(build(p))) unstable.push(source);
    }
    expect(unstable, `недетерминированная сборка:\n${unstable.join("\n")}`).toEqual([]);
  });

  for (const { source, artifact } of PAIRS) {
    it(`${artifact} не устарел`, () => {
      const fresh = build(path.join(DIR, source));
      const onDisk = fs.readFileSync(path.join(DIR, artifact), "utf-8");
      if (sha256(fresh) !== sha256(onDisk)) {
        expect.fail(
          `${artifact} разошёлся со свежей сборкой ${source} ` +
            `(${fresh.length} байт против ${onDisk.length}). ` +
            `Пересобрать: npx tsx src/compiler/cli.ts ${source}`,
        );
      }
      expect(sha256(fresh)).toBe(sha256(onDisk));
    });
  }
});
