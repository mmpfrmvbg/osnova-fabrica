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
 * Читает отказ понижения как **запись с КОДОМ** (`src/e2k/loweringRefusal.ts`): код — личность
 * причины, текст — для человека. Таблицы «текст → класс» здесь больше НЕТ и быть не должно: она
 * была обходным путём, пока кода не существовало, и держалась на формулировках. Теперь класс
 * берётся из кода ({@link LOWERING_CODE_CLASSES}), поэтому переписанная причина наблюдателя
 * не ослепляет, а неизвестный код виден как `код-вне-контракта`, а не как «похоже на…».
 *
 * # Два канала отказа — один код
 *
 * Отказ приходит либо ЗАПИСЬЮ (`refused: {code, reason}[]`), либо ИСКЛЮЧЕНИЕМ (раскладка не удалась,
 * несколько возвратов, отказ печати). Канал разный, личность одна: исключения несут то же поле
 * `code`, и {@link codeOfThrown} читает именно его — имени класса и текста не спрашивает.
 *
 * # Два режима
 *
 * - `e2kLoweringDiagnostics <файл.osnova> [--json]` — что будет с ЭТОЙ программой на цели;
 * - `e2kLoweringDiagnostics --corpus [--json]` — объявление корпуса против факта.
 *
 * Код возврата: 0 — образ собран без отказов; 1 — есть отказы или образ не собран; 2 — вызов.
 */
import * as fs from "fs";
import * as path from "path";
import { collectCompileDiagnostics } from "../compiler/compileDiagnostics";
import { compileSource } from "../compiler/compiler";
import { buildE2kImage } from "./e2kProgramRun";
import {
  LOWERING_CODES,
  LOWERING_CODE_CLASSES,
  codeOfThrown,
  isLoweringRefusalCode,
  type LoweringRefusalCode,
} from "../e2k/loweringRefusal";

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Класс отказа понижения — с 2026-09-28 это ИМЯ КОДА, а не вывод из текста.
 *
 * `язык` и `сборка-упала` остаются вне контракта понижения: первый приходит из компилятора
 * со своими кодами (`OSN-PAR-*`), второй — не названный отказ сборки (признак дефекта обвязки).
 */
export type LoweringClass =
  | "язык"
  | "сборка-упала"
  | "код-вне-контракта"
  | (typeof LOWERING_CODE_CLASSES)[LoweringRefusalCode];

/** Одна запись об отказе цели: КОД — личность причины, текст — для человека. */
export interface LoweringDiagnostic {
  class: LoweringClass;
  /** Код контракта `OSN-LOW-*`; пусто только у отказов ВНЕ контракта понижения (`язык`, `сборка-упала`). */
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
 * Класс по КОДУ. Текста причины не спрашивает вовсе — в этом и смысл контракта.
 *
 * Неизвестный код — `код-вне-контракта`: читатель обязан заметить, что производитель назвал
 * код, которого нет в таблице, а не «подобрать похожий».
 */
export function classOfCode(code: string | undefined): LoweringClass {
  if (code === undefined) return "сборка-упала";
  return isLoweringRefusalCode(code) ? LOWERING_CODE_CLASSES[code] : "код-вне-контракта";
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

/**
 * Класс БРОШЕННОГО отказа: читается из кода исключения, а не из имени класса и не из текста.
 *
 * Порядок именно такой: сначала КОД (`codeOfThrown`), и только если его нет — два случая вне
 * контракта понижения: программа не компилируется (`язык`) и всё прочее (`сборка-упала`).
 * Таблицы «имя класса → класс отказа» здесь нет намеренно: она была бы тем же выводом по тексту.
 */
function classOfThrown(error: unknown): LoweringClass {
  if (codeOfThrown(error) !== undefined) return classOfCode(codeOfThrown(error));
  const message = error instanceof Error ? error.message : String(error);
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
      const parsed = parseRefusalText(refused.reason);
      return {
        // Класс — ИЗ КОДА. Текст используется только для места (`#N IR.x`) и для человека.
        class: classOfCode(refused.code),
        code: refused.code,
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
    const cls = classOfThrown(error);
    const code = codeOfThrown(error);
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics: LoweringDiagnostic[] =
      cls === "язык"
        ? languageDiagnostics(source, filename)
        : [{ class: cls, ...(code === undefined ? {} : { code }), message }];
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

/**
 * Все вердикты списком — их проверяет оракул наблюдателя.
 *
 * Список здесь, а не в тесте: иначе оракул держал бы ВТОРУЮ копию набора, и новый вердикт,
 * добавленный в код, проходил бы мимо него.
 */
export const CORPUS_VERDICTS: readonly CorpusVerdict[] = [
  "совпадает",
  "ОБЪЯВЛЕНИЕ УСТАРЕЛО: «нет» с причиной про понижение, а понижение проходит",
  "РАСХОЖДЕНИЕ: объявлено «работает», а понижение отказывает",
  "вне понижения: причина называет другой слой",
];

export interface CorpusRow {
  dir: string;
  declared: string;
  layer: string;
  refused: number;
  built: boolean;
  /**
   * Сколько отказов пришло БЕЗ кода контракта (должно быть 0).
   *
   * Было «сколько не подошло под таблицу причин»: с контрактом код есть у каждого отказа
   * понижения, поэтому ненулевое значение здесь значит, что производитель назвал код вне
   * таблицы (`код-вне-контракта`) — то есть контракт нарушен, а не «формулировка изменилась».
   */
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
      // Отказ без кода — нарушение контракта, а не «незнакомая формулировка»: так это и читается.
      unnamed: report.diagnostics.filter((d) => d.class === "код-вне-контракта").length,
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

/**
 * КОНТРАКТ КОДОВ ОТКАЗА ПОНИЖЕНИЯ — переизлучение для читателей наблюдателя.
 *
 * Единственный источник истины живёт в плоскости `src/e2k/**` (`src/e2k/loweringRefusal.ts`):
 * здесь он только виден тем, кто читает наблюдателя, и НЕ дублируется таблицей.
 */
export { LOWERING_CODES, LOWERING_CODE_CLASSES, LOWERING_CODE_MEANINGS } from "../e2k/loweringRefusal";

/** Пространство кодов одной строкой — для справки и для читателей `--json`. */
export const LOWERING_CODE_SPACE = `OSN-LOW-<NNN>: ${Object.values(LOWERING_CODES).join(", ")}`;
