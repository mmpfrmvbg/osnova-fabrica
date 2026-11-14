/**
 * ОРАКУЛ КОРПУСА ПРИМЕРОВ: `examples/**`.
 *
 * # Чем он отличается от оракула учебника
 *
 * Учебник проверяет, что примеры **работают**. Корпус проверяет больше: что у
 * каждого примера есть **независимый эталон**, что статусы не врут и что индекс
 * не расходится с содержимым. Учебник — про текст, корпус — про проверяемую
 * единицу: программа + эталон + названный статус.
 *
 * # Четыре требования к корпусу
 *
 * 1. **Каждая программа собирается и исполняется на VM**, результат сравнивается
 *    с `expected.txt` построчно.
 * 2. **Объявленное исполняемым на e2k обязано исполняться на e2k** — против ТОГО
 *    ЖЕ эталона. Прогон живёт в шлюзе `gate:qemu` (ресурсозависимый ресурс, случай
 *    12 реестра проверяемости), а здесь проверяется, что он **подключён**: пример
 *    со статусом «e2k: работает» без оракула цели — красное.
 * 3. **Эталон не перегенерируется тем же прогоном.** `expected.txt` только
 *    читается; чем он получен — написано в `meta.expected.origin`. Проверка
 *    «в этом файле нет записи в корпус» стоит здесь намеренно: она защищает
 *    свойство, которое глазами не видно.
 * 4. **Статус «нет» называет причину**, а не молчит: причина обязана ссылаться на
 *    измерение или раздел канона.
 * 5. **Статус «отказывает» подтверждён понижением** (введён 2026-10-29, A4-5а): он значит «наша
 *    сборка отказывает намеренно» — включён поведенческий сторож, и честный отказ выбран вместо
 *    неверного числа (D4 в `docs/decisions.md`). Утверждение проверяется: если понижение начнёт
 *    СОБИРАТЬ образ, статус обязан покраснеть, а не остаться зелёным ярлыком.
 *
 * # Счётчик корпуса
 *
 * `EXPECTED_EXAMPLES` и `EXPECTED_E2K` сравниваются ТОЧНО — как счётчик формы
 * примеров в учебнике. Отчёт по каждой правке называет оба числа, и «из них на
 * e2k» не может вырасти незаметно.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ATOM_CATALOGUE } from "../compiler/atomRegions";
import { compileSource } from "../compiler/compiler";
import { deprecatedClosingsOf } from "./deprecatedEnds";
import {
  E2K_LAYERS,
  EXAMPLE_DIR_RE,
  readBoundaries,
  readExamples,
  renderIndex,
  type Example,
} from "./examplesIndex";
import { MultiReturnRefusal, buildE2kImage } from "./e2kProgramRun";
import { formatValue, runProgramOnVm } from "./programRunner";

const ROOT = path.resolve(__dirname, "..", "..");
const EXAMPLES = path.join(ROOT, "examples");
const INDEX = path.join(EXAMPLES, "README.md");
const E2K_LANE = path.join(ROOT, "src", "scripts", "examplesE2k.audit.test.ts");
const QEMU_CONFIG = path.join(ROOT, "vitest.qemu.config.ts");

/**
 * ИМЯ СТОРОЖА ПОВЕДЕНИЯ, которым оракул цели сверяет вывод гостя с эталоном побайтово.
 *
 * Ищется по имени функции в тексте оракула цели: сам сторож живёт в шлюзе (`gate:qemu`), где
 * гоняется модель, а здесь проверяется, что он ПОДКЛЮЧЁН. Так запись «работает + вывод» не может
 * появиться без проверки — именно этого запрет и добивался, но запретом, а не замком на пустое место.
 */
const GUEST_OUTPUT_GUARD = "guestOutputMatches";

/**
 * СЧЁТЧИК КОРПУСА: сколько примеров и сколько из них исполняется на цели.
 *
 * Числа сравниваются точно, поэтому каждое изменение корпуса обязано быть названо
 * в отчёте. Номер `01` оставлен примеру владельца — эталону FIR (181).
 *
 * Сдвиг 2026-09-27: `EXPECTED_E2K` 24 → **25** — запись `17-ранжирование-выбором` переведена
 * в «работает». Причина сдвига не в примере, а в раскладке регистров: цели переходов
 * пересчитываются ДО анализа живости (`src/e2k/regAlloc.ts`, коммит 8552bdf), поэтому код
 * возврата на цели стал 23 = эталон VM вместо 4. Сторож — `src/e2k/regAllocCoverage.test.ts`.
 *
 * Сдвиг 2026-09-28: `EXPECTED_E2K` 25 → **31** — шесть печатающих записей `39`–`44` переведены
 * в «работает». Причина сдвига тоже не в примерах: печать подключена к конвейеру
 * (`src/e2k/printCall.ts` + `src/e2k/programImage.ts`), а раскладка узнала длину развёртки
 * (`src/e2k/twoPassLayout.ts`). Сторож поведения — сверка байтов вывода в оракуле цели
 * (`src/scripts/examplesE2k.audit.test.ts`), устройство пути — `src/e2k/printPipeline.test.ts`,
 * разбор — `docs/hardware-debt.md` §3.43.
 *
 * Сдвиг 2026-09-28 (второй за день): `EXPECTED_E2K` 31 → **34** — записи `02-переменные` и
 * `04-строки` переведены в «работает»: строки понижаются статическими байтами, длина считается
 * в КОДОВЫХ ТОЧКАХ, склейка идёт в статический буфер 20 байт (`src/e2k/stringRuntime.ts` +
 * `src/e2k/stringPlan.ts`). Сторож тот же — сверка байтов вывода; разбор — §3.48.
 *
 * Сдвиг 2026-09-29: `EXPECTED_E2K` 34 → **35** — запись `08-факториал` переведена на ИТЕРАЦИЮ
 * (цикл с накопителем; рекурсия остаётся названным отказом). Сторож тот же — сверка байтов
 * вывода (`120\n`); разбор — §3.54.
 *
 * Сдвиг 2026-09-29 (второй за день): `EXPECTED_E2K` 35 → **36**, `EXPECTED_EXAMPLES` 44 → **45** —
 * запись `08-факториал` вернулась к РЕКУРСИВНОЙ форме (отказ `OSN-LOW-003` снят: пролог вызывающей
 * растит окно, внутренний вызов `wbs = 8`, возврат на глубине ≥ 2 в порядке «`return` → значение →
 * `ct`»), а итеративная сохранена отдельной записью `47-факториал-итерацией`. Обе под сторожем
 * байтов вывода; разбор — §3.57.
 *
 * Сдвиг 2026-09-29 (третий за день): `EXPECTED_E2K` 36 → **37**, `EXPECTED_EXAMPLES` 45 → **46** —
 * заведена запись `48-память-выделение`: `система.память.выделить` понижается в арену, проверка
 * предела живёт ВНУТРИ понижения, исчерпание даёт строку в stderr и код 231. Эталон — четыре
 * «16» (разность соседних блоков; адрес арены у VM и у цели разный по решению). Сторож байтов
 * вывода — `src/e2k/arenaQemu.test.ts`; разбор — §3.89.
 *
 * Сдвиг 2026-09-29 (четвёртый за день): `EXPECTED_E2K` 37 → **38**, `EXPECTED_EXAMPLES` 46 → **47** —
 * заведена запись `49-склейка-арена`: склейка СВЕРХ статического буфера (50 байт) больше не отказ
 * сборки, блок берётся у арены ровно под сумму байтов (24 + 26), а отказ переехал на исчерпание
 * (строка в stderr и код 231). Эталон — «Основа — это язык для машин» и «27» (27 кодпоинтов при
 * 50 байтах), посчитан независимо .NET; сторож поведения — сверка байтов вывода, шлюз
 * `src/e2k/arenaQemu.test.ts`; разбор — §3.90.
 *
 * Сдвиг 2026-10-29 (A4-5а): `EXPECTED_E2K` 38 → **37**, `EXPECTED_EXAMPLES` **не меняется** (47) —
 * ВКЛЮЧЁН сторож K5 (тихая ложь на ребре взятого перехода), и запись `24-условие-по-элементу`
 * переехала в новый статус «отказывает»: её пара «сравнение → переход» читала мусор и отдавала
 * **7 вместо 12** — на модели И на железе, при нуле отказов. Это сдвиг СТАТУСА, а не корпуса:
 * пример остаётся в корпусе и на VM работает. Цена включения замерена заранее (задача 0 среза 5а):
 * краснеет ровно одна запись, сдвига образов у остальных 37 нет; разбор — `docs/decisions.md` D3/D4
 * и `docs/verification-debt.md`, случай 54.
 *
 * Сдвиг 2026-10-29 (A4-5д, задача 5): `EXPECTED_E2K` 37 → **38**, `EXPECTED_EXAMPLES` **не меняется**
 * (47) — ВЫПУЩЕН черновик ветвления по значению: оба сравнения склейки материализуются, переход
 * ветвится по значению, поэтому запись `24-условие-по-элементу` вернулась из статуса «отказывает»
 * в «работает» — сторож снял её отказ ВМЕСТЕ с ложью, а не заглушил. Число записи на цели —
 * эталон `10`; разбор — `docs/hardware-debt.md` §3.148. Обратный ход (статус снова «отказывает»)
 * обязан быть отдельным датированным сдвигом с замером, а не правкой числа.
 */
const EXPECTED_EXAMPLES = 47;
const EXPECTED_E2K = 38;

/**
 * СЧЁТЧИК ЛЕГАСИ-ЗАКРЫТИЙ: сколько в корпусе закрытий одиночным `конец`.
 *
 * Считает тот же механизм, что отчёт корпуса (`src/scripts/deprecatedEnds.ts`) —
 * предупреждения компилятора вида `deprecated_closer`. Пример №1 пришёл из линии
 * e2k текстом без изменения, и три его `конец` здесь названы числом: это долг, а
 * не образец. Новые примеры пишутся каноном, поэтому число может только
 * уменьшаться — как 73 → 1 в учебнике.
 */
const EXPECTED_LEGACY_CLOSERS = 3;

const examples: Example[] = readExamples(ROOT);
const boundaries = readBoundaries(ROOT);

/** Эталон примера строками: как в учебнике, хвостовые пробелы не значимы. */
function expectedLines(e: Example): string[] {
  const raw = fs.readFileSync(path.join(EXAMPLES, e.dir, "expected.txt"), "utf-8");
  const lines = raw.split("\n").map((l) => l.replace(/\s+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Эталон примера одной строкой — для сверки с возвратом точки входа. */
const expectedValue = (e: Example): string => expectedLines(e).join("\n");

/** Строка-ссылка на измерение: раздел канона, документ или файл пробы. */
const NAMED_SOURCE_RE = /§\s*\d|docs\/|\S+\.(?:md|ts|py)\b/u;

/**
 * Точка входа примера.
 *
 * По раскладке это `main.osnova`. Но если программа в каталоге одна и названа
 * иначе (`fir.osnova`), это не дефект: в каноне имя файла = имя модуля, и
 * единственный файл однозначен. Неоднозначность (несколько файлов без
 * `main.osnova`) — дефект, и она называется.
 */
function entryOf(e: Example): string | null {
  if (e.modules.includes("main.osnova")) return "main.osnova";
  return e.modules.length === 1 ? e.modules[0]! : null;
}

/** Каталоги в `examples/`, которые не являются примерами по имени. */
function strayDirs(): string[] {
  if (!fs.existsSync(EXAMPLES)) return [];
  return fs
    .readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && EXAMPLE_DIR_RE.exec(e.name) === null)
    .map((e) => e.name);
}

describe("корпус примеров: раскладка и статусы", () => {
  it("корпус на месте: каталоги примеров и индекс", () => {
    expect(fs.existsSync(EXAMPLES), "каталог examples/").toBe(true);
    expect(fs.existsSync(INDEX), "индекс examples/README.md").toBe(true);
    expect(strayDirs(), "каталоги вне шаблона NN-имя").toEqual([]);
  });

  it("у каждого примера есть программа, expected.txt и meta.json", () => {
    const bad: string[] = [];
    for (const e of examples) {
      for (const file of ["expected.txt", "meta.json"]) {
        if (!fs.existsSync(path.join(EXAMPLES, e.dir, file))) bad.push(`${e.dir}: нет ${file}`);
      }
      if (e.modules.length === 0) bad.push(`${e.dir}: нет ни одного .osnova`);
      else if (entryOf(e) === null) {
        bad.push(`${e.dir}: нет main.osnova, а файлов несколько — точка входа неоднозначна`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("meta.json заполнен: имя, показ, статусы и происхождение эталона", () => {
    const bad: string[] = [];
    for (const e of examples) {
      const m = e.meta;
      if (typeof m.name !== "string" || m.name.trim() === "") bad.push(`${e.dir}: пустое name`);
      if (typeof m.shows !== "string" || m.shows.trim() === "") bad.push(`${e.dir}: пустое shows`);
      if (m.vm !== "работает" && m.vm !== "нет") bad.push(`${e.dir}: vm = ${String(m.vm)}`);
      // Третий статус, «отказывает», введён 2026-10-29 (A4-5а, решение владельца D4): он значит
      // НЕ «язык не умеет» (это «нет»), а «наша сборка отказывает НАМЕРЕННО» — включён наш
      // поведенческий сторож, и честный отказ выбран вместо неверного числа. Смешивать их нельзя:
      // у «нет» причина — отсутствие понижения, у «отказывает» — работающий сторож и снятая тихая
      // ложь; разбор — `docs/verification-debt.md`, случай 54.
      if (m.e2k?.status !== "работает" && m.e2k?.status !== "нет" && m.e2k?.status !== "отказывает") {
        bad.push(`${e.dir}: e2k.status = ${String(m.e2k?.status)}`);
      }
      if (typeof m.expected?.origin !== "string" || m.expected.origin.trim() === "") {
        bad.push(`${e.dir}: пустое expected.origin — не сказано, чем получен эталон`);
      }
      const via = m.expected?.via;
      if (via !== undefined && via !== "вывод" && via !== "возврат") {
        bad.push(`${e.dir}: expected.via = ${String(via)}`);
      }
      // Пример, объявленный работающим на цели, обязан отдавать результат способом, который на
      // цели существует. ЗАПРЕТ «работает + вывод» СНЯТ 2026-09-28: печать на цели появилась —
      // `система.лог.вывести` понижается развёрткой (`src/e2k/printCall.ts`), шесть записей `39`–`44`
      // переехали сменой статусов (docs/hardware-debt.md §3.43). Вместо запрета стоит ТРЕБОВАНИЕ:
      // у такой записи обязан быть сторож поведения — сверка вывода гостя с эталоном ПОБАЙТОВО
      // (не `includes` и не `trim`). Порядок приёмки назван замером (§3.42.1): сначала сторож,
      // потом статус; обратный порядок дал бы зелёную запись без проверки.
      if (m.e2k?.status === "работает" && (via ?? "вывод") === "вывод") {
        if (!fs.readFileSync(E2K_LANE, "utf-8").includes(GUEST_OUTPUT_GUARD)) {
          bad.push(
            `${e.dir}: объявлен работающим на e2k по выводу, а сторожа поведения в оракуле цели нет — ` +
              `байты вывода никто не сверяет (нужна проверка «${GUEST_OUTPUT_GUARD}»)`,
          );
        }
      }
      // И обязан называть, ЧТО он докажет на живой машине: иначе первую сессию
      // на железе придётся тратить на придумывание утверждений.
      if (m.e2k?.status === "работает" && (m.hardware ?? "").trim().length < 15) {
        bad.push(`${e.dir}: не сказано, что пример доказывает на железе (поле hardware)`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("статус «e2k: нет» называет причину со ссылкой на измерение", () => {
    const bad: string[] = [];
    for (const e of examples) {
      if (e.meta.e2k.status !== "нет") continue;
      const reason = (e.meta.e2k.reason ?? "").trim();
      if (reason.length < 15) bad.push(`${e.dir}: причина короче 15 знаков — «${reason}»`);
      else if (!NAMED_SOURCE_RE.test(reason)) {
        bad.push(`${e.dir}: причина без ссылки на измерение или канон — «${reason}»`);
      }
      // Расхождение обязано быть разложено по слоям: «дефект модели» без
      // разложения не доказательство (правило владельца после класса 3).
      const layer = e.meta.e2k.layer;
      if (layer === undefined || !(E2K_LAYERS as readonly string[]).includes(layer)) {
        bad.push(`${e.dir}: слой не назван или назван неверно — «${String(layer)}»`);
      }
    }
    for (const b of boundaries) {
      const reason = (b.e2k.reason ?? "").trim();
      if (reason.length < 15 || !NAMED_SOURCE_RE.test(reason)) {
        bad.push(`граница ${b.path}: причина не названа — «${reason}»`);
      }
      const layer = b.e2k.layer;
      if (layer === undefined || !(E2K_LAYERS as readonly string[]).includes(layer)) {
        bad.push(`граница ${b.path}: слой не назван или назван неверно — «${String(layer)}»`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("статус «e2k: отказывает» называет причину, слой и ПОДТВЕРЖДЁН понижением", () => {
    // Порядок приёмки тот же, что у «работает+вывод» (§3.42.1): **сначала сторож, потом статус**.
    // Статус «отказывает» — это УТВЕРЖДЕНИЕ, что понижение действительно отказывает; если его
    // снять (или починить причину), тест обязан покраснеть, а не тихо остаться зелёным. Иначе
    // «отказывает» стало бы ярлыком, за которым ничего не проверяется.
    const bad: string[] = [];
    for (const e of examples) {
      if (e.meta.e2k.status !== "отказывает") continue;
      const reason = (e.meta.e2k.reason ?? "").trim();
      if (reason.length < 15 || !NAMED_SOURCE_RE.test(reason)) {
        bad.push(`${e.dir}: причина отказа не названа со ссылкой на измерение — «${reason}»`);
      }
      const layer = e.meta.e2k.layer;
      if (layer === undefined || !(E2K_LAYERS as readonly string[]).includes(layer)) {
        bad.push(`${e.dir}: слой не назван или назван неверно — «${String(layer)}»`);
      }
      const files = fs.readdirSync(path.join(EXAMPLES, e.dir)).filter((f) => f.endsWith(".osnova"));
      const entry = files.includes("main.osnova") ? "main.osnova" : files[0];
      if (entry === undefined) {
        bad.push(`${e.dir}: нет исходника — отказ нечем подтвердить`);
        continue;
      }
      const source = fs.readFileSync(path.join(EXAMPLES, e.dir, entry), "utf-8");
      let refused = 0;
      try {
        refused = buildE2kImage(source).refused.length;
      } catch {
        // Названный отказ бывает и исключением (`MultiReturnRefusal`) — это тоже отказ.
        refused = 1;
      }
      if (refused === 0) {
        bad.push(
          `${e.dir}: объявлена «отказывает», а понижение СОБИРАЕТ образ — либо причина снята ` +
            `(тогда статус вручает зелёное за непроверенное), либо запись обязана снова стать «работает»`,
        );
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("эталон непустой, а прогон не переписывает корпус", () => {
    const bad: string[] = [];
    for (const e of examples) {
      if (expectedLines(e).length === 0) bad.push(`${e.dir}: expected.txt пуст`);
    }
    // Свойство, которое глазами не видно: оракул только ЧИТАЕТ корпус. Имена
    // собираются по частям, чтобы проверка не нашла саму себя в тексте файла.
    const own = fs.readFileSync(__filename, "utf-8");
    const forbidden = ["write" + "FileSync", "append" + "FileSync", "write" + "Index"];
    for (const name of forbidden) {
      if (own.includes(name)) bad.push(`оракул корпуса вызывает ${name}: эталон может быть перезаписан`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("заявка на атом — с гарантией и существующей проверкой, и атом есть в каталоге", () => {
    // Правило подписи: «реализует» — слишком сильно, «демонстрирует» — слишком
    // слабо. Подпись заявляет атом ВМЕСТЕ с текстом гарантии и указателем на
    // проверку; нет проверки — заявить нельзя. Пустая подпись у языкового
    // примера — норма, а не пробел.
    const known = new Set(ATOM_CATALOGUE.map((a) => a.id));
    const bad: string[] = [];
    for (const e of examples) {
      for (const claim of e.meta.atoms ?? []) {
        if (!known.has(claim.atom)) {
          bad.push(`${e.dir}: атом «${claim.atom}» не найден в каталоге 27 атомов`);
        }
        if (claim.guarantee.trim().length < 15) {
          bad.push(`${e.dir}: у атома ${claim.atom} гарантия не названа — «${claim.guarantee}»`);
        }
        if (claim.check.trim() === "" || !fs.existsSync(path.join(ROOT, claim.check))) {
          bad.push(`${e.dir}: у атома ${claim.atom} проверки нет в дереве — «${claim.check}»`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("поле core — это ядро атома, и слов-притязаний на гарантию в нём нет", () => {
    // `core` говорит только «пример есть вычислительное ядро атома». Как только в
    // тексте появляется «обеспечивает» или «гарантирует», поле превращается в
    // заявку на гарантию — а для неё нужно поле `atoms` с проверкой гарантии.
    // Отрицание — не притязание: «гарантии не обеспечивает» это ровно то, что
    // поле обязано говорить, поэтому `не обеспечивает` из проверки исключено.
    // Границы слова `\b` здесь не годятся: в JS она ASCII-ная, а перед кириллицей
    // не срабатывает — проверено прогоном (отрицание не снималось).
    const known = new Set(ATOM_CATALOGUE.map((a) => a.id));
    const CLAIM_WORDS = ["обеспечива", "гарантиру", "гарантирует", "реализует гарантию"];
    const NEGATED = /(^|\s)не\s+(?:обеспечива|гарантиру|гарантирует)\S*/gu;
    const bad: string[] = [];
    for (const e of examples) {
      const core = e.meta.core;
      if (core === undefined) continue;
      if (!known.has(core.atom)) {
        bad.push(`${e.dir}: ядро атома «${core.atom}» не найдено в каталоге 27 атомов`);
      }
      if (core.what.trim().length < 10) bad.push(`${e.dir}: core.what не назван — «${core.what}»`);
      const text = `${core.what} ${core.note ?? ""}`.toLowerCase().replace(NEGATED, "");
      for (const word of CLAIM_WORDS) {
        if (text.includes(word)) {
          bad.push(`${e.dir}: core притязает на гарантию словами «${word}» — для гарантии нужно поле atoms с проверкой`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("устаревшие закрытия `конец` в корпусе — счётчик, который может только уменьшаться", () => {
    // Правило счёта — метка компилятора `deprecated_closer`, тот же, которым
    // считает отчёт корпуса (`src/scripts/deprecatedEnds.ts`). Своё правило
    // разошлось бы с их числом, и оба стали бы врать по-разному.
    //
    // Компилируется КАЖДЫЙ пример в своём каталоге: многомодульный пример
    // (глава 10) склейкой текстов не разбирается — импорт ищется на диске.
    const counts: Array<{ dir: string; count: number }> = [];
    const bad: string[] = [];
    const singleFile: Array<{ file: string; text: string }> = [];
    for (const e of examples) {
      const sources = e.modules.map((m) => fs.readFileSync(path.join(EXAMPLES, e.dir, m), "utf-8"));
      const entry = entryOf(e) ?? e.modules[0]!;
      const r = compileSource(sources[e.modules.indexOf(entry)]!, {
        filename: entry,
        baseDir: path.join(EXAMPLES, e.dir),
        warnDeprecated: true,
      });
      const failed = r.lexerErrors.length > 0 || r.parserErrors.length > 0 || r.module === null;
      if (failed) bad.push(`${e.dir}: пример не разбирается — счёт закрытий невозможен`);
      counts.push({ dir: e.dir, count: failed ? 0 : r.warnings.filter((w) => w.kind === "deprecated_closer").length });
      if (e.modules.length === 1) singleFile.push({ file: e.dir, text: sources[0]! });
    }
    expect(bad, bad.join("\n")).toEqual([]);

    // Сверка механизмов: на однофайльных примерах мой счёт обязан совпасть со
    // счётом отчёта корпуса — иначе это два разных правила под одним именем.
    const theirs = deprecatedClosingsOf(singleFile).reduce((sum, r) => sum + r.count, 0);
    const mineSingle = counts
      .filter((c) => examples.find((e) => e.dir === c.dir)!.modules.length === 1)
      .reduce((sum, c) => sum + c.count, 0);
    expect(mineSingle, "мой счёт против счёта отчёта корпуса (однофайльные)").toBe(theirs);

    // Пример №1 пришёл из линии e2k текстом без изменения — три его `конец`
    // законны и названы числом. Новые примеры пишутся каноном, поэтому число
    // может только уменьшаться — как 73 → 1 в учебнике.
    expect(
      counts.reduce((sum, c) => sum + c.count, 0),
      "устаревших закрытий `конец` в корпусе",
    ).toBe(EXPECTED_LEGACY_CLOSERS);
  });

  it("индекс examples/README.md совпадает с корпусом", () => {
    // Индекс — чистая функция от каталогов; расхождение означает, что его
    // правили руками или забыли пересобрать.
    const generated = renderIndex(examples, boundaries);
    const actual = fs.readFileSync(INDEX, "utf-8");
    expect(actual, "пересобрать: npx tsx src/scripts/examplesIndex.ts").toBe(generated);
  });

  it("границы: путь существует и назван", () => {
    const bad: string[] = [];
    for (const b of boundaries) {
      if (!fs.existsSync(path.join(ROOT, b.path))) bad.push(`${b.path}: файла нет на диске`);
      if (b.what.trim() === "") bad.push(`${b.path}: не сказано, что делает`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("объявленное на e2k проверяется оракулом цели", () => {
    const declared = examples.filter((e) => e.meta.e2k.status === "работает").map((e) => e.dir);
    if (declared.length === 0) return;
    const problems: string[] = [];
    if (!fs.existsSync(E2K_LANE)) problems.push(`нет оракула цели ${path.relative(ROOT, E2K_LANE)}`);
    else {
      const config = fs.readFileSync(QEMU_CONFIG, "utf-8");
      if (!config.includes("examplesE2k.audit.test.ts")) {
        problems.push("оракул цели не подключён в vitest.qemu.config.ts (gate:qemu)");
      }
    }
    expect(problems, `на e2k объявлены: ${declared.join(", ")}\n${problems.join("\n")}`).toEqual([]);
  });

  it("кит для машины не отстал от корпуса", () => {
    // Кит собирается ИЗ корпуса (`npx tsx src/scripts/e2kHardwareKit.ts`), а его
    // таблица эталонов плоская — чтобы читаться на машине, где может не быть ни
    // python, ни jq, зато есть awk. Если добавить целевой пример и не пересобрать
    // кит, машина прогонит старый набор: это обязано быть видно здесь, а не на
    // железе за неделю доступа.
    const ready = examples.filter((e) => e.meta.e2k.status === "работает").length;
    // Кит несёт не только корпус: 8 программ B2 (рантайм-разбор ленты) собираются
    // генератором и проверяются на железе тем же каналом `вывод`. Их отсутствие —
    // тоже отставание кита, поэтому число фиксировано здесь, а не выводится из корпуса.
    const b2 = 8;
    // B2b: 15 форм P4a (5+5+5) + 20 форм L2 + 5 вызовов в выражениях + 9 форм §41
    // (индексация `а[…]` и `Список T` с литералом `[…]`) + 5 форм §41.2 (квалифицированный
    // вызов) + 4 формы СКОБКИ-ГРУППЫ (круг 26, `b2b9`: конец выражения после `)`) — 58.
    const b2b = 58;
    // P4a: все 15 форм B2b одной программой (`b2b/all`, 192512 кода, данные 64 КиБ).
    const p4a = 1;
    // L2 §42/§44 (2026-11-13): ТА ЖЕ программа пятнадцати форм, но лента приходит `read(3)` из
    // `/tmp/input.osnova` (`bin/b2b-file.elf` + `bin/input.osnova`, `run.sh` кладёт ленту на место
    // перед прогоном). Это НЕ запись корпуса и не новая форма: эталон тот же `эталоннаяЛента`,
    // различие ровно одно — источник ячеек. Поэтому число фиксировано здесь, как и у B2.
    const файл = 1;
    // P2b (2026-11-13): пять форм ЗАГОЛОВКА `процедура` (без параметров, `-> Тип`, один параметр,
    // два параметра со `Список`, контроль `действие`) — источник ЦЕЛИКОМ, а не тело действия.
    // Отдельное слагаемое, потому что это не новые записи корпуса и не формы B2b-54.
    const p2b = 5;
    const kitReadme = path.join(ROOT, "tools", "e2k-hardware", "README.md");
    const kit = path.join(ROOT, "tools", "e2k-hardware", "expected.tsv");
    const problems: string[] = [];
    if (!fs.existsSync(kitReadme)) {
      problems.push("нет tools/e2k-hardware/README.md — порядок прогонов негде смотреть");
    }
    if (!fs.existsSync(kit)) {
      problems.push("нет tools/e2k-hardware/expected.tsv — пересобрать: npx tsx src/scripts/e2kHardwareKit.ts");
    } else {
      const rows = fs
        .readFileSync(kit, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "").length;
      if (rows !== ready + b2 + b2b + p2b + p4a + файл) {
        problems.push(
          `в ките ${String(rows)} строк эталонов, а целевых примеров ${String(ready)} + B2 ${String(b2)} + B2b ${String(b2b)} + P2b ${String(p2b)} + P4a ${String(p4a)} + файловый вход ${String(файл)} = ${String(ready + b2 + b2b + p2b + p4a + файл)} — пересобрать: npx tsx src/scripts/e2kHardwareKit.ts`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("границы со слоем «обвязка» действительно отклоняются обвязкой", () => {
    // Граница — не запись в списке, а работающее утверждение. Для слоя «обвязка»
    // это значит: программа обязана быть ОТКЛОНЕНА раннером с названной причиной.
    // Если обвязку «починят», а граница останется, тест покраснеет — и это
    // правильно: список границ обязан совпадать с поведением, а не с памятью.
    const bad: string[] = [];
    for (const b of boundaries.filter((x) => x.e2k.layer === "обвязка")) {
      const source = fs.readFileSync(path.join(ROOT, b.path), "utf-8");
      // Граница обязана быть ГРАНИЦЕЙ: образ не собирается, причина названа. А
      // если граница про возвраты — отказ обязан быть именно тем, что заявлен.
      const aboutReturns = /возврат/iu.test(b.e2k.reason ?? "");
      try {
        buildE2kImage(source);
        bad.push(`${b.path}: обвязка СОБРАЛА образ, хотя граница утверждает отказ — обновить границу`);
      } catch (e) {
        if (aboutReturns && !(e instanceof MultiReturnRefusal)) {
          bad.push(`${b.path}: отказ не тот, что заявлен: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("счётчик корпуса: примеров ровно EXPECTED_EXAMPLES, из них на e2k EXPECTED_E2K", () => {
    expect(examples.length, "примеров в корпусе").toBe(EXPECTED_EXAMPLES);
    expect(
      examples.filter((e) => e.meta.e2k.status === "работает").length,
      "из них исполняемых на e2k",
    ).toBe(EXPECTED_E2K);
  });
});

describe("корпус примеров: программы исполняются", () => {
  for (const e of examples) {
    it(`пример ${e.dir}`, async () => {
      if (e.meta.vm !== "работает") return; // статус «нет» обязан быть назван — проверено выше
      const sources = new Map<string, string>();
      for (const file of e.modules) {
        sources.set(file, fs.readFileSync(path.join(EXAMPLES, e.dir, file), "utf-8"));
      }
      const { output, value, error } = await runProgramOnVm(sources, entryOf(e) ?? "main.osnova");
      expect(error, `пример должен исполняться: ${error ?? ""}`).toBeNull();
      if (e.meta.expected.via === "возврат") {
        // Результат — возврат процедуры: печатать программа не может (на цели
        // печати нет), поэтому эталон сверяется со значением точки входа.
        expect(formatValue(value), `возврат ${e.dir}`).toBe(expectedValue(e));
        return;
      }
      expect(output.map((l) => l.replace(/\s+$/u, ""))).toEqual(expectedLines(e));
    });
  }
});
