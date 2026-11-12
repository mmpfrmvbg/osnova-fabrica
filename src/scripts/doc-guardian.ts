#!/usr/bin/env tsx
/**
 * Сторож документации (doc-guardian).
 *
 * Оракул слоя «документация»: следит, чтобы ничего не расползалось.
 * Источник истины — `docs/manifest.yaml`; индекс — `docs/README.md` и штампы
 * `<!-- doc-status: … -->` в самих доках (оба генерируются, руками не правятся).
 *
 * Проверяет:
 *   - каждый .md (docs/** + корень) занесён в реестр (иначе ошибка);
 *   - статус валиден;
 *   - source-files существуют, и если исходник менялся ПОЗЖЕ самого дока
 *     (по mtime), док считается возможно устаревшим (предупреждение);
 *   - указатели superseded-by / rework-plan ведут на существующие файлы.
 *
 * `--fix` пишет два генерируемых артефакта:
 *   - индекс `docs/README.md`;
 *   - штамп `<!-- doc-status: <статус>; source: <файлы> -->` в шапку каждого дока.
 * Штамп пишется с **сохранением mtime** дока: свежесть меряется по mtime самого
 * дока, поэтому штамповка не должна «омолаживать» док и прятать протухание.
 *
 * Логика вынесена в {@link runGuardian}, чтобы её можно было тестировать
 * (`doc-guardian.test.ts`); `main()` — тонкая CLI-обёртка.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, utimesSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { load } from "js-yaml";

const STATUSES = new Set(["active", "stable", "frozen", "superseded", "deprecated", "scratch"]);
const META = new Set(["version", "as-of"]);
const SKIP = new Set(["docs/README.md"]);
const LEGACY_RE = /^docs\/legacy\//;
const STAMP_RE = /<!--\s*doc-status:.*?-->/;

export interface Entry {
  status: string;
  sourceFiles?: string[];
  supersededBy?: string;
  reworkPlan?: string;
}

export type Problem = { path: string; kind: "error" | "warn"; msg: string };

function listMd(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listMd(p));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function rootMd(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(root, e.name));
}

const rel = (root: string, p: string) => relative(root, p).replace(/\\/g, "/");

export function loadManifest(manifestPath: string): {
  entries: Map<string, Entry>;
  bulk: Map<string, string[]>;
} {
  const raw = readFileSync(manifestPath, "utf8");
  const data = load(raw) as Record<string, unknown>;
  const entries = new Map<string, Entry>();
  const bulk = new Map<string, string[]>();
  for (const [k, v] of Object.entries(data)) {
    if (META.has(k)) continue;
    if (STATUSES.has(k) && Array.isArray(v)) {
      bulk.set(k, v as string[]);
    } else if (v && typeof v === "object") {
      const e = v as Record<string, unknown>;
      entries.set(k, {
        status: e.status as string,
        sourceFiles: e["source-files"] as string[] | undefined,
        supersededBy: e["superseded-by"] as string | undefined,
        reworkPlan: e["rework-plan"] as string | undefined,
      });
    }
  }
  return { entries, bulk };
}

export function classify(path: string, man: ReturnType<typeof loadManifest>): Entry | null {
  if (man.entries.has(path)) return man.entries.get(path)!;
  for (const [status, paths] of man.bulk) if (paths.includes(path)) return { status };
  if (LEGACY_RE.test(path)) return { status: "deprecated" };
  return null;
}

/** Штамп статуса для шапки дока — генерируется из записи реестра. */
export function stampFor(entry: Entry): string {
  const src = entry.sourceFiles && entry.sourceFiles.length > 0 ? `; source: ${entry.sourceFiles.join(", ")}` : "";
  return `<!-- doc-status: ${entry.status}${src} -->`;
}

/** Вписать штамп в текст дока: заменить существующий или добавить в начало. */
export function applyStamp(text: string, stamp: string): string {
  return STAMP_RE.test(text) ? text.replace(STAMP_RE, stamp) : stamp + "\n" + text;
}

export function buildIndex(
  root: string,
  indexPath: string,
  index: Record<string, string[]>,
  stale: Set<string> = new Set(),
): string {
  const order = ["stable", "active", "frozen", "superseded", "deprecated", "scratch"] as const;
  const labels: Record<string, string> = {
    stable: "Канон",
    active: "Фронтир и замеры",
    frozen: "Заморожено",
    superseded: "Заменено",
    deprecated: "Устарело",
    scratch: "Разведка и сырьё",
  };
  const lines: string[] = [];
  lines.push("# Карта документации", "");
  lines.push(
    "> Сгенерировано `src/scripts/doc-guardian.ts --fix`. Не редактировать руками —",
    "",
  );
  lines.push("> источник истины — `docs/manifest.yaml`.", "");
  if (stale.size > 0) {
    lines.push("", `> ⚠ — исходник менялся позже дока (${stale.size}). Детали: \`npm run docs:check\`.`);
  }
  for (const s of order) {
    const paths = index[s];
    if (!paths || paths.length === 0) continue;
    lines.push(`## ${labels[s]} (${paths.length})`, "");
    for (const p of [...paths].sort()) {
      const href = relative(dirname(indexPath), join(root, p)).replace(/\\/g, "/");
      const mark = stale.has(p) ? " ⚠" : "";
      lines.push(`- [${p}](${href})${mark}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface GuardianResult {
  files: string[];
  errors: Problem[];
  warnings: Problem[];
  index: string;
  /** Желаемый штамп для каждого дока (путь → штамп). Пишется в `--fix`. */
  stamps: Map<string, string>;
}

/** Ядро сторожа: обходит доки, валидирует реестр, возвращает отчёт и штампы. */
export function runGuardian(opts: { root?: string; strict?: boolean } = {}): GuardianResult {
  const root = opts.root ?? process.cwd();
  const strict = opts.strict ?? false;
  const docsDir = join(root, "docs");
  const manifestPath = join(docsDir, "manifest.yaml");
  const indexPath = join(docsDir, "README.md");

  if (!existsSync(manifestPath)) {
    return {
      files: [],
      errors: [{ path: "docs/manifest.yaml", kind: "error", msg: "не найден" }],
      warnings: [],
      index: "",
      stamps: new Map(),
    };
  }

  const man = loadManifest(manifestPath);
  const files = [...listMd(docsDir), ...rootMd(root)];
  const problems: Problem[] = [];
  const index: Record<string, string[]> = {};
  const stamps = new Map<string, string>();
  const stale = new Set<string>();

  for (const f of files) {
    const path = rel(root, f);
    if (SKIP.has(path)) continue;
    const entry = classify(path, man);
    if (!entry) {
      problems.push({ path, kind: "error", msg: "не занесён в docs/manifest.yaml" });
      continue;
    }
    if (!STATUSES.has(entry.status)) {
      problems.push({ path, kind: "error", msg: `неизвестный статус "${entry.status}"` });
      continue;
    }
    (index[entry.status] ??= []).push(path);
    stamps.set(path, stampFor(entry));

    if (entry.status === "superseded" && !entry.supersededBy) {
      problems.push({ path, kind: "error", msg: "status=superseded требует superseded-by" });
    }
    if (entry.supersededBy && !existsSync(join(root, entry.supersededBy))) {
      problems.push({ path, kind: "error", msg: `superseded-by "${entry.supersededBy}" не существует` });
    }
    if (entry.status === "frozen" && !entry.reworkPlan) {
      problems.push({ path, kind: "warn", msg: "status=frozen без rework-plan (рекомендуется указать)" });
    }
    if (entry.reworkPlan && !existsSync(join(root, entry.reworkPlan))) {
      problems.push({ path, kind: "error", msg: `rework-plan "${entry.reworkPlan}" не существует` });
    }

    if (entry.sourceFiles) {
      const docMtime = statSync(f).mtime.getTime();
      for (const sf of entry.sourceFiles) {
        const full = join(root, sf);
        if (!existsSync(full)) {
          problems.push({ path, kind: "error", msg: `source-file "${sf}" не существует` });
          continue;
        }
        if (statSync(full).mtime.getTime() > docMtime) {
          stale.add(path);
          problems.push({
            path,
            kind: strict ? "error" : "warn",
            msg: `source-file "${sf}" менялся позже самого дока — контент может быть устаревшим`,
          });
        }
      }
    }
  }

  return {
    files,
    errors: problems.filter((p) => p.kind === "error"),
    warnings: problems.filter((p) => p.kind === "warn"),
    index: buildIndex(root, indexPath, index, stale),
    stamps,
  };
}

/** Вписать штампы в доки, сохранив их mtime (чтобы не «омолодить» и не спрятать протухание). */
function writeStamps(root: string, stamps: Map<string, string>): number {
  let changed = 0;
  for (const [relPath, stamp] of stamps) {
    const full = join(root, relPath);
    if (!existsSync(full)) continue;
    const before = statSync(full);
    const text = readFileSync(full, "utf8");
    const stamped = applyStamp(text, stamp);
    if (stamped !== text) {
      writeFileSync(full, stamped);
      utimesSync(full, before.atime, before.mtime);
      changed++;
    }
  }
  return changed;
}

/** Сравнение индекса без mtime-меток: список доков — канон, ⚠ — сигнал, а не состав. */
export function withoutStaleMarks(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("> ⚠ — исходник менялся позже дока"))
    .map((line) => (line.endsWith(" ⚠") ? line.slice(0, -2) : line))
    .join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const fix = args.includes("--fix");
  const strict = args.includes("--strict");
  const root = process.cwd();
  const indexPath = join(root, "docs", "README.md");

  const result = runGuardian({ strict });

  if (fix) {
    writeFileSync(indexPath, result.index);
    const stamped = writeStamps(root, result.stamps);
    console.log(`✓ индекс перегенерирован: docs/README.md; штампов обновлено: ${stamped}`);
  } else if (existsSync(indexPath)) {
    const onDisk = readFileSync(indexPath, "utf8");
    // Метка ⚠ зависит от mtime, а в свежем checkout порядок выдачи файлов делает
    // источник «позже» дока случайно. Список доков — канон, метка протухания — сигнал,
    // поэтому она не участвует в сравнении индекса (иначе L1 краснеет от порядка checkout).
    if (withoutStaleMarks(onDisk) !== withoutStaleMarks(result.index)) {
      result.errors.push({ path: "docs/README.md", kind: "error", msg: "индекс устарел — запусти `npm run docs:index`" });
    }
  }

  if (result.warnings.length) {
    console.log(`⚠ предупреждений: ${result.warnings.length}`);
    for (const w of result.warnings) console.log(`  - ${w.path}: ${w.msg}`);
  }
  if (result.errors.length) {
    console.error(`\n✗ ошибок: ${result.errors.length}`);
    for (const e of result.errors) console.error(`  - ${e.path}: ${e.msg}`);
    process.exit(1);
  }

  console.log(`✓ доков: ${result.files.length}, ошибок: 0, предупреждений: ${result.warnings.length}`);
}

// Запускать CLI только при прямом вызове (tsx src/scripts/doc-guardian.ts),
// не при импорте из тестов (doc-guardian.test.ts).
if (process.argv[1] && process.argv[1].includes("doc-guardian")) {
  main();
}
