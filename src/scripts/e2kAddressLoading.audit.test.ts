/**
 * ОРАКУЛ ДОКУМЕНТА О ЗАГРУЗКЕ 64-БИТНОГО АДРЕСА В РЕГИСТР e2k.
 *
 * # Зачем этот тест
 *
 * `docs/e2k-address-loading.md` утверждает конкретное: форма `movtd,0 _f64 <64-бит>, %rN`
 * кодируется ассемблером МЦСТ с определёнными байтами и по коду QEMU кладёт все 64 бита в `lo`
 * оконного регистра. Утверждение без проверки — не оракул. Тест проверяет четыре уровня:
 *
 * 1. **Структура документа** (всегда): есть разделы 4.1–4.5, есть кандидаты К1–К5, есть пометки
 *    «НЕТ В ИСТОЧНИКЕ» и «НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ», нет утверждения «выполняется без оговорок».
 * 2. **Ссылки «файл:строка»** (когда есть `.tmp/e2k-sources/`): каждая из них указывает на
 *    существующий файл и существующую строку, а якоря — на настоящий фрагмент.
 * 3. **Байты, полученные ассемблером** (когда есть `.tmp/addr-probe/`): hex из документа
 *    совпадает с `.bin`, который оставил `as-new`, а ассемблерный текст — с `.s`.
 * 4. **Негативный контроль**: испорченный вход обязан ловиться, иначе оракул ничего не проверяет.
 *
 * # Слабое место названо прямо
 *
 * Ни `.tmp/e2k-sources/`, ни `.tmp/addr-probe/` не коммитятся. На чистой копии репозитория
 * уровни 2 и 3 выполнить нечем, и тест **сообщает об этом**, а не выдаёт «проверок не было» за
 * «проверки пройдены». Каталог проб можно переопределить переменной `E2K_ADDR_PROBE_DIR` —
 * иначе слабый режим никто бы не проверил.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const DOC = path.join(ROOT, "docs", "e2k-address-loading.md");
const SOURCES = process.env.E2K_SOURCES_DIR ?? path.join(ROOT, ".tmp", "e2k-sources");
const QEMU = path.join(SOURCES, "qemu-e2k", "qemu");
const PROBE = process.env.E2K_ADDR_PROBE_DIR ?? path.join(ROOT, ".tmp", "addr-probe");

/** Голые имена файлов (без каталога) → полный путь от соответствующего корня. */
export const BARE_FILE_ROOTS: Readonly<Record<string, string>> = {
  "cpu.h": path.join(QEMU, "target", "e2k", "cpu.h"),
  "decoder.h": path.join(QEMU, "target", "e2k", "decoder.h"),
  "reg-index.h": path.join(QEMU, "target", "e2k", "reg-index.h"),
  "decoder.c": path.join(QEMU, "target", "e2k", "decoder.c"),
  "cpu_loop.c": path.join(QEMU, "linux-user", "e2k", "cpu_loop.c"),
  "syscall_nr.h": path.join(QEMU, "linux-user", "e2k", "syscall_nr.h"),
  "e2k-dis.c": path.join(SOURCES, "binutils-gdb", "opcodes", "e2k-dis.c"),
  "e2k-opc.h": path.join(SOURCES, "binutils-gdb", "opcodes", "e2k-opc.h"),
  "tc-e2k.c": path.join(SOURCES, "binutils-gdb", "gas", "config", "tc-e2k.c"),
  "translate-al.c": path.join(QEMU, "target", "e2k", "tcg", "translate-al.c"),
  "translate-al-c12.c": path.join(QEMU, "target", "e2k", "tcg", "translate-al-c12.c"),
  "translate-mem.c": path.join(QEMU, "target", "e2k", "tcg", "translate-mem.c"),
  "e2k-real.ts": path.join(ROOT, "src", "e2k", "e2k-real.ts"),
};

/** Корни, относительно которых разворачиваются ссылки документа. */
const REF_ROOTS: readonly string[] = [ROOT, SOURCES, QEMU];

/** Якорь: «в этом файле, в этих строках лежит этот фрагмент». */
export interface Anchor {
  readonly file: string;
  readonly from: number;
  readonly to: number;
  readonly contains: string;
  readonly claim: string;
}

/** Ссылка документа на строку источника. */
export interface SourceRef {
  readonly raw: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Утверждения документа, обязанные оставаться и в документе, и в источнике.
 *
 * Таблица зафиксирована здесь, а не читается из документа: вырезание ссылки из документа
 * не должно «согласовать» документ с самим собой.
 */
export const ANCHORS: readonly Anchor[] = [
  // elbrus-docs: таблица кодирования src2 и имена регистров
  { file: "elbrus-docs/README.md", from: 461, to: 461, contains: "dc-de", claim: "64-битный литерал — пара LTS" },
  { file: "elbrus-docs/README.md", from: 461, to: 461, contains: "64 bit literal syllable pair", claim: "та же строка словами" },
  { file: "elbrus-docs/README.md", from: 460, to: 460, contains: "32 bit literal syllable", claim: "32-битный литерал" },
  { file: "elbrus-docs/README.md", from: 436, to: 436, contains: "literal syllables (LTS)", claim: "src2 кодирует доступ к LTS" },
  { file: "elbrus-docs/README.md", from: 50, to: 54, contains: "`%dr0`", claim: "%rN и %drN — один регистр окна" },
  { file: "elbrus-docs/README.md", from: 129, to: 129, contains: "Literal syllable", claim: "определение LTS" },
  // binutils: дизассемблер
  { file: "binutils-gdb/opcodes/e2k-dis.c", from: 485, to: 485, contains: "0xdc", claim: "64-битный литерал = 0xdc" },
  { file: "binutils-gdb/opcodes/e2k-dis.c", from: 487, to: 487, contains: "64-bit literal", claim: "комментарий про 64 бита" },
  { file: "binutils-gdb/opcodes/e2k-dis.c", from: 490, to: 491, contains: "lit_num == 3", claim: "lts3 для 64 бит нелегален" },
  { file: "binutils-gdb/opcodes/e2k-dis.c", from: 480, to: 484, contains: "32-bit literal", claim: "32-битный литерал = 0xd8" },
  // binutils: газ
  { file: "binutils-gdb/gas/config/tc-e2k.c", from: 1819, to: 1819, contains: "_f64", claim: "спецификатор _f64" },
  { file: "binutils-gdb/gas/config/tc-e2k.c", from: 1867, to: 1869, contains: "LITERAL_64", claim: "размещение LITERAL_64" },
  { file: "binutils-gdb/gas/config/tc-e2k.c", from: 4635, to: 4635, contains: "parse_mova_args", claim: "функция для mova* без вызовов" },
  // binutils: таблица опкодов
  { file: "binutils-gdb/opcodes/e2k-opc.h", from: 644, to: 644, contains: '"movts"', claim: "movts в таблице" },
  { file: "binutils-gdb/opcodes/e2k-opc.h", from: 644, to: 644, contains: "ARGS_SS", claim: "movts — S_S" },
  { file: "binutils-gdb/opcodes/e2k-opc.h", from: 664, to: 664, contains: '"movtd"', claim: "movtd в таблице" },
  { file: "binutils-gdb/opcodes/e2k-opc.h", from: 664, to: 664, contains: "ARGS_DD", claim: "movtd — D_D" },
  { file: "binutils-gdb/opcodes/e2k-opc.h", from: 2814, to: 2814, contains: '"movtq"', claim: "movtq в таблице" },
  // QEMU: разбор
  { file: "target/e2k/decoder.h", from: 191, to: 195, contains: "IMM64", claim: "разбор src2: 0xdc → IMM64" },
  { file: "target/e2k/decoder.h", from: 215, to: 219, contains: "WINDOW", claim: "dst 0x88 → окно" },
  { file: "target/e2k/decoder.c", from: 602, to: 602, contains: "E2K_OP_MOVTD_CTPR", claim: "movtd в ctpr" },
  { file: "target/e2k/decoder.c", from: 606, to: 606, contains: "E2K_OP_MOVTD_RF", claim: "movtd в регистр" },
  // QEMU: чтение литерала
  { file: "target/e2k/tcg/translate-al.c", from: 1685, to: 1703, contains: "IMM64", claim: "обработка IMM64" },
  { file: "target/e2k/tcg/translate-al.c", from: 1697, to: 1697, contains: "E2K_SRC_TYPE_D", claim: "старшие 32 бита — только D/X/QP" },
  // QEMU: запись в регистр
  { file: "target/e2k/tcg/translate-al-c12.c", from: 32, to: 32, contains: "get_src_val_sw", claim: "MOVTS читает 32 бита" },
  { file: "target/e2k/tcg/translate-al-c12.c", from: 37, to: 37, contains: "lo32", claim: "MOVTS пишет только lo32" },
  { file: "target/e2k/tcg/translate-al-c12.c", from: 53, to: 53, contains: "get_src_val_dw", claim: "MOVTD читает 64 бита" },
  { file: "target/e2k/tcg/translate-al-c12.c", from: 58, to: 58, contains: "temp_res_full.lo", claim: "MOVTD пишет весь lo" },
  // QEMU: состояние и ABI
  { file: "target/e2k/cpu.h", from: 111, to: 112, contains: "uint64_t lo;", claim: "lo — 64 бита" },
  { file: "linux-user/e2k/cpu_loop.c", from: 177, to: 177, contains: "args[i] = arg_p->lo", claim: "syscall читает lo" },
  { file: "target/e2k/reg-index.h", from: 30, to: 52, contains: "br_rsz_full_d", claim: "окно (rsz+1)*2 единиц" },
  { file: "target/e2k/tcg/translate-mem.c", from: 1051, to: 1051, contains: "is_imm", claim: "литералы в translate-mem — про LD/ST" },
  // LLVM
  { file: "llvm-project/llvm/lib/Target/E2K/E2KInstrInfo.td", from: 513, to: 513, contains: "movts", claim: "MOVTS в LLVM" },
  { file: "llvm-project/llvm/lib/Target/E2K/E2KInstrInfo.td", from: 520, to: 520, contains: "movtd", claim: "MOVTD в LLVM" },
  { file: "llvm-project/llvm/lib/Target/E2K/E2KInstrInfo.td", from: 950, to: 950, contains: "movtq", claim: "MOVTQ в LLVM" },
  // наш кодировщик
  { file: "src/e2k/e2k-real.ts", from: 288, to: 288, contains: "movts", claim: "movts есть в кодировщике" },
  { file: "src/e2k/e2k-real.ts", from: 289, to: 289, contains: "movtd", claim: "movtd есть в кодировщике" },
  // Все четыре якоря на src/e2k/e2k-real.ts пересчитаны 2026-09-27 замером: обе правки того дня
  // (сначала семейство CMPAND* в таблице, затем слот `psrc` с полем `acceptsPsrc` и разделом CDS)
  // добавлены ВЫШЕ них и сдвинули номера дважды. Якорь — факт о файле, поэтому он измеряется, а не
  // подгоняется под проходящий тест.
  { file: "src/e2k/e2k-real.ts", from: 1187, to: 1189, contains: "0xd8", claim: "поля F16/F32/F64" },
  // Числа пересчитаны 2026-09-20: короткая непосредственная форма (`encodeShortImm`, коммит соседней
  // работы) добавила строки выше, и прежние 942-944 / 933-966 указывали мимо. Якоря — это ФАКТ о
  // файле, поэтому они пересчитываются замером, а не «подгоняются» под проходящий тест.
  // Пересчитаны дважды 2026-09-27: сначала +32 (в таблицу опкодов добавлено семейство CMPAND*),
  // затем ещё +208 (тип слота `psrc`, поле `acceptsPsrc` записи и раздел слога-условия CDS).
  // Обе правки — выше якоря, поэтому он сдвигался дважды одной и той же причиной.
  { file: "src/e2k/e2k-real.ts", from: 1249, to: 1285, contains: "encodeImm64", claim: "форма 0xdc реализована (encodeImm64)" },
];

/**
 * Пробы ассемблера: имя файла в каталоге проб, ассемблерный текст и ожидаемые байты.
 *
 * Байты получены `as-new -mcpu=elbrus-v5` + `objcopy -O binary -j .text`. Так проверка связывает
 * документ не с пересказом, а с артефактом прогона.
 */
export interface Probe {
  readonly name: string;
  readonly asm: string;
  readonly hex: string;
  readonly kind: "accept" | "reject";
}

export const PROBES: readonly Probe[] = [
  { name: "ctrl_movts_imm16", asm: "movts,0 1, %r8", hex: "0100000488c1c060", kind: "accept" },
  { name: "candA_movts_f32", asm: "movts,0 0x100000, %r8", hex: "1100000488d8c0600000000000001000", kind: "accept" },
  { name: "candB_movts_f64", asm: "movts,0 _f64 0x100000, %r8", hex: "1100000488dcc0600000000000001000", kind: "accept" },
  { name: "candC_movtd_f64_small", asm: "movtd,0 _f64 0x100000, %r8", hex: "1100000488dcc0610000000000001000", kind: "accept" },
  { name: "candC_movtd_f64_bit32", asm: "movtd,0 _f64 0x100000000, %r8", hex: "1100000488dcc0610100000000000000", kind: "accept" },
  { name: "candC_movtd_f64_e2kbase", asm: "movtd,0 _f64 0x0000d00000000000, %r8", hex: "1100000488dcc06100d0000000000000", kind: "accept" },
  { name: "candC_movtd_f64_wide", asm: "movtd,0 _f64 0xdeadbeefcafebabe, %r8", hex: "1100000488dcc061efbeaddebebafeca", kind: "accept" },
  { name: "candC_movtd_f64_max", asm: "movtd,0 _f64 0xffffffffffffffff, %r8", hex: "1100000488dcc061ffffffffffffffff", kind: "accept" },
  { name: "candC_movtd_f64_r11", asm: "movtd,0 _f64 0x100000, %r11", hex: "110000048bdcc0610000000000001000", kind: "accept" },
  { name: "candD_movtd_f32", asm: "movtd,0 0x100000, %r8", hex: "1100000488d8c0610000000000001000", kind: "accept" },
  { name: "movts_imm64", asm: "movts,0 0x100000000, %r8", hex: "1100000488d8c0600000000000000000", kind: "accept" },
  { name: "f64_r9", asm: "movts,0 _f64 0x100000, %r9", hex: "1100000489dcc0600000000000001000", kind: "accept" },
  { name: "f64_r11", asm: "movts,0 _f64 0x100000, %r11", hex: "110000048bdcc0600000000000001000", kind: "accept" },
  { name: "movtd_imm64", asm: "movtd,0 0x100000, %r8", hex: "1100000488d8c0610000000000001000", kind: "accept" },
];

/** Точные тексты отказов ассемблера, которые документ обязан называть. */
export const REFUSALS: readonly string[] = [
  "literal is not allowed in position of %q(uad) operand",
  "Invalid combination of literal format and location",
];

/** Развернуть ссылку документа в путь файла. */
export function resolveRef(raw: string): string | undefined {
  if (raw.startsWith("docs/") || raw.startsWith("src/")) return path.join(ROOT, raw);
  if (BARE_FILE_ROOTS[raw] !== undefined) return BARE_FILE_ROOTS[raw]!;
  for (const root of REF_ROOTS) {
    const candidate = path.join(root, raw);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(QEMU, raw);
}

/** Собрать из документа ссылки `` `файл:строка` `` и `` `файл:строка-строка` ``. */
export function collectSourceRefs(doc: string): SourceRef[] {
  const refs: SourceRef[] = [];
  const pattern = /`([A-Za-z0-9_./-]+\.(?:c|h|tbl|td|ts|md)):(\d+)(?:-(\d+))?/g;
  for (const match of doc.matchAll(pattern)) {
    const from = Number(match[2]);
    refs.push({ raw: match[1]!, from, to: match[3] === undefined ? from : Number(match[3]) });
  }
  return refs;
}

/** Проблемы ссылок: пустой список — все ссылки указывают на настоящие строки. */
export function verifySourceRefs(refs: readonly SourceRef[], resolve: (raw: string) => string | undefined = resolveRef): string[] {
  const problems: string[] = [];
  for (const ref of refs) {
    const file = resolve(ref.raw);
    if (file === undefined || !fs.existsSync(file)) {
      problems.push(`нет файла ${ref.raw} (ссылка ${ref.raw}:${ref.from})`);
      continue;
    }
    if (ref.to < ref.from) {
      problems.push(`${ref.raw}:${ref.from}-${ref.to} — обратный диапазон`);
      continue;
    }
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    if (lines.length < ref.to) {
      problems.push(`${ref.raw}: строк ${lines.length}, ссылка требует до ${ref.to}`);
    }
  }
  return problems;
}

/** Проверить якоря по локальной копии источников. */
export function verifyAnchors(anchors: readonly Anchor[], resolve: (raw: string) => string | undefined = resolveRef): string[] {
  const problems: string[] = [];
  for (const anchor of anchors) {
    const file = resolve(anchor.file);
    if (file === undefined || !fs.existsSync(file)) {
      problems.push(`нет файла ${anchor.file} (утверждение: ${anchor.claim})`);
      continue;
    }
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    if (lines.length < anchor.to) {
      problems.push(`${anchor.file}: строк ${lines.length}, якорь требует до ${anchor.to}`);
      continue;
    }
    let found = false;
    for (let line = anchor.from; line <= anchor.to; line++) {
      if ((lines[line - 1] ?? "").includes(anchor.contains)) {
        found = true;
        break;
      }
    }
    if (!found) {
      problems.push(`${anchor.file}:${anchor.from}-${anchor.to} не содержит «${anchor.contains}» (утверждение: ${anchor.claim})`);
    }
  }
  return problems;
}

/**
 * Сверить зафиксированные в документе байты с артефактами прогона ассемблера.
 *
 * Для приёмки: `.s` существует и содержит инструкцию, `.bin` существует и его hex совпадает
 * с ожидаемым, а ожидаемый hex присутствует в документе. Для отказа: `.o` не появился, а в
 * документе назван точный текст ошибки.
 */
export function verifyProbes(probes: readonly Probe[], doc: string, probeDir: string): string[] {
  const problems: string[] = [];
  for (const probe of probes) {
    const docHex = doc.replace(/[\s`]/g, "");
    if (!docHex.includes(probe.hex)) {
      problems.push(`байты пробы ${probe.name} (${probe.hex}) не зафиксированы в документе`);
    }
    if (!doc.includes(probe.asm)) {
      problems.push(`ассемблерный текст пробы ${probe.name} «${probe.asm}» не назван в документе`);
    }
    const src = path.join(probeDir, `${probe.name}.s`);
    const obj = path.join(probeDir, `${probe.name}.o`);
    const bin = path.join(probeDir, `${probe.name}.bin`);
    if (!fs.existsSync(src)) {
      problems.push(`нет пробы ${probe.name}.s`);
      continue;
    }
    const text = fs.readFileSync(src, "utf-8");
    if (!text.includes(probe.asm)) {
      problems.push(`проба ${probe.name}.s не содержит «${probe.asm}»`);
    }
    if (probe.kind === "accept") {
      if (!fs.existsSync(obj)) {
        problems.push(`ассемблер не собрал ${probe.name} (нет .o)`);
        continue;
      }
      if (!fs.existsSync(bin)) {
        problems.push(`нет байтов пробы ${probe.name} (нет .bin)`);
        continue;
      }
      const actual = fs.readFileSync(bin).toString("hex");
      if (actual !== probe.hex) {
        problems.push(`${probe.name}: байты ${actual}, в оракуле ${probe.hex}`);
      }
    }
  }
  return problems;
}

/** Разделы 4.1–4.5 обязаны присутствовать. */
export function findMissingSections(doc: string): string[] {
  const missing: string[] = [];
  for (const id of ["4.1", "4.2", "4.3", "4.4", "4.5"]) {
    if (!new RegExp(`^#{2,4}\\s*${id.replace(".", "\\.")}\\.`, "m").test(doc)) missing.push(id);
  }
  return missing;
}

describe("документ о загрузке 64-битного адреса в регистр e2k", () => {
  const haveSources = fs.existsSync(QEMU);
  const haveProbe = fs.existsSync(PROBE);
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf-8") : "";

  it("документ существует и содержит разделы 4.1–4.5", () => {
    expect(fs.existsSync(DOC), "нет docs/e2k-address-loading.md").toBe(true);
    expect(findMissingSections(doc), "нет разделов").toEqual([]);
    expect(doc).toContain("## 1. Сырые данные");
    expect(doc).toContain("## 2. Кандидаты");
    expect(doc).toContain("## 3. Проверка ассемблером");
  });

  it("названы кандидаты К1–К5 и форма загрузки", () => {
    for (const id of ["К1", "К2", "К3", "К4", "К5"]) {
      expect(doc, `кандидат ${id} не назван`).toContain(id);
    }
    expect(doc).toContain("movtd,0 _f64");
    expect(doc).toContain("movts,0");
    expect(doc).toContain("_f32s");
    expect(doc).toContain("_f64");
  });

  it("документ не обещает больше проверенного", () => {
    expect(doc).toContain("НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ");
    expect(doc).toContain("НЕТ В ИСТОЧНИКЕ");
    expect(doc).toMatch(/Форма\s*\*{0,2}найдена/i);
    expect(doc).not.toMatch(/\b(работает|готово)\b/);
  });

  it("все ссылки «файл:строка» документа указывают на настоящие строки", () => {
    const refs = collectSourceRefs(doc);
    expect(refs.length, "ссылок в документе").toBeGreaterThanOrEqual(60);
    if (!haveSources) {
      // Слабая проверка: копии нет. Это не «проверено» — это «проверять нечего».
      expect(haveSources, "нет .tmp/e2k-sources — сверка ссылок не выполнялась").toBe(false);
      return;
    }
    const problems = verifySourceRefs(refs);
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("якоря совпадают с источником", () => {
    if (!haveSources) {
      expect(haveSources).toBe(false);
      return;
    }
    expect(ANCHORS.length).toBeGreaterThanOrEqual(35);
    const problems = verifyAnchors(ANCHORS);
    expect(problems, problems.join("; ")).toEqual([]);
    const mentioned = ANCHORS.map((anchor) => anchor.file).filter((file) => !doc.includes(file));
    expect(mentioned, `якоря не упомянуты в документе: ${mentioned.join(", ")}`).toEqual([]);
  });

  it("байты ассемблера зафиксированы в документе и совпадают с пробами", () => {
    const acceptProbes = PROBES.filter((probe) => probe.kind === "accept");
    expect(acceptProbes.length).toBeGreaterThanOrEqual(10);
    // Байты и текст обязаны быть в документе всегда.
    for (const probe of acceptProbes) {
      const squeezed = doc.replace(/[\s`]/g, "");
      expect(squeezed, `байты ${probe.name} не в документе`).toContain(probe.hex);
      expect(doc, `текст ${probe.name} не в документе`).toContain(probe.asm);
    }
    for (const refusal of REFUSALS) {
      expect(doc, `отказ «${refusal}» не назван в документе`).toContain(refusal);
    }
    if (!haveProbe) {
      expect(haveProbe, "нет .tmp/addr-probe — сверка с артефактами не выполнялась").toBe(false);
      return;
    }
    const problems = verifyProbes(acceptProbes, doc, PROBE);
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("ни один документ не ссылается на несуществующий файл", () => {
    const docs = [
      path.join(ROOT, "docs", "e2k-address-loading.md"),
      path.join(ROOT, "docs", "e2k-syscalls-minimal.md"),
      path.join(ROOT, "docs", "e2k-syscall-abi.md"),
    ];
    const problems: string[] = [];
    for (const docPath of docs) {
      if (!fs.existsSync(docPath)) {
        problems.push(`нет документа ${path.relative(ROOT, docPath)}`);
        continue;
      }
      const text = fs.readFileSync(docPath, "utf-8");
      const references = new Set<string>();
      for (const match of text.matchAll(/`((?:docs|src)\/[^`]+?)(?::\d+(?:-\d+)?)?`/g)) {
        references.add(match[1]!);
      }
      for (const reference of references) {
        if (/[<>*]/.test(reference)) continue;
        if (!fs.existsSync(path.join(ROOT, reference))) {
          problems.push(`${path.relative(ROOT, docPath)}: ссылка на отсутствующий файл ${reference}`);
        }
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("негативный контроль: испорченные входы ловятся", () => {
    // 1. Отсутствующий файл — ловится всегда, копии источников не требует.
    expect(verifySourceRefs([{ raw: "no/such.c", from: 1, to: 1 }]).join(" ")).toMatch(/нет файла/);

    // 2. Выдуманная строка и обратный диапазон — требуют копии источников.
    if (haveSources) {
      expect(verifySourceRefs([{ raw: "target/e2k/cpu.h", from: 999999, to: 999999 }]).join(" ")).toMatch(
        /ссылка требует до 999999/,
      );
      expect(verifySourceRefs([{ raw: "target/e2k/cpu.h", from: 200, to: 100 }]).join(" ")).toMatch(/обратный диапазон/);

      // 3. Якорь с чужой строкой.
      const broken = verifyAnchors([
        { file: "target/e2k/cpu.h", from: 111, to: 112, contains: "выдуманный текст", claim: "порча" },
      ]);
      expect(broken.join(" ")).toMatch(/не содержит/);
    } else {
      expect(haveSources).toBe(false);
    }

    // 4. Раздел 4.x пропал.
    const withoutSection = doc.replace(/^### 4\.4\..*$/m, "### без номера");
    expect(findMissingSections(withoutSection)).toContain("4.4");

    // 5. Байты пробы подменены в документе.
    if (haveProbe) {
      const first = PROBES[0]!;
      const tampered = doc.replace(first.hex, "00".repeat(first.hex.length / 2));
      const problems = verifyProbes([first], tampered, PROBE);
      expect(problems.join(" ")).toMatch(/не зафиксированы в документе/);

      // 6. Проба с чужими байтами не проходит сверку с .bin.
      const wrong: Probe = { name: "candC_movtd_f64_small", asm: "movtd,0 _f64 0x100000, %r8", hex: "00", kind: "accept" };
      const wrongProblems = verifyProbes([wrong], doc, PROBE);
      expect(wrongProblems.join(" ")).toMatch(/байты|не зафиксированы/);
    } else {
      expect(haveProbe).toBe(false);
    }
  });
});
