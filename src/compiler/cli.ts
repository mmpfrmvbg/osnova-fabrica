#!/usr/bin/env node
/**
 * CLI: osnova-compile input.osnova [-o output.osvbc.json]
 */

import * as fs from "fs";
import * as path from "path";
import { compileSource } from ".";
import { printParseError } from "./parser";

function main(): number {
  const args = process.argv.slice(2);
  let input: string | null = null;
  let output: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--output") {
      output = args[++i] ?? null;
    } else if (!args[i].startsWith("-")) {
      input = args[i];
    }
  }
  if (!input) {
    console.error("Использование: osnova-compile input.osnova [-o output.osvbc.json]");
    return 1;
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    console.error("Файл не найден:", inputPath);
    return 1;
  }
  const source = fs.readFileSync(inputPath, "utf-8");
  const result = compileSource(source);
  if (result.lexerErrors.length > 0) {
    for (const e of result.lexerErrors) console.error(`Лексер ${e.line}:${e.column}: ${e.message}`);
  }
  if (result.parserErrors.length > 0) {
    for (const e of result.parserErrors) printParseError(e, source);
  }
  if (!result.module) {
    return 1;
  }
  const json = JSON.stringify(result.module, null, 2);
  const outPath = output ?? inputPath.replace(/\.osnova$/i, ".osvbc.json");
  fs.writeFileSync(path.resolve(outPath), json, "utf-8");
  console.log("Скомпилировано:", outPath);
  return 0;
}

process.exit(main());
