/**
 * Экспорт реестра языка в docs/osnova/language-schema.json.
 * Запуск: npx tsx src/tools/osnova-compiler/export-language-schema.ts
 */
import * as fs from "fs";
import * as path from "path";
import { LANGUAGE_REGISTRY, languageRegistryToJson } from "./language-registry";

const outPath = path.join(process.cwd(), "docs", "osnova", "language-schema.json");
const json = languageRegistryToJson(LANGUAGE_REGISTRY);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, json, "utf-8");
console.log(`[osnova-language] written ${outPath}`);
