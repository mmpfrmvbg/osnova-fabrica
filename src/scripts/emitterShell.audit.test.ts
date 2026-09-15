/**
 * АУДИТ ЭМИТТЕРА НА ОБОЛОЧКЕ: защита от регрессии.
 *
 * Проверяется:
 *
 * 1. файл эмиттера существует и его имя содержит `shell` — и рядом **нет** файла с именем
 *    вида «эмиттер e2k»;
 * 2. паспорт выхода несёт идентификатор бэкенда и статус `ДОПУЩЕНИЕ`;
 * 3. `optimizable` читается из `module.atoms`, а не из разметки вызывающего;
 * 4. `verifyAtomRegions` проверяется **до** эмиссии (испорченная разметка → останов);
 * 5. пять DSP-ядер проходят круг до эталона;
 * 6. негативный контроль зафиксирован: четыре дефекта с числами `sha256`;
 * 7. **стоячий негативный контроль формулировок:** документы не называют результат
 *    «эмиттер e2k» без оговорки. Проверка строковая, и у неё есть свой негативный контроль
 *    на подложенном тексте — иначе она была бы декоративной.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";
import { getEncoder } from "../e2k/backend";
import { emitShell } from "../e2k/emitterShell";
import { decodeShellImage, runShellImage } from "../e2k/emitterRoundtrip";
import { annotateAtomRegions, verifyAtomRegions } from "../compiler/atomRegions";
import { regModuleOf } from "../vliw/regOracle";
import type { RegModule } from "../runtime/vm/regcode";

const ROOT = path.resolve(__dirname, "..", "..");
const EMITTER = path.join("src", "e2k", "emitterShell.ts");
const ROUNDTRIP = path.join("src", "e2k", "emitterRoundtrip.ts");
const DOC = path.join("docs", "e2k-emitter-shell.md");
const KERNELS_DIR = path.join(ROOT, "tests", "dsp", "kernels");
const REFERENCE = path.join(ROOT, "tests", "dsp", "reference.json");

const encoder = getEncoder("internal-shell");

const KERNELS: Array<{ name: string; atom: string }> = [
  { name: "fir", atom: "A5" },
  { name: "iir", atom: "A5" },
  { name: "fft", atom: "A5" },
  { name: "convolution", atom: "A6" },
  { name: "correlation", atom: "A6" },
];

function read(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, "utf-8");
}

function flat(rel: string): string {
  return read(rel).replace(/\s+/g, " ");
}

function annotatedKernel(name: string, atom: string): RegModule {
  const source = fs.readFileSync(path.join(KERNELS_DIR, `${name}.osnova`), "utf-8");
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  return annotateAtomRegions(built.module, [
    { atom, procedures: built.module.procedures.map((p) => p.name) },
  ]);
}

/**
 * Стоячая проверка формулировок: строка с «эмиттер e2k» обязана нести оговорку.
 *
 * Чистая функция — её же проверяет негативный контроль на подложенном тексте.
 */
export function bareE2kEmitterClaims(text: string): string[] {
  const problems: string[] = [];
  for (const line of text.split("\n")) {
    if (!/эмиттер\s+e2k/i.test(line)) continue;
    if (/не\s|без оговорки|запрещ|оговорк|вместо|НЕ ЭМИТТЕР|недопустим/i.test(line)) continue;
    problems.push(line.trim());
  }
  return problems;
}

describe("эмиттер на оболочке: имя, паспорт, правила", () => {
  it("файл эмиттера назван по оболочке и файла «эмиттер e2k» рядом нет", () => {
    expect(fs.existsSync(path.join(ROOT, EMITTER)), "нет эмиттера на оболочке").toBe(true);
    expect(path.basename(EMITTER).toLowerCase()).toContain("shell");
    const names = fs.readdirSync(path.join(ROOT, "src", "e2k"));
    const misleading = names.filter((name) => /e2k.*emitter|emitter.*e2k/i.test(name) && !/shell/i.test(name));
    expect(misleading, `имена, выдающие оболочку за e2k: ${misleading.join(", ")}`).toEqual([]);
  });

  it("паспорт выхода несёт идентификатор бэкенда и статус ДОПУЩЕНИЕ", () => {
    const module = annotatedKernel("fir", "A5");
    const emitted = emitShell(module, encoder);
    expect(emitted.image.passport.backendId).toBe("internal-shell");
    expect(emitted.image.passport.backendStatus).toBe("ДОПУЩЕНИЕ");
    expect(emitted.image.passport.note).toMatch(/оболочк/i);
    expect(emitted.image.passport.note).toMatch(/НЕ e2k/i);
    expect(emitted.report.backendId).toBe("internal-shell");
    expect(emitted.report.backendStatus).toBe("ДОПУЩЕНИЕ");
  });

  it("optimizable читается из module.atoms, а не из разметки вызывающего", () => {
    const module = annotatedKernel("fir", "A5");
    const flipped = module.atoms!.map((region) => ({ ...region, optimizable: !region.optimizable }));
    const result = emitShell(module, encoder, { callerAtoms: flipped });
    expect(result.report.regions.map((region) => region.optimizable)).toEqual(
      module.atoms!.map((region) => region.optimizable),
    );
    expect(result.image.placement.every((entry) => entry.optimizable)).toBe(true);
  });

  it("verifyAtomRegions проверяется ДО эмиссии: испорченная разметка — останов", () => {
    const module = annotatedKernel("fir", "A5");
    const broken: RegModule = {
      ...module,
      atoms: module.atoms!.map((region, index) => (index === 0 ? { ...region, end: region.end - 1 } : region)),
    };
    expect(verifyAtomRegions(broken).length).toBeGreaterThan(0);
    expect(() => emitShell(broken, encoder)).toThrow(/разметк/i);

    const withoutAtoms: RegModule = { ...module };
    delete withoutAtoms.atoms;
    expect(() => emitShell(withoutAtoms, encoder)).toThrow(/разметк/i);
  });

  it("пять DSP-ядер проходят круг до независимого эталона", async () => {
    const reference = JSON.parse(fs.readFileSync(REFERENCE, "utf-8")) as Record<
      string,
      { checksum: number }
    >;
    for (const { name, atom } of KERNELS) {
      const module = annotatedKernel(name, atom);
      const emitted = emitShell(module, encoder);
      const decoded = decodeShellImage(emitted.image, encoder);
      expect(decoded.code.length, `${name}: инструкций после круга`).toBe(module.code.length);
      const value = await runShellImage(emitted.image, encoder);
      expect(Number(value), `${name}: круг против эталона`).toBe(reference[name]!.checksum);
    }
  });

  it("негативный контроль зафиксирован: четыре дефекта и их sha256", () => {
    const doc = flat(DOC);
    for (const defect of ["4.1", "4.2", "4.3", "4.4"]) {
      expect(doc, `нет дефекта ${defect}`).toContain(`| ${defect} |`);
    }
    expect(doc, "нет sha256 до = после").toContain("sha256");
    expect(doc).toContain("1DF909FC");
    expect(doc, "не сказано, что дефект 4.3 ненаблюдаем на уровне байтов").toMatch(
      /на уровне байтов ненаблюдаем|не\s*\*\*видит\*\*|потерю \*\*не\*\* видит/i,
    );
    // Тесты дефектов обязаны жить в репозитории, а не только в отчёте.
    const oracleTests = read(path.join("src", "e2k", "emitterOracle.test.ts"));
    const roundtripTests = read(path.join("src", "e2k", "emitterRoundtrip.test.ts"));
    expect(oracleTests).toMatch(/trustCallerFlags/);
    expect(roundtripTests).toMatch(/allowUnsupported/);
    expect(roundtripTests).toMatch(/identityDecode/);
    expect(read(ROUNDTRIP)).toMatch(/identityDecode/);
  });

  it("документ объясняет, почему носители IR, а не мнемоники e2k, и что круг не доказывает", () => {
    const doc = flat(DOC);
    expect(doc, "нет объяснения носителей").toMatch(/носител/i);
    expect(doc, "не сказано, что это не e2k").toMatch(/Это не эмиттер e2k|НЕ ЭМИТТЕР E2K/i);
    expect(doc, "не сказано, что круг не доказывает корректность e2k").toMatch(
      /не доказывает/i,
    );
    expect(doc, "нет раздела допущений").toMatch(/Что осталось допущением/);
    expect(doc, "не назван предел двух аргументов").toMatch(/не больше двух|не больше 2/i);
  });
});

describe("стоячий контроль формулировок: «эмиттер e2k» без оговорки", () => {
  it("в документах и памяти нет утверждения «эмиттер e2k» без оговорки", () => {
    const files = [
      path.join("docs", "e2k-emitter-shell.md"),
      path.join("docs", "e2k-emitter-plan.md"),
      path.join("docs", "e2k-backend.md"),
      path.join("memory", "_index.md"),
    ];
    const problems = files.flatMap((file) =>
      bareE2kEmitterClaims(read(file)).map((line) => `${file}: ${line}`),
    );
    expect(problems, `формулировка без оговорки:\n${problems.join("\n")}`).toEqual([]);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: проверка ловит подложенное утверждение", () => {
    const bad = [
      "Наш эмиттер e2k выдаёт машинный код.",
      "Эмиттер e2k готов к работе.",
      "Здесь описан эмиттер на внутренней оболочке, и это не эмиттер e2k.",
      "Формулировка «эмиттер e2k» без оговорки запрещена.",
    ].join("\n");
    const problems = bareE2kEmitterClaims(bad);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("выдаёт машинный код");
    expect(problems[1]).toContain("готов к работе");
    // И чистый текст проверкой не задевается — иначе контроль был бы красен всегда.
    expect(
      bareE2kEmitterClaims("Это эмиттер на внутренней оболочке, не эмиттер e2k."),
    ).toEqual([]);
  });
});
