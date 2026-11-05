/**
 * ЗАЛИВ И СВЕРКА ЧУЖОЙ СПЕЦИФИКАЦИИ: `OpenE2K/relcc2` → `vendor/relcc2/spec/`.
 *
 * # Зачем скрипт, а не «скачал руками»
 *
 * Утверждение «копия побайтово совпадает с первоисточником» обязано проверяться, а не
 * заявляться. У GitHub есть готовый хеш содержимого: поле `sha` блоба в дереве — это
 * **git-blob sha1** (`sha1("blob <len>\0" + bytes)`). Сверка с ним ловит и порчу передачи, и
 * подмену содержимого, и обрезанный ответ API (усечённое дерево объявляется отказом, а не
 * «скачалось столько, сколько дали»).
 *
 * # Два режима
 *
 *   node vendor/relcc2/fetch-spec.mjs fetch   — залить заново с закреплённого коммита
 *                                              (`inventory.json` перезаписывается)
 *   node vendor/relcc2/fetch-spec.mjs check   — сверить УЖЕ ЛЕЖАЩУЮ копию с `inventory.json`,
 *                                              без сети; выход 1, если хоть один файл разошёлся
 *   node vendor/relcc2/fetch-spec.mjs table   — напечатать таблицу описи (её несёт
 *                                              `PROVENANCE.md`; таблица — данные, а не проза)
 *
 * Режим `check` — тот, которым доказывается «копия та самая» на чистом клоне: он не ходит в
 * сеть вовсе.
 *
 * # Ревизия закреплена КОММИТОМ
 *
 * `main` уедет, а опись останется: в `inventory.json` лежат и коммит, и его дерево, поэтому
 * любую строку таблицы можно перепроверить через API независимо от нас.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = "OpenE2K/relcc2";
const PREFIX = "spec/";
/** Каталог этого скрипта = каталог вендорной копии (скрипт запускают из любого места). */
const OUT_ROOT = resolve(import.meta.dirname);
const INVENTORY = join(OUT_ROOT, "inventory.json");
const UA = "osnova-fabrika-vendor-script";
const mode = process.argv[2] ?? "check";

const gitBlobSha1 = (buf) => createHash("sha1").update(`blob ${buf.length}\0`, "utf8").update(buf).digest("hex");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function getBytes(url) {
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Залив с закреплённого коммита ветки `main` + опись. */
async function fetchAll() {
  const commit = await getJson(`https://api.github.com/repos/${REPO}/commits/main`);
  const commitSha = commit.sha;
  const commitDate = commit.commit.committer.date;
  const treeSha = commit.commit.tree.sha;

  const tree = await getJson(`https://api.github.com/repos/${REPO}/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated) throw new Error("дерево усечено API — залив неполон, опись будет лгать");

  const blobs = tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith(PREFIX))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const records = [];
  const problems = [];
  for (const blob of blobs) {
    const url = `https://raw.githubusercontent.com/${REPO}/${commitSha}/${blob.path}`;
    const bytes = await getBytes(url);
    const gotSha1 = gitBlobSha1(bytes);
    const gotSha256 = sha256(bytes);
    if (gotSha1 !== blob.sha) problems.push(`${blob.path}: git-sha1 ${gotSha1} ≠ ${blob.sha} (заявлен GitHub)`);
    if (bytes.length !== blob.size) problems.push(`${blob.path}: размер ${bytes.length} ≠ ${blob.size}`);
    const local = join(OUT_ROOT, ...blob.path.split("/"));
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, bytes);
    records.push({
      path: blob.path,
      localPath: `vendor/relcc2/${blob.path}`,
      size: bytes.length,
      gitSha1: gotSha1,
      sha256: gotSha256,
      sourceUrl: url,
    });
    console.log(`${gotSha1 === blob.sha ? "ok  " : "БРАК"} ${blob.path} ${bytes.length} Б`);
  }

  writeFileSync(
    INVENTORY,
    JSON.stringify(
      {
        source: { repo: REPO, ref: "main", commit: commitSha, commitDate, tree: treeSha, prefix: PREFIX },
        files: records,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nкоммит ${commitSha} (${commitDate}), файлов ${records.length}, брак ${problems.length}`);
  for (const p of problems) console.error(`БРАК ${p}`);
  if (problems.length > 0) process.exitCode = 1;
}

/** Сверка лежащей копии с описью — без сети. */
function checkAll() {
  const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));
  const problems = [];
  for (const record of inventory.files) {
    const local = join(OUT_ROOT, ...record.path.split("/"));
    let bytes;
    try {
      bytes = readFileSync(local);
    } catch {
      problems.push(`${record.path}: файла нет по пути ${local}`);
      continue;
    }
    const gotSha256 = sha256(bytes);
    const gotSha1 = gitBlobSha1(bytes);
    if (gotSha256 !== record.sha256) problems.push(`${record.path}: sha256 ${gotSha256} ≠ ${record.sha256} (опись)`);
    if (gotSha1 !== record.gitSha1) problems.push(`${record.path}: git-sha1 ${gotSha1} ≠ ${record.gitSha1} (опись)`);
    if (bytes.length !== record.size) problems.push(`${record.path}: размер ${bytes.length} ≠ ${record.size}`);
  }
  console.log(
    `опись ${inventory.source.repo}@${inventory.source.commit.slice(0, 12)}: файлов ${inventory.files.length}, ` +
      `расхождений ${problems.length}`,
  );
  for (const p of problems) console.error(`РАСХОЖДЕНИЕ ${p}`);
  if (problems.length > 0) process.exitCode = 1;
}

if (mode === "fetch") await fetchAll();
else if (mode === "check") checkAll();
else if (mode === "table") {
  const inventory = JSON.parse(readFileSync(INVENTORY, "utf8"));
  console.log("| файл в `spec/` | размер, Б | git-blob sha1 (тот же хеш называет GitHub) | sha256 |");
  console.log("|---|---|---|---|");
  for (const r of inventory.files) {
    console.log(`| \`${r.path}\` | ${r.size} | \`${r.gitSha1}\` | \`${r.sha256}\` |`);
  }
  console.log(
    `\nВсего: **${inventory.files.length}** файлов, **${inventory.files.reduce((s, r) => s + r.size, 0)}** Б.`,
  );
} else {
  console.error(`неизвестный режим «${mode}»: ожидается fetch, check или table`);
  process.exitCode = 2;
}
