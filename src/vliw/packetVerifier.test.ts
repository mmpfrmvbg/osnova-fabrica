/**
 * ОРАКУЛ ПАКЕТОВ: тесты пишутся ДО реализации верификатора.
 *
 * ## Зачем отдельный верификатор
 *
 * Модель задержек говорит, какие инструкции **могут** стоять рядом по времени.
 * Но пакет — это не только время: внутри пакета слоты исполняются
 * последовательно на одной широкой команде, и часть комбинаций просто
 * недопустима аппаратно:
 *
 * - **RAW внутри пакета**: потребитель читает регистр, который производитель в
 *   том же пакете ещё не записал (в e2k значения видны со следующего пакета);
 * - **WAR**: запись затирает регистр до того, как его прочитал сосед по пакету;
 * - **WAW**: два писателя в один регистр — какое значение победит, не определено;
 * - **больше одной передачи управления**: VM покидает пакет при передаче
 *   управления, поэтому остальные слоты просто не исполнятся;
 * - **больше слотов, чем в машине**;
 * - **слот несовместим с операцией**: например, деление умеет только АЛУ5
 *   (стр. 56 руководства МЦСТ).
 *
 * Этот файл существовал как ТЕСТ и падал до появления `packetVerifier.ts`:
 * сначала оракул, потом код.
 *
 * ## Почему это важно именно здесь
 *
 * Упаковка по времени выдачи (`issueAt`) уже один раз сломала эквивалентность
 * (`while.osnova`: 49 вместо 1049) и была откачена. Верификатор — то, что должно
 * ловить такие пакеты **до** попадания в VM, а не после расхождения результата.
 */

import { describe, it, expect } from "vitest";
import { verifyPackets, type MachineModel } from "./packetVerifier";
import type { RegInstruction, RegModule, RegPacket } from "../runtime/vm/regcode";

/** Модель машины для тестов: 4 слота. */
const MODEL: MachineModel = {
  slots: 4,
  possibleSlots: (op: string) => {
    // Деление — только «слот 0» (образ АЛУ5 из модели устройств: деление умеет
    // только он). Это самая узкая группа — на ней проверяется конфликт слотов.
    if (op === "div" || op === "rem") return [0];
    // Ветвления — только «слот 3».
    if (op === "jmp" || op === "jmp_if" || op === "jmp_if_not" || op === "ret" || op === "throw") {
      return [3];
    }
    // Всё остальное — любой АЛУ-слот. ВАЖНО: сюда входит и `mul`, иначе пакет из
    // четырёх арифметических операций не поместился бы в 4 слота (тест поймал
    // ровно эту ошибку в моих тестовых данных).
    return [0, 1, 2];
  },
};

const K = (d: number, k = 0): RegInstruction =>
  ({ op: "const", d, type: "i32", k }) as RegInstruction;
const ADD = (d: number, a: number, b: number): RegInstruction =>
  ({ op: "add", d, a, b }) as RegInstruction;
const DIV = (d: number, a: number, b: number): RegInstruction =>
  ({ op: "div", d, a, b }) as RegInstruction;
const RET = (v?: number): RegInstruction =>
  (v === undefined ? { op: "ret" } : { op: "ret", v }) as RegInstruction;
const JMP = (off: number): RegInstruction => ({ op: "jmp", off }) as RegInstruction;
const CALL = (d: number, fi = 0, args: number[] = []): RegInstruction =>
  ({ op: "call", d, fi, args, argc: args.length }) as RegInstruction;
const MOVE = (d: number, a: number): RegInstruction => ({ op: "move", d, a }) as RegInstruction;

/** Собрать модуль из одного пакета. */
function moduleWithPacket(slots: RegInstruction[]): RegModule {
  return {
    ir: "osnova-reg",
    version: 1,
    moduleName: "тест",
    constants: [1, 2, 3],
    procedures: [{ name: "главная", codeOffset: 0, argc: 0, vregs: 16, localToVreg: {} }],
    code: [{ packet: true, slots } as RegPacket],
  };
}

/** Собрать модуль из линейного кода (пакетов нет). */
function linearModule(code: RegInstruction[]): RegModule {
  return {
    ir: "osnova-reg",
    version: 1,
    moduleName: "тест",
    constants: [1, 2, 3],
    procedures: [{ name: "главная", codeOffset: 0, argc: 0, vregs: 16, localToVreg: {} }],
    code,
  };
}

// ---------------------------------------------------------------------------
// ПОЗИТИВНЫЕ: 5 легальных пакетов
// ---------------------------------------------------------------------------

describe("verifyPackets: легальные пакеты принимаются", () => {
  it("1. два независимых const в одном пакете", () => {
    const m = moduleWithPacket([K(1, 0), K(2, 1)]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });

  it("2. const и независимый add (нет общих регистров)", () => {
    const m = moduleWithPacket([K(1, 0), ADD(5, 2, 3)]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });

  it("3. три независимые ALU-операции в трёх ALU-слотах", () => {
    // В модели 4 слота: 0,1,2 — АЛУ, 3 — ветвление. Поэтому независимых
    // ALU-операций в одном пакете максимум ТРИ, а не четыре.
    //
    // И регистры обязаны быть РАЗНЫМИ: `K(1); K(2); ADD(5,2,3)` — это RAW
    // (add читает 2, который только что записан const'ом). Первая версия теста
    // этого не учитывала, и верификатор справедливо отказывал дважды — за
    // нехватку слота и за RAW.
    const m = moduleWithPacket([K(1, 0), K(2, 1), K(3, 2)]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });

  it("4. пакет с терминатором: ret БЕЗ значения, один и последний", () => {
    // ВАЖНО: `ret v=1` читает регистр 1. Если в том же пакете его кто-то пишет —
    // это RAW, и верификатор обязан отказать. Первая версия теста ставила
    // `K(1); RET(1)` и «ожидала» успех, что было неверно: значение станет видно
    // только со следующего пакета.
    const m = moduleWithPacket([K(1, 0), RET()]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });

  it("4б. ret со значением в пакете с его производителем отвергается (RAW)", () => {
    const m = moduleWithPacket([K(1, 0), RET(1)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("RAW");
  });

  it("5. модуль без пакетов (только одиночные инструкции) легален", () => {
    const m = linearModule([K(1, 0), ADD(2, 1, 1), RET(2)]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });

  it("6. `call` один в пакете — легален", () => {
    // Вызов процедуры передаёт управление, но если он единственный слот, то
    // терять нечего: пакет и должен на нём закончиться.
    const m = moduleWithPacket([CALL(3, 0, [4])]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });

  it("7. `call` последним в пакете — легален", () => {
    // Аргумент вызова уже лежит в регистре 4 из ПРЕДЫДУЩЕГО пакета, а `const`
    // пишет регистр 9, которого вызов не касается.
    //
    // Первая версия теста ставила `K(4, 7); CALL(3, 0, [4])` и «ждала» успеха —
    // это RAW: вызов читает регистр 4, который `const` пишет в том же пакете.
    // Верификатор отказал справедливо: значение станет видно только со
    // следующего пакета. Это третий случай, когда оракул поймал ошибку в моих
    // тестовых данных (до него — `ret v=1` и `K(1);K(2);ADD(5,2,3)`).
    const m = moduleWithPacket([K(9, 7), CALL(3, 0, [4])]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// НЕГАТИВНЫЕ: по одному на каждый тип нарушения
// ---------------------------------------------------------------------------

describe("verifyPackets: нелегальные пакеты отвергаются с точной причиной", () => {
  it("1. RAW внутри пакета: потребитель читает регистр производителя", () => {
    // const d=1, затем add, который ЧИТАЕТ 1 — значение ещё не записано.
    const m = moduleWithPacket([K(1, 0), ADD(5, 1, 2)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("RAW");
    expect(r.at).toBe(0);
  });

  it("2. WAR внутри пакета: запись затирает регистр, который читает сосед", () => {
    // add читает 9, const пишет 9 — при последовательном исполнении порядок
    // слотов решает, но инвариант требует независимости.
    const m = moduleWithPacket([ADD(5, 9, 2), K(9, 0)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("WAR");
  });

  it("3. WAW внутри пакета: два писателя в один регистр", () => {
    const m = moduleWithPacket([K(7, 0), K(7, 1)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("WAW");
  });

  it("4. две передачи управления в одном пакете", () => {
    const m = moduleWithPacket([JMP(0), RET(1)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("BRANCH");
  });

  it("5. больше слотов, чем в машине", () => {
    const m = moduleWithPacket([K(1, 0), K(2, 1), K(3, 2), K(4, 3), K(5, 4)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("слотов");
  });

  it("6. слот несовместим с операцией: деление требует один слот, а он занят", () => {
    // В модели деление допустимо ТОЛЬКО в слоте 0. Пакет из четырёх делений
    // требует четырёх слотов, но каждый может занять лишь слот 0 — раскладки
    // не существует.
    const m = moduleWithPacket([
      DIV(1, 10, 11),
      DIV(2, 12, 13),
      DIV(3, 14, 15),
      DIV(4, 16, 17),
    ]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/не помещается/);
    expect(r.reason).toContain("div");
  });

  it("7. операция, не поддержанная машиной вообще", () => {
    const noDiv: MachineModel = { slots: 4, possibleSlots: (op) => (op === "div" ? [] : [0, 1, 2]) };
    const m = moduleWithPacket([DIV(1, 2, 3)]);
    const r = verifyPackets(m, noDiv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("не поддержана");
  });

  it("8. терминатор не последний в пакете", () => {
    // ret идёт первым, после него ещё инструкция — VM покинет пакет и не
    // исполнит её.
    const m = moduleWithPacket([RET(1), K(2, 0)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/терминатор|BRANCH/i);
  });

  it("9. `call` не последний в пакете: слот после него не исполнится", () => {
    // РЕГРЕССИЯ НА РЕАЛЬНЫЙ ДЕФЕКТ. Упаковка по `issueAt` положила `move` в один
    // пакет с `call` (слот 0 — call, слот 1 — move). VM на `call` возвращает
    // `callee.codeOffset` (`reginterpreter.ts`), а `executeElement` покидает
    // пакет при `next !== packetPc + 1`. Поэтому `move` не исполнился ни в этом
    // пакете, ни позже: `returnPc = packetPc + 1` перепрыгивает остаток пакета.
    //
    // Измерено на `while.osnova`: потеряна ровно одна инструкция
    // (`move d=6 a=0`), 249 → 248 шагов, результат 1049 → 49.
    //
    // Первая версия верификатора этот пакет ПРОПУСКАЛА: `call` не входил в
    // набор передающих управление. Дефект нашла диагностика, а не тесты.
    const m = moduleWithPacket([CALL(3, 0, [4]), MOVE(6, 0)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("BRANCH");
    expect(r.reason).toContain("call");
    expect(r.at).toBe(0);
  });

  it("10. `ret` не последний в пакете тоже BRANCH, а не терминатор", () => {
    const m = moduleWithPacket([RET(), K(2, 0)]);
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("BRANCH");
  });
});

// ---------------------------------------------------------------------------
// ГРАНИЦЫ
// ---------------------------------------------------------------------------

describe("verifyPackets: границы и точность", () => {
  it("возвращает позицию первого нелегального пакета", () => {
    const good: RegPacket = { packet: true, slots: [K(1, 0), K(2, 1)] } as RegPacket;
    const bad: RegPacket = { packet: true, slots: [K(5, 0), K(5, 1)] } as RegPacket;
    const m: RegModule = { ...linearModule([]), code: [good, bad] };
    const r = verifyPackets(m, MODEL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.at).toBe(1);
  });

  it("пустой пакет не считается нарушением", () => {
    const m = moduleWithPacket([]);
    expect(verifyPackets(m, MODEL)).toEqual({ ok: true });
  });

  it("модель с одним слотом отвергает пакет из двух инструкций", () => {
    const oneSlot: MachineModel = { slots: 1, possibleSlots: () => [0] };
    const m = moduleWithPacket([K(1, 0), K(2, 1)]);
    const r = verifyPackets(m, oneSlot);
    expect(r.ok).toBe(false);
  });

  it("модель с 24 слотами принимает широкий независимый пакет", () => {
    const wide: MachineModel = {
      slots: 24,
      possibleSlots: () => Array.from({ length: 24 }, (_, i) => i),
    };
    const slots = Array.from({ length: 10 }, (_, i) => K(i + 1, i));
    const m = moduleWithPacket(slots);
    expect(verifyPackets(m, wide)).toEqual({ ok: true });
  });
});
