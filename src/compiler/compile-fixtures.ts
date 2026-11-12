#!/usr/bin/env node
/**
 * Компилирует все .osnova в fixtures в .osvbc.json.
 * Запуск: npx tsx src/compiler/compile-fixtures.ts
 */

import * as fs from "fs";
import * as path from "path";
import { compileSource } from ".";

const FIXTURES_DIR = path.join(__dirname, "..", "runtime", "fixtures");

function main(): number {
  let exitCode = 0;
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".osnova"));

  for (const file of files) {
    const inputPath = path.join(FIXTURES_DIR, file);
    const outPath = inputPath.replace(/\.osnova$/i, ".osvbc.json");
    const source = fs.readFileSync(inputPath, "utf-8");
    // Имя файла и его каталог передаются ЯВНО — как в `cliCompile.ts:59`.
    //
    // Без `filename` канон «файл = модуль» называет модуль `вход` вместо имени
    // файла, и записанный артефакт расходится со сторожем
    // `src/runtime/artifactDrift.test.ts` (он собирает с `filename: basename`).
    // Без `baseDir` импорты `использовать модуль X из "y.osnova"` разрешаются от
    // текущего каталога, а не от каталога исходника.
    const result = compileSource(source, {
      baseDir: path.dirname(inputPath),
      filename: path.basename(inputPath),
    });

    if (result.lexerErrors.length > 0 || result.parserErrors.length > 0 || !result.module) {
      console.error(`[osnova-compile:all] Ошибка компиляции: ${file}`);
      for (const e of result.lexerErrors) console.error(`  Лексер ${e.line}:${e.column}: ${e.message}`);
      for (const e of result.parserErrors) console.error(`  Парсер ${e.line}:${e.column}: ${e.message}`);
      exitCode = 1;
      continue;
    }

    fs.writeFileSync(outPath, JSON.stringify(result.module, null, 2), "utf-8");
    console.log(`[osnova-compile:all] ${file} → ${path.basename(outPath)}`);
  }

  return exitCode;
}

process.exit(main());
