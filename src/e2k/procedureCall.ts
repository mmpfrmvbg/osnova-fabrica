/**
 * ВЫЗОВ ПРОЦЕДУРЫ И ВОЗВРАТ ИЗ НЕЁ: КТО КОГО ЗОВЁТ И КУДА ВОЗВРАЩАЕТСЯ.
 *
 * # Зачем отдельный модуль
 *
 * До него конвейер цели знал ровно одну процедуру: точка входа — начало образа, а «возврат» —
 * это `exit` с кодом. Отсюда три упора, названные замером (`.tmp/osnova-call-gap.ts`):
 *
 * | упор | чем измерен |
 * |---|---|
 * | `IR.call` отказывает: «не передано смещение вызова» (`OSN-LOW-004`) | цель вызова — адрес первой команды вызываемой, а он известен только ПОСЛЕ раскладки |
 * | обвязка отказывает: «возвратов со значением больше одного» | `IR.ret` не понижался вовсе: результат уходил в регистр, который читает `exit` |
 * | площадка печати кончается на третьем вызове | развёртка печати вставляется по месту: 1432 байта на КАЖДЫЙ вызов |
 *
 * # Что здесь считается
 *
 * | вопрос | ответ |
 * |---|---|
 * | кто точка входа | `главная`/`main` — тем же правилом, что у VM (`resolveEntryIndex`) |
 * | какой процедуре принадлежит носитель | по смещениям процедур: последняя, чьё смещение ≤ индекса |
 * | куда вернуться | `return %ctpr3`: адрес возврата кладёт сам `call` (приём соглашения, §7.10) |
 * | куда звать | адрес первой команды вызываемой **после раскладки** — тем же способом, что цель перехода |
 *
 * # Переход к точке входа вместо «первой процедуры»
 *
 * Образ начинается с пролога, а не с процедуры: точка входа может стоять в модуле где угодно
 * (у `08-факториал` первой идёт `факториал`). Поэтому в начало образа встаёт **переход** к точке
 * входа — `IR.jmp`, тот же носитель, что у циклов, и раскладка считает его смещение сама
 * (`secondPass`). Переход, а не `call`: `call` сужает окно вызываемой (`wbs = 4`), а точка входа
 * обязана работать в полном окне входа — шестнадцать регистров (`WINDOW_REGISTERS_ENTRY`).
 *
 * # Границы, названные здесь
 *
 * 1. **Глубина вложенных вызовов ограничена окном.** `call wbs = 4` уменьшает `size_q` на 4,
 *    поэтому вызываемая получает `2*(size_q − 4)` регистров, а её собственный вызов — ещё на 4
 *    меньше. При паспортной геометрии (`size_q = 8`) вызываемая получает восемь регистров
 *    (`src/e2k/regAlloc.ts#WINDOW_REGISTERS_CALLEE`), и **вложенный вызов из неё невозможен**:
 *    аргументы кладутся в `%r(2*wbs + i)` вызывающего, то есть в `%r8` вызываемой, которого у неё
 *    нет. Это измерено оракулом окна (`src/e2k/e2kCallWindowQemu.test.ts`) и перемеряется здесь
 *    пробой `.tmp/osnova-call-depth.ts`, а не предполагается.
 * 2. **Системный вызов из вызываемой невозможен по той же причине:** номер вызова идёт в `%r8`.
 *    Поэтому печать целиком в процедуру не выносится — выносится её разделяемая часть
 *    (см. `src/e2k/printCall.ts`).
 */
import type { AsmInstruction, Operand } from './backend';
import { isJumpCarrier } from './twoPassLayout';
import { LOWERING_CODES, type LoweringRefusalCode } from './loweringRefusal';
import { resolveEntryIndex } from '../oracle/parity';

const imm = (value: number): Operand => ({ kind: 'imm', value });

/** Смещение процедуры в потоке носителей (`codeOffset`) и её имя. */
export interface ProcedureOffset {
  readonly name: string;
  readonly codeOffset: number;
}

/**
 * Точка входа по имени: `главная`, затем `main`, иначе первая процедура.
 *
 * Правило берётся у VM (`src/oracle/parity.ts#resolveEntryIndex`), а не заводится своё: две
 * разные точки входа в одном дереве — это два разных ответа на вопрос «что исполнится».
 */
export function entryProcedureIndex(procedures: readonly ProcedureOffset[]): number {
  if (procedures.length === 0) return 0;
  return resolveEntryIndex(procedures.map((procedure) => ({ name: procedure.name })));
}

/** Номер процедуры, которой принадлежит носитель: последняя, чьё смещение не больше индекса. */
export function procedureAt(procedures: readonly ProcedureOffset[], index: number): number | undefined {
  let found: number | undefined;
  procedures.forEach((procedure, at) => {
    if (procedure.codeOffset <= index) found = at;
  });
  return found;
}

/**
 * Пролог исполнения: переход к точке входа, если та стоит не первой.
 *
 * Возвращает поток и смещения процедур В НОВЫХ индексах: переход занимает нулевой индекс, поэтому
 * все цели переходов и все смещения процедур сдвигаются на единицу. Сдвиг делается здесь, а не в
 * раскладке: раскладка обязана видеть поток, в котором цели уже верны (`docs/hardware-debt.md` §3.35 —
 * ровно этот класс дефекта стоил примера 17).
 */
export function withEntryJump(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
): { code: readonly AsmInstruction[]; procedures: readonly ProcedureOffset[]; added: boolean } {
  if (procedures.length <= 1) return { code, procedures, added: false };
  const entry = entryProcedureIndex(procedures);
  const entryOffset = procedures[entry]!.codeOffset;
  if (entryOffset === 0) return { code, procedures, added: false };

  const shifted = code.map((carrier) => {
    if (!isJumpCarrier(carrier.mnemonic)) return carrier;
    const targetAt = carrier.mnemonic === 'IR.jmp' ? 0 : 1;
    const target = carrier.operands[targetAt];
    if (target === undefined || target.kind !== 'imm') return carrier;
    const operands = [...carrier.operands];
    operands[targetAt] = imm(target.value + 1);
    return { ...carrier, operands };
  });
  const jump: AsmInstruction = { mnemonic: 'IR.jmp', channel: 0, operands: [imm(entryOffset + 1)] };
  return {
    code: [jump, ...shifted],
    procedures: procedures.map((procedure) => ({ ...procedure, codeOffset: procedure.codeOffset + 1 })),
    added: true,
  };
}

/** Отказ вычисления адреса вызова: номер носителя, код и причина. */
export interface CallProblem {
  readonly index: number;
  readonly code: LoweringRefusalCode;
  readonly reason: string;
}

/** Что осталось от подготовки потока: носители, процедуры и выход точки входа. */
export interface PreparedImage {
  readonly code: readonly AsmInstruction[];
  readonly procedures: readonly ProcedureOffset[];
  /** Регистр значения возврата точки входа: её выход — `exit(значение)`, а не `return`. */
  readonly entryReturnRegister?: number;
  /**
   * Индексы носителей, которые в образ НЕ ПОПАДАЮТ: возвраты точки входа.
   *
   * Их место занимает её `exit(значение)`, поэтому и раскладка обязана считать их нулевыми —
   * иначе она резервирует байты под то, чего в образе нет, и адреса всего, что стоит дальше,
   * уезжают (класс дефекта `docs/hardware-debt.md` §3.35). Цели переходов при этом не ломаются:
   * переход, ведший на такой возврат (выход из цикла идёт в конец процедуры), ведёт на адрес
   * СЛЕДУЮЩЕГО носителя — то есть туда же, куда шло исполнение.
   */
  readonly zeroSize: readonly number[];
  /** Индекс носителя, НАЧИНАЯ с которого в потоке нет носителей точки входа (её выход ставится здесь). */
  readonly entryEndsAt: number;
  readonly addedEntryJump: boolean;
}

/**
 * ПОДГОТОВИТЬ ПОТОК К ОБРАЗУ: назвать возвраты точки входа нулевыми и поставить переход к ней.
 *
 * Возврат точки входа НЕ ИСПОЛНЯЕТСЯ — её выход это `exit(значение)` (так было и раньше, и так
 * остаётся: результат точки входа уходит кодом возврата процесса). Но раскладка считала его форму
 * и резервировала байты, которых в образе не будет, — а теперь, когда процедур несколько, это
 * сдвигало адреса ВСЕХ последующих процедур. Здесь эти носители помечаются нулевыми, и раскладка
 * видит ровно тот поток, который соберётся.
 */
export function prepareImage(
  code: readonly AsmInstruction[],
  procedures: readonly ProcedureOffset[],
): PreparedImage {
  const entryAt = procedures.length === 0 ? 0 : entryProcedureIndex(procedures);
  const entry = procedures[entryAt];

  // 1. Возвраты точки входа — нулевые; её значение запоминается (первое со значением).
  let entryReturnRegister: number | undefined;
  const zeroSizeBeforeJump: number[] = [];
  code.forEach((carrier, index) => {
    if (carrier.mnemonic !== 'IR.ret') return;
    if (procedures.length > 0 && (procedureAt(procedures, index) ?? 0) !== entryAt) return;
    const flag = carrier.operands[0];
    const value = carrier.operands[1];
    if (entryReturnRegister === undefined && flag?.kind === 'imm' && flag.value === 1 && value?.kind === 'reg') {
      entryReturnRegister = value.index;
    }
    zeroSizeBeforeJump.push(index);
  });

  // 2. Переход к точке входа, если та стоит не первой (она может стоять где угодно в модуле).
  const entryOffset = entry?.codeOffset ?? 0;
  const addJump = procedures.length > 1 && entryOffset !== 0;
  const shift = addJump ? 1 : 0;
  const remapped: AsmInstruction[] = code.map((carrier) => {
    if (!isJumpCarrier(carrier.mnemonic)) return carrier;
    const targetAt = carrier.mnemonic === 'IR.jmp' ? 0 : 1;
    const target = carrier.operands[targetAt];
    if (target === undefined || target.kind !== 'imm') return carrier;
    const operands = [...carrier.operands];
    operands[targetAt] = imm(target.value + shift);
    return { ...carrier, operands };
  });
  const jump: AsmInstruction = { mnemonic: 'IR.jmp', channel: 0, operands: [imm(entryOffset + shift)] };
  const finalCode = addJump ? [jump, ...remapped] : remapped;
  const finalProcedures = procedures.map((procedure) => ({
    ...procedure,
    codeOffset: procedure.codeOffset + shift,
  }));
  const nextProcedure = finalProcedures
    .map((procedure) => procedure.codeOffset)
    .filter((offset) => offset > entryOffset + shift)
    .sort((a, b) => a - b)[0];

  return {
    code: finalCode,
    procedures: finalProcedures,
    ...(entryReturnRegister === undefined ? {} : { entryReturnRegister }),
    zeroSize: zeroSizeBeforeJump.map((index) => index + shift),
    entryEndsAt: nextProcedure ?? finalCode.length,
    addedEntryJump: addJump,
  };
}

/** Что нужно, чтобы посчитать смещение вызова: адреса раскладки и форма носителя. */
export interface CallAddressOptions {
  readonly code: readonly AsmInstruction[];
  readonly procedures: readonly ProcedureOffset[];
  /** Адреса размещённых носителей: индекс → адрес (`LayoutTable.addresses`). */
  readonly addresses: ReadonlyMap<number, number>;
  /** Сколько байт занимает команда `disp` внутри носителя вызова — до неё идут пересылки аргументов. */
  readonly dispOffsetOf: (index: number) => number | undefined;
}

/**
 * Смещения вызовов после раскладки — цель вызова это тот же класс, что цель перехода.
 *
 * `disp` считается в восьмибайтных единицах от адреса САМОЙ команды `disp` (за ней идут только
 * `call` и чтение результата, поэтому «адрес носителя» и «адрес `disp`» — разные числа, и разницу
 * даёт форма носителя, а не догадка).
 */
export function callAddresses(
  options: CallAddressOptions,
): { readonly displacements: ReadonlyMap<number, number>; readonly problems: readonly CallProblem[] } {
  const displacements = new Map<number, number>();
  const problems: CallProblem[] = [];
  options.code.forEach((carrier, index) => {
    if (carrier.mnemonic !== 'IR.call') return;
    const payload = carrier.operands[3];
    if (payload === undefined || payload.kind !== 'imm') {
      problems.push({
        index,
        code: LOWERING_CODES.carrier,
        reason: '«IR.call»: цель не выражена числом — индекс процедуры потерян',
      });
      return;
    }
    const callee = options.procedures[payload.value];
    if (callee === undefined) {
      problems.push({
        index,
        code: LOWERING_CODES.carrier,
        reason: `«IR.call»: в таблице процедур нет записи с индексом ${String(payload.value)} (всего ${String(options.procedures.length)})`,
      });
      return;
    }
    const callAddress = options.addresses.get(index);
    const targetAddress = options.addresses.get(callee.codeOffset);
    if (callAddress === undefined || targetAddress === undefined) {
      problems.push({
        index,
        code: LOWERING_CODES.noForm,
        reason:
          `«IR.call» → «${callee.name}»: ${callAddress === undefined ? 'носитель вызова не размещён' : `первая команда вызываемой (#${String(callee.codeOffset)}) не размещена`}` +
          ' — адрес цели неизвестен',
      });
      return;
    }
    const dispOffset = options.dispOffsetOf(index);
    if (dispOffset === undefined) {
      problems.push({
        index,
        code: LOWERING_CODES.carrier,
        reason: '«IR.call»: в форме носителя нет команды `disp` — смещение считать не от чего',
      });
      return;
    }
    const delta = targetAddress - (callAddress + dispOffset);
    if (delta % 8 !== 0) {
      problems.push({
        index,
        code: LOWERING_CODES.layout,
        reason: `«IR.call» → «${callee.name}»: разность адресов ${String(delta)} не кратна 8 — смещение выражается только в восьмибайтных словах`,
      });
      return;
    }
    displacements.set(index, delta / 8);
  });
  return { displacements, problems };
}
