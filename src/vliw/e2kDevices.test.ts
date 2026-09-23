/**
 * Тесты модели исполнительных устройств e2k и планировщика с задержками.
 *
 * Все числа и ограничения — из руководства МЦСТ
 * (`docs/elbrus-prog-1.2_2024-02-28.pdf`); в каждом тесте указана страница.
 * Тест «покрывает реальный набор опкодов» сверяется с каноническим `Op` из
 * `src/runtime/vm/bytecode.ts`, чтобы модель не разошлась с языком (именно эта
 * рассинхронизация и была найдена: `e2kModel` знала про `global.get` и
 * `field.get`, которых в языке нет).
 */

import { describe, it, expect } from "vitest";
import {
  ALL_CHANNELS,
  CHANNELS,
  DOMAIN_PENALTY,
  E2K_ISSUE_WIDTH,
  LATENCY,
  PREDICATE_FILE,
  REGISTER_FILE,
  UNITS,
  channelsFor,
  latencyFor,
  opClassOf,
} from "./e2kDevices";
import { VLIW_SLOTS, classifyOpcode, possibleSlots, primaryChannel } from "./e2kModel";
import {
  LATENCY_CORPUS,
  scheduleWithLatency,
  formatSchedule,
} from "./latencyScheduler";import { ALL_OPS, type RawInstruction } from "../runtime/vm/bytecode";

/** Канонический набор опкодов языка — единственный источник, не копия. */
const REAL_OPS: readonly string[] = ALL_OPS;

describe("e2kDevices: состав устройств (стр. 54–56)", () => {
  it("24 позиции выдачи: 6 АЛУ + СТ + 3 PL + 6 QP + 4 APB + 4 LIT", () => {
    expect(E2K_ISSUE_WIDTH).toBe(24);
    expect(ALL_CHANNELS).toHaveLength(24);
    expect(CHANNELS.ALU).toHaveLength(6);
    expect(CHANNELS.PL).toHaveLength(3);
    expect(CHANNELS.QP).toHaveLength(6);
    expect(CHANNELS.APB).toHaveLength(4);
    expect(CHANNELS.LIT).toHaveLength(4);
  });

  it("АЛУ5 умеет деление и корень, остальные — нет (стр. 56)", () => {
    expect(UNITS.alu5.divsqrt).toBe(true);
    for (const alu of ["alu0", "alu1", "alu2", "alu3", "alu4"] as const) {
      expect(UNITS[alu].divsqrt, `${alu} не должен уметь деление`).toBe(false);
    }
  });

  it("чтение из памяти есть у АЛУ0/2/3/5 и НЕТ у АЛУ1/4 (стр. 56)", () => {
    expect(UNITS.alu0.load).toBe(true);
    expect(UNITS.alu2.load).toBe(true);
    expect(UNITS.alu3.load).toBe(true);
    expect(UNITS.alu5.load).toBe(true);
    expect(UNITS.alu1.load).toBe(false);
    expect(UNITS.alu4.load).toBe(false);
  });

  it("запись в память есть только у АЛУ2 и АЛУ5 (стр. 56)", () => {
    expect(UNITS.alu2.store).toBe(true);
    expect(UNITS.alu5.store).toBe(true);
    for (const alu of ["alu0", "alu1", "alu3", "alu4"] as const) {
      expect(UNITS[alu].store, `${alu} не должен уметь запись`).toBe(false);
    }
  });

  it("регистровый и предикатный файлы (стр. 57)", () => {
    expect(REGISTER_FILE).toEqual({ total: 256, global: 32, local: 224 });
    expect(PREDICATE_FILE).toEqual({ count: 32, bits: 2 });
  });
});

describe("e2kDevices: длительности операций (стр. 71–72)", () => {
  it("таблица длительностей совпадает с документом", () => {
    expect(LATENCY.int).toBe(1);
    expect(LATENCY.int_combined).toBe(2);
    expect(LATENCY.fp).toBe(4);
    expect(LATENCY.fp_combined).toBe(8);
    expect(LATENCY.fdiv32).toBe(11);
    expect(LATENCY.fdiv64).toBe(14);
    expect(LATENCY.ld_l1).toBe(3);
    expect(LATENCY.ld_l2).toBe(11);
    expect(LATENCY.ld_l3).toBe(40);
    expect(LATENCY.ld_mem).toBe(100);
    expect(LATENCY.cmp_to_logic).toBe(1);
    expect(LATENCY.logic_to_logic).toBe(0.5);
    expect(LATENCY.qual).toBe(2);
    expect(LATENCY.to_ct).toBe(3);
    expect(LATENCY.disp_to_ct).toBe(5);
    expect(LATENCY.return_to_ct).toBe(6);
    expect(LATENCY.movtd_to_ct).toBe(9);
  });

  it("штраф домена fp→int = +2 (стр. 72)", () => {
    expect(DOMAIN_PENALTY.fp_to_int).toBe(2);
  });

  it("штраф домена int→fp = +1: противоречие стр. 72 разрешено главой 12", () => {
    // Таблица стр. 72 говорит «int->fp +0», а абзац на той же странице — «+1 такт
    // в симметричном случае». Глава 12 (стр. 194) разрешает противоречие:
    // «результаты операций группы ibps передаются в операции группы fbps с
    // задержкой в 1 такт». ibps — целочисленные, fbps — вещественные, то есть
    // это ровно int->fp. Берём +1.
    expect(DOMAIN_PENALTY.int_to_fp).toBe(1);
  });

  it("int→fp действительно задерживает потребителя на 1 такт", () => {
    // Проверяем не константу, а следствие: потребитель из другого домена
    // выдаётся на такт позже, чем потребитель из того же.
    const K = (k: number) => ({ op: "const", type: "i32", k }) as RawInstruction;
    // add (int) → mul (fp): переход int→fp, штраф +1.
    const cross: RawInstruction[] = [
      K(0), K(1),
      { op: "add" } as RawInstruction,
      { op: "mul" } as RawInstruction,
    ];
    const r = scheduleWithLatency(cross);
    const addAt = r.packets.find((p) => p.slots.some((s) => s.op === "add"))!.issueAt;
    const mulAt = r.packets.find((p) => p.slots.some((s) => s.op === "mul"))!.issueAt;
    const addLat = latencyFor(opClassOf("add")); // 1
    // Разрыв = длительность add (1) + штраф int→fp (1) = 2.
    expect(mulAt - addAt).toBe(addLat + DOMAIN_PENALTY.int_to_fp);
  });

  it("задержка Cmp/логических зависит от потребителя (стр. 71)", () => {
    expect(latencyFor("cmp_to_logic", "logic")).toBe(1);
    expect(latencyFor("cmp_to_logic", "qualified")).toBe(2);
    expect(latencyFor("cmp_to_logic", "ct")).toBe(3);
  });

  it("деление — 11 тактов для 32 бит и 14 для 64 (стр. 71)", () => {
    expect(LATENCY.fdiv32).toBe(11);
    expect(LATENCY.fdiv64).toBe(14);
  });

  it("mul отнесён к Fp: документ прямо включает целочисленное умножение в класс Fp (стр. 71)", () => {
    expect(opClassOf("mul")).toBe("fp");
    expect(opClassOf("add")).toBe("int");
    expect(opClassOf("obj.get")).toBe("ld_l1");
  });
});

describe("e2kModel: слоты формата Основа выводятся из реальных устройств", () => {
  it("VLIW_SLOTS остаётся 4 — это ширина формата, не железа", () => {
    expect(VLIW_SLOTS).toBe(4);
    expect(E2K_ISSUE_WIDTH).toBe(24);
  });

  it("деление и остаток больше не едут в произвольный слот", () => {
    // Регрессия: прежде possibleSlots("div") возвращал ["I0","I1"] — то есть
    // разрешал деление в любом ALU-слоте. Деление умеет только АЛУ5.
    expect(possibleSlots("div")).toEqual(["M"]);
    expect(possibleSlots("rem")).toEqual(["M"]);
    // БЛОК 2: целочисленное деление — тот же делитель АЛУ5.
    expect(possibleSlots("idiv")).toEqual(["M"]);
    expect(channelsFor("div")).toEqual([CHANNELS.ALU[5]]);
    expect(channelsFor("idiv")).toEqual([CHANNELS.ALU[5]]);
  });

  it("ветвление и вызовы — только СТ", () => {
    for (const op of ["jmp", "jmp_if", "jmp_if_not", "call", "ret", "invoke"]) {
      expect(channelsFor(op), op).toEqual([CHANNELS.CT]);
      expect(classifyOpcode(op), op).toBe("B");
    }
  });

  it("запись в поле объекта доступна только АЛУ2 и АЛУ5", () => {
    const ch = channelsFor("obj.set");
    expect(ch).toContain(CHANNELS.ALU[2]);
    expect(ch).toContain(CHANNELS.ALU[5]);
    expect(ch).not.toContain(CHANNELS.ALU[1]);
    expect(ch).not.toContain(CHANNELS.ALU[4]);
  });

  it("чтение поля объекта не попадает в АЛУ1 и АЛУ4", () => {
    const ch = channelsFor("obj.get");
    expect(ch).toContain(CHANNELS.ALU[0]);
    expect(ch).not.toContain(CHANNELS.ALU[1]);
    expect(ch).not.toContain(CHANNELS.ALU[4]);
  });

  it("локальные переменные — это НЕ память: local.get/local.set идут как целочисленные", () => {
    // Локали стековой VM лежат в массиве кадра (`frame.locals`), к памяти
    // отношения не имеющего. Отнести их к `ld`/`st` было бы ложной аналогией —
    // и именно такая аналогия однажды сломала упаковку (см. отчёт).
    expect(opClassOf("local.get")).toBe("int");
    expect(opClassOf("local.set")).toBe("int");
    expect(opClassOf("obj.get")).toBe("ld_l1");
    expect(opClassOf("obj.set")).toBe("store");
    // Следствие: локальные доступны всем шести АЛУ, а поле объекта — нет.
    expect(channelsFor("local.set")).toHaveLength(6);
    expect(channelsFor("obj.set").length).toBeLessThan(6);
  });

  it("у каждой операции реального языка есть хотя бы один канал", () => {
    for (const op of REAL_OPS) {
      expect(() => possibleSlots(op), `нет слота для ${op}`).not.toThrow();
      expect(primaryChannel(op), op).toBeTruthy();
    }
  });

  it("модель знает ровно реальный набор опкодов — без выдуманных", () => {
    // Это тест против той самой рассинхронизации, из-за которой здесь когда-то
    // жили `global.get`/`global.set`/`field.get`/`field.set`/`result.unwrap`/
    // `result.tag`. Сверяемся с `ALL_OPS`, а не с копией списка.
    expect(REAL_OPS).toHaveLength(35);

    // Каждый реальный опкод обязан получить канал и слот.
    for (const op of REAL_OPS) {
      expect(channelsFor(op).length, `нет канала для ${op}`).toBeGreaterThan(0);
      expect(possibleSlots(op).length, `нет слота для ${op}`).toBeGreaterThan(0);
    }

    // И ни один выдуманный опкод не должен быть признан реальным.
    for (const op of [
      "global.get", "global.set", "field.get", "field.set",
      "result.unwrap", "result.tag",
    ]) {
      expect(REAL_OPS, `${op} не должен быть в каноне`).not.toContain(op);
    }
  });
});

describe("latencyScheduler: задержки учитываются", () => {
  const K = (k: number): RawInstruction => ({ op: "const", type: "i32", k }) as RawInstruction;

  /** Цепочка «const → mul → add» без общих ресурсов. */
  const chain: RawInstruction[] = [
    K(0), K(1),
    { op: "mul" } as RawInstruction, // L=4 (fp)
    K(2),
    { op: "add" } as RawInstruction, // int, зависит от mul
  ];

  it("потребитель не выдаётся раньше готовности результата", () => {
    const r = scheduleWithLatency(chain);
    const mulIdx = 2;
    const addIdx = 4;
    const mulPacket = r.packets.find((p) => p.slots.some((s) => s.index === mulIdx))!;
    const addPacket = r.packets.find((p) => p.slots.some((s) => s.index === addIdx))!;
    // mul класса fp: результат готов через 4 такта после выдачи.
    expect(r.readyAt[mulIdx]).toBe(mulPacket.issueAt + 4);
    expect(addPacket.issueAt).toBeGreaterThanOrEqual(r.readyAt[mulIdx]);
  });

  it("вставленные пустые такты видны как nopsBefore", () => {
    const r = scheduleWithLatency(chain);
    expect(r.nopCycles).toBeGreaterThan(0);
    expect(formatSchedule(r)).toContain("nop ");
  });

  it("цепочка из целочисленных операций дешевле цепочки из умножений", () => {
    const intChain: RawInstruction[] = [
      K(0), K(1), { op: "add" } as RawInstruction,
      K(2), { op: "add" } as RawInstruction,
      K(3), { op: "add" } as RawInstruction,
    ];
    const fpChain: RawInstruction[] = [
      K(0), K(1), { op: "mul" } as RawInstruction,
      K(2), { op: "mul" } as RawInstruction,
      K(3), { op: "mul" } as RawInstruction,
    ];
    const a = scheduleWithLatency(intChain);
    const b = scheduleWithLatency(fpChain);
    expect(b.cycles).toBeGreaterThan(a.cycles);
  });

  it("потребитель не выдаётся в том же такте, что и его операнд", () => {
    // ВАЖНОЕ СЛЕДСТВИЕ задержек, которого нет у планировщиков без них.
    //
    // Программа: const#0 const#1 add#2 | const#3 const#4 add#5
    // Оба add зависят от своих const. Даже если add#2 и const#3/#4 попали в
    // один пакет (такт 1), результат const готов только к такту 2 — поэтому
    // add#5 обязан быть выдан в такте 2, а не в такте 1. Слить оба add в один
    // такт можно было бы только перестановкой (перенести const в такт 0), а
    // планировщик сохраняет порядок программы.
    //
    // Здесь проверяется именно правило готовности, а не плотность упаковки.
    const indep: RawInstruction[] = [
      K(0), K(1), { op: "add" } as RawInstruction,
      K(2), K(3), { op: "add" } as RawInstruction,
    ];
    const r = scheduleWithLatency(indep);
    const add2At = r.packets.find((p) => p.slots.some((s) => s.index === 2))!.issueAt;
    const add5At = r.packets.find((p) => p.slots.some((s) => s.index === 5))!.issueAt;
    // const#3/#4 выданы не раньше такта 1 → результат готов к такту 2 → add#5
    // не может быть раньше такта 2.
    expect(add5At).toBeGreaterThanOrEqual(2);
    // И при этом планировщик не выдумывает лишних тактов: ровно на 1 позже.
    expect(add5At).toBe(add2At + 1);
  });

  it("без задержек тот же код упаковался бы плотнее — в этом и разница", () => {
    // Контрольный смысл теста: показываем, что учёт задержек реально влияет на
    // расписание. Программа из шести инструкций занимает 3 такта (без задержек
    // её можно было бы уложить в 2: const-ы в такт 0, add-ы в такт 1).
    const indep: RawInstruction[] = [
      K(0), K(1), { op: "add" } as RawInstruction,
      K(2), K(3), { op: "add" } as RawInstruction,
    ];
    const r = scheduleWithLatency(indep);
    expect(r.cycles).toBe(3);
    expect(r.nopCycles).toBe(0); // такты не пустые — они заняты const-ами
  });

  it("участок завершается, когда готов результат, а не когда выдан пакет", () => {
    // Последняя операция — mul класса Fp (4 такта). Пакет выдаётся в такте 1,
    // результат готов в такте 5 — раньше участок закончиться не может.
    const r = scheduleWithLatency([K(0), K(1), { op: "mul" } as RawInstruction]);
    expect(r.readyAt[2]).toBe(r.packets[1]!.issueAt + 4);
    expect(r.cycles).toBeGreaterThanOrEqual(r.readyAt[2]!);
  });

  it("штраф fp→int даёт разрыв 6 тактов на зависимой паре (стр. 72)", () => {
    // Документ: «задержка от операции muls до операции add составляет 6 тактов:
    // 4 такта собственной длительности mul, и +2 такта передачи результата от
    // вещественной операции до целочисленной».
    const chain: RawInstruction[] = [
      K(0), K(1),
      { op: "mul" } as RawInstruction,
      { op: "add" } as RawInstruction,
    ];
    const r = scheduleWithLatency(chain);
    const mulAt = r.packets.find((p) => p.slots.some((s) => s.op === "mul"))!.issueAt;
    const addAt = r.packets.find((p) => p.slots.some((s) => s.op === "add"))!.issueAt;
    expect(addAt - mulAt).toBe(6);
  });

  it("целочисленная пара платит только 1 такт — штрафа нет", () => {
    const chain: RawInstruction[] = [
      K(0), K(1), { op: "add" } as RawInstruction,
      K(2), { op: "add" } as RawInstruction,
    ];
    const r = scheduleWithLatency(chain);
    const first = r.packets.find((p) => p.slots.some((s) => s.index === 2))!.issueAt;
    const second = r.packets.find((p) => p.slots.some((s) => s.index === 4))!.issueAt;
    expect(second - first).toBe(1);
  });

  it("длительности совпадают с таблицей документа (стр. 71–72)", () => {
    // Калибровка: эти же числа документ показывает в своём примере (стр. 70),
    // где muls даёт «+4 такта», а подготовка возврата — «+6 тактов».
    expect(latencyFor(opClassOf("mul"))).toBe(4);
    expect(latencyFor(opClassOf("add"))).toBe(1);
    expect(latencyFor(opClassOf("div"))).toBe(11);
    expect(latencyFor(opClassOf("obj.get"))).toBe(3);
    expect(latencyFor(opClassOf("ret"))).toBe(6);
    expect(latencyFor(opClassOf("jmp"))).toBe(5);
  });

  it("даже при пустом коде нет деления на ноль в метриках", () => {
    const r = scheduleWithLatency([]);
    expect(r.cpi).toBe(0);
    expect(r.cycles).toBe(0);
  });

  it("все инструкции размещены — ничего не потеряно", () => {
    for (const program of LATENCY_CORPUS) {
      const r = scheduleWithLatency(program.code);
      expect(r.placedSlots, program.name).toBe(program.code.length);
    }
  });
});

describe("latencyScheduler: корпус", () => {
  it("в корпусе есть программы всех трёх классов стоимости", () => {
    const names = LATENCY_CORPUS.map((c) => c.name);
    expect(names).toContain("целочисленная цепочка");
    expect(names).toContain("вещественная цепочка (mul)");
    expect(names).toContain("независимые пары");
  });
});
