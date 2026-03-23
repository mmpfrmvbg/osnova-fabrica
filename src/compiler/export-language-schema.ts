import * as fs from "fs";
import * as path from "path";
import { serializeLanguageSchema } from "./language-schema";

const outPath = path.join(process.cwd(), "docs", "osnova", "language-schema.json");
const json = serializeLanguageSchema();
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, json, "utf-8");
console.log(`[osnova-language] written ${outPath}`);
