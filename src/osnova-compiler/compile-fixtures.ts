#!/usr/bin/env node
/**
 * Компилирует все .osnova в fixtures в .osvbc.json.
 * Запуск: npx tsx src/tools/osnova-compiler/compile-fixtures.ts
 * Кросс-платформенно (Node), без bash.
 */

import * as fs from "fs";
import * as path from "path";
import { compileSource } from "./compiler";

const FIXTURES_DIR = path.join(__dirname, "..", "osnova-runtime", "fixtures");

function main(): number {
  let exitCode = 0;
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".osnova"));

  for (const file of files) {
    const inputPath = path.join(FIXTURES_DIR, file);
    const outPath = inputPath.replace(/\.osnova$/i, ".osvbc.json");
    const source = fs.readFileSync(inputPath, "utf-8");
    const result = compileSource(source);

    if (result.lexErrors.length > 0 || result.parseErrors.length > 0 || !result.module) {
      console.error(`[osnova-compile:all] Ошибка компиляции: ${file}`);
      for (const e of result.lexErrors) console.error(`  Лексер ${e.line}:${e.column}: ${e.message}`);
      for (const e of result.parseErrors) console.error(`  Парсер ${e.line}:${e.column}: ${e.message}`);
      exitCode = 1;
      continue;
    }

    fs.writeFileSync(outPath, JSON.stringify(result.module, null, 2), "utf-8");
    console.log(`[osnova-compile:all] ${file} → ${path.basename(outPath)}`);
  }

  return exitCode;
}

process.exit(main());
