#!/usr/bin/env node
/**
 * Минимальный CLI для osnova-runtime (app-manifest-v0.1.md, протокол лаунчер ↔ рантайм).
 *
 * Запуск: npx tsx src/tools/osnova-runtime/cli.ts run --manifest ./app.osapp.yaml
 * или после сборки: node dist/tools/osnova-runtime/cli.js run --manifest ./app.osapp.yaml
 */

import { run } from "./run";

const args = process.argv.slice(2);
const subcommand = args[0];

if (subcommand === "run") {
  run(args.slice(1))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
} else {
  console.error("Usage: osnova-runtime run --manifest <path> [options]");
  console.error("  --package <path>   App package directory (default: directory of manifest)");
  console.error("  --module <name>   Entry module (default: from manifest)");
  console.error("  --procedure <name> Entry procedure (default: from manifest)");
  console.error("  --args <json>     Entry arguments (default: from manifest)");
  console.error("  --ui <kind>       window | tray | cli | service");
  console.error("  --single-instance");
  process.exit(1);
}
