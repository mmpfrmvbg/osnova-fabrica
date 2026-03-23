#!/usr/bin/env tsx
import * as fs from "fs";
import * as path from "path";
import { serializeLanguageSchema } from "../src/compiler/language-schema";

function main(): void {
  const target = path.resolve(process.cwd(), "docs", "osnova", "language-schema.json");
  if (!fs.existsSync(target)) {
    console.error("[check:language-schema] docs/osnova/language-schema.json is missing.");
    console.error("Run: npm run generate:language-schema");
    process.exit(1);
  }

  const expected = serializeLanguageSchema();
  const actual = fs.readFileSync(target, "utf-8");
  if (expected !== actual) {
    console.error("[check:language-schema] Schema is out of sync with compiler sources.");
    console.error("Run: npm run generate:language-schema");
    process.exit(1);
  }

  console.log("[check:language-schema] OK");
}

main();
