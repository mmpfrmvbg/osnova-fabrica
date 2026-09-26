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
import { buildElfFromCode } from "../e2k/elfMinimal";
import { runInQemu } from "./e2kQemuExec";
import { WINDOW_PROBE_BASE, WINDOW_PROBE_MARK, windowProbeProgram } from "./e2kWindowProbe";

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

/**
 * ЗОНДЫ ОКНА: проверяются НА МОДЕЛИ до записи в кит.
 *
 * Контроль (`%r7`, регистр внутри окна модели) обязан дать 42 — иначе конструкция негодна и
 * зонд на машину не идёт. Вопрос (`%r8`) на модели обязан дать НЕ 42: там ловушка.
 * Замер свипом `.tmp/debug-window-probe.ts`: %r4…%r7 → 42, %r8, %r9 → 9.
 */
interface WindowProbe {
  name: string;
  register: number;
  mustBe42: boolean;
  answers: string;
}

const WINDOW_PROBES: WindowProbe[] = [
  {
    name: "probe-window-control.elf",
    register: 7,
    mustBe42: true,
    answers: `контроль: код ${String(WINDOW_PROBE_MARK)} — запись в %r7 у вызываемой проходит (регистр внутри окна модели)`,
  },
  {
    name: "probe-window.elf",
    register: 8,
    mustBe42: false,
    answers: `ВОПРОС к машине: код ${String(WINDOW_PROBE_MARK)} — окно вызываемой ШИРЕ восьми регистров (модель говорит 8); код 9 или иной — модель права`,
  },
];

function checkWindowProbes(rows: string[]): void {
  const problems: string[] = [];
  for (const probe of WINDOW_PROBES) {
    const elf = buildElfFromCode(windowProbeProgram(probe.register), WINDOW_PROBE_BASE).bytes;
    const file = path.join(BIN, probe.name);
    fs.mkdirSync(BIN, { recursive: true });
    fs.writeFileSync(file, elf);
    const status = runInQemu(file, { shim: true, timeoutMs: 30_000 })?.status ?? null;
    const ok = probe.mustBe42 ? status === WINDOW_PROBE_MARK : status !== WINDOW_PROBE_MARK;
    if (!ok) {
      problems.push(
        `${probe.name}: %r${String(probe.register)} → статус ${String(status)}; ожидалось ` +
          `${probe.mustBe42 ? String(WINDOW_PROBE_MARK) : `не ${String(WINDOW_PROBE_MARK)}`}`,
      );
      continue;
    }
    const hash = createHash("sha256").update(elf).digest("hex");
    console.log(`${probe.name}: %r${String(probe.register)} → ${String(status)} — сходится`);
    rows.push(`${probe.name}\t${hash}\t${probe.answers}`);
  }
  if (problems.length > 0) {
    // Зонд, который ничего не проверяет, на машину не отправляется: таблица не пишется вовсе.
    throw new Error(`самопроверка зондов окна не сошлась:\n${problems.join("\n")}`);
  }
}
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
checkWindowProbes(rows);
fs.writeFileSync(path.join(KIT, "probes.tsv"), `${rows.join("\n")}\n`, "utf-8");
console.log(`зондов: ${String(NOTES.length)}; таблица — tools/e2k-hardware/probes.tsv`);
