/**
 * ОРАКУЛ VLIW-ГОТОВНОСТИ АТЛАСА: защита от регрессии в документах.
 *
 * ## Зачем тест на документах
 *
 * VLIW-готовность атласа держится на соглашениях: у каждого из 27 атомов есть флаг
 * `optimizable` с обоснованием; границы атомов описаны как ABI; интерфейс
 * «подпись → эмиттер» зафиксирован; данные для выбора B-задачи собраны. Всё это —
 * текст, а текст теряется: флаг удаляют при переписывании таблицы, раздел
 * переименовывают, документ забывают перенести. Тогда следующий сеанс начнёт
 * проектировать то, что уже спроектировано, или, хуже, эмиттер получит разрешение
 * на перестановку без гарантии детерминизма.
 *
 * Это тот же приём, что `sourceAudit.test.ts` (константы модели),
 * `packetPacker.audit.test.ts` (инъекция дефектов) и `decisionB.audit.test.ts`
 * (решение B): проверяется наличие обязательного факта в дереве.
 *
 * ## Что здесь проверяется по существу, а не по наличию
 *
 * 1. Флаг есть у всех 27 атомов, ровно по одному разу, и множество идентификаторов
 *    совпадает с атласом: A1–A7, B1–B5, C1–C7, D1–D4, E1–E4.
 * 2. Обоснование непустое и содержательное (не «да» и не «кажется»).
 * 3. **Флаг согласован с тремя вопросами.** В таблице есть столбцы
 *    «вычисление / независимость / детерминизм»; `optimizable: true` допустим
 *    только там, где все три ответа «да». Это и есть оракул: он ловит и
 *    произвольный флаг, и отредактированный ответ без правки флага.
 * 4. Все пять документов на месте, и в каждом — обязательные разделы.
 * 5. В документах нет запрещённых утверждений: выбора B-задачи как сделанного и
 *    замеров на железе как выполненных.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");

/** Текст документа со схлопнутыми пробелами (markdown переносит фразы произвольно). */
function read(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, "utf-8").replace(/\s+/g, " ");
}

/** Сырой текст: таблицы нужно разбирать построчно, без схлопывания. */
function readRaw(rel: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) throw new Error(`нет файла: ${rel}`);
  return fs.readFileSync(full, "utf-8");
}

const SIGNATURE = path.join("docs", "osnova-signature-spec.md");
const BOUNDARIES = path.join("docs", "osnova-atom-boundaries.md");
const EMITTER = path.join("docs", "osnova-signature-to-emitter.md");
const CANDIDATES = path.join("docs", "b-task-candidates.md");

/** Ожидаемый состав 27 атомов — из атласа `docs/osnova-atlas-v0.1.md`. */
const AXES: Record<string, number> = { A: 7, B: 5, C: 7, D: 4, E: 4 };
const EXPECTED_IDS: string[] = Object.entries(AXES).flatMap(([axis, count]) =>
  Array.from({ length: count }, (_, i) => `${axis}${i + 1}`),
);

interface FlagRow {
  id: string;
  computation: string;
  independence: string;
  determinism: string;
  optimizable: string;
  justification: string;
}

/**
 * Разобрать строки таблицы каталога.
 *
 * Формат строки: `| A5 | природа | да | да | да | true | обоснование |`
 *
 * Из ячеек снимается markdown-акцент (`**true**`, `` `true` ``): значение всё
 * равно обязано быть `true` или `false` после снятия разметки — проверка не
 * ослабляется, но автор может выделять значение жирным.
 */
function plain(cell: string): string {
  return cell.replace(/[*`]/g, "").trim();
}

function parseFlagRows(): FlagRow[] {
  const rows: FlagRow[] = [];
  for (const line of readRaw(SIGNATURE).split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] и последний — пустые (обрамление строки таблицы).
    const id = cells[1] ?? "";
    if (!/^[A-E][1-9]$/.test(id)) continue;
    rows.push({
      id,
      computation: plain(cells[3] ?? ""),
      independence: plain(cells[4] ?? ""),
      determinism: plain(cells[5] ?? ""),
      optimizable: plain(cells[6] ?? ""),
      justification: plain(cells[7] ?? ""),
    });
  }
  return rows;
}

describe("VLIW-готовность: флаг optimizable у 27 атомов", () => {
  const rows = parseFlagRows();

  it("в каталоге ровно 27 атомов, ровно те же, что в атласе", () => {
    expect(rows).toHaveLength(27);
    expect([...rows.map((r) => r.id)].sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(rows.map((r) => r.id)).size).toBe(27);
  });

  it("у каждого атома флаг равен true или false", () => {
    for (const row of rows) {
      expect(["true", "false"], `атом ${row.id}: флаг «${row.optimizable}»`).toContain(row.optimizable);
    }
  });

  it("у каждого атома есть содержательное обоснование, а не «да» и не «кажется»", () => {
    for (const row of rows) {
      expect(row.justification.length, `атом ${row.id}: обоснование слишком короткое`).toBeGreaterThanOrEqual(40);
      const lower = row.justification.toLowerCase();
      expect(lower, `атом ${row.id}: обоснование-отписка`).not.toMatch(/^(кажется|наверное|возможно|да|нет)\.?$/);
    }
  });

  it("флаг согласован с тремя вопросами о природе атома", () => {
    for (const row of rows) {
      const answers = [row.computation, row.independence, row.determinism];
      const answersPresent = answers.every((a) => a === "да" || a === "нет" || a === "—");
      expect(answersPresent, `атом ${row.id}: ответы «${answers.join(" / ")}»`).toBe(true);
      const allYes = answers.every((a) => a === "да");
      const expected = allYes ? "true" : "false";
      expect(row.optimizable, `атом ${row.id}: три вопроса дают «${expected}», а флаг «${row.optimizable}»`).toBe(expected);
    }
  });

  it("ядрами помечены ровно те атомы, чья природа — обработка данных", () => {
    // Не «столько-то ради числа», а фиксация результата применения правила §1.
    const optimizable = rows.filter((r) => r.optimizable === "true").map((r) => r.id).sort();
    expect(optimizable).toEqual(["A5", "A6", "B4", "B5"]);
  });
});

describe("VLIW-готовность: границы атомов как ABI", () => {
  it("есть все пять разделов 2.1–2.5", () => {
    const doc = read(BOUNDARIES);
    for (const section of ["2.1.", "2.2.", "2.3.", "2.4.", "2.5."]) {
      expect(doc, `раздел ${section}`).toContain(`## ${section}`);
    }
  });

  it("есть пример с границами: оптимизируемая связка и неоптимизируемая", () => {
    const doc = read(BOUNDARIES);
    // Пример обязан назвать конкретные атомы обеих сторон: ML-инференс (A6 + B5)
    // и закупки (A1 + B1 + C5) — иначе «пример» не проверяем.
    expect(doc).toContain("A6");
    expect(doc).toContain("B5");
    expect(doc).toContain("A1");
    expect(doc).toContain("B1");
    expect(doc).toContain("C5");
    expect(doc.toLowerCase()).toContain("ml-инференс");
    expect(doc.toLowerCase()).toContain("закупк");
  });

  it("граница описана как запрет на перестановку через неё", () => {
    const doc = read(BOUNDARIES);
    expect(doc).toMatch(/не может переставлять|запрещено|никогда/i);
    expect(doc).toMatch(/границ/i);
  });
});

describe("VLIW-готовность: интерфейс подпись → эмиттер", () => {
  it("есть все пять разделов 3.1–3.5", () => {
    const doc = read(EMITTER);
    for (const section of ["3.1.", "3.2.", "3.3.", "3.4.", "3.5."]) {
      expect(doc, `раздел ${section}`).toContain(`## ${section}`);
    }
  });

  it("описаны вход и выход эмиттера, и оба вида выхода названы", () => {
    const doc = read(EMITTER);
    expect(doc.toLowerCase()).toContain("получает на вход");
    expect(doc.toLowerCase()).toContain("возвращает");
    // Выход: машинный код подмножества либо пакеты — оба варианта обязаны быть
    // названы, иначе интерфейс недоопределён.
    expect(doc.toLowerCase()).toContain("машинный код");
    expect(doc.toLowerCase()).toContain("пакет");
  });

  it("сказано, что эмиттера и симулятора нет — это долг, а не сделанная работа", () => {
    const doc = read(EMITTER);
    expect(doc.toLowerCase()).toContain("не реализован");
    expect(doc).toContain("docs/hardware-debt.md");
    // Интерфейс не должен выдавать себя за реализацию.
    expect(doc).toMatch(/не эмиттер|это не эмиттер/i);
  });

  it("описано, что происходит с атомами optimizable: false", () => {
    const doc = read(EMITTER);
    expect(doc.toLowerCase()).toContain("optimizable: false");
    expect(doc).toMatch(/без перестановки|не переставля/i);
  });
});

describe("VLIW-готовность: данные для выбора B-задачи", () => {
  const doc = read(CANDIDATES);

  it("разобраны все три кандидата", () => {
    expect(doc.toLowerCase()).toContain("ml-инференс");
    expect(doc.toLowerCase()).toContain("dsp");
    expect(doc.toLowerCase()).toContain("обработка сигналов");
  });

  it("у каждого кандидата есть все шесть подразделов 4.1–4.6", () => {
    for (const section of ["4.1.", "4.2.", "4.3.", "4.4.", "4.5.", "4.6."]) {
      // По одному на каждого из трёх кандидатов: раздел, встречающийся один или
      // два раза, означает, что кандидат разобран неполно.
      const occurrences = doc.split(section).length - 1;
      expect(occurrences, `подраздел ${section}: встречается ${occurrences} раз(а), ожидалось 3`).toBe(3);
    }
  });

  it("требования к инструкциям помечены как требование, а не как факт о e2k", () => {
    // Запрещено выдавать непроверенное наличие операций за факт.
    expect(doc).toContain("ТРЕБОВАНИЕ, НЕ ФАКТ");
    expect(doc.toLowerCase()).toContain("не сверялось");
  });

  it("есть раздел «Критерии выбора» и в нём нет рекомендации", () => {
    expect(doc).toContain("Критерии выбора");
    expect(doc.toLowerCase()).toContain("рекомендации нет");
    // Задача внутри B — решение владельца; документ не должен его подменять.
    expect(doc).toMatch(/решение владельца/i);
  });
});

describe("VLIW-готовность: решение записано, а несделанное не выдаётся за сделанное", () => {
  const docs = [SIGNATURE, BOUNDARIES, EMITTER, CANDIDATES];
  /** Документы, которые обсуждают, что строить под B: обязаны назвать решение. */
  const discussChoice = [EMITTER, CANDIDATES];

  it("выбор задачи записан: DSP, и это решение владельца", () => {
    // Владелец выбрал DSP 2026-09-15. Оракул проверяет именно это — раньше он
    // требовал обратного («задача не выбрана»), и после решения был обновлён, а не
    // удалён: иначе документы снова могли бы «забыть» выбор.
    for (const rel of discussChoice) {
      const doc = read(rel);
      expect(doc, `${rel}: не назван выбранный DSP`).toMatch(/DSP/);
      expect(doc, `${rel}: не сказано, что это решение владельца`).toMatch(/решение владельца/i);
    }
  });

  it("нигде не сказано, что выбран ДРУГОЙ кандидат", () => {
    // Подмена решения — такой же дефект, как его отсутствие.
    const forbidden = [
      /задача выбрана: (ML|обработк)/i,
      /выбран (ML|ML-инференс)/i,
      /выбрана обработка сигналов/i,
      /остановились на (ML|обработк)/i,
      /принято решение в пользу (ML|обработк)/i,
    ];
    for (const rel of docs) {
      const doc = read(rel);
      for (const pattern of forbidden) {
        expect(doc, `${rel}: ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("нигде не сказано, что замеры на железе сделаны", () => {
    const forbidden = [
      /замер на железе выполнен/i,
      /на железе измерено/i,
      /реальные такты получены/i,
      /измерено на эльбрусе/i,
      /подтверждено на железе/i,
    ];
    for (const rel of docs) {
      const doc = read(rel);
      for (const pattern of forbidden) {
        expect(doc, `${rel}: ${pattern}`).not.toMatch(pattern);
      }
    }
    // Долг перед железом обязан быть назван там, где речь о числах.
    expect(read(CANDIDATES)).toContain("docs/hardware-debt.md");
    expect(read(EMITTER)).toContain("docs/hardware-debt.md");
  });

  it("нигде не обещано ускорение: только плотность упаковки и модельные такты", () => {
    /**
     * Проверка на предложениях, а не на всём тексте: честная оговорка «флаг не
     * означает, что программа станет быстрее» содержит ту же фразу, что и обещание.
     * Поэтому предложение с обещанием засчитывается только при отсутствии в нём
     * отрицания.
     */
    const promissory = /(ускорит|будет быстрее|станет быстрее|ускорение в \d|даст ускорение)/i;
    const negation = /(не |ни |нельзя|не обещ|не означает)/i;
    for (const rel of docs) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      const sentences = text.split(/(?<=[.!?])\s+/);
      const offenders = sentences.filter((s) => promissory.test(s) && !negation.test(s));
      expect(offenders, `${rel}: обещание ускорения без оговорки`).toEqual([]);
    }
  });
});
