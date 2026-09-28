/**
 * Оракул наблюдателя за понижением (`./e2kLoweringDiagnostics`).
 *
 * **Повод.** Отказ понижения видит только оракул корпуса — и только у записей,
 * объявленных «работает», и только в шлюзе `gate:qemu`. Замер 2026-09-28: `вернуть 17 % 5`
 * даёт образ 112 байт с ОДНИМ выброшенным носителем (`IR.rem`: формы понижения нет),
 * а `npx tsx src/cli.ts compile` на том же файле печатает «Скомпилировано» и выходит
 * нулём. Это класс «программа собралась, а число неверное».
 *
 * **Что держит этот сторож.**
 * 1. Класс выводится из ПРИЧИНЫ, а не из строки: две разные причины дают разные классы,
 *    одинаковые — одинаковые. Сравнение строк негодно: текст несёт значение
 *    (`константа пула #0 = Аня`), поэтому один и тот же отказ даёт разные строки.
 * 2. Класс `класс-не-назван` не появляется ни на пробах, ни на всём корпусе: таблица
 *    причин исчерпывающая. Ослепшая таблица (плоскость e2k переписала текст отказа)
 *    краснеет здесь, а не проходит молча.
 * 3. Тихая ложь названа прямо: образ СОБРАН при непустых отказах — это `built: true`
 *    и `refusedTotal > 0`, и сторож требует обоих полей, а не «есть отказы».
 * 4. У класса «язык» есть НАСТОЯЩИЙ код из общего канала (`OSN-PAR-001`) — единственный
 *    класс, у которого код есть сегодня; остальные ждут контракта `OSN-LOW-*`.
 * 5. Объявление корпуса против факта: у записей «работает» не бывает ни отказов, ни
 *    несобранного образа; расхождение с причиной «нет» остаётся находкой отчёта, а не
 *    закреплённым ожиданием (запись 06 в работе у плоскости e2k — прибивать её нельзя).
 *
 * Негативный контроль — контрольная арифметика: у неё отказов НОЛЬ, поэтому «печатать
 * отказ всегда» этот сторож не прошло бы.
 */
import { describe, it, expect } from "vitest";
import {
  classifyReason,
  corpusLoweringRows,
  formatLoweringDiagnosticJson,
  loweringDiagnosticsOf,
  parseRefusalText,
} from "./e2kLoweringDiagnostics";

/** Корпус 39 дословно: печать числа на цель. */
const PRINT = "процедура главная()\n  система.лог.вывести(7 + 3)\nконец_процедуры\n";
/** Носитель без формы понижения: `IR.rem`. */
const REMAINDER = "модуль О\nпроцедура главная()\n  вернуть 17 % 5\nконец\nконец\n";
/** Строка: две РАЗНЫЕ причины отказа. */
const STRINGY = 'модуль С\nпроцедура главная()\n  пусть имя = "Аня"\n  вернуть система.строка.длина(имя)\nконец\nконец\n';
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
    expect(first.class).toBe("носитель-без-формы");
    expect(first.carrier).toBe("IR.rem");
    expect(first.index).toBe(2);
  });

  it("разные причины — разные классы (сравнение строк не различает)", () => {
    const report = loweringDiagnosticsOf(STRINGY, "строка.osnova");
    const classes = report.diagnostics.map((d) => d.class);
    expect(classes).toEqual(["константа-невыразима", "вызов-вне-рантайма"]);
    // Тот же текст с другим ЗНАЧЕНИЕМ — тот же класс: класс по причине, а не по строке.
    expect(
      classifyReason(
        "«IR.const»: константа пула #0 = Борис (тип string) — литералом e2k кодируются только целые 16- и 32-битные значения",
      ),
    ).toBe("константа-невыразима");
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

  it("JSONL-запись несёт класс и не выдумывает код", () => {
    const report = loweringDiagnosticsOf(REMAINDER, "остаток.osnova");
    const line = formatLoweringDiagnosticJson(report.diagnostics[0]!);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["class"]).toBe("носитель-без-формы");
    expect(parsed["carrier"]).toBe("IR.rem");
    expect("code" in parsed, "кода у понижения пока нет — выдумывать нельзя").toBe(false);
  });
});

describe("корпус: объявление против факта", () => {
  const rows = corpusLoweringRows();

  it("ни один класс отказа не остался не названным по всему корпусу", () => {
    expect(rows.length, "записей в корпусе").toBeGreaterThan(30);
    const unnamed = rows.reduce((sum, r) => sum + r.unnamed, 0);
    // Таблица причин исчерпывающая: если плоскость e2k переписала текст отказа, класс
    // не найдётся и сторож покраснеет здесь, а не пройдёт молча.
    expect(unnamed, "отказов с классом «класс-не-назван»").toBe(0);
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
    const allowed = new Set([
      "совпадает",
      "ОБЪЯВЛЕНИЕ УСТАРЕЛО: «нет» с причиной про понижение, а понижение проходит",
      "РАСХОЖДЕНИЕ: объявлено «работает», а понижение отказывает",
      "вне понижения: причина называет другой слой",
    ]);
    for (const r of rows) expect(allowed.has(r.verdict), `${r.dir}: ${r.verdict}`).toBe(true);
  });
});
