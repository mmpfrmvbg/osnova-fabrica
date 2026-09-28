/**
 * Оракул наблюдателя за понижением (`./e2kLoweringDiagnostics`).
 *
 * **Повод.** Отказ понижения видит только оракул корпуса — и только у записей,
 * объявленных «работает», и только в шлюзе `gate:qemu`. Замер 2026-09-28: `вернуть 17 % 5`
 * даёт образ 112 байт с ОДНИМ выброшенным носителем (`IR.rem`: формы понижения нет),
 * а `npx tsx src/cli.ts compile` на том же файле печатает «Скомпилировано» и выходит
 * нулём. Это класс «программа собралась, а число неверное».
 *
 * **Что держит этот сторож (с 2026-09-28 — по КОНТРАКТУ кодов `OSN-LOW-*`).**
 * 1. Класс выводится из КОДА отказе, а не из текста причины: контракт живёт в
 *    `src/e2k/loweringRefusal.ts`, наблюдатель читает поле `code`. Сравнение строк негодно:
 *    текст несёт значение (`константа пула #0 = 1.5`), поэтому один и тот же отказ даёт разные
 *    строки — это и было измеренной ценой отсутствия контракта.
 * 2. Класс `код-вне-контракта` не появляется ни на пробах, ни на всём корпусе: у каждого отказа
 *    понижения код есть, и он из таблицы. Производитель, назвавший чужой код, краснеет здесь,
 *    а не проходит молча.
 * 3. Тихая ложь названа прямо: образ СОБРАН при непустых отказах — это `built: true`
 *    и `refusedTotal > 0`, и сторож требует обоих полей, а не «есть отказы».
 * 4. У класса «язык» — свой канал кодов (`OSN-PAR-001`): отказ языка приходит из компилятора,
 *    а не из контракта понижения, и это разные пространства.
 * 5. Объявление корпуса против факта: у записей «работает» не бывает ни отказов, ни
 *    несобранного образа; расхождение с причиной «нет» остаётся находкой отчёта, а не
 *    закреплённым ожиданием (запись 06 в работе у плоскости e2k — прибивать её нельзя).
 *
 * Негативный контроль — контрольная арифметика: у неё отказов НОЛЬ, поэтому «печатать
 * отказ всегда» этот сторож не прошло бы. Негативные контроли САМОГО контракта
 * («подмена текста класса не меняет, подмена кода меняет») живут рядом с контрактом —
 * `src/e2k/loweringRefusal.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  CORPUS_VERDICTS,
  classOfCode,
  corpusLoweringRows,
  formatLoweringDiagnosticJson,
  loweringDiagnosticsOf,
  parseRefusalText,
} from "./e2kLoweringDiagnostics";
import { LOWERING_CODES, LOWERING_CODE_CLASSES } from "../e2k/loweringRefusal";

/** Корпус 39 дословно: печать числа на цель. */
const PRINT = "процедура главная()\n  система.лог.вывести(7 + 3)\nконец_процедуры\n";
/** Носитель без формы понижения: `IR.rem`. */
const REMAINDER = "модуль О\nпроцедура главная()\n  вернуть 17 % 5\nконец\nконец\n";
/** Дробная константа: причина отказа, у которой есть код (`002`). Строки с 2026-09-28 понижаются. */
/**
 * ДВЕ РАЗНЫЕ причины отказа в одной программе: дробная константа (`002`) и вызов, которого нет
 * в рантайме (`003`). Строки с 2026-09-28 понижаются (`docs/hardware-debt.md` §3.48), поэтому
 * прежний источник `002` — строковая константа — код больше не выдаёт, и производителя пришлось
 * сменить: иначе проверка стерегла бы код, которого никто не выдаёт.
 */
const STRINGY = "модуль Д\nпроцедура главная()\n  пусть х = 1.5\n  вернуть система.строка.содержит(\"привет\", \"ри\")\nконец\nконец\n";
/** Контрольная арифметика: отказов быть не должно. */
const CONTROL = "модуль К\nпроцедура главная()\n  вернуть 2 + 2\nконец\nконец\n";
/** Незакрытый блок: отказ ЯЗЫКА, а не понижения. */
const SYNTAX = "модуль П\nпроцедура главная()\n  вернуть 1\n";

describe("наблюдатель понижения: класс вместо строки", () => {
  it("печать понижается: образ собран, отказов ноль", () => {
    const report = loweringDiagnosticsOf(PRINT, "печать.osnova");
    expect(report.built).toBe(true);
    expect(report.refusedTotal).toBe(0);
    expect(report.diagnostics).toEqual([]);
  });

  it("ТИХАЯ ЛОЖЬ названа: образ собран при выброшенном носителе", () => {
    const report = loweringDiagnosticsOf(REMAINDER, "остаток.osnova");
    // Оба поля обязательны: «собран» и «есть отказы» вместе — и есть тихая ложь.
    expect(report.built, "образ собран").toBe(true);
    expect(report.refusedTotal, "отказов").toBe(1);
    const first = report.diagnostics[0]!;
    expect(first.code, "код контракта у отказа понижения").toBe(LOWERING_CODES.noForm);
    expect(first.class).toBe(LOWERING_CODE_CLASSES[LOWERING_CODES.noForm]);
    expect(first.carrier).toBe("IR.rem");
    expect(first.index).toBe(2);
  });

  it("код отказа — личность: разные коды дают разные классы, текст класса не решает", () => {
    const report = loweringDiagnosticsOf(STRINGY, "строка.osnova");
    // Два РАЗНЫХ отказа — два разных кода и два разных класса.
    expect(report.diagnostics.map((d) => d.code)).toEqual([LOWERING_CODES.constant, LOWERING_CODES.runtime]);
    expect(report.diagnostics.map((d) => d.class)).toEqual([
      LOWERING_CODE_CLASSES[LOWERING_CODES.constant],
      LOWERING_CODE_CLASSES[LOWERING_CODES.runtime],
    ]);
    // НЕГАТИВНЫЙ КОНТРОЛЬ КОНТРАКТА: тот же КОД с ДРУГИМ ТЕКСТОМ (другое значение константы,
    // другой номер носителя) — тот же класс. Именно этого не хватало, пока кода не было.
    const first = report.diagnostics[0]!;
    expect(first.message, "текст несёт значение — он и различается").toContain("1.5");
    expect(classOfCode(LOWERING_CODES.constant), "класс от текста не зависит").toBe(
      classOfCode(LOWERING_CODES.constant),
    );
    expect(classOfCode(LOWERING_CODES.constant)).not.toBe(classOfCode(LOWERING_CODES.runtime));
    // Подмена кода МЕНЯЕТ класс — вторая половина негативного контроля.
    expect(classOfCode(LOWERING_CODES.constant)).not.toBe(classOfCode(LOWERING_CODES.print));
    // Код вне таблицы назван прямо, а не «подобран похожий».
    expect(classOfCode("OSN-LOW-999")).toBe("код-вне-контракта");
    expect(classOfCode(undefined)).toBe("сборка-упала");
  });

  it("у класса «язык» есть настоящий код из общего канала", () => {
    const report = loweringDiagnosticsOf(SYNTAX, "синтаксис.osnova");
    expect(report.built, "образ не собирается").toBe(false);
    const codes = report.diagnostics.map((d) => d.code);
    expect(codes).toContain("OSN-PAR-001");
    expect(report.diagnostics.every((d) => d.class === "язык")).toBe(true);
  });

  it("негативный контроль: контрольная арифметика молчит", () => {
    const report = loweringDiagnosticsOf(CONTROL, "контроль.osnova");
    expect(report.built).toBe(true);
    expect(report.diagnostics).toEqual([]);
    expect(report.refusedTotal).toBe(0);
  });

  it("разбор строки отказа не выдумывает место, когда его нет", () => {
    expect(parseRefusalText("#2 IR.rem: причина")).toEqual({ index: 2, carrier: "IR.rem", reason: "причина" });
    expect(parseRefusalText("раскладка отказала: причина")).toEqual({ reason: "раскладка отказала: причина" });
  });

  it("JSONL-запись несёт КОД контракта, а не только текст", () => {
    const report = loweringDiagnosticsOf(REMAINDER, "остаток.osnova");
    const line = formatLoweringDiagnosticJson(report.diagnostics[0]!);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["class"]).toBe(LOWERING_CODE_CLASSES[LOWERING_CODES.noForm]);
    expect(parsed["carrier"]).toBe("IR.rem");
    // Код есть и он из контракта: до 2026-09-28 здесь стояло обратное утверждение —
    // «кода у понижения пока нет». Контракт его дал.
    expect(parsed["code"], "код обязан быть в записи").toBe(LOWERING_CODES.noForm);
    expect(parsed["message"], "место отказа остаётся в тексте").toContain("IR.rem");
  });
});

describe("корпус: объявление против факта", () => {
  const rows = corpusLoweringRows();

  it("ни один отказ по всему корпусу не остался БЕЗ КОДА контракта", () => {
    expect(rows.length, "записей в корпусе").toBeGreaterThan(30);
    const unnamed = rows.reduce((sum, r) => sum + r.unnamed, 0);
    // С контрактом код есть у каждого отказа понижения: ненулевое число здесь значит, что
    // производитель назвал код ВНЕ таблицы (класс `код-вне-контракта`) — сторож краснеет.
    expect(unnamed, "отказов с классом «код-вне-контракта»").toBe(0);
  });

  it("у объявленных «работает» образ собирается без отказов", () => {
    const works = rows.filter((r) => r.declared === "работает");
    expect(works.length).toBeGreaterThan(0);
    for (const r of works) {
      expect(r.built, `${r.dir}: объявлено «работает», а образ не собран`).toBe(true);
      expect(r.refused, `${r.dir}: объявлено «работает», а носители выброшены`).toBe(0);
    }
  });

  it("вердикты — только из названного набора, без «похоже на»", () => {
    // Набор берётся у самого наблюдателя: вторая копия в тесте пропускала бы новый вердикт.
    const allowed = new Set<string>(CORPUS_VERDICTS);
    for (const r of rows) expect(allowed.has(r.verdict), `${r.dir}: ${r.verdict}`).toBe(true);
  });
});
