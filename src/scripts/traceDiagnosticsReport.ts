/**
 * Замер диагностик на сохранённых исходниках (`runs/traces.jsonl`).
 *
 * Зачем: числа вида «`redeclare_var` — 82 случая» живут в документах
 * (`docs/language-v2-requirements.md`, `docs/trace-failure-report.md`), но
 * проверить их было нечем: датасет лежит не рядом с документом, и «замер» не
 * воспроизводился. Здесь замер воспроизводим одной командой.
 *
 * Что делает: берёт записи с полем `source.source`, перекомпилирует каждую
 * текущим компилятором и печатает распределение семантических диагностик, а
 * также имена переменных для `redeclare_var` и имена несуществующих системных
 * вызовов для `unknown_syscall`.
 *
 * Запуск: `npx tsx src/scripts/traceDiagnosticsReport.ts`
 *
 * **Что этот замер НЕ показывает.** Исходники записаны ДО правок промпта, поэтому
 * распределение — это baseline поведения модели на старом промпте. Уменьшение
 * доли после правки правила в промпте этим замером не проверяется: нужен новый
 * прогон генерации, и только тогда сравнение «до/после» что-то доказывает.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { compileSource } from "../compiler/compiler";

const ROOT = path.resolve(__dirname, "..", "..");
const TRACES = path.join(ROOT, "runs", "traces.jsonl");

function main(): void {
  if (!fs.existsSync(TRACES)) {
    console.error("[trace-diagnostics] нет " + TRACES);
    process.exit(1);
  }
  const lines = fs.readFileSync(TRACES, "utf8").split("\n").filter(Boolean);

  const kinds = new Map<string, number>();
  const redeclareNames = new Map<string, number>();
  const unknownSyscalls = new Map<string, number>();
  let sources = 0;

  for (const line of lines) {
    let rec: { source?: { source?: string } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const src = rec.source?.source;
    if (typeof src !== "string" || src.trim() === "") continue;
    sources++;
    let res;
    try {
      res = compileSource(src, { filename: "trace.osnova" });
    } catch {
      continue;
    }
    for (const e of res.semanticErrors) {
      kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
      const m = /'([^']+)'/.exec(e.message);
      const arg = m?.[1] ?? "?";
      if (e.kind === "redeclare_var") redeclareNames.set(arg, (redeclareNames.get(arg) ?? 0) + 1);
      if (e.kind === "unknown_syscall") unknownSyscalls.set(arg, (unknownSyscalls.get(arg) ?? 0) + 1);
    }
  }

  const sorted = (m: Map<string, number>): Array<[string, number]> =>
    [...m.entries()].sort((a, b) => b[1] - a[1]);

  console.log("[trace-diagnostics] исходников с source: " + sources + " (записей: " + lines.length + ")");
  console.log("\nдиагностика                 раз");
  for (const [k, n] of sorted(kinds)) console.log(k.padEnd(28) + String(n).padStart(4));

  console.log("\nredeclare_var: имена переменных (топ-12)");
  for (const [n, c] of sorted(redeclareNames).slice(0, 12)) console.log(String(c).padStart(4) + "  " + n);

  console.log("\nunknown_syscall: имена (топ-12)");
  for (const [n, c] of sorted(unknownSyscalls).slice(0, 12)) console.log(String(c).padStart(4) + "  " + n);
}

main();
