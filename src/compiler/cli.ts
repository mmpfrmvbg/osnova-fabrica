#!/usr/bin/env node
/**
 * CLI: osnova-compile input.osnova [-o output.osvbc.json] [--warn-deprecated] [--diagnostics=json]
 *
 * Логика — в `./cliCompile` (её проверяет оракул); здесь только проброс argv.
 */

import { runCompileCli } from "./cliCompile";

process.exit(runCompileCli(process.argv.slice(2)));
