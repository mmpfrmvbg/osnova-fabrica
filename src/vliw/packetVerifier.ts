/**
 * Верификатор VLIW-пакетов: оракул для упаковки.
 *
 * ## Задача
 *
 * Модель задержек говорит, какие инструкции **могут** стоять рядом по времени.
 * Но пакет — не только время. Слоты пакета исполняются на одной широкой команде,
 * и часть комбинаций аппаратно недопустима. Этот верификатор отвергает пакет
 * **до** того, как он попадёт в VM.
 *
 * ## Почему он появился
 *
 * Упаковка по времени выдачи (`issueAt`) один раз сломала эквивалентность:
 * `while.osnova` дала `49` вместо `1049`. Расхождение обнаружилось только по
 * результату прогона — то есть после того, как нелегальный пакет уже был
 * исполнен. Верификатор переносит обнаружение на шаг раньше: он проверяет
 * **структуру** пакета, не исполняя её.
 *
 * Порядок работы был обратный обычному: сначала написан
 * `packetVerifier.test.ts` (5 позитивных, 5 негативных случаев), он падал,
 * и лишь затем появился этот файл.
 *
 * ## Проверяемые инварианты
 *
 * 1. **RAW** — потребитель читает регистр, который производитель в том же пакете
 *    пишет. В e2k результат операции виден со следующего пакета, поэтому внутри
 *    пакета такой пары быть не должно.
 * 2. **WAR** — запись в регистр, который в том же пакете кто-то читает.
 * 3. **WAW** — две записи в один регистр: какое значение победит, не определено.
 * 4. **BRANCH** — больше одной передачи управления. VM покидает пакет при
 *    передаче управления, поэтому остальные слоты не исполнятся. В набор
 *    входят `jmp*`, `call`, `ret`, `throw` (см. {@link isBranchInstruction}).
 * 5. **Слоты** — пакет шире машины.
 * 6. **Совместимость** — операция занимает слот, который её не поддерживает
 *    (например, деление умеет только АЛУ5, стр. 56 руководства МЦСТ).
 *
 * Дополнительно: терминатор обязан быть **последним** в пакете — иначе слоты
 * после него не исполнятся.
 *
 * ## Граница применимости (важно)
 *
 * Верификатор проверяет **структуру** пакета. Он НЕ проверяет два инварианта,
 * которые нельзя восстановить из упакованного модуля:
 *
 * 1. **Цель перехода не внутри пакета.** В упакованном коде `off` — индекс
 *    элемента, а не инструкции, поэтому информация «какая именно инструкция
 *    была целью» теряется. Гарантировать это обязан упаковщик: инструкция-цель
 *    и первая инструкция процедуры обязаны открывать пакет (слот 0).
 * 2. **Порядок инструкций внутри пакета.** Если пакет собран не в том порядке,
 *    `RAW`/`WAR`/`WAW` этого не покажут, а результат изменится.
 *
 * Оба инварианта закрываются упаковщиком `packInstructions`, а не здесь.
 */

import {
  isRegPacket,
  type RegCodeElement,
  type RegInstruction,
  type RegModule,
} from "../runtime/vm/regcode";
import { regInstructionDef, regInstructionUses } from "./regGraph";

/**
 * Модель машины, по которой проверяется пакет.
 *
 * Отдельный тип, а не прямая зависимость от `e2kDevices`, чтобы верификатор
 * можно было тестировать на **произвольной** модели (например, на машине с
 * одним слотом или с 24 слотами), не подстраивая тесты под реальный e2k.
 */
export interface MachineModel {
  /** Сколько слотов в одной широкой команде. */
  slots: number;
  /**
   * В какие слоты может лечь операция.
   *
   * Возвращает индексы слотов (0..slots-1). Пустой массив означает «операция
   * не поддержана машиной» — это тоже нарушение.
   */
  possibleSlots: (op: string) => number[];
}

/** Результат проверки: либо всё хорошо, либо конкретная причина с позицией. */
export type VerifyResult = { ok: true } | { ok: false; reason: string; at: number };

/**
 * Производит ли инструкция передачу управления.
 *
 * Такие инструкции обязаны быть последними в пакете и единственными: VM
 * покидает пакет при передаче управления и остальные слоты не исполняет.
 *
 * ## Почему здесь `call` (дефект, найденный диагностикой)
 *
 * Первая версия этого набора содержала `jmp*`, `ret` и `throw`, но **не
 * `call`**. Этого хватило, чтобы упаковка по `issueAt` прошла верификатор и
 * сломала эквивалентность: `while.osnova` дала `49` вместо `1049`.
 *
 * Факты из VM (`src/runtime/vm/reginterpreter.ts`):
 * - `case "call"` возвращает `callee.codeOffset`, а не `next`;
 * - `executeElement` покидает пакет, когда `next !== packetPc + 1`;
 * - `returnPc` вызываемого равен `packetPc + 1`, поэтому остаток пакета не
 *   исполняется ни в этот раз, ни после возврата.
 *
 * Измерено на реальном дефекте: `call` в слоте 0 и `move d=6 a=0` в слоте 1 —
 * потеряна ровно одна инструкция, шагов `249 → 248`, результат `1049 → 49`.
 *
 * `invoke` и `try_begin` передачей управления НЕ являются: оба возвращают
 * `next`, пакет после них продолжается.
 */
export function isBranchInstruction(ins: RegInstruction): boolean {
  switch (ins.op) {
    case "jmp":
    case "jmp_if":
    case "jmp_if_not":
    case "call":
    case "ret":
    case "throw":
      return true;
    default:
      return false;
  }
}

/**
 * Проверить все пакеты модуля.
 *
 * @param module регистровый модуль (проверяются только элементы `packet`)
 * @param model модель машины: число слотов и совместимость операций
 * @returns `{ ok: true }` либо первое нарушение с причиной и индексом элемента
 */
export function verifyPackets(module: RegModule, model: MachineModel): VerifyResult {
  for (let at = 0; at < module.code.length; at++) {
    const el: RegCodeElement = module.code[at]!;
    if (!isRegPacket(el)) continue;
    const bad = verifyOnePacket(el.slots, model, at);
    if (bad !== null) return bad;
  }
  return { ok: true };
}

/** Нарушение пакета: причина без позиции (позицию добавляет {@link verifyOnePacket}). */
export type PacketProblem = { reason: string } | null;

/** 5. Ширина пакета. */
export function verifyWidth(slots: readonly RegInstruction[], model: MachineModel): PacketProblem {
  if (slots.length > model.slots) {
    return { reason: `пакет шире машины: слотов ${slots.length}, а машина допускает ${model.slots}` };
  }
  return null;
}

/**
 * 4. Передача управления.
 *
 * Проверяется ДО совместимости слотов. Почему раньше: пакет из двух передач
 * управления нелегален сразу, независимо от раскладки по слотам. Если проверять
 * слоты первыми, точная причина («больше одной передачи управления») подменяется
 * менее точной («слот занят»). Точность причины важна: по ней ищут дефект.
 */
export function verifyControlTransfer(slots: readonly RegInstruction[]): PacketProblem {
  const branchPositions: number[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (isBranchInstruction(slots[i]!)) branchPositions.push(i);
  }
  if (branchPositions.length > 1) {
    return {
      reason:
        `BRANCH: в пакете ${branchPositions.length} передачи управления ` +
        `(слоты ${branchPositions.join(", ")}) — VM покинет пакет после первой`,
    };
  }
  if (branchPositions.length === 1 && branchPositions[0] !== slots.length - 1) {
    return {
      reason:
        `BRANCH: передача управления «${slots[branchPositions[0]!]!.op}» в слоте ` +
        `${branchPositions[0]} не последняя — VM покинет пакет и слоты после неё ` +
        `не исполнятся`,
    };
  }
  return null;
}

/**
 * 6. Совместимость со слотами: существует ли раскладка инструкций по слотам,
 * при которой каждая занимает допустимый слот.
 *
 * Пакет НЕ несёт номеров слотов — в формате `.osvreg` это только массив
 * `slots`. Поэтому проверяется не «инструкция i стоит в слоте i», а
 * существование корректного назначения. Раскладка — жадная, от самой узкой
 * допустимой множества к самой широкой: так пары вроде «const (слот 0) и
 * div (только слот 0)» обнаруживаются как конфликт.
 *
 * Жадность здесь достаточна: у нас не задача о паросочетаниях общего вида, а
 * множества слотов из небольшого числа групп (АЛУ / ветвление / память).
 */
export function verifySlotAssignment(
  slots: readonly RegInstruction[],
  model: MachineModel,
): PacketProblem {
  const order = slots
    .map((ins, i) => ({ ins, i }))
    .sort((a, b) => {
      const la = model.possibleSlots(a.ins.op).length;
      const lb = model.possibleSlots(b.ins.op).length;
      if (la !== lb) return la - lb; // узкие — первыми
      return a.i - b.i; // детерминизм
    });

  const occupied = new Set<number>();
  for (const { ins, i } of order) {
    const allowed = model.possibleSlots(ins.op);
    if (allowed.length === 0) {
      return { reason: `операция «${ins.op}» (слот ${i}) не поддержана машиной: possibleSlots пуст` };
    }
    const free = allowed.find((s) => s >= 0 && s < model.slots && !occupied.has(s));
    if (free === undefined) {
      return {
        reason:
          `операция «${ins.op}» (слот ${i}) не помещается: ` +
          `машина допускает слоты [${allowed.join(", ")}], но все они заняты ` +
          `другими инструкциями пакета`,
      };
    }
    occupied.add(free);
  }
  return null;
}

/**
 * 1–3. Регистры внутри пакета: RAW, WAR, WAW.
 *
 * Значения видны со следующего пакета, поэтому внутри пакета инструкции обязаны
 * быть независимы по регистрам.
 */
export function verifyRegisters(slots: readonly RegInstruction[]): PacketProblem {
  /** Регистры, которые уже прочитаны в этом пакете. */
  const read = new Set<number>();
  /** Регистры, которые уже записаны в этом пакете. */
  const written = new Set<number>();

  for (let i = 0; i < slots.length; i++) {
    const ins = slots[i]!;
    const op = ins.op;
    const uses = regInstructionUses(ins);
    const def = regInstructionDef(ins);

    // 1. RAW: читаем то, что уже записано в этом пакете.
    for (const r of uses) {
      if (written.has(r)) {
        return {
          reason:
            `RAW внутри пакета: слот ${i} («${op}») читает регистр ${r}, ` +
            `который в этом же пакете записан раньше — значение станет видно ` +
            `только со следующего пакета`,
        };
      }
    }
    // 2. WAR: пишем то, что в этом пакете кто-то читает.
    if (def !== undefined && read.has(def)) {
      return {
        reason:
          `WAR внутри пакета: слот ${i} («${op}») пишет регистр ${def}, ` +
          `который в этом же пакете уже прочитан раньше`,
      };
    }
    // 3. WAW: две записи в один регистр.
    if (def !== undefined && written.has(def)) {
      return {
        reason:
          `WAW внутри пакета: слот ${i} («${op}») пишет регистр ${def}, ` +
          `который в этом же пакете уже записан — какое значение победит, не определено`,
      };
    }

    for (const r of uses) read.add(r);
    if (def !== undefined) written.add(def);
  }
  return null;
}

/** Проверки пакета в порядке применения. Единственный источник истины. */
export const PACKET_CHECKS: ReadonlyArray<
  (slots: readonly RegInstruction[], model: MachineModel) => PacketProblem
> = [
  (slots, model) => verifyWidth(slots, model),
  (slots) => verifyControlTransfer(slots),
  (slots, model) => verifySlotAssignment(slots, model),
  (slots) => verifyRegisters(slots),
];

/**
 * Проверить один пакет.
 *
 * Вынесено отдельно, чтобы упаковщик мог спрашивать «можно ли добавить вот эту
 * инструкцию к уже набранному пакету» без сборки целого модуля.
 */
export function verifyOnePacket(
  slots: readonly RegInstruction[],
  model: MachineModel,
  at = 0,
): VerifyResult | null {
  for (const check of PACKET_CHECKS) {
    const problem = check(slots, model);
    if (problem !== null) return { ok: false, reason: problem.reason, at };
  }
  return null;
}

/**
 * Легален ли пакет (удобная обёртка для упаковщика).
 *
 * @returns `null`, если пакет легален; иначе причина
 */
export function packetProblem(
  slots: readonly RegInstruction[],
  model: MachineModel,
): string | null {
  const r: VerifyResult | null = verifyOnePacket(slots, model, 0);
  if (r === null) return null;
  return r.ok ? null : r.reason;
}
