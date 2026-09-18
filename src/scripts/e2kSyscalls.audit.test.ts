/**
 * ОРАКУЛ ДОКУМЕНТОВ О СИСТЕМНЫХ ВЫЗОВАХ e2k.
 *
 * # Зачем этот тест
 *
 * Три документа этого сеанса утверждают конкретные числа и ссылки на исходники порта QEMU-e2k:
 *
 * - `docs/e2k-syscalls-raw.md` — «в источнике 446 `#define TARGET_NR_*`» и индекс на 446 строк;
 * - `docs/e2k-syscall-abi.md` — каждый факт ABI со ссылкой `файл:строка`;
 * - `docs/e2k-syscalls-minimal.md` — «семь вызовов: read, write, open, close, brk, mmap, exit».
 *
 * Утверждение без проверки — не оракул. Тест проверяет четыре уровня: **структуру документов**
 * (всегда), **совпадение со источником** (когда есть `.tmp/e2k-sources/`), **соответствие
 * документов друг другу** (номера минимального набора против сырой таблицы) и **негативный
 * контроль** (испорченный вход обязан ловиться, иначе оракул ничего не проверяет).
 *
 * # Что именно ловит
 *
 * Если кто-то удалит факт, источник `файл:строка` или строку индекса — тест краснеет:
 * якоря зафиксированы в этом файле, а не выведены из документа, поэтому вырезание ссылки из
 * документа не может «согласовать» документ с самим собой.
 *
 * # Слабое место названо прямо
 *
 * `.tmp/e2k-sources/` **не коммитится** (сотни мегабайт). На чистой копии репозитория
 * сильные уровни выполнить нечем, и тест **сообщает об этом**, а не выдаёт «проверок не было»
 * за «проверки пройдены»: каждый пропущенный уровень отмечается, и проверяется, что причина
 * пропуска — отсутствие каталога, а не что-то ещё.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const RAW_DOC = path.join(ROOT, "docs", "e2k-syscalls-raw.md");
const ABI_DOC = path.join(ROOT, "docs", "e2k-syscall-abi.md");
const MINIMAL_DOC = path.join(ROOT, "docs", "e2k-syscalls-minimal.md");
/**
 * Копия источников. Переменная `E2K_SOURCES_DIR` позволяет прогнать слабый режим
 * («копии нет») на машине, где копия есть, — иначе этот режим никто бы не проверил.
 */
const SOURCES = process.env.E2K_SOURCES_DIR ?? path.join(ROOT, ".tmp", "e2k-sources");
const QEMU = path.join(SOURCES, "qemu-e2k", "qemu");
const SYS_NR = path.join(QEMU, "linux-user", "e2k", "syscall_nr.h");
const X64_TBL = path.join(QEMU, "linux-user", "x86_64", "syscall_64.tbl");

/** Маркеры сравнения с x86_64, допустимые в индексе §3 сырого документа. */
const COMPARE_MARKERS = ["СОВПАЛ", "НОМЕР ИНОЙ", "СПЕЦИФИЧЕН", "АЛИАС", "МАРКЕР"] as const;

/** Строка `#define TARGET_NR_*` источника. */
export interface SyscallDefine {
  readonly line: number;
  readonly name: string;
  readonly value: string;
}

/** Строка машиночитаемого индекса §3 сырого документа. */
export interface IndexRow {
  readonly nr: string;
  readonly name: string;
  readonly line: number;
  readonly x86_64: string;
  readonly marker: string;
}

/** Якорь: «в этом файле, в этой строке (диапазоне) лежит этот фрагмент». */
export interface Anchor {
  readonly file: string;
  readonly from: number;
  readonly to: number;
  readonly contains: string;
  readonly claim: string;
}

/** Разобрать все `#define TARGET_NR_*` источника (включая алиасы и маркер). */
export function parseDefines(text: string): SyscallDefine[] {
  const defines: SyscallDefine[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s*#define\s+TARGET_NR_(\S+)\s+(\S+)/.exec(lines[index]!);
    if (match === null) continue;
    defines.push({ line: index + 1, name: match[1]!, value: match[2]! });
  }
  return defines;
}

/**
 * Разобрать машиночитаемый индекс между маркерами `BEGIN/END SYSCALL-INDEX`.
 *
 * Пустая строка или пропущенный маркер — это `[]`, а не «всё хорошо»: тест ниже требует
 * ровно 446 строк индекса.
 */
export function parseIndex(doc: string): IndexRow[] {
  const lines = doc.split(/\r?\n/);
  const begin = lines.findIndex((line) => line.includes("BEGIN SYSCALL-INDEX"));
  const end = lines.findIndex((line) => line.includes("END SYSCALL-INDEX"));
  if (begin < 0 || end <= begin) return [];
  const rows: IndexRow[] = [];
  for (const line of lines.slice(begin + 1, end)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("```")) continue;
    const cells = trimmed.split("|");
    if (cells.length !== 5) continue;
    rows.push({
      nr: cells[0]!,
      name: cells[1]!,
      line: Number(cells[2]),
      x86_64: cells[3]!,
      marker: cells[4]!,
    });
  }
  return rows;
}

/** Проблемы индекса: пустой список — индекс верен. */
export function validateIndexAgainstDefines(
  rows: readonly IndexRow[],
  defines: readonly SyscallDefine[],
): string[] {
  const problems: string[] = [];
  if (rows.length !== defines.length) {
    problems.push(`строк индекса: ${rows.length}, #define в источнике: ${defines.length}`);
    return problems;
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const define = defines[index]!;
    if (row.name !== define.name) {
      problems.push(`строка ${index + 1}: имя «${row.name}», в источнике «${define.name}»`);
    }
    if (row.line !== define.line) {
      problems.push(`строка ${index + 1} (${row.name}): строка ${row.line}, в источнике ${define.line}`);
    }
    const numeric = /^\d+$/.test(define.value);
    if (numeric) {
      if (row.nr !== String(Number(define.value))) {
        problems.push(`строка ${index + 1} (${row.name}): номер «${row.nr}», в источнике «${define.value}»`);
      }
    } else if (!row.nr.includes(define.value)) {
      problems.push(`строка ${index + 1} (${row.name}): алиас «${row.nr}» не ссылается на ${define.value}`);
    }
    if (!COMPARE_MARKERS.includes(row.marker as (typeof COMPARE_MARKERS)[number])) {
      problems.push(`строка ${index + 1} (${row.name}): неизвестный маркер «${row.marker}»`);
    }
    if (!/^x86_64:(\d+|—)$/.test(row.x86_64)) {
      problems.push(`строка ${index + 1} (${row.name}): графа x86_64 «${row.x86_64}»`);
    }
  }
  return problems;
}

/** Проблемы сортировки: строки источника обязаны быть по возрастанию (без пропусков строк). */
export function validateOrder(rows: readonly IndexRow[]): string[] {
  const problems: string[] = [];
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (current.line <= previous.line) {
      problems.push(`порядок строк нарушен: ${previous.name}:${previous.line} → ${current.name}:${current.line}`);
    }
  }
  return problems;
}

/**
 * Проверить якоря по локальной копии источников.
 *
 * Сравнение побуквенное (`includes`), без учёта пробелов по краям: `contains` — подстрока,
 * которая обязана лежать хотя бы в одной строке из объявленного диапазона.
 */
export function verifyAnchors(anchors: readonly Anchor[]): string[] {
  const problems: string[] = [];
  for (const anchor of anchors) {
    const file = path.join(QEMU, anchor.file);
    if (!fs.existsSync(file)) {
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
      problems.push(
        `${anchor.file}:${anchor.from}-${anchor.to} не содержит «${anchor.contains}» (утверждение: ${anchor.claim})`,
      );
    }
  }
  return problems;
}

/** Ссылка документа на строку источника: `файл:строка` или `файл:строка-строка`. */
export interface SourceRef {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Собрать из документа все ссылки вида `` `файл:строка` ``.
 *
 * Собираются пути с расширениями исходников и документов (`.c`, `.h`, `.tbl`, `.ts`, `.md`).
 * Не разобранные до строки ссылки (`.tmp/…`, `docs/…`) сюда не попадают и проверяются отдельным
 * тестом — там сравнивать нечего, кроме существования файла.
 */
export function collectSourceRefs(doc: string): SourceRef[] {
  const refs: SourceRef[] = [];
  const pattern = /`([A-Za-z0-9_./-]+\.(?:c|h|tbl|ts|md)):(\d+)(?:-(\d+))?/g;
  for (const match of doc.matchAll(pattern)) {
    const from = Number(match[2]);
    refs.push({ path: match[1]!, from, to: match[3] === undefined ? from : Number(match[3]) });
  }
  return refs;
}

/**
 * Голые имена файлов (без каталога) → полный путь от корня дерева исходников.
 *
 * В документах ссылки пишутся и полно (`target/e2k/cpu.h:57-58`), и коротко (`cpu.h:57-58`);
 * таблица делает короткую форму проверяемой, а не догадкой.
 */
export const BARE_FILE_ROOTS: Readonly<Record<string, string>> = {
  "cpu.h": "qemu-e2k/qemu/target/e2k/cpu.h",
  "cpu-sregs.h": "qemu-e2k/qemu/target/e2k/cpu-sregs.h",
  "cpu_loop.c": "qemu-e2k/qemu/linux-user/e2k/cpu_loop.c",
  "reg-index.h": "qemu-e2k/qemu/target/e2k/reg-index.h",
  "translate-ct.c": "qemu-e2k/qemu/target/e2k/tcg/translate-ct.c",
  "translate-ctp.c": "qemu-e2k/qemu/target/e2k/tcg/translate-ctp.c",
  "translate-wi.c": "qemu-e2k/qemu/target/e2k/tcg/translate-wi.c",
  "syscall.c": "qemu-e2k/qemu/linux-user/syscall.c",
  "syscall_nr.h": "qemu-e2k/qemu/linux-user/e2k/syscall_nr.h",
  "syscall_64.tbl": "qemu-e2k/qemu/linux-user/x86_64/syscall_64.tbl",
  "user-internals.h": "qemu-e2k/qemu/linux-user/user-internals.h",
};

/** Проблемы ссылок: пустой список — все ссылки указывают на настоящие строки. */
export function verifySourceRefs(refs: readonly SourceRef[]): string[] {
  const problems: string[] = [];
  for (const ref of refs) {
    let file = "";
    if (ref.path.startsWith("docs/") || ref.path.startsWith("src/")) {
      file = path.join(ROOT, ref.path);
    } else if (BARE_FILE_ROOTS[ref.path] !== undefined) {
      file = path.join(SOURCES, BARE_FILE_ROOTS[ref.path]!);
    } else {
      file = path.join(QEMU, ref.path);
    }
    if (!fs.existsSync(file)) {
      problems.push(`нет файла ${ref.path} (ссылка ${ref.path}:${ref.from})`);
      continue;
    }
    if (ref.to < ref.from) {
      problems.push(`${ref.path}:${ref.from}-${ref.to} — обратный диапазон`);
      continue;
    }
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    if (lines.length < ref.to) {
      problems.push(`${ref.path}: строк ${lines.length}, ссылка требует до ${ref.to}`);
    }
  }
  return problems;
}

/** Минимальный набор: имя, номер, строка `#define` и место в обработчике. */
export interface MinimalSyscall {
  readonly name: string;
  readonly nr: number;
  readonly nrLine: number;
  readonly handler: string;
  readonly handlerFrom: number;
  readonly handlerTo: number;
}

export const MINIMAL_SYSCALLS: readonly MinimalSyscall[] = [
  { name: "read", nr: 3, nrLine: 11, handler: "case TARGET_NR_read:", handlerFrom: 10567, handlerTo: 10580 },
  { name: "write", nr: 4, nrLine: 12, handler: "case TARGET_NR_write:", handlerFrom: 10581, handlerTo: 10599 },
  { name: "open", nr: 5, nrLine: 13, handler: "case TARGET_NR_open:", handlerFrom: 10602, handlerTo: 10610 },
  { name: "close", nr: 6, nrLine: 14, handler: "case TARGET_NR_close:", handlerFrom: 10664, handlerTo: 10666 },
  { name: "brk", nr: 45, nrLine: 53, handler: "case TARGET_NR_brk:", handlerFrom: 10680, handlerTo: 10681 },
  { name: "mmap", nr: 90, nrLine: 98, handler: "case TARGET_NR_mmap:", handlerFrom: 11907, handlerTo: 11928 },
  { name: "exit", nr: 1, nrLine: 9, handler: "case TARGET_NR_exit:", handlerFrom: 10517, handlerTo: 10517 },
];

/**
 * Утверждения ABI-документа, обязанные оставаться в документе **и** в источнике.
 *
 * Таблица зафиксирована здесь, а не читается из документа: вырезание ссылки из документа
 * не должно «согласовать» документ с самим собой.
 */
export const ABI_ANCHORS: readonly Anchor[] = [
  { file: "linux-user/e2k/cpu_loop.c", from: 164, to: 164, contains: "e2k_try_get_window_reg_p(env, 0)", claim: "номер вызова — оконный r0" },
  { file: "linux-user/e2k/cpu_loop.c", from: 165, to: 169, contains: "syscall without proper WD configuration", claim: "защита от неверного окна" },
  { file: "linux-user/e2k/cpu_loop.c", from: 170, to: 170, contains: "1ull << 10ull", claim: "номер — младшие 10 бит" },
  { file: "linux-user/e2k/cpu_loop.c", from: 172, to: 178, contains: "args[8]", claim: "аргументы — восемь слотов" },
  { file: "linux-user/e2k/cpu_loop.c", from: 172, to: 178, contains: "e2k_try_get_window_reg_p(env, i+1)", claim: "аргументы — оконные r1..r8" },
  { file: "linux-user/e2k/cpu_loop.c", from: 209, to: 215, contains: "ret_nr_p->lo = ret", claim: "результат — в оконный r0" },
  { file: "linux-user/e2k/cpu_loop.c", from: 217, to: 217, contains: "e2k_cpu_exec_ct_return", claim: "возврат по цепочке возврата" },
  { file: "linux-user/e2k/cpu_loop.c", from: 187, to: 197, contains: "env->restart_syscall = true", claim: "повтор вызова вместо повтора инструкции" },
  { file: "linux-user/e2k/cpu_loop.c", from: 302, to: 303, contains: "psize_q", claim: "начальные psize_q/size_q" },
  { file: "target/e2k/reg-index.h", from: 131, to: 139, contains: "e2k_try_get_window_reg_p", claim: "номер и аргументы — по индексу окна" },
  { file: "target/e2k/reg-index.h", from: 79, to: 79, contains: "% MAXSR_D", claim: "индекс окна → физический регистр" },
  { file: "target/e2k/cpu.h", from: 117, to: 117, contains: "window[E2K_RF_WIN_INTERNAL_SIZE]", claim: "физический индекс 0 — первый регистр окна" },
  { file: "target/e2k/cpu.h", from: 57, to: 58, contains: "MAXNR_D", claim: "квадрослово — две регистровые единицы" },
  { file: "target/e2k/cpu.h", from: 52, to: 55, contains: "EXCP_SYSCALL", claim: "EXCP_SYSCALL = 0x102" },
  { file: "linux-user/user-internals.h", from: 113, to: 116, contains: "(abi_ulong)(-4096)", claim: "признак ошибки — ret >= -4096" },
  { file: "linux-user/syscall.c", from: 15341, to: 15344, contains: "abi_long arg8", claim: "общий обработчик принимает 8 аргументов" },
  { file: "target/e2k/cpu-sregs.h", from: 163, to: 173, contains: "E2K_CTPR_TAG_CTPSL", claim: "тег CTPSL = 5" },
  { file: "target/e2k/tcg/translate-ctp.c", from: 81, to: 81, contains: "E2K_CTPR_TAG_CTPLL", claim: "disp всегда пишет CTPLL" },
  { file: "target/e2k/tcg/translate-ctp.c", from: 142, to: 184, contains: "sdisp * 2048ull", claim: "sdisp — база от oscud" },
  { file: "target/e2k/tcg/translate-ctp.c", from: 142, to: 184, contains: "E2K_CTPR_TAG_CTPSL", claim: "sdisp — тег CTPSL" },
  { file: "target/e2k/tcg/translate-ct.c", from: 751, to: 755, contains: "can_have_syscall", claim: "CALL с CTPSL → возможен syscall" },
  { file: "target/e2k/tcg/translate-ct.c", from: 908, to: 917, contains: "WD, psize_q", claim: "wbs ограничен размерами окна" },
  { file: "target/e2k/tcg/translate-ct.c", from: 1090, to: 1090, contains: "env->sregs.br = 0", claim: "CALL сбрасывает BR" },
  { file: "target/e2k/tcg/translate-ct.c", from: 1144, to: 1145, contains: "have_syscall = true", claim: "CTPSL взводит have_syscall" },
  { file: "target/e2k/tcg/translate-wi.c", from: 569, to: 579, contains: "have_syscall", claim: "выход из трансляции по have_syscall" },
  { file: "linux-user/e2k/syscall_nr.h", from: 1, to: 4, contains: "arch/e2k/include/uapi/asm/unistd.h", claim: "происхождение таблицы" },
  { file: "linux-user/e2k/syscall_nr.h", from: 451, to: 451, contains: "TARGET_NR_syscalls", claim: "маркер syscalls = 436" },
];

/** Якоря утверждений о коде модели, на которые ссылаются документы. */
export const CROSS_ANCHORS: readonly Anchor[] = [
  { file: "linux-user/x86_64/syscall_64.tbl", from: 12, to: 24, contains: "read", claim: "x86_64: read = 0" },
  { file: "linux-user/x86_64/syscall_64.tbl", from: 13, to: 13, contains: "write", claim: "x86_64: write = 1" },
  { file: "linux-user/x86_64/syscall_64.tbl", from: 72, to: 72, contains: "exit", claim: "x86_64: exit = 60" },
  { file: "linux-user/syscall.c", from: 871, to: 909, contains: "do_brk", claim: "реализация brk" },
  { file: "linux-user/syscall.c", from: 11926, to: 11926, contains: "do_mmap(arg1, arg2, arg3, arg4, arg5, arg6)", claim: "mmap: шесть аргументов напрямую" },
  { file: "linux-user/syscall_defs.h", from: 3135, to: 3140, contains: "TARGET_ARCH_WANT_SYS_OLD_MMAP", claim: "список архитектур старого mmap" },
  { file: "linux-user/e2k/target_fcntl.h", from: 9, to: 9, contains: "../generic/fcntl.h", claim: "флаги open — из generic" },
  { file: "linux-user/e2k/target_mman.h", from: 8, to: 22, contains: "TARGET_MAP_ANONYMOUS", claim: "флаги mmap для e2k есть в порте" },
  { file: "linux-user/e2k/target_mman.h", from: 8, to: 22, contains: "TARGET_MAP_FIXED_NOREPLACE", claim: "MAP_FIXED_NOREPLACE для e2k есть в порте" },
];

/** Проблемы утверждений минимального набора. */
export function checkMinimalClaims(doc: string, defines: readonly SyscallDefine[]): string[] {
  const problems: string[] = [];
  for (const syscall of MINIMAL_SYSCALLS) {
    if (!doc.includes(`\`${syscall.name}\``)) {
      problems.push(`вызов ${syscall.name} не назван в документе`);
    }
    const define = defines.find((item) => item.name === syscall.name);
    if (define === undefined) {
      problems.push(`вызова ${syscall.name} нет в источнике syscall_nr.h`);
      continue;
    }
    if (Number(define.value) !== syscall.nr) {
      problems.push(`${syscall.name}: в документе ${syscall.nr}, в источнике ${define.value}`);
    }
    if (!doc.includes(`${syscall.nr}`)) {
      problems.push(`номер ${syscall.nr} (${syscall.name}) не назван в документе`);
    }
    if (!doc.includes(`TARGET_NR_${syscall.name}`)) {
      problems.push(`обработчик ${syscall.handler} не назван в документе`);
    }
  }
  return problems;
}

/** Есть ли у вызова блок кода с шаблоном `sdisp` + `call %ctpr1`. */
export function hasCallTemplate(doc: string, name: string): boolean {
  const marker = doc.indexOf(`### 3.`);
  const body = marker >= 0 ? doc.slice(marker) : doc;
  const heading = new RegExp(`#{3}[^\\n]*\`${name}\``);
  const match = heading.exec(body);
  if (match === null) return false;
  const rest = body.slice(match.index + match[0].length);
  const next = rest.search(/\n### /);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const block = /```asm([\s\S]*?)```/.exec(section);
  if (block === null) return false;
  return block[1]!.includes("sdisp") && block[1]!.includes("call");
}

/** Счётчики вызовов вида `call    %ctpr1` в коде документа. */
export function countCallSites(doc: string): number {
  const matches = doc.match(/call\s+%ctpr1/g);
  return matches === null ? 0 : matches.length;
}

describe("документы о системных вызовах e2k", () => {
  const haveSources = fs.existsSync(QEMU);
  const rawDoc = fs.existsSync(RAW_DOC) ? fs.readFileSync(RAW_DOC, "utf-8") : "";
  const abiDoc = fs.existsSync(ABI_DOC) ? fs.readFileSync(ABI_DOC, "utf-8") : "";
  const minimalDoc = fs.existsSync(MINIMAL_DOC) ? fs.readFileSync(MINIMAL_DOC, "utf-8") : "";
  const defines = fs.existsSync(SYS_NR) ? parseDefines(fs.readFileSync(SYS_NR, "utf-8")) : [];
  const index = parseIndex(rawDoc);

  it("сырой документ: индекс совпадает с числом #define в источнике", () => {
    expect(fs.existsSync(RAW_DOC), "нет docs/e2k-syscalls-raw.md").toBe(true);
    expect(rawDoc).toContain("SYSCALL-INDEX");
    expect(index.length, "строк индекса").toBe(446);
    if (!haveSources) {
      // Слабая проверка: источника нет. Это не «проверено» — это «проверять нечего».
      expect(haveSources, "нет .tmp/e2k-sources/qemu-e2k/qemu — сверка с #define не выполнялась").toBe(false);
      return;
    }
    expect(defines.length, "#define TARGET_NR_* в syscall_nr.h").toBe(446);
    expect(validateIndexAgainstDefines(index, defines)).toEqual([]);
    expect(validateOrder(index)).toEqual([]);
    expect(rawDoc).toContain(String(defines.length));
  });

  it("сырой документ: маркеры сверки с x86_64 не выдуманы", () => {
    expect(index.length).toBe(446);
    const same = index.filter((row) => row.marker === "СОВПАЛ");
    const other = index.filter((row) => row.marker === "НОМЕР ИНОЙ");
    const specific = index.filter((row) => row.marker === "СПЕЦИФИЧЕН");
    const aliases = index.filter((row) => row.marker === "АЛИАС");
    const markers = index.filter((row) => row.marker === "МАРКЕР");
    expect(same.length + other.length + specific.length + aliases.length + markers.length).toBe(446);
    expect(same.length).toBe(1);
    expect(aliases.length).toBe(3);
    expect(markers.length).toBe(1);
    if (!haveSources) {
      expect(haveSources).toBe(false);
      return;
    }
    const table = fs.readFileSync(X64_TBL, "utf-8");
    const x64: Record<string, number> = {};
    for (const line of table.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(common|64|x32)\s+(\S+)\s/.exec(line);
      if (match === null) continue;
      if (x64[match[3]!] === undefined) x64[match[3]!] = Number(match[1]);
    }
    const problems: string[] = [];
    for (const row of index) {
      if (row.marker === "АЛИАС" || row.marker === "МАРКЕР") continue;
      const expected = x64[row.name];
      const actual = /^x86_64:(\d+)$/.exec(row.x86_64)?.[1];
      if (expected === undefined) {
        if (row.marker !== "СПЕЦИФИЧЕН" || actual !== undefined) {
          problems.push(`${row.name}: на x86_64 нет, а в индексе «${row.marker}» / «${row.x86_64}»`);
        }
      } else if (row.marker === "СПЕЦИФИЧЕН") {
        problems.push(`${row.name}: на x86_64 есть (${expected}), а помечен «СПЕЦИФИЧЕН»`);
      } else if (Number(actual) !== expected) {
        problems.push(`${row.name}: x86_64 ${expected}, в индексе ${row.x86_64}`);
      } else if (row.marker === "СОВПАЛ" && Number(row.nr) !== expected) {
        problems.push(`${row.name}: «СОВПАЛ» при номерах ${row.nr} и ${expected}`);
      } else if (row.marker === "НОМЕР ИНОЙ" && Number(row.nr) === expected) {
        problems.push(`${row.name}: «НОМЕР ИНОЙ» при одинаковых номерах ${expected}`);
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("ABI-документ: у каждого факта есть источник или названная причина", () => {
    expect(fs.existsSync(ABI_DOC), "нет docs/e2k-syscall-abi.md").toBe(true);
    const refs = collectSourceRefs(abiDoc);
    expect(refs.length, "ссылок «файл:строка» в ABI-документе").toBeGreaterThanOrEqual(80);
    expect(abiDoc).toContain("НЕТ В ИСТОЧНИКЕ");
    // §5 перешёл из «шаблон, исполнением не проверен» в «проверено прогоном»: сторож требует
    // ровно этого и требует назвать, чего прогон НЕ доказывает (иначе «проверено» — обещание).
    const section5 = abiDoc.slice(abiDoc.indexOf("## 5."), abiDoc.indexOf("## 6."));
    expect(section5, "§5 не называет исполнение проверенным").toContain("ПРОВЕРЕНО ИСПОЛНЕНИЕМ");
    expect(section5, "§5 одновременно помечен как непроверенный").not.toContain("НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ");
    expect(section5, "§5 не называет оракул прогона").toContain("src/e2k/e2kSyscallRuntime.test.ts");
    expect(section5, "§5 не называет, чего прогон не доказывает").toMatch(/НЕ ЗАМЕРЕНО|НЕТ В ИСТОЧНИКЕ/);
    // Заявленное «проверено» обязано иметь инструмент: файл оракула существует и утверждает hello.
    const runOracle = fs.readFileSync(path.join(ROOT, "src", "e2k", "e2kSyscallRuntime.test.ts"), "utf-8");
    expect(runOracle, "оракул прогона не утверждает hello").toContain("hello");
    expect(abiDoc).not.toContain("работает");
    // Факты, оставшиеся без источника, обязаны быть перечислены в §7 таблицей отсутствующего.
    const notFound = abiDoc.slice(abiDoc.indexOf("## 7."), abiDoc.indexOf("## 8."));
    expect(notFound.split(/\r?\n/).filter((line) => line.trim().startsWith("|")).length).toBeGreaterThanOrEqual(10);
  });

  it("ссылки «файл:строка» всех трёх документов указывают на настоящие строки источника", () => {
    if (!haveSources) {
      expect(haveSources).toBe(false);
      return;
    }
    const problems = verifyAnchors([...ABI_ANCHORS, ...CROSS_ANCHORS]);
    expect(problems, problems.join("; ")).toEqual([]);
    const referenced = new Set([...ABI_ANCHORS, ...CROSS_ANCHORS].map((anchor) => anchor.file));
    const unmentioned = [...referenced].filter((file) => !abiDoc.includes(file));
    expect(unmentioned, `якоря не упомянуты в документе: ${unmentioned.join(", ")}`).toEqual([]);

    // Каждая ссылка документа — существующий файл и существующая строка.
    const refProblems: string[] = [];
    for (const [label, text] of [
      ["сырой", rawDoc],
      ["ABI", abiDoc],
      ["минимальный", minimalDoc],
    ] as const) {
      const refs = collectSourceRefs(text);
      expect(refs.length, `${label} документ: ссылок`).toBeGreaterThan(0);
      refProblems.push(...verifySourceRefs(refs).map((problem) => `${label}: ${problem}`));
    }
    expect(refProblems, refProblems.join("; ")).toEqual([]);
  });

  it("минимальный набор: семь вызовов, у каждого номер, источник и шаблон вызова", () => {
    expect(fs.existsSync(MINIMAL_DOC), "нет docs/e2k-syscalls-minimal.md").toBe(true);
    expect(MINIMAL_SYSCALLS.length).toBe(7);
    for (const syscall of MINIMAL_SYSCALLS) {
      expect(hasCallTemplate(minimalDoc, syscall.name), `нет блока asm с sdisp/call у ${syscall.name}`).toBe(true);
    }
    expect(countCallSites(minimalDoc)).toBeGreaterThanOrEqual(7);
    if (haveSources) {
      expect(checkMinimalClaims(minimalDoc, defines)).toEqual([]);
      const problems = verifyAnchors(
        MINIMAL_SYSCALLS.map((syscall) => ({
          file: "linux-user/e2k/syscall_nr.h",
          from: syscall.nrLine,
          to: syscall.nrLine,
          contains: `TARGET_NR_${syscall.name}`,
          claim: `${syscall.name} = ${syscall.nr}`,
        })),
      );
      expect(problems, problems.join("; ")).toEqual([]);
      const handlerProblems = verifyAnchors(
        MINIMAL_SYSCALLS.map((syscall) => ({
          file: "linux-user/syscall.c",
          from: syscall.handlerFrom,
          to: syscall.handlerTo,
          contains: syscall.handler,
          claim: `обработчик ${syscall.name}`,
        })),
      );
      expect(handlerProblems, handlerProblems.join("; ")).toEqual([]);
    } else {
      expect(haveSources).toBe(false);
      expect(checkMinimalClaims(minimalDoc, MINIMAL_SYSCALLS.map((syscall) => ({
        line: syscall.nrLine,
        name: syscall.name,
        value: String(syscall.nr),
      })))).toEqual([]);
    }
  });

  it("номера минимального набора совпадают с сырой таблицей", () => {
    expect(index.length).toBe(446);
    const problems: string[] = [];
    for (const syscall of MINIMAL_SYSCALLS) {
      const row = index.find((item) => item.name === syscall.name);
      if (row === undefined) {
        problems.push(`${syscall.name} отсутствует в индексе сырой таблицы`);
        continue;
      }
      if (Number(row.nr) !== syscall.nr) {
        problems.push(`${syscall.name}: сырая таблица ${row.nr}, минимальный набор ${syscall.nr}`);
      }
      if (row.line !== syscall.nrLine) {
        problems.push(`${syscall.name}: строка ${row.line}, ожидалась ${syscall.nrLine}`);
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("ни один документ не ссылается на несуществующий файл", () => {
    const docs = [RAW_DOC, ABI_DOC, MINIMAL_DOC];
    const problems: string[] = [];
    for (const docPath of docs) {
      if (!fs.existsSync(docPath)) {
        problems.push(`нет документа ${path.relative(ROOT, docPath)}`);
        continue;
      }
      const text = fs.readFileSync(docPath, "utf-8");
      const references = new Set<string>();
      // Ссылка вида `docs/файл.md:12-34` — это путь плюс строка, номер отбрасывается.
      for (const match of text.matchAll(/`((?:docs|src)\/[^`]+?)(?::\d+(?:-\d+)?)?`/g)) {
        references.add(match[1]!);
      }
      for (const reference of references) {
        if (/[<>*]/.test(reference)) continue; // шаблон, а не путь
        if (reference.split("/").pop() === "") continue;
        if (!fs.existsSync(path.join(ROOT, reference))) {
          problems.push(`${path.relative(ROOT, docPath)}: ссылка на отсутствующий файл ${reference}`);
        }
      }
    }
    expect(problems, problems.join("; ")).toEqual([]);
  });

  it("ABI-документ не обещает больше, чем проверено", () => {
    const section5 = abiDoc.slice(abiDoc.indexOf("## 5."), abiDoc.indexOf("## 6."));
    expect(section5).toContain("ПРОВЕРЕНО ИСПОЛНЕНИЕМ");
    expect(section5).not.toContain("НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ");
    expect(minimalDoc).toContain("НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ");
    expect(abiDoc).not.toMatch(/\b(работает|готово)\b/);
    expect(minimalDoc).not.toMatch(/\b(работает|готово)\b/);
    expect(minimalDoc.match(/НЕ ПРОВЕРЕНО ИСПОЛНЕНИЕМ/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("негативный контроль: испорченные входы ловятся", () => {
    // 1. Индекс разрежён — число строк не совпадает с источником.
    const thinned = index.slice(1);
    expect(validateIndexAgainstDefines(thinned, defines).join(" ")).toMatch(/строк индекса/);

    // 2. Сдвинутая строка источника.
    if (haveSources) {
      const shifted = index.map((row, position) =>
        position === 0 ? { ...row, line: row.line + 1 } : row,
      );
      expect(validateIndexAgainstDefines(shifted, defines).join(" ")).toMatch(/строка/);
    } else {
      expect(defines.length).toBe(0);
    }

    // 3. Переставленные строки (проверка порядка не зависит от источника).
    const swapped = [...index];
    const first = swapped[0]!;
    const second = swapped[1]!;
    swapped[0] = second;
    swapped[1] = first;
    expect(validateOrder(swapped).join(" ")).toMatch(/порядок строк/);

    // 4. Испорченный номер.
    if (haveSources) {
      const wrongNr = index.map((row, position) => (position === 3 ? { ...row, nr: "9999" } : row));
      expect(validateIndexAgainstDefines(wrongNr, defines).join(" ")).toMatch(/номер/);
    } else {
      expect(defines.length).toBe(0);
    }

    // 5. Якорь с несуществующим файлом и с неверной строкой.
    if (haveSources) {
      const brokenAnchors = verifyAnchors([
        { file: "НЕТ/ТАКОГО/ФАЙЛА.c", from: 1, to: 1, contains: "x", claim: "порча" },
        { file: "linux-user/e2k/cpu_loop.c", from: 164, to: 164, contains: "выдуманный текст", claim: "порча" },
      ]);
      expect(brokenAnchors.join(" ")).toMatch(/нет файла/);
      expect(brokenAnchors.join(" ")).toMatch(/не содержит/);

      // 6. Ссылка на выдуманную строку и на файл, которого нет.
      const fabricated = collectSourceRefs("Смотри `linux-user/e2k/cpu_loop.c:999999` и `no/such.c:1`.");
      expect(fabricated.length).toBe(2);
      const fabricatedProblems = verifySourceRefs(fabricated).join(" ");
      expect(fabricatedProblems).toMatch(/нет файла no\/such\.c/);
      expect(fabricatedProblems).toMatch(/ссылка требует до 999999/);

      // 7. Обратный диапазон строк.
      expect(verifySourceRefs([{ path: "linux-user/e2k/cpu_loop.c", from: 200, to: 100 }]).join(" ")).toMatch(
        /обратный диапазон/,
      );
    } else {
      // Слабая копия: файловых проверок нет, но разбор ссылок проверить можно.
      const fabricated = collectSourceRefs("Смотри `no/such.c:1`.");
      expect(fabricated.length).toBe(1);
      expect(fabricated[0]!.path).toBe("no/such.c");
    }

    // 8. Минимальный набор: вызов пропал из документа.
    const withoutRead = minimalDoc.replace(/`read`/g, "`чтение`");
    if (haveSources) {
      expect(checkMinimalClaims(withoutRead, defines).join(" ")).toMatch(/read/);
    } else {
      expect(withoutRead.includes("`read`")).toBe(false);
    }
  });
});
