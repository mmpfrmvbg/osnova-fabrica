/**
 * ОРАКУЛ ОПИСИ СЫРЫХ ИСТОЧНИКОВ КОДИРОВКИ e2k.
 *
 * # Зачем этот тест
 *
 * `docs/e2k-sources-raw.md` утверждает: шесть внешних источников скачаны, кодировка и ABI
 * лежат в конкретных файлах и строках. Утверждение без проверки — не оракул. Тест проверяет
 * три уровня:
 *
 * 1. **Опись полна** — в документе есть все шесть источников, у каждого URL, дата, коммит или
 *    хеш архива и локальный путь (проверяется всегда).
 * 2. **Ссылки «файл:строка» не выдуманы** — по списку якорей проверяется, что в названной
 *    строке названного файла лежит ожидаемый текст (проверяется, когда есть локальная копия).
 * 3. **Копия совпадает с описью** — коммит в `.git/HEAD` клона и `sha256` архива равны
 *    записанным в документе (проверяется, когда есть локальная копия).
 *
 * # Слабое место названо прямо
 *
 * `.tmp/e2k-sources/` **не коммитится** (объём — сотни мегабайт). На чистой копии репозитория
 * уровни 2 и 3 выполнить нечем, и тест **сообщает об этом**, а не выдаёт «проверок не было» за
 * «проверки пройдены»: каждый пропущенный уровень отмечается в `weak` и проверяется, что
 * причина пропуска — **отсутствие каталога**, а не что-то ещё.
 *
 * # Негативный контроль
 *
 * Проверяющая функция прогоняется на **испорченной** описи (снят хеш, снят URL, испорчена
 * строка якоря). Если порча не ловится — оракул красен всегда и ничего не проверяет.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const ROOT = path.resolve(__dirname, "..", "..");
const DOC = path.join(ROOT, "docs", "e2k-sources-raw.md");
const SOURCES_DIR = path.join(ROOT, ".tmp", "e2k-sources");

/**
 * Сколько источников обязана описывать опись.
 *
 * 1–4 — источники кодировки и форматов (binutils, llvm, порт QEMU, реверс-инжиниринг);
 * 5–6 — исходники ядра Linux для e2k (6.1 и 5.10, опубликованы МЦСТ 2026-09-30): это
 * первоисточник ABI (номера системных вызовов, подписи обработчиков), которого до той даты
 * в зеркале не было — шапка таблицы порта QEMU ссылалась на файл ядра, которого не существовало.
 */
const SOURCE_COUNT = 6;

/**
 * Второй канал для файла ABI: копия `arch/e2k/include/uapi/asm/unistd.h` из `OpenE2K/linux`
 * (ветка `master`), взятая через `raw.githubusercontent.com` с **обычной** проверкой цепочки —
 * в отличие от архивов, пришедших с `dev.mcst.ru` Node-скриптом с отключённой проверкой.
 *
 * Зачем проверка: «номера системных вызовов подтверждены двумя каналами» — утверждение
 * (`docs/verification-debt.md`, случай 25), и оно обязано краснеть, если копии разойдутся или
 * если опись перестанет называть каналы. Байты **архивов** вторым каналом не подтверждены —
 * это записано незакрытым, а не выдано за проверенное.
 */
const INDEPENDENT_COPY = path.join(SOURCES_DIR, "opene2k-linux-master-unistd.h");
const INDEPENDENT_COPY_SHA256 = "054208985e28da4acdc45449c73c8875aebe70411bafc693ad327aba6f4c5881";
const INDEPENDENT_COPY_CHANNEL = "raw.githubusercontent.com";
const ARCHIVE_UNISTD = path.join(
  SOURCES_DIR,
  "linux-6.1.0-1.19-open",
  "arch",
  "e2k",
  "include",
  "uapi",
  "asm",
  "unistd.h",
);

/** Запись описи: одна строка таблицы §1. */
export interface SourceRecord {
  readonly index: number;
  readonly title: string;
  readonly url: string;
  readonly date: string;
  readonly revision: string;
  readonly localPaths: readonly string[];
}

/**
 * Разобрать таблицу источников (§1) документа.
 *
 * Формат строки: `| # | источник | URL | дата | коммит/хеш | локальный путь |`.
 */
export function parseSourceTable(doc: string): SourceRecord[] {
  const records: SourceRecord[] = [];
  for (const line of doc.split(/\r?\n/)) {
    const raw = line.split("|").map((cell) => cell.trim());
    if (raw.length < 8) continue;
    // Ячейки таблицы заключают URL, коммит и пути в обратные кавычки; для разбора
    // значений кавычки снимаются, для разбора путей — сохраняются (путей в ячейке может
    // быть два, и оба выделены кавычками).
    const cells = raw.map((cell) => cell.replace(/`/g, ""));
    const index = Number(cells[1]);
    if (!Number.isInteger(index) || index < 1 || index > 20) continue;
    if (!/^https:\/\//.test(cells[3] ?? "")) continue;
    const paths = [...(raw[6] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    records.push({
      index,
      title: cells[2] ?? "",
      url: cells[3] ?? "",
      date: cells[4] ?? "",
      revision: cells[5] ?? "",
      localPaths: paths,
    });
  }
  return records;
}

/** Проблемы описи: пустой список — опись полна. */
export function validateSourceTable(records: readonly SourceRecord[]): string[] {
  const problems: string[] = [];
  if (records.length !== SOURCE_COUNT) {
    problems.push(`источников в описи: ${records.length}, ожидалось ${SOURCE_COUNT}`);
  }
  const seen = new Set<number>();
  for (const record of records) {
    if (seen.has(record.index)) problems.push(`источник ${record.index} записан дважды`);
    seen.add(record.index);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
      problems.push(`источник ${record.index}: дата «${record.date}» не вида ГГГГ-ММ-ДД`);
    }
    if (!/^https:\/\/\S+$/.test(record.url)) {
      problems.push(`источник ${record.index}: URL «${record.url}» не вида https://…`);
    }
    const commit = /^[0-9a-f]{40}\b/.test(record.revision);
    const archive = /^sha256:[0-9a-f]{64}/.test(record.revision);
    if (!commit && !archive) {
      problems.push(`источник ${record.index}: «${record.revision}» — ни коммит, ни sha256`);
    }
    if (record.localPaths.length === 0) problems.push(`источник ${record.index}: нет локального пути`);
  }
  return problems;
}

/**
 * Якоря: утверждения документа «в этом файле, в этой строке лежит это».
 *
 * Проверяются по локальной копии. Строка сравнивается без учёта регистра и пробелов по краям;
 * `contains` — подстрока, которая обязана в ней быть.
 */
const ANCHORS: ReadonlyArray<{ source: number; file: string; line: number; contains: string }> = [
  { source: 1, file: "opcodes/e2k-opc.h", line: 19, contains: '"adds"' },
  { source: 1, file: "opcodes/e2k-opc.h", line: 19, contains: "0x10" },
  { source: 1, file: "opcodes/e2k-opc.h", line: 1434, contains: '"muls"' },
  { source: 1, file: "opcodes/e2k-opc.h", line: 644, contains: '"movts"' },
  { source: 1, file: "include/opcode/e2k.h", line: 68, contains: "EXT" },
  { source: 1, file: "include/opcode/e2k.h", line: 93, contains: "NONE" },
  { source: 1, file: "opcodes/e2k-dis.c", line: 828, contains: "0x7f000000" },
  { source: 1, file: "opcodes/e2k-dis.c", line: 412, contains: "0x00ff0000" },
  { source: 1, file: "opcodes/e2k-dis.c", line: 449, contains: "0x0000ff00" },
  { source: 1, file: "gas/config/tc-e2k.c", line: 9577, contains: "lng" },
  { source: 1, file: "gas/config/tc-e2k.c", line: 9366, contains: "mdl" },
  { source: 1, file: "bfd/cpu-e2k.c", line: 58, contains: "elbrus-v2" },
  { source: 2, file: "llvm/lib/Target/E2K/E2KInstrFormats.td", line: 475, contains: "Inst{30-24}" },
  { source: 2, file: "llvm/lib/Target/E2K/E2KInstrFormats.td", line: 478, contains: "Inst{7-0}" },
  { source: 2, file: "llvm/lib/Target/E2K/E2KInstrInfo.td", line: 121, contains: "ADDS" },
  { source: 2, file: "llvm/lib/Target/E2K/E2KInstrInfo.td", line: 735, contains: "MULS" },
  { source: 2, file: "llvm/lib/Target/E2K/E2KInstrInfo.td", line: 513, contains: "MOVTS" },
  { source: 2, file: "llvm/lib/Target/E2K/MCTargetDesc/E2KMCCodeEmitter.cpp", line: 94, contains: "endian::write" },
  { source: 3, file: "target/e2k/syllab-format.h", line: 33, contains: "cop" },
  { source: 3, file: "target/e2k/syllab-format.h", line: 41, contains: "src1" },
  { source: 3, file: "target/e2k/syllab-format.h", line: 91, contains: "opc2" },
  { source: 3, file: "target/e2k/instr-bits.h", line: 42, contains: "hs_lng" },
  { source: 3, file: "target/e2k/opcode-tables.h", line: 15, contains: "E2K_ALEF_OPC2_EXT" },
  { source: 3, file: "target/e2k/opcode-tables.h", line: 41, contains: "E2K_ALF_OPCE_NONE" },
  { source: 4, file: "README.md", line: 285, contains: "Opcode" },
  { source: 4, file: "README.md", line: 197, contains: "8 bytes" },
  // Источник 5 — ядро 6.1: первоисточник ABI, на который теперь опирается `e2kSyscalls.audit.test.ts`.
  { source: 5, file: "arch/e2k/include/uapi/asm/unistd.h", line: 27, contains: "__NR_exit" },
  { source: 5, file: "arch/e2k/include/uapi/asm/unistd.h", line: 113, contains: "__NR_mmap" },
  { source: 5, file: "arch/e2k/include/uapi/asm/unistd.h", line: 466, contains: "NR_syscalls" },
  { source: 5, file: "arch/e2k/kernel/systable.c", line: 41, contains: "sys_call_table[NR_syscalls]" },
  { source: 5, file: "arch/e2k/kernel/prot_syscall_synopsis.c", line: 34, contains: "protected syscall arguments" },
  { source: 5, file: "fs/read_write.c", line: 621, contains: "SYSCALL_DEFINE3(read" },
  { source: 5, file: "mm/mmap.c", line: 174, contains: "SYSCALL_DEFINE1(brk" },
  // Источник 6 — ядро 5.10: его счётчик `NR_syscalls` = 436 объясняет маркер порта QEMU.
  { source: 6, file: "arch/e2k/include/uapi/asm/unistd.h", line: 467, contains: "NR_syscalls" },
  { source: 6, file: "arch/e2k/include/uapi/asm/unistd.h", line: 122, contains: "__NR_mmap" },
];

/**
 * Подкаталог распакованного дерева, от которого отсчитываются файлы якорей.
 *
 * У источника 3 (архив порта QEMU) дерево лежит во вложенном каталоге `qemu/`; у источников
 * 5 и 6 (ядра) распакованное дерево и есть корень, поэтому подкаталога для них нет.
 */
const EXTRACT_SUBDIR: Readonly<Record<number, string>> = { 3: "qemu" };

/** Каталог, относительно которого проверяются файлы источника. */
function fileRootOf(record: SourceRecord): string {
  const [first, second] = record.localPaths;
  if (first === undefined) return "";
  if (second !== undefined) return path.join(ROOT, second, EXTRACT_SUBDIR[record.index] ?? "");
  return path.join(ROOT, first);
}

interface CopyCheck {
  strong: boolean;
  notes: string[];
  problems: string[];
}

/** Сверить опись с локальной копией: коммит клона, хеш архива, строки якорей. */
function checkLocalCopy(records: readonly SourceRecord[]): CopyCheck {
  const notes: string[] = [];
  const problems: string[] = [];
  if (!fs.existsSync(SOURCES_DIR)) {
    return {
      strong: false,
      notes: [`нет каталога ${path.relative(ROOT, SOURCES_DIR)} — сильные проверки не выполнялись`],
      problems: [],
    };
  }

  for (const record of records) {
    const root = fileRootOf(record);
    const archive =
      record.localPaths[0] !== undefined && /\.(?:tgz|tar\.gz|gz)$/.test(record.localPaths[0]!);
    if (!fs.existsSync(root)) {
      problems.push(`источник ${record.index}: нет локальной копии ${path.relative(ROOT, root)}`);
      continue;
    }
    if (archive) {
      const file = path.join(ROOT, record.localPaths[0]!);
      const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const expected = /sha256:([0-9a-f]{64})/.exec(record.revision)?.[1] ?? "";
      if (digest !== expected) {
        problems.push(`источник ${record.index}: sha256 архива ${digest}, в описи ${expected}`);
      } else {
        notes.push(`источник ${record.index}: sha256 архива совпал (${digest.slice(0, 12)}…)`);
      }
    } else {
      const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf-8").trim();
      let commit = head;
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5).trim();
        const refFile = path.join(root, ".git", ref);
        if (fs.existsSync(refFile)) {
          commit = fs.readFileSync(refFile, "utf-8").trim();
        } else {
          const packed = fs.readFileSync(path.join(root, ".git", "packed-refs"), "utf-8");
          const found = packed
            .split(/\r?\n/)
            .map((line) => line.split(" "))
            .find((parts) => parts[1] === ref);
          commit = found?.[0] ?? "";
        }
      }
      if (!record.revision.startsWith(commit)) {
        problems.push(`источник ${record.index}: HEAD ${commit}, в описи ${record.revision}`);
      } else {
        notes.push(`источник ${record.index}: коммит ${commit.slice(0, 12)}… совпал`);
      }
    }
  }

  for (const anchor of ANCHORS) {
    const record = records.find((item) => item.index === anchor.source);
    if (record === undefined) {
      problems.push(`якорь ссылается на источник ${anchor.source}, которого нет в описи`);
      continue;
    }
    const file = path.join(fileRootOf(record), anchor.file);
    if (!fs.existsSync(file)) {
      problems.push(`нет файла якоря: ${anchor.file}`);
      continue;
    }
    const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
    const line = lines[anchor.line - 1];
    if (line === undefined) {
      problems.push(`${anchor.file}: строки ${anchor.line} нет (в файле ${lines.length})`);
      continue;
    }
    if (!line.includes(anchor.contains)) {
      problems.push(`${anchor.file}:${anchor.line} не содержит «${anchor.contains}»: ${line.trim()}`);
    }
  }
  if (problems.length === 0) notes.push(`якорей проверено: ${ANCHORS.length}`);
  return { strong: true, notes, problems };
}

describe("опись источников кодировки e2k", () => {
  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, "utf-8") : "";
  const records = parseSourceTable(doc);

  it("документ существует и описывает шесть источников", () => {
    expect(fs.existsSync(DOC), "нет docs/e2k-sources-raw.md").toBe(true);
    expect(validateSourceTable(records)).toEqual([]);
    expect(records.map((record) => record.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(records[0]!.url).toContain("OpenE2K/binutils-gdb");
    expect(records[1]!.url).toContain("e2k-ports/llvm-project");
    expect(records[2]!.url).toContain("qemu-e2k.tar.gz");
    expect(records[3]!.url).toContain("nrdmn/elbrus-docs");
    expect(records[4]!.url).toContain("linux-6.1.0-1.19-open.tgz");
    expect(records[5]!.url).toContain("linux-5.10.0-1.50.1-open.tgz");
  });

  it("в документе названы все восемь файлов-носителей кодировки", () => {
    const named = [
      "opcodes/e2k-opc.h",
      "opcodes/e2k-dis.c",
      "include/opcode/e2k.h",
      "gas/config/tc-e2k.c",
      "E2KInstrFormats.td",
      "E2KInstrInfo.td",
      "syllab-format.h",
      "instr-bits.h",
    ];
    const missing = named.filter((file) => !doc.includes(file));
    expect(missing, `не названы в документе: ${missing.join(", ")}`).toEqual([]);
  });

  it("локальная копия совпадает с описью: коммиты, sha256 архива, строки якорей", () => {
    const check = checkLocalCopy(records);
    if (!check.strong) {
      // Слабая проверка: копии нет. Это не «проверено» — это «проверять нечего»,
      // и причина названа (см. шапку файла, §«Слабое место названо прямо»).
      expect(check.notes.join(" ")).toMatch(/нет каталога/);
      return;
    }
    expect(check.problems, check.notes.join("; ")).toEqual([]);
  });

  it("второй канал: копия файла ABI из GitHub совпадает с копией из архива", () => {
    // «Два канала» не должны жить только в отчёте сессии: опись обязана называть и канал,
    // и сам хеш — иначе проверять нечего, кроме собственной памяти.
    expect(doc, "опись не называет второй канал").toContain(INDEPENDENT_COPY_CHANNEL);
    expect(doc, "опись не называет sha256 копии второго канала").toContain(INDEPENDENT_COPY_SHA256);
    expect(doc, "опись не разделяет канал артефакта и канал эталона").toContain("канал эталона");
    if (!fs.existsSync(INDEPENDENT_COPY)) {
      expect(
        fs.existsSync(INDEPENDENT_COPY),
        `нет ${path.relative(ROOT, INDEPENDENT_COPY)} — сверка второго канала не выполнялась`,
      ).toBe(false);
      return;
    }
    const independent = fs.readFileSync(INDEPENDENT_COPY);
    expect(createHash("sha256").update(independent).digest("hex"), "sha256 копии второго канала").toBe(
      INDEPENDENT_COPY_SHA256,
    );
    expect(fs.existsSync(ARCHIVE_UNISTD), "нет таблицы ABI в распакованном архиве").toBe(true);
    const fromArchive = fs.readFileSync(ARCHIVE_UNISTD);
    expect(independent.equals(fromArchive), "копии двух каналов разошлись побайтово").toBe(true);

    // Негативный контроль: испорченная копия обязана расходиться и с хешем, и с архивом.
    const corrupted = Buffer.from(independent);
    corrupted[0] = corrupted[0]! ^ 0xff;
    expect(createHash("sha256").update(corrupted).digest("hex")).not.toBe(INDEPENDENT_COPY_SHA256);
    expect(corrupted.equals(fromArchive)).toBe(false);
  });

  it("негативный контроль: испорченная опись не проходит", () => {
    const healthy = validateSourceTable(records);
    expect(healthy).toEqual([]);

    const withoutUrl = records.map((record, index) =>
      index === 2 ? { ...record, url: "ftp://dev.mcst.ru/qemu-e2k.tar.gz" } : record,
    );
    expect(validateSourceTable(withoutUrl).join(" ")).toMatch(/URL/);

    const withoutRevision = records.map((record, index) =>
      index === 0 ? { ...record, revision: "ветка без коммита" } : record,
    );
    expect(validateSourceTable(withoutRevision).join(" ")).toMatch(/ни коммит, ни sha256/);

    const wrongDate = records.map((record, index) =>
      index === 1 ? { ...record, date: "3 января" } : record,
    );
    expect(validateSourceTable(wrongDate).join(" ")).toMatch(/ГГГГ-ММ-ДД/);

    const withoutCopy = records.map((record, index) =>
      index === 3 ? { ...record, localPaths: [] } : record,
    );
    expect(validateSourceTable(withoutCopy).join(" ")).toMatch(/локального пути/);

    // Порча якоря: подменяем строку в разобранной таблице нельзя, поэтому проверяем,
    // что проверяльщик якорей видит несуществующий файл как проблему, а не молчит.
    const broken = checkLocalCopy([{ ...records[0]!, localPaths: [".tmp/e2k-sources/нет-такого"] }]);
    expect(broken.problems.join(" ")).toMatch(/нет локальной копии/);

    // Архивы ядер имеют расширение `.tgz`, а не `.gz`: ветка «архив» обязана их узнавать.
    // Проверяется поведением, а не чтением кода — испорченный хеш источника 5 обязан быть назван.
    const kernelRecord = records.find((record) => record.index === 5);
    if (kernelRecord !== undefined && fs.existsSync(path.join(ROOT, kernelRecord.localPaths[0]!))) {
      const brokenHash = checkLocalCopy([{ ...kernelRecord, revision: `sha256:${"0".repeat(64)}` }]);
      expect(brokenHash.problems.join(" ")).toMatch(/sha256 архива/);
    }
  });
});
