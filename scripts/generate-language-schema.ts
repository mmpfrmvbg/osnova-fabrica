#!/usr/bin/env tsx
import * as fs from "fs";
import * as path from "path";
import { serializeLanguageSchema } from "../src/compiler/language-schema";

function main(): void {
  const target = path.resolve(process.cwd(), "docs", "osnova", "language-schema.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, serializeLanguageSchema(), "utf-8");
  console.log(`[generate:language-schema] written ${target}`);
}

main();
