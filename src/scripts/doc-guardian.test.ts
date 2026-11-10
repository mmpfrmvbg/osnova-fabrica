/**
 * Тест сторожа документации — оракул у самого оракула.
 *
 * Проверяет, что runGuardian реально ловит:
 *   - незанесённый док (структурное расползание),
 *   - невалидный статус,
 *   - superseded без указателя и битый указатель,
 *   - несуществующий source-file,
 *   - протухший док (source-file новее самого дока),
 *   - замороженный без rework-plan (предупреждение),
 *   - авто-классификацию legacy/** и генерацию индекса.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runGuardian, classify, loadManifest, buildIndex, stampFor, applyStamp, withoutStaleMarks } from "./doc-guardian";

const OLD = new Date("2020-01-01T00:00:00Z");
const RECENT = new Date("2030-01-01T00:00:00Z");

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "doc-guardian-"));
}

function writeManifest(root: string, content: string): void {
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "manifest.yaml"), content);
}

function touch(root: string, relPath: string, mtime?: Date): void {
  const p = join(root, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "# doc\n");
  if (mtime) utimesSync(p, mtime, mtime);
}

describe("runGuardian", () => {
  it("валидный реестр — 0 ошибок, 0 предупреждений", () => {
    const root = makeRoot();
    touch(root, "docs/a.md");
    writeManifest(root, "docs/a.md: {status: active}\n");
    const r = runGuardian({ root });
    expect(r.errors).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("незанесённый док — ошибка", () => {
    const root = makeRoot();
    touch(root, "docs/a.md");
    writeManifest(root, "docs/b.md: {status: active}\n");
    const r = runGuardian({ root });
    expect(r.errors.some((e) => e.msg.includes("не занесён"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("невалидный статус — ошибка", () => {
    const root = makeRoot();
    touch(root, "docs/a.md");
    writeManifest(root, "docs/a.md: {status: bogus}\n");
    const r = runGuardian({ root });
    expect(r.errors.some((e) => e.msg.includes("неизвестный статус"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("superseded без superseded-by — ошибка", () => {
    const root = makeRoot();
    touch(root, "docs/a.md");
    writeManifest(root, "docs/a.md: {status: superseded}\n");
    const r = runGuardian({ root });
    expect(r.errors.some((e) => e.msg.includes("требует superseded-by"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("битый superseded-by — ошибка", () => {
    const root = makeRoot();
    touch(root, "docs/a.md");
    writeManifest(root, "docs/a.md: {status: superseded, superseded-by: docs/nonexistent.md}\n");
    const r = runGuardian({ root });
    expect(r.errors.some((e) => e.msg.includes("не существует"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("несуществующий source-file — ошибка", () => {
    const root = makeRoot();
    touch(root, "docs/a.md");
    writeManifest(root, "docs/a.md: {status: active, source-files: [src/missing.ts]}\n");
    const r = runGuardian({ root });
    expect(r.errors.some((e) => e.msg.includes("source-file") && e.msg.includes("не существует"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("протухший док — предупреждение (в --strict — ошибка)", () => {
    const root = makeRoot();
    touch(root, "docs/a.md", OLD); // док старый
    touch(root, "src/code.ts", RECENT); // код новее
    writeManifest(root, "docs/a.md: {status: active, source-files: [src/code.ts]}\n");
    const r = runGuardian({ root });
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.some((w) => w.msg.includes("менялся позже"))).toBe(true);

    const rStrict = runGuardian({ root, strict: true });
    expect(rStrict.errors.some((e) => e.msg.includes("менялся позже"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("свежий док (код не новее дока) — без предупреждений о свежести", () => {
    const root = makeRoot();
    touch(root, "docs/a.md", RECENT);
    touch(root, "src/code.ts", OLD);
    writeManifest(root, "docs/a.md: {status: active, source-files: [src/code.ts]}\n");
    const r = runGuardian({ root });
    expect(r.warnings.filter((w) => w.msg.includes("менялся позже"))).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("frozen без rework-plan — предупреждение", () => {
    const root = makeRoot();
    touch(root, "docs/a.md");
    writeManifest(root, "docs/a.md: {status: frozen}\n");
    const r = runGuardian({ root });
    expect(r.warnings.some((w) => w.msg.includes("rework-plan"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("legacy/** — deprecated автоматически, без ошибок", () => {
    const root = makeRoot();
    touch(root, "docs/legacy/old.md");
    writeManifest(root, "docs/a.md: {status: active}\n");
    const r = runGuardian({ root });
    // legacy не требует записи в реестре
    expect(r.errors).toHaveLength(0);
    expect(r.index).toContain("Устарело");
    expect(r.index).toContain("docs/legacy/old.md");
    rmSync(root, { recursive: true, force: true });
  });

  it("нет manifest.yaml — ошибка", () => {
    const root = makeRoot();
    const r = runGuardian({ root });
    expect(r.errors.some((e) => e.msg.includes("не найден"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("индекс генерируется с секциями и сортировкой", () => {
    const root = makeRoot();
    touch(root, "docs/z.md");
    touch(root, "docs/a.md");
    writeManifest(root, "docs/a.md: {status: stable}\ndocs/z.md: {status: active}\n");
    const r = runGuardian({ root });
    expect(r.index).toContain("## Канон (1)");
    expect(r.index).toContain("## Фронтир и замеры (1)");
    expect(r.index).toContain("docs/a.md");
    expect(r.index).toContain("docs/z.md");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("classify (автономно)", () => {
  it("legacy → deprecated, ключ → entry, bulk → статус, неизвестный → null", () => {
    const root = makeRoot();
    const mp = join(root, "docs", "manifest.yaml");
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(mp, "docs/a.md: {status: stable}\nscratch:\n  - docs/b.md\n");
    const man = loadManifest(mp);

    expect(classify("docs/legacy/x.md", man)?.status).toBe("deprecated");
    expect(classify("docs/a.md", man)?.status).toBe("stable");
    expect(classify("docs/b.md", man)?.status).toBe("scratch");
    expect(classify("docs/unknown.md", man)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("buildIndex", () => {
  it("ссылки относительны от docs/README.md", () => {
    const root = makeRoot();
    const idx = buildIndex(root, join(root, "docs", "README.md"), {
      active: ["AGENTS.md", "docs/a.md"],
    });
    expect(idx).toContain("[AGENTS.md](../AGENTS.md)");
    expect(idx).toContain("[docs/a.md](a.md)");
    rmSync(root, { recursive: true, force: true });
  });

  it("протухший док помечается ⚠, свежий — нет", () => {
    const root = makeRoot();
    const idx = buildIndex(
      root,
      join(root, "docs", "README.md"),
      { active: ["docs/a.md", "docs/b.md"] },
      new Set(["docs/a.md"]),
    );
    expect(idx).toContain("- [docs/a.md](a.md) ⚠");
    expect(idx).toContain("- [docs/b.md](b.md)\n");
    expect(idx).toContain("⚠ — исходник менялся позже дока (1)");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("withoutStaleMarks", () => {
  it("mtime-метка не делает индекс устаревшим, а смена состава — делает", () => {
    const marked = "# Карта\n> ⚠ — исходник менялся позже дока (1)\n- [docs/a.md](a.md) ⚠\n";
    const plain = "# Карта\n- [docs/a.md](a.md)\n";
    expect(withoutStaleMarks(marked)).toBe(withoutStaleMarks(plain));
    expect(withoutStaleMarks("- [docs/a.md](a.md)")).not.toBe(withoutStaleMarks("- [docs/b.md](b.md)"));
  });
});

describe("stampFor / applyStamp", () => {
  it("штамп без source-files", () => {
    expect(stampFor({ status: "active" })).toBe("<!-- doc-status: active -->");
  });

  it("штамп с source-files", () => {
    expect(stampFor({ status: "stable", sourceFiles: ["src/a.ts", "src/b.ts"] })).toBe(
      "<!-- doc-status: stable; source: src/a.ts, src/b.ts -->",
    );
  });

  it("applyStamp добавляет штамп в начало, если его нет", () => {
    expect(applyStamp("# Заголовок\n", "<!-- doc-status: active -->")).toBe(
      "<!-- doc-status: active -->\n# Заголовок\n",
    );
  });

  it("applyStamp заменяет существующий штамп (и не дублирует)", () => {
    const text = "<!-- doc-status: active -->\n# Заголовок\n";
    expect(applyStamp(text, "<!-- doc-status: stable -->")).toBe(
      "<!-- doc-status: stable -->\n# Заголовок\n",
    );
  });
});
