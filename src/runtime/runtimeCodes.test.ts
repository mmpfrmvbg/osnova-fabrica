/**
 * СТОРОЖ КОДОВ ОТКАЗА ИСПОЛНЕНИЯ (`src/runtime/runtimeCodes.ts`).
 *
 * **Что охраняется.** Не «таблица красивая», а четыре вещи, каждая из которых
 * ломается молча:
 * 1. **Пространство имён.** Коды уникальны и формата `OSN-RT-NNN`; диапазон
 *    `900+` — только внутренние (дефект VM, а не отказ программы); «код не
 *    назван» — явный маркер `OSN-RT-000`, а не пустое поле.
 * 2. **Полнота канала до ошибки.** КАЖДАЯ точка броска обеих VM несёт код, и
 *    КАЖДЫЙ код таблицы либо стоит в точке броска, либо помечен «ставится
 *    записью». Проверяется **сканом источников**: без него новый
 *    `throw new InterpreterError(...)` без кода прошёл бы все остальные тесты
 *    (текст-то не изменился) — а именно так канал и разъезжается.
 * 3. **Полнота канала до записи.** Запись `GoldenReport.vmErrors`
 *    (`vmErrorRecordOf` в `src/runtime/goldenApps.ts`) несёт `code` — из ошибки
 *    или явный `OSN-RT-000`. Замер 2026-09-28 (проба T4): код у ошибки был, а в
 *    записи лежал только текст — 51 отказ исполнения в `runs/traces.jsonl`, у
 *    всех код «не назван». Каждая точка сборки записи проверяется сканом, а
 *    поведение — прогоном golden-проверки.
 * 4. **Текст не переписан.** Код ДОБАВЛЯЕТСЯ к сообщению, а не заменяет его:
 *    на существующие тексты опираются канон (`src/compiler/canon.test.ts`,
 *    машинная ошибка `10 div 0` не ловится `попробовать`) и человек.
 *
 * **Границы сторожа (честно).** Скан точек броска покрывает
 * `src/runtime/vm/interpreter.ts`, `src/runtime/vm/reginterpreter.ts`,
 * `src/runtime/vm.ts` — то, что является отказом ВМ; скан точек сборки записи —
 * `src/runtime/goldenApps.ts`. За границей осознанно остались:
 * `src/compiler/compiler.ts` (там есть свой `new InterpreterError`, файл чужой
 * плоскости) и хостовые ошибки `invoke` (`оценить`/`оценить_в` бросают обычный
 * `Error` про ошибку компиляции — это не отказ машины), а также `SandboxError`
 * (`src/runtime/sandbox.ts`) — отказ доступа к файлам на уровне хоста.
 *
 * **Негативный контроль** (без него сторож — украшение): механизмы скана
 * проверены на ИСПОРЧЕННОМ настоящем исходнике — убрать код у точки броска,
 * подменить имя кода на несуществующее, убрать сборщик записи; в каждом случае
 * сторож обязан это увидеть.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  RUNTIME_CODES,
  RUNTIME_CODE_TABLE,
  isRuntimeErrorCode,
  runtimeCodeInfo,
  runtimeErrorCodeOf,
} from "./runtimeCodes";
import { InterpreterError, VM, runProgram } from "./vm/interpreter";
import { RegInterpreterError, RegVM } from "./vm/reginterpreter";
import { REGCODE_IR, type RegInstruction, type RegModule } from "./vm/regcode";
import { OsVbcVM, VM_ERROR_CONCURRENT_EXECUTE, formatVmRuntimeError, safeExecutePipelineVm } from "./vm";
import { runGoldenCheck, vmErrorRecordOf } from "./goldenApps";
import { TimeoutError } from "./runtimeRecovery";
import type { OsnovaSpec } from "../pipeline/types";
import type { OsVbcModule, RawInstruction } from "./vm/bytecode";

// ─────────────────────────────────────────────────────────────────────────────
// 1. ТАБЛИЦА: ПРОСТРАНСТВО ИМЁН И ПРИЗНАК ВНУТРЕННЕГО
// ─────────────────────────────────────────────────────────────────────────────

describe("коды исполнения: пространство имён и признак внутреннего", () => {
  it("коды уникальны и формата OSN-RT-NNN", () => {
    const codes = Object.values(RUNTIME_CODES);
    expect(new Set(codes).size, "код выдаётся один раз и не переиспользуется").toBe(codes.length);
    const bad = codes.filter((c) => !/^OSN-RT-\d{3}$/.test(c));
    expect(bad, `коды вне формата OSN-RT-NNN: ${bad.join(", ")}`).toEqual([]);
  });

  it("таблица покрывает ровно множество кодов — ни лишних строк, ни забытых", () => {
    const fromTable = RUNTIME_CODE_TABLE.map((r) => r.code).sort();
    const fromConst = [...Object.values(RUNTIME_CODES)].sort();
    expect(fromTable).toEqual(fromConst);
    const withoutCause = RUNTIME_CODE_TABLE.filter((r) => r.cause.trim() === "").map((r) => r.code);
    expect(withoutCause, `код без причины: ${withoutCause.join(", ")}`).toEqual([]);
    for (const row of RUNTIME_CODE_TABLE) {
      expect(typeof row.internal, `${row.code}: признак internal обязан быть булевым`).toBe("boolean");
    }
  });

  it("OSN-RT-900 — внутренний (дефект VM), и весь диапазон 900+ внутренний", () => {
    const internal = runtimeCodeInfo(RUNTIME_CODES.internalInvariant);
    expect(internal, "код внутреннего дефекта обязан быть в таблице").toBeDefined();
    expect(internal!.code).toBe("OSN-RT-900");
    expect(internal!.internal, "900 — сигнал о дефекте интерпретатора, а не о программе").toBe(true);

    const notMarked = RUNTIME_CODE_TABLE.filter((r) => Number(r.code.slice(-3)) >= 900 && !r.internal);
    expect(notMarked.map((r) => r.code), "диапазон 900+ зарезервирован под внутренние").toEqual([]);
  });

  it("чтение чужого значения как кода не проходит", () => {
    expect(isRuntimeErrorCode("OSN-RT-002")).toBe(true);
    // Соседние пространства и почти-коды: чужое значение кодом не считается.
    for (const alien of ["TIMEOUT_ERROR", "EXECUTION_ERROR", "ENOENT", "OSN-RT-2", "OSN-RT-0002", "", "osn-rt-002"]) {
      expect(isRuntimeErrorCode(alien), `${alien} — не код исполнения`).toBe(false);
    }
    expect(isRuntimeErrorCode(undefined)).toBe(false);
    expect(isRuntimeErrorCode(2)).toBe(false);
    expect(runtimeCodeInfo("OSN-RT-002")?.internal).toBe(false);
    expect(runtimeCodeInfo("OSN-RT-777")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. СКАН ИСТОЧНИКОВ: КОД ЕСТЬ У КАЖДОЙ ТОЧКИ БРОСКА, МЁРТВЫХ КОДОВ НЕТ
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE_FILES = {
  stackVm: "src/runtime/vm/interpreter.ts",
  regVm: "src/runtime/vm/reginterpreter.ts",
  facade: "src/runtime/vm.ts",
} as const;

/** Классы, которыми VM отказывает. `TimeoutError` — потому что лимит времени тоже отказ VM. */
const ERROR_CLASSES = ["InterpreterError", "RegInterpreterError", "TimeoutError"];

const REPO_ROOT = path.join(__dirname, "..", "..");

interface Construction {
  className: string;
  file: string;
  line: number;
  /** Текст аргументов вызова (между внешними скобками). */
  args: string;
}

/** Пропустить строковый/шаблонный литерал; возвращает индекс закрывающей кавычки. */
function skipStringLiteral(src: string, start: number): number {
  const quote = src[start]!;
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    // В шаблонной строке `${ ... }` — это код: внутри могут быть свои скобки,
    // поэтому он пропускается как сбалансированный блок, а не как текст.
    if (quote === "`" && ch === "$" && src[i + 1] === "{") {
      i = skipBalanced(src, i + 1, "{", "}") + 1;
      continue;
    }
    i++;
  }
  return src.length - 1;
}

/** Индекс закрывающей скобки для открывающей на позиции `start` (с учётом строк и комментариев). */
function skipBalanced(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipStringLiteral(src, i) + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return src.length - 1;
      i = nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i);
      if (end < 0) return src.length - 1;
      i = end + 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return src.length - 1;
}

function lineNumberAt(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** Все конструкции `new InterpreterError(...)` / `RegInterpreterError` / `TimeoutError` в исходнике. */
function findErrorConstructions(src: string, file: string): Construction[] {
  const out: Construction[] = [];
  const re = new RegExp(`\\bnew\\s+(${ERROR_CLASSES.join("|")})\\s*\\(`, "g");
  let match = re.exec(src);
  while (match !== null) {
    const open = match.index + match[0].length - 1;
    const close = skipBalanced(src, open, "(", ")");
    out.push({
      className: match[1]!,
      file,
      line: lineNumberAt(src, match.index),
      args: src.slice(open + 1, close),
    });
    re.lastIndex = close + 1;
    match = re.exec(src);
  }
  return out;
}

/**
 * Ссылка на код в исходнике. Класс символов — ЮНИКОДНЫЙ: имя ключа может быть
 * написано и кириллицей, и опечатка такого рода обязана быть видна сторожу.
 * (Поймано негативным контролем: ASCII-класс пропускал `RUNTIME_CODES.нетТакогоКода`
 * молча — точка броска выглядела как «ссылка есть», а на деле код не тот.)
 */
const CODE_REF = /RUNTIME_CODES\.([\p{L}_][\p{L}\p{N}_]*)/gu;

/** Имена кодов, на которые ссылается текст (аргументы точки броска). */
function codeKeysOf(text: string): string[] {
  return [...text.matchAll(CODE_REF)].map((m) => m[1]!);
}

function readSource(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
}

const SOURCES = Object.values(SOURCE_FILES).map((file) => ({ file, src: readSource(file) }));
const CONSTRUCTIONS = SOURCES.flatMap(({ file, src }) => findErrorConstructions(src, file));

/**
 * Коды, которые ставятся не точкой броска, а сборкой записи об отказе
 * (`fromRecord` в таблице). Это ДАННЫЕ таблицы, а не список, переписанный в
 * тест: новый такой код получает сторож автоматически. Хранятся КЛЮЧИ таблицы —
 * в том же пространстве, в котором скан видит ссылки `RUNTIME_CODES.<ключ>`.
 */
const KEY_BY_CODE = new Map(
  Object.entries(RUNTIME_CODES).map(([key, code]) => [code as string, key]),
);
const FROM_RECORD_KEYS: ReadonlySet<string> = new Set(
  RUNTIME_CODE_TABLE.filter((r) => r.fromRecord === true).map((r) => KEY_BY_CODE.get(r.code)!),
);

describe("коды исполнения: скан источников — канал полон, мёртвых кодов нет", () => {
  it("скан видит точки броска (иначе все проверки ниже — пустое множество)", () => {
    const byFile = Object.fromEntries(
      Object.values(SOURCE_FILES).map((file) => [
        file,
        CONSTRUCTIONS.filter((c) => c.file === file).length,
      ]),
    );
    // Числа — не украшение: если скан сломается и вернёт 0, тест покраснеет
    // здесь, а не «пройдёт» впустую на пустом списке.
    expect(byFile[SOURCE_FILES.stackVm], "точек броска в стековой VM").toBeGreaterThan(10);
    expect(byFile[SOURCE_FILES.regVm], "точек броска в регистровой VM").toBeGreaterThan(10);
    expect(byFile[SOURCE_FILES.facade], "точек отказа в фасаде VM").toBeGreaterThan(0);
  });

  it("у КАЖДОЙ точки броска есть код — нет броска без кода", () => {
    const codeless = CONSTRUCTIONS.filter((c) => codeKeysOf(c.args).length === 0);
    expect(
      codeless.map((c) => `${c.file}:${c.line} ${c.className}`),
      "точка броска без кода: машине не за что зацепиться",
    ).toEqual([]);
  });

  it("у каждой точки броска ровно один код — без «двух кодов на один отказ»", () => {
    const doubled = CONSTRUCTIONS.filter((c) => codeKeysOf(c.args).length > 1);
    expect(doubled.map((c) => `${c.file}:${c.line} ${c.className}`)).toEqual([]);
  });

  it("КАЖДЫЙ код таблицы где-то ставится: точкой броска или записью (мёртвых нет)", () => {
    const used = new Set(CONSTRUCTIONS.flatMap((c) => codeKeysOf(c.args)));
    const notPlaced = Object.keys(RUNTIME_CODES).filter(
      (key) => !used.has(key) && !FROM_RECORD_KEYS.has(key),
    );
    expect(notPlaced, `коды, которые никто не ставит: ${notPlaced.join(", ")}`).toEqual([]);
  });

  it("маркер «код не назван» не ставится точкой броска — иначе он перестанет различать", () => {
    // `OSN-RT-000` значит «кода нет». Если его поставить в точке броска, он
    // перестанет отличать «код не назван» от «код есть» — и разрыв канала
    // станет невидимым ровно там, где его ищут.
    expect(FROM_RECORD_KEYS.has("unnamedRefusal"), "маркер обязан быть в таблице").toBe(true);
    const usedAtThrow = new Set(CONSTRUCTIONS.flatMap((c) => codeKeysOf(c.args)));
    const bothWays = [...FROM_RECORD_KEYS].filter((key) => usedAtThrow.has(key));
    expect(bothWays, `код-маркер поставлен точкой броска: ${bothWays.join(", ")}`).toEqual([]);
  });

  it("ссылки ведут на существующие ключи таблицы", () => {
    const used = new Set(CONSTRUCTIONS.flatMap((c) => codeKeysOf(c.args)));
    const unknown = [...used].filter((key) => !(key in RUNTIME_CODES));
    expect(unknown, `ссылки на несуществующие коды: ${unknown.join(", ")}`).toEqual([]);
  });

  it("обе VM говорят одним словарём: код, живущий в одной VM, есть и в другой", () => {
    // Смысл кода обязан совпадать в стековой и регистровой машине: иначе частоты
    // по журналу считаются по двум разным словарям с одинаковыми именами.
    // Лимит времени и гонка — свойства фасада (`vm.ts`), они в обеих VM не нужны.
    const keysIn = (file: string): Set<string> =>
      new Set(
        CONSTRUCTIONS.filter((c) => c.file === file).flatMap((c) => codeKeysOf(c.args)),
      );
    const stack = keysIn(SOURCE_FILES.stackVm);
    const reg = keysIn(SOURCE_FILES.regVm);
    const onlyStack = [...stack].filter((k) => !reg.has(k));
    const onlyReg = [...reg].filter((k) => !stack.has(k));
    expect(onlyStack, `код есть в стековой VM, но не в регистровой: ${onlyStack.join(", ")}`).toEqual([]);
    expect(onlyReg, `код есть в регистровой VM, но не в стековой: ${onlyReg.join(", ")}`).toEqual([]);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: убрать код у точки броска — сторож видит именно её", () => {
    const file = SOURCE_FILES.stackVm;
    const src = readSource(file);
    expect(findErrorConstructions(src, file).filter((c) => codeKeysOf(c.args).length === 0)).toEqual([]);

    // Портим НАСТОЯЩИЙ исходник: снимаем код у точки `maxSteps` ровно так, как
    // это сделал бы невнимательный автор.
    const broken = src.replace(", RUNTIME_CODES.maxSteps", "");
    expect(broken, "мутация обязана примениться (иначе контроль пустой)").not.toBe(src);
    const codeless = findErrorConstructions(broken, file).filter((c) => codeKeysOf(c.args).length === 0);
    expect(codeless, "точка броска без кода обязана быть найдена").toHaveLength(1);
    expect(codeless[0]!.args).toContain("Max steps exceeded");
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: подменить имя кода на несуществующее — сторож видит", () => {
    const file = SOURCE_FILES.stackVm;
    const src = readSource(file);
    const broken = src.replace("RUNTIME_CODES.divisionByZero", "RUNTIME_CODES.нетТакогоКода");
    expect(broken, "мутация обязана примениться").not.toBe(src);
    const used = new Set(findErrorConstructions(broken, file).flatMap((c) => codeKeysOf(c.args)));
    expect([...used].filter((key) => !(key in RUNTIME_CODES))).toEqual(["нетТакогоКода"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2б. ЗАПИСЬ ОБ ОТКАЗЕ: КОД ДОЕЗЖАЕТ ДО `GoldenReport.vmErrors`
// ─────────────────────────────────────────────────────────────────────────────

const GOLDEN_FILE = "src/runtime/goldenApps.ts";

/**
 * Точки сборки записи об отказе: `vmErrors: [...]` и `vmErrors.push(...)`.
 *
 * Пустой список (`vmErrors: []`) — это НЕ точка отказа, а успешный прогон:
 * нести код там нечему, и требовать сборщик от него значило бы требовать
 * выдумать отказ. Такие точки пропускаются осознанно и явно.
 */
function findRecordSites(src: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  for (const re of [/vmErrors\s*:\s*\[/g, /vmErrors\.push\s*\(/g] as const) {
    let match = re.exec(src);
    while (match !== null) {
      const open = match.index + match[0].length - 1;
      const close = skipBalanced(src, open, src[open]!, src[open] === "[" ? "]" : ")");
      const body = src.slice(open, close + 1);
      if (!/^\[\s*\]$/.test(body)) out.push({ line: lineNumberAt(src, match.index), body });
      re.lastIndex = close + 1;
      match = re.exec(src);
    }
  }
  return out;
}

describe("запись об отказе: код едет в запись, а не теряется", () => {
  const goldenSrc = readSource(GOLDEN_FILE);
  const recordSites = findRecordSites(goldenSrc);

  it("скан видит все точки сборки записи", () => {
    expect(recordSites.length, "точек сборки `vmErrors` в goldenApps.ts").toBeGreaterThan(3);
  });

  it("КАЖДАЯ точка сборки записи идёт через `vmErrorRecordOf`", () => {
    const bypassed = recordSites
      .filter((site) => !site.body.includes("vmErrorRecordOf("))
      .map((site) => `${GOLDEN_FILE}:${site.line}`);
    expect(
      bypassed,
      "запись собрана в обход сборщика: код в неё не попадёт (замер T4: 51 отказ без кода)",
    ).toEqual([]);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: запись в обход сборщика сторож видит", () => {
    const broken = goldenSrc.replace("vmErrors.push(vmErrorRecordOf(e))", "vmErrors.push({ message: String(e) })");
    expect(broken, "мутация обязана примениться").not.toBe(goldenSrc);
    const bypassed = findRecordSites(broken).filter((site) => !site.body.includes("vmErrorRecordOf("));
    expect(bypassed).toHaveLength(1);
  });

  it("код ошибки → поле `code` записи; текст остаётся дословным", () => {
    const err = new InterpreterError("Division by zero", 12, "div", RUNTIME_CODES.divisionByZero);
    const record = vmErrorRecordOf(err);
    expect(record.message, "текст записи — прежний, дословный").toBe("Division by zero");
    expect(record.code).toBe(RUNTIME_CODES.divisionByZero);
    expect(record.op).toBe("div");
    expect(record.pc).toBe(12);
    // Читается тем же способом, что и в VM: запись — тоже носитель кода.
    expect(runtimeErrorCodeOf(record)).toBe(RUNTIME_CODES.divisionByZero);
  });

  it("отказ БЕЗ кода → явный маркер OSN-RT-000, а не пустое поле", () => {
    const hostError = new Error("сбой хоста");
    const record = vmErrorRecordOf(hostError);
    expect(record.message).toBe("сбой хоста");
    expect(record.code, "пустое поле не отличить от «поле забыли»").toBe(RUNTIME_CODES.unnamedRefusal);
    expect(isRuntimeErrorCode(record.code)).toBe(true);
    expect(record).not.toHaveProperty("op");
    expect(record).not.toHaveProperty("pc");
  });

  it("регистровая ошибка тоже доезжает: код и место", () => {
    const err = new RegInterpreterError("Remainder by zero", 7, "rem", RUNTIME_CODES.remainderByZero);
    const record = vmErrorRecordOf(err);
    expect(record.code).toBe(RUNTIME_CODES.remainderByZero);
    expect(record.op).toBe("rem");
    expect(record.pc).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. КОД ДОХОДИТ ДО ВЫЗЫВАЮЩЕГО: КОНЕЦ-В-КОНЕЦ НА ОБЕИХ VM
// ─────────────────────────────────────────────────────────────────────────────

function ri(op: RawInstruction["op"], rest: Record<string, unknown> = {}): RawInstruction {
  return { op, ...rest } as RawInstruction;
}

function stackModule(
  code: RawInstruction[],
  constants: unknown[] = [],
  moduleName = "КодыСтековая",
): OsVbcModule {
  return {
    version: 1,
    moduleName,
    constants,
    procedures: [{ name: "главная", codeOffset: 0, argc: 0, localsCount: 2 }],
    code: code as never,
  };
}

function regModule(code: RegInstruction[], constants: unknown[] = []): RegModule {
  return {
    ir: REGCODE_IR,
    version: 1,
    moduleName: "КодыРегистровая",
    constants,
    procedures: [{ name: "главная", codeOffset: 0, argc: 0, vregs: 8, localToVreg: {} }],
    code,
  };
}

/** Поймать отказ; отсутствие отказа — сам по себе провал проверки. */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (err) {
    return err;
  }
  throw new Error("ожидался отказ, но прогон завершился успешно");
}

describe("коды исполнения: отказ доходит до вызывающего с кодом", () => {
  it("стековая VM: div на ноль → OSN-RT-002, текст прежний", async () => {
    const module = stackModule([ri("const", { type: "i32", k: 0 }), ri("const", { type: "i32", k: 1 }), ri("div")], [1, 0]);
    const err = await refusal(() => new VM(module).runProcedure(0, []));
    expect(err).toBeInstanceOf(InterpreterError);
    expect((err as InterpreterError).message, "текст существующей ошибки не переписывается").toBe("Division by zero");
    expect((err as InterpreterError).op).toBe("div");
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.divisionByZero);
  });

  it("стековая VM: idiv и rem различаются КОДОМ, а не только строкой", async () => {
    const idiv = stackModule([ri("const", { type: "i32", k: 0 }), ri("const", { type: "i32", k: 1 }), ri("idiv")], [1, 0]);
    const rem = stackModule([ri("const", { type: "i32", k: 0 }), ri("const", { type: "i32", k: 1 }), ri("rem")], [1, 0]);
    const idivErr = await refusal(() => new VM(idiv).runProcedure(0, []));
    const remErr = await refusal(() => new VM(rem).runProcedure(0, []));
    expect((idivErr as Error).message).toBe("Integer division by zero");
    expect((remErr as Error).message).toBe("Remainder by zero");
    expect(runtimeErrorCodeOf(idivErr)).toBe(RUNTIME_CODES.divisionByZero);
    expect(runtimeErrorCodeOf(remErr)).toBe(RUNTIME_CODES.remainderByZero);
    expect(runtimeErrorCodeOf(idivErr)).not.toBe(runtimeErrorCodeOf(remErr));
  });

  it("стековая VM: лимит шагов → OSN-RT-001", async () => {
    const module = stackModule([ri("jmp", { off: 0 })]);
    const err = await refusal(() => new VM(module, { maxSteps: 10 }).runProcedure(0, []));
    expect((err as Error).message).toBe("Max steps exceeded (10)");
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.maxSteps);
  });

  it("стековая VM: необработанное `выбросить` → OSN-RT-005", async () => {
    const module = stackModule([ri("const.true"), ri("throw")]);
    const err = await refusal(() => new VM(module).runProcedure(0, []));
    expect((err as Error).message).toBe("Необработанное исключение: true");
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.unhandledThrow);
  });

  it("стековая VM: неизвестный invoke → OSN-RT-004", async () => {
    const module = stackModule([ri("invoke", { name: "нет.такого.вызова" })]);
    const err = await refusal(() => new VM(module).runProcedure(0, []));
    expect((err as Error).message).toBe("Unknown invoke: нет.такого.вызова");
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.unknownInvoke);
  });

  it("стековая VM: порча байткода (underflow стека) → OSN-RT-900, это дефект VM", async () => {
    const module = stackModule([ri("pop"), ri("ret")]);
    const err = await refusal(() => new VM(module).runProcedure(0, []));
    expect((err as Error).message).toBe("Stack underflow on pop");
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.internalInvariant);
    expect(runtimeCodeInfo(runtimeErrorCodeOf(err))?.internal).toBe(true);
  });

  it("точка входа не найдена → OSN-RT-007 (пустая программа)", async () => {
    const err = await refusal(() => runProgram([]));
    expect((err as Error).message).toBe("Program is empty: no modules provided");
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.entryNotFound);
  });

  it("регистровая VM: те же причины дают те же коды, что в стековой", async () => {
    const divCode: RegInstruction[] = [
      { op: "const", d: 1, type: "i32", k: 0 },
      { op: "const", d: 2, type: "i32", k: 1 },
      { op: "div", d: 3, a: 1, b: 2 },
      { op: "ret", v: 3 },
    ];
    const divErr = await refusal(() => new RegVM(regModule(divCode, [1, 0]), { maxSteps: 100 }).runProcedure(0, []));
    expect(divErr).toBeInstanceOf(RegInterpreterError);
    expect((divErr as Error).message).toBe("Division by zero");
    expect(runtimeErrorCodeOf(divErr)).toBe(RUNTIME_CODES.divisionByZero);

    const remCode: RegInstruction[] = [
      { op: "const", d: 1, type: "i32", k: 0 },
      { op: "const", d: 2, type: "i32", k: 1 },
      { op: "rem", d: 3, a: 1, b: 2 },
      { op: "ret", v: 3 },
    ];
    const remErr = await refusal(() => new RegVM(regModule(remCode, [1, 0]), { maxSteps: 100 }).runProcedure(0, []));
    expect((remErr as Error).message).toBe("Remainder by zero");
    expect(runtimeErrorCodeOf(remErr)).toBe(RUNTIME_CODES.remainderByZero);

    const jumpCode: RegInstruction[] = [{ op: "jmp", off: 0 }];
    const stepsErr = await refusal(() => new RegVM(regModule(jumpCode), { maxSteps: 5 }).runProcedure(0, []));
    expect((stepsErr as Error).message).toBe("Max steps exceeded (5)");
    expect(runtimeErrorCodeOf(stepsErr)).toBe(RUNTIME_CODES.maxSteps);

    const throwCode: RegInstruction[] = [
      { op: "const.true", d: 1 },
      { op: "throw", a: 1 },
    ];
    const throwErr = await refusal(() => new RegVM(regModule(throwCode), { maxSteps: 100 }).runProcedure(0, []));
    expect(runtimeErrorCodeOf(throwErr)).toBe(RUNTIME_CODES.unhandledThrow);
  });

  it("повторный вход в исполняющую VM → OSN-RT-008, текст прежний", async () => {
    const module = stackModule([ri("const", { type: "i32", k: 0 }), ri("ret")], [7]);
    const vm = new OsVbcVM(module, { maxSteps: 100 });
    const first = vm.execute();
    const err = await refusal(() => vm.execute());
    expect((err as Error).message).toBe(VM_ERROR_CONCURRENT_EXECUTE);
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.concurrentExecute);
    await expect(first).resolves.toBe(7);
  });

  it("лимит времени → OSN-RT-006 в metadata, чужое поле `code` не тронуто", async () => {
    const module = stackModule(
      [ri("const", { type: "i32", k: 0 }), ri("invoke", { name: "система.математика.абс" }), ri("ret")],
      [5],
    );
    const vm = new OsVbcVM(module, {
      maxSteps: 100,
      invoke: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return 5;
      },
    });
    const err = await refusal(() => vm.execute({ timeoutMs: 5 }));
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).name).toBe("TimeoutError");
    expect(
      (err as TimeoutError).code,
      "поле `code` занято значением восстановления — его менять нельзя",
    ).toBe("TIMEOUT_ERROR");
    expect(runtimeErrorCodeOf(err)).toBe(RUNTIME_CODES.timeout);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ТЕКСТ: КОД ДОБАВЛЯЕТСЯ, А НЕ ЗАМЕНЯЕТ
// ─────────────────────────────────────────────────────────────────────────────

describe("formatVmRuntimeError: код печатается, текст остаётся дословным", () => {
  it("с кодом — прежний текст плюс `код=OSN-RT-NNN` в конце", () => {
    const err = new InterpreterError("Remainder by zero", 12, "rem", RUNTIME_CODES.remainderByZero);
    expect(formatVmRuntimeError(err)).toBe("Remainder by zero op=rem pc=12 код=OSN-RT-003");
    // Прежний текст — дословный префикс: поиск по нему не сломан.
    expect(formatVmRuntimeError(err).startsWith("Remainder by zero op=rem pc=12")).toBe(true);
  });

  it("без кода — строки `код=` нет вовсе", () => {
    const bare = new InterpreterError("Procedure not found: главная");
    expect(formatVmRuntimeError(bare)).toBe("Procedure not found: главная");
    expect(formatVmRuntimeError(bare)).not.toContain("код=");
    // Место в байткоде остаётся, даже когда кода нет.
    expect(formatVmRuntimeError(new InterpreterError("Unknown op: x", 3, "x"))).toBe("Unknown op: x op=x pc=3");
  });

  it("чужая ошибка: без кода — как была, с кодом — с суффиксом", () => {
    expect(formatVmRuntimeError(new Error("сбой хоста"))).toBe("сбой хоста");
    expect(formatVmRuntimeError("строка как ошибка")).toBe("строка как ошибка");
    const timeout = new TimeoutError("VM.execute: превышен лимит времени (5 мс)", {
      timeoutMs: 5,
      procedure: "главная",
      metadata: { runtimeCode: RUNTIME_CODES.timeout },
    });
    expect(formatVmRuntimeError(timeout)).toBe("VM.execute: превышен лимит времени (5 мс) код=OSN-RT-006");
  });

  it("чужое поле `code` не печатается как код исполнения", () => {
    const foreign = Object.assign(new Error("нет файла"), { code: "ENOENT" });
    expect(formatVmRuntimeError(foreign)).toBe("нет файла");
    expect(formatVmRuntimeError(foreign)).not.toContain("код=");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. НЕГАТИВНЫЙ КОНТРОЛЬ: УСПЕШНЫЙ ПРОГОН КОДА НЕ НЕСЁТ
// ─────────────────────────────────────────────────────────────────────────────

describe("негативный контроль: успешный прогон кода не несёт", () => {
  it("значение, результат и журнал успешного прогона чисты", async () => {
    const events: Array<Record<string, unknown>> = [];
    const module = stackModule([ri("const", { type: "i32", k: 0 }), ri("ret")], [42], "КодыУспех");
    const vm = new OsVbcVM(module, {
      maxSteps: 100,
      onExecutionLog: (e) => events.push(e as unknown as Record<string, unknown>),
    });

    const value = await vm.execute();
    expect(value).toBe(42);
    expect(vm.getReturnValue()).toBe(42);
    expect(runtimeErrorCodeOf(value), "у значения успешного прогона кода нет").toBeUndefined();
    expect(events.map((e) => e.phase)).toEqual(["start", "done"]);
    expect(JSON.stringify(events), "в журнале успешного прогона нет ни кода, ни `код=`").not.toContain("OSN-RT");
    expect(JSON.stringify(events)).not.toContain("код=");

    const safe = await safeExecutePipelineVm(vm);
    expect(safe.ok).toBe(true);
    expect(safe).not.toHaveProperty("code");
    expect(JSON.stringify(safe)).not.toContain("OSN-RT");
    if (safe.ok) expect(safe.returnValue).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ИНТЕГРАЦИЯ: `runGoldenCheck` — отказ несёт код, успех не несёт ничего
// ─────────────────────────────────────────────────────────────────────────────

const makeSpec = (overrides: Partial<OsnovaSpec> = {}): OsnovaSpec => ({
  specId: "test-spec",
  modules: [],
  mainModule: "главная",
  types: [],
  procedures: [],
  syscalls: [],
  conventions: {},
  ...overrides,
});

/**
 * Поля записи, которых **пока нет в типе** `VMError` (`src/pipeline/types.ts`):
 * `message` объявлен, а `code`/`op`/`pc` запись несёт в рантайме (схема журнала
 * — `.passthrough()`). Читаем их здесь явно, чтобы разрыв «запись несёт — тип не
 * знает» был виден, а не спрятан за `any`. Расширение типа — чужая плоскость
 * (T3, запись об ошибке), поэтому здесь только чтение.
 */
function recordFields(record: unknown): { message: string; code?: unknown; op?: unknown; pc?: unknown } {
  return record as { message: string; code?: unknown; op?: unknown; pc?: unknown };
}

describe("runGoldenCheck: код доезжает до записи об отказе", () => {
  it("отказ VM: запись несёт код, место и прежний текст", async () => {
    const module = stackModule(
      [ri("const", { type: "i32", k: 0 }), ri("const", { type: "i32", k: 1 }), ri("div")],
      [1, 0],
      "КодыГолден",
    );
    const report = await runGoldenCheck(module, makeSpec());
    expect(report.executed).toBe(false);
    expect(report.vmErrors).toHaveLength(1);
    const record = recordFields(report.vmErrors[0]);
    expect(record.message, "текст записи не переписан").toBe("Division by zero");
    expect(record.code, "это и есть разрыв, из-за которого 51 отказ был без кода").toBe(
      RUNTIME_CODES.divisionByZero,
    );
    expect(record.op).toBe("div");
    expect(typeof record.pc, "место отказа в байткоде").toBe("number");
    // Запись читается тем же способом, что и ошибка: поле `code` → таблица.
    expect(runtimeErrorCodeOf(report.vmErrors[0])).toBe(RUNTIME_CODES.divisionByZero);
  });

  it("предполётный отказ (невалидный байткод) → явный маркер, а не пустое поле", async () => {
    const report = await runGoldenCheck(null, makeSpec());
    expect(report.executed).toBe(false);
    const record = recordFields(report.vmErrors[0]);
    expect(record.message).toBe("bytecode is not a valid OsVbcModule");
    expect(record.code).toBe(RUNTIME_CODES.unnamedRefusal);
  });

  it("НЕГАТИВНЫЙ КОНТРОЛЬ: успешный прогон — `vmErrors` пуст и кода нет нигде", async () => {
    const module = stackModule([ri("const", { type: "i32", k: 0 }), ri("ret")], [42], "КодыГолденУспех");
    const report = await runGoldenCheck(module, makeSpec({ expectedReturnValue: 42 }));
    expect(report.executed).toBe(true);
    expect(report.vmErrors, "у успеха отказов нет — и кода тоже").toEqual([]);
    expect(JSON.stringify(report)).not.toContain("OSN-RT");
    expect(JSON.stringify(report)).not.toContain("код=");
  });
});
