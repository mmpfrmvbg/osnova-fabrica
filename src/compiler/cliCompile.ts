/**
 * Логика CLI компилятора (`osnova-compile`), отделённая от точки входа.
 *
 * Зачем отдельный модуль: `src/compiler/cli.ts` завершается `process.exit(main())`
 * на импорте, поэтому проверить флаги оракулом можно было только запуском
 * подпроцесса. Здесь — чистая функция `runCompileCli(argv, io)`: флаги, вывод,
 * код возврата; `cli.ts` остаётся тремя строками.
 *
 * Флаг `--warn-deprecated` (Стадия 2 плана v2) включает предупреждения об
 * устаревшем закрывающем `конец`. Предупреждение **информационное**: код
 * возврата не меняется, файл байткода пишется как обычно.
 */

import * as fs from "fs";
import * as path from "path";
import { compileSource } from ".";
import { reportCompileDiagnostics } from "./compileDiagnostics";
import type { ParseWarning } from "./parser";

/** Куда CLI пишет. Инъекция — ради оракула, а не ради гибкости. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Единственное место, где предупреждение превращается в строку вывода. */
export function formatDeprecatedWarning(w: ParseWarning): string {
  return `[устаревшее] строка ${w.line}:${w.column}: ${w.message}`;
}

export function runCompileCli(argv: string[], io: CliIo = DEFAULT_IO): number {
  let input: string | null = null;
  let output: string | null = null;
  let warnDeprecated = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-o" || argv[i] === "--output") {
      output = argv[++i] ?? null;
    } else if (argv[i] === "--warn-deprecated") {
      warnDeprecated = true;
    } else if (!argv[i]!.startsWith("-")) {
      input = argv[i]!;
    }
  }
  if (!input) {
    io.err("Использование: osnova-compile input.osnova [-o output.osvbc.json] [--warn-deprecated]");
    return 1;
  }
  const inputPath = path.resolve(input);
  if (!fs.existsSync(inputPath)) {
    io.err(`Файл не найден: ${inputPath}`);
    return 1;
  }
  const source = fs.readFileSync(inputPath, "utf-8");
  const result = compileSource(source, {
    baseDir: path.dirname(inputPath),
    filename: path.basename(inputPath),
    warnDeprecated,
  });
  // Вывод один на все точки входа — `./compileDiagnostics`. Здесь раньше жила
  // четвёртая копия сборки строк, и она уходила от остальных: семантическая
  // ошибка печаталась зеркалом `[semantic] …` без вида и файла.
  reportCompileDiagnostics(result, { error: io.err }, { source });
  // Предупреждения печатаются ДО проверки модуля: даже при отказе сборки
  // полезно видеть, что причина — не только устаревшая форма.
  for (const w of result.warnings) io.err(formatDeprecatedWarning(w));
  if (!result.module) {
    return 1;
  }
  const json = JSON.stringify(result.module, null, 2);
  const outPath = output ?? inputPath.replace(/\.osnova$/i, ".osvbc.json");
  fs.writeFileSync(path.resolve(outPath), json, "utf-8");
  io.out(`Скомпилировано: ${outPath}`);
  return 0;
}
