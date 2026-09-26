/**
 * ЗОНДЫ ДЛЯ ЖИВОЙ МАШИНЫ — то, что не является примером корпуса.
 *
 * # Зачем отдельно от кита
 *
 * Кит (`src/scripts/e2kHardwareKit.ts`, автор — владелец) собирается ИЗ корпуса:
 * берутся примеры с `meta.e2k.status === "работает"`, у каждого — ожидаемый
 * результат из `expected.txt`. Зонды устроены иначе: у них нет эталона VM,
 * который машина обязана повторить, — у них есть ВОПРОС к машине и два возможных
 * ответа. Поэтому они лежат отдельно, в `tools/e2k-hardware/probes/`, а их
 * таблица — `probes.tsv` — не смешивается с `expected.tsv` (иначе сторож
 * «кит не отстал от корпуса» перестал бы значить то, что написано).
 *
 * Запуск: `npx tsx src/scripts/e2kHardwareProbes.ts`
 * Кладёт образы в `tools/e2k-hardware/bin/` рядом с образами кита и пишет
 * `probes.tsv` (имя, sha256, что означает какой код возврата).
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import { buildElfImage } from "./e2kProgramRun";

const ROOT = path.resolve(__dirname, "..", "..");
const KIT = path.join(ROOT, "tools", "e2k-hardware");
const PROBES = path.join(KIT, "probes");
const BIN = path.join(KIT, "bin");

/** Что означает код возврата: у зонда два ожидания, а не одно. */
interface ProbeNote {
  file: string;
  question: string;
  answers: string;
}

const NOTES: ProbeNote[] = [
  {
    file: "probe-rem.osnova",
    question: "знак остатка через вызов `система.математика.остаток(0 - 7, 3)` (вопрос 3 доступа: руководство §10.3.3 против порта)",
    answers: "код 255 = −1, как обещает руководство МЦСТ §10.3.3; код 0 = 0, как даёт порт (канон §13.6a, docs/hardware-debt.md §3.21); VM даёт −1",
  },
  {
    file: "probe-bool.osnova",
    question: "доходит ли булев литерал `истина` до цели",
    answers: "образ не собирается: отказ «операция const.true не выражается оболочкой» — это граница языка на цели, а не дефект модели",
  },
];

const rows: string[] = ["# зонд\tsha256\tчто означает код возврата"];
fs.mkdirSync(BIN, { recursive: true });
for (const note of NOTES) {
  const source = fs.readFileSync(path.join(PROBES, note.file), "utf-8");
  const elf = path.join(BIN, `${note.file.replace(/\.osnova$/u, "")}.elf`);
  let hash: string;
  try {
    const bytes = buildElfImage(source);
    fs.writeFileSync(elf, bytes);
    hash = createHash("sha256").update(bytes).digest("hex");
  } catch (e) {
    // Названный отказ — тоже результат: зонд остаётся в таблице без образа.
    hash = `НЕ СОБИРАЕТСЯ: ${e instanceof Error ? e.message : String(e)}`;
  }
  rows.push(`${note.file}\t${hash}\t${note.answers}`);
  console.log(`${note.file}: ${hash.slice(0, 40)}${hash.length > 40 ? "…" : ""}`);
  console.log(`  вопрос: ${note.question}`);
}
fs.writeFileSync(path.join(KIT, "probes.tsv"), `${rows.join("\n")}\n`, "utf-8");
console.log(`зондов: ${String(NOTES.length)}; таблица — tools/e2k-hardware/probes.tsv`);
