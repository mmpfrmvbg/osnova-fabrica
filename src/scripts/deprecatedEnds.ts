/**
 * Долг по устаревшим закрывающим словам `конец` (Стадия 2 плана v2).
 *
 * Модуль намеренно отделён от точки входа `deprecatedEndReport.ts`: тот
 * завершается `process.exit`, и импортировать его из оракула нельзя.
 *
 * Это **информационный** замер, а не gate: корпус и примеры написаны на
 * legacy-закрытиях осознанно (миграция — Стадия 3, после выкладки 0.1), поэтому
 * ненулевой долг сам по себе не отказ. Отказом считается только одно: если
 * предупреждение срабатывает БЕЗ флага — значит, сломана развязка «по умолчанию
 * молчит» (требование владельца), и это надо ловить сразу.
 *
 * Запуск: npx tsx src/scripts/deprecatedEndReport.ts
 */

import * as fs from "fs";
import * as path from "path";
import { compileSource } from "../compiler";

const FIXTURES_DIR = path.join(__dirname, "..", "runtime", "fixtures");

export interface DeprecatedRow {
  file: string;
  /** Сколько закрытий `конец` (одно на блок: процедура, модуль, пока, …). */
  count: number;
  /** Файл с ошибками компиляции — долг по нему не считается. */
  failed: boolean;
}

/** Куда пишет отчёт. */
export interface ReportIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Долг по каждому исходнику. Чистая функция над текстами: оракул проверяет её на
 * синтетических программах, а не на числах корпуса — числа меняются, механизм нет.
 */
export function deprecatedClosingsOf(sources: Array<{ file: string; text: string }>): DeprecatedRow[] {
  return sources.map(({ file, text }) => {
    const r = compileSource(text, { filename: file, warnDeprecated: true });
    const failed = r.lexerErrors.length > 0 || r.parserErrors.length > 0 || r.module === null;
    // Считаются ТОЛЬКО устаревшие закрытия `конец`. С БЛОК 3 (пункт 1) под тем же
    // флагом приходит и второй вид предупреждения — «шапка `модуль имя` без
    // закрытия»; он про шапку, а не про закрывающее слово, и в этот долг не
    // входит. Иначе число в отчёте перестало бы значить то, что написано в шапке.
    const closings = r.warnings.filter((w) => w.kind === "deprecated_closer").length;
    return { file, count: failed ? 0 : closings, failed };
  });
}

/**
 * Корпус замера: корень фикстур + `reg-parity` — тот же набор, на котором мерят
 * gate'ы (`src/scripts/corpus.ts`).
 */
export function fixtureSources(): Array<{ file: string; text: string }> {
  const dirs = [FIXTURES_DIR, path.join(FIXTURES_DIR, "reg-parity")];
  const out: Array<{ file: string; text: string }> = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".osnova"))
      .sort();
    for (const file of files) {
      const name = dir === FIXTURES_DIR ? file : `reg-parity/${file}`;
      out.push({ file: name, text: fs.readFileSync(path.join(dir, file), "utf-8") });
    }
  }
  return out;
}

/** Код возврата: 0 — долг измерен (любой), 1 — сломана развязка «по умолчанию». */
export function reportDeprecatedEnds(io: ReportIo): number {
  const sources = fixtureSources();
  const rows = deprecatedClosingsOf(sources);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const failed = rows.filter((r) => r.failed);

  for (const r of rows) {
    if (r.count > 0) io.out(`[устаревшее] ${r.file}: ${r.count}`);
  }
  io.out(
    `[устаревшее] итого: ${total} закрытий 'конец' в ${rows.length - failed.length} файлах корпуса`,
  );
  if (failed.length > 0) {
    // Ошибки компиляции — не долг Стадии 2; их ловят другие gate'ы, но молчать нельзя.
    for (const r of failed) io.err(`[устаревшее] ${r.file}: компиляция не прошла, долг не посчитан`);
  }

  const leaked = sources.filter((s) => compileSource(s.text, { filename: s.file }).warnings.length > 0);
  if (leaked.length > 0) {
    io.err(
      `ОШИБКА: предупреждение об устаревшем 'конец' сработало без --warn-deprecated в: ${leaked
        .map((s) => s.file)
        .join(", ")}`,
    );
    return 1;
  }
  io.out("[устаревшее] по умолчанию предупреждение выключено (проверено на том же корпусе)");
  return 0;
}
