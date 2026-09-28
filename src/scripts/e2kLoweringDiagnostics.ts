/**
 * ОТКАЗ ПОНИЖЕНИЯ — НАБЛЮДАТЕЛЬ, КОТОРОГО НЕ БЫЛО.
 *
 * # Повод (замер 2026-09-28, пробы `.tmp/useful-probe-*.ts`)
 *
 * Конвейер цели умеет собирать образ и **собирает его даже тогда, когда часть носителей
 * отвергнута**: `src/e2k/programImage.ts` кладёт причины в `refused: string[]` и отдаёт
 * образ. Замер: `вернуть 17 % 5` — образ 112 байт, **1 отказ** (`IR.rem`: формы понижения
 * нет), инструкция в образ не попала. Это класс «программа собралась, а число неверное» —
 * самый дорогой, потому что не отказ, а тихая ложь.
 *
 * Кто это видит сегодня:
 *
 * | наблюдатель | что видит |
 * |---|---|
 * | `npx tsx src/cli.ts compile <файл>` | **ничего**: «Скомпилировано» и код 0 (замер: 1 строка, про цель ни слова) |
 * | `node dist/cli.js compile <файл>` | то же |
 * | оракул корпуса `src/scripts/examplesE2k.audit.test.ts` | отказы — но только у записей, объявленных «работает», и только в шлюзе `gate:qemu` |
 * | объявление записи (`examples/<запись>/meta.json`, поле `e2k.reason`) | рукописный текст: **устаревает молча** |
 * | журнал `runs/traces.jsonl` | линия e2k в него не пишет вовсе (замер: 0 записей из 7251 упоминают e2k) |
 *
 * # Что делает этот модуль
 *
 * Превращает `refused: string[]` в **записи с классом**: класс выводится из причины и
 * носителя, а не из сравнения строк. Строки для этого негодны по замеру: текст отказа несёт
 * ЗНАЧЕНИЕ (`константа пула #0 = Аня`), поэтому два одинаковых по причине отказа дают разные
 * строки, а два разных — могут совпасть по префиксу.
 *
 * **Кода у класса пока нет — и это намеренно.** Пространство кодов `OSN-LOW-*` принадлежит
 * плоскости `src/e2k/**` (контракт описан в отчёте); выдумывать чужие коды здесь запрещено
 * тем же правилом, что и в каталоге видов («выдумывать код нельзя»). Когда коды появятся,
 * читатель берёт `code`, а класс остаётся как расшифровка для человека.
 *
 * # Два режима
 *
 * - `e2kLoweringDiagnostics <файл.osnova> [--json]` — что будет с ЭТОЙ программой на цели;
 * - `e2kLoweringDiagnostics --corpus [--json]` — объявление корпуса против факта: расхождение
 *   «объявлено, но не проверено» называется вслух (замер: `06-циклы-пока` объявлен «нет»
 *   с причиной про печать, а понижение печати проходит — 0 отказов).
 *
 * Код возврата: 0 — образ собран без отказов; 1 — есть отказы или образ не собран; 2 — вызов.
 */
import * as fs from "fs";
import * as path from "path";
import { collectCompileDiagnostics } from "../compiler/compileDiagnostics";
import { compileSource } from "../compiler/compiler";
import { buildE2kImage } from "./e2kProgramRun";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Класс отказа понижения — «личность до кода».
 *
 * Разделение по ПРИЧИНЕ, а не по носителю: один и тот же `IR.invoke` отказывает и за
 * отсутствие операции в рантайме, и за неподъёмную константу — это разные классы.
 */
export type LoweringClass =
  | "язык"
  | "носитель-без-формы"
  | "константа-невыразима"
  | "вызов-вне-рантайма"
  | "раскладка"
  | "печать"
  | "обвязка"
  | "сборка-упала"
  | "класс-не-назван";

/** Одна запись об отказе цели. `code` появится, когда плоскость e2k назовёт коды (§отчёт). */
export interface LoweringDiagnostic {
  class: LoweringClass;
  code?: string;
  /** Мнемоника носителя IR, если отказ по носителю. */
  carrier?: string;
  /** Номер носителя в потоке (`#2`), если назван. */
  index?: number;
  message: string;
}

export interface LoweringReport {
  /** Собран ли образ. `true` при непустых отказах — и это худший случай: инструкции выброшены. */
  built: boolean;
  bytes?: number;
  used?: number;
  refusedTotal: number;
  diagnostics: LoweringDiagnostic[];
}

/**
 * Таблица «причина → класс». Исчерпывающая по замеру: тест требует, чтобы отказы корпуса
 * и проб разбирались ЦЕЛИКОМ, иначе появляется `класс-не-назван` и сторож краснеет.
 */
const MESSAGE_CLASSES: ReadonlyArray<{ match: RegExp; cls: LoweringClass }> = [
  { match: /формы понижения нет/, cls: "носитель-без-формы" },
  { match: /константа пула .* литералом e2k кодируются только целые/, cls: "константа-невыразима" },
  { match: /у рантайма массивов нет такой операции/, cls: "вызов-вне-рантайма" },
  { match: /цели переходов не пересчитаны|раскладка/, cls: "раскладка" },
];

/** Класс по дословной причине. Не назвался — `класс-не-назван`, а не «похоже на…». */
export function classifyReason(reason: string): LoweringClass {
  for (const row of MESSAGE_CLASSES) if (row.match.test(reason)) return row.cls;
  return "класс-не-назван";
}

/** Разбор строки отказа вида `#2 IR.rem: «IR.rem»: формы понижения нет — …`. */
export function parseRefusalText(refused: string): { index?: number; carrier?: string; reason: string } {
  const m = /^#(\d+)\s+(IR\.\w+):\s*(.*)$/s.exec(refused);
  if (m === null) return { reason: refused };
  return { index: Number(m[1]), carrier: m[2]!, reason: m[3]! };
}

/** Диагностика языка (с кодами `OSN-*`) — для случая, когда программа не компилируется. */
function languageDiagnostics(source: string, filename: string): LoweringDiagnostic[] {
  const result = compileSource(source, { filename });
  return collectCompileDiagnostics(result).map((d) => ({
    class: "язык" as const,
    code: d.code,
    message: `${d.phase}: ${d.message}`,
  }));
}

/** Класс исключения конвейера цели: имя и текст известны по замеру. */
function classifyThrown(error: unknown): LoweringClass {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "PrintCallRefusal" || /печать:/.test(message)) return "печать";
  if (name === "MultiReturnRefusal") return "обвязка";
  if (/раскладка отказала/.test(message)) return "раскладка";
  if (/программа не компилируется/.test(message)) return "язык";
  return "сборка-упала";
}

/**
 * Собрать диагностику цели для программы: что понизилось, что отвергнуто и каким классом.
 * Ничего не печатает и не бросает: отказ — это данные, а не исключение (кроме вызова).
 */
export function loweringDiagnosticsOf(source: string, filename = "вход.osnova"): LoweringReport {
  try {
    const image = buildE2kImage(source);
    const diagnostics: LoweringDiagnostic[] = image.refused.map((refused) => {
      const parsed = parseRefusalText(refused);
      return {
        class: classifyReason(parsed.reason),
        ...(parsed.carrier === undefined ? {} : { carrier: parsed.carrier }),
        ...(parsed.index === undefined ? {} : { index: parsed.index }),
        message: parsed.reason,
      };
    });
    return {
      built: true,
      bytes: image.bytes.length,
      used: image.used,
      refusedTotal: image.refused.length,
      diagnostics,
    };
  } catch (error) {
    const cls = classifyThrown(error);
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics: LoweringDiagnostic[] =
      cls === "язык" ? languageDiagnostics(source, filename) : [{ class: cls, message }];
    return { built: false, refusedTotal: diagnostics.length, diagnostics };
  }
}

/** Одна строка JSONL на запись — тот же принцип, что у `--diagnostics=json` компилятора. */
export function formatLoweringDiagnosticJson(d: LoweringDiagnostic): string {
  const fields: string[] = [`"class":${JSON.stringify(d.class)}`];
  if (d.code !== undefined) fields.push(`"code":${JSON.stringify(d.code)}`);
  if (d.carrier !== undefined) fields.push(`"carrier":${JSON.stringify(d.carrier)}`);
  if (d.index !== undefined) fields.push(`"index":${d.index}`);
  fields.push(`"message":${JSON.stringify(d.message)}`);
  return `{${fields.join(",")}}`;
}

/** Объявление корпуса против факта. Состояния названы словами, а не булевым «ок». */
export type CorpusVerdict =
  | "совпадает"
  | "ОБЪЯВЛЕНИЕ УСТАРЕЛО: «нет» с причиной про понижение, а понижение проходит"
  | "РАСХОЖДЕНИЕ: объявлено «работает», а понижение отказывает"
  | "вне понижения: причина называет другой слой";

export interface CorpusRow {
  dir: string;
  declared: string;
  layer: string;
  refused: number;
  built: boolean;
  /** Сколько отказов не подошло ни под одну строку таблицы причин (должно быть 0). */
  unnamed: number;
  verdict: CorpusVerdict;
}

/**
 * Пройти корпус и сверить объявление с фактом статической сборки.
 *
 * Правило сверки — по СЛОЮ, а не по одному статусу: у записей `layer: "канал наблюдения"`
 * (примеры 21 и 25) собираемый образ не противоречит объявлению «нет» — там усечён канал
 * возврата, а не понижение. Придираться к ним значило бы выдать ложное расхождение.
 */
export function corpusLoweringRows(examplesDir = path.join(ROOT, "examples")): CorpusRow[] {
  const rows: CorpusRow[] = [];
  for (const entry of fs.readdirSync(examplesDir).sort()) {
    const dir = path.join(examplesDir, entry);
    const metaPath = path.join(dir, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
      e2k?: { status?: string; layer?: string };
    };
    const main = fs.readdirSync(dir).find((f) => f.endsWith(".osnova"));
    if (main === undefined) continue;
    const source = fs.readFileSync(path.join(dir, main), "utf-8");
    const report = loweringDiagnosticsOf(source, main);
    const declared = meta.e2k?.status ?? "—";
    const layer = meta.e2k?.layer ?? "—";
    let verdict: CorpusVerdict = "совпадает";
    if (declared === "работает") {
      // Объявлено работающим: понижение обязано пройти без отказов. Иначе — расхождение.
      if (!report.built || report.refusedTotal > 0) {
        verdict = "РАСХОЖДЕНИЕ: объявлено «работает», а понижение отказывает";
      }
    } else if (layer !== "понижение") {
      // «Нет» по другой причине (канал наблюдения, модель): собираемый образ ей не противоречит.
      verdict = "вне понижения: причина называет другой слой";
    } else if (report.built && report.refusedTotal === 0) {
      verdict = "ОБЪЯВЛЕНИЕ УСТАРЕЛО: «нет» с причиной про понижение, а понижение проходит";
    }
    rows.push({
      dir: entry,
      declared,
      layer,
      refused: report.refusedTotal,
      built: report.built,
      unnamed: report.diagnostics.filter((d) => d.class === "класс-не-назван").length,
      verdict,
    });
  }
  return rows;
}

/** Точка входа CLI. Возвращает код возврата — её проверяет оракул. */
export function runLoweringDiagnosticsCli(argv: readonly string[]): number {
  const json = argv.includes("--json");
  const corpus = argv.includes("--corpus");
  const file = argv.find((a) => !a.startsWith("-"));

  if (corpus) {
    const rows = corpusLoweringRows();
    const bad = rows.filter((r) => r.verdict !== "совпадает" && r.verdict !== "вне понижения: причина называет другой слой");
    for (const r of rows) {
      if (json) {
        console.log(JSON.stringify({ dir: r.dir, declared: r.declared, layer: r.layer, refused: r.refused, built: r.built, unnamed: r.unnamed, verdict: r.verdict }));
      } else {
        const mark = bad.includes(r) ? "!" : " ";
        console.log(`${mark} ${r.dir}: объявлено «${r.declared}» (слой ${r.layer}), отказов понижения ${r.refused}, вердикт: ${r.verdict}`);
      }
    }
    console.log(`\nзаписей ${rows.length}, расхождений-требующих-внимания ${bad.length}`);
    return bad.length === 0 ? 0 : 1;
  }

  if (file === undefined) {
    console.error("Использование: e2kLoweringDiagnostics <файл.osnova> [--json] | --corpus [--json]");
    return 2;
  }
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    console.error(`Файл не найден: ${full}`);
    return 2;
  }
  const source = fs.readFileSync(full, "utf-8");
  const report = loweringDiagnosticsOf(source, path.basename(full));
  for (const d of report.diagnostics) {
    if (json) console.log(formatLoweringDiagnosticJson(d));
    else console.log(`[${d.class}]${d.code === undefined ? "" : ` ${d.code}`}${d.index === undefined ? "" : ` #${d.index}`}${d.carrier === undefined ? "" : ` ${d.carrier}`}: ${d.message}`);
  }
  if (!json) {
    console.log(
      report.built
        ? `образ ${String(report.bytes)} байт, регистров ${String(report.used)}, отказов ${report.refusedTotal}`
        : `образ НЕ собран, записей ${report.refusedTotal}`,
    );
    if (report.built && report.refusedTotal > 0) {
      console.log("ВНИМАНИЕ: образ собран, но носители выброшены — на цели число будет неверным");
    }
  }
  return report.built && report.refusedTotal === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(runLoweringDiagnosticsCli(process.argv.slice(2)));
}

/** Коды диагностик языка в записи — для тех, кто читает `--json`: заготовка для `OSN-LOW-*`. */
export const LOWERING_CODE_CONTRACT = "OSN-LOW-<NNN>: коды выдаёт плоскость src/e2k/** (см. отчёт Lead'а)";
