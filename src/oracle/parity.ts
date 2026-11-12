/**
 * Дифференциальный оракул: один `.osnova` — две VM, сверка трасс.
 *
 * Канон проекта: оракул на каждый слой. Стековая VM — эталон; регистровая
 * принимается ровно тогда, когда её наблюдения совпадают с эталоном. Сравнивается
 * **трасса** (последовательность вызовов хоста), а не только итоговое значение:
 * одинаковый ответ при разной последовательности вызовов — это расхождение
 * поведения, которое golden-проверка не видит.
 *
 * Обе VM получают **одну и ту же** фабрику хоста (у каждой свой экземпляр), один
 * и тот же расширенный AST (`CompileResult.moduleAst`) и один и тот же индекс
 * точки входа. Так расхождение указывает на кодоген или интерпретатор, а не на
 * разную настройку прогонов.
 *
 * @remarks
 * Трасса ограничена тем, что наблюдаемо в **обеих** VM: вызовы хоста плюс
 * возврат точки входа. Внутренние возвраты из вложенных процедур стековая VM
 * наружу не отдаёт, поэтому и регистровая их в трассу не пишет — иначе оракул
 * сравнивал бы разные определения трассы, а не поведение.
 */

import { compileSource, type CompileError } from "../compiler/compiler";
import { compileToReg, RegCodegenError } from "../compiler/regcodegen";
import { createDefaultInvokeHandler, VM, type InvokeHandler, type StackValue } from "../runtime/vm/interpreter";
import { RegVM } from "../runtime/vm/reginterpreter";
import type { RegModule } from "../runtime/vm/regcode";

/** Шаг наблюдения в общей форме: и стековая, и регистровая VM дают такой. */
export type ParityStep =
  | { kind: "invoke"; name: string; args: StackValue[] }
  | { kind: "return"; value: StackValue | undefined };

export interface ParityOptions {
  /** Имя процедуры точки входа; по умолчанию — `главная`/`main`/0. */
  entryProcedure?: string;
  /** Аргументы точки входа. */
  args?: StackValue[];
  /** Фабрика хоста. По умолчанию — `createDefaultInvokeHandler()` (свой экземпляр на бэкенд). */
  invokeFactory?: () => InvokeHandler;
  /** Хост-вызовы вне реестра `система.*` (имя + argc). */
  extraInvokes?: ReadonlyArray<{ name: string; argc: number }>;
  /** Лимит инструкций на бэкенд. */
  maxSteps?: number;
  /** Независимое от VM ожидание результата (оракул оракула). */
  expectedReturn?: StackValue;
}

/**
 * Исход сверки. Отдельные статусы нужны потому, что «обе VM упали одинаково» —
 * это не паритет: одинаковое падение ничего не доказывает о совпадении
 * поведения. Раньше такой случай возвращал `ok: true` и маскировал отсутствие
 * проверки (см. `docs/vliw-phases-plan.md`, Фаза 1).
 */
export type ParityStatus =
  | "ok"
  | "diverged"
  | "expectation_failed"
  | "both_failed"
  | "both_hit_step_limit";

export type ParityResult = {
  /** `true` только при `status === "ok"`. */
  ok: boolean;
  status: ParityStatus;
  /** Индекс первого расхождения в трассе; `-1` — расходится только итог. */
  divergenceIndex: number;
  stackValue: StackValue | undefined;
  regValue: StackValue | undefined;
  stackTrace: ParityStep[];
  regTrace: ParityStep[];
  message: string;
  /** Итог, отличный от `expectedReturn` (если он задан). */
  expectationFailed: boolean;
};

/** Исходник вне среза регистрового бэкенда — не ошибка, просто ещё не поддержано. */
export interface ParitySkip {
  skipped: true;
  reason: string;
}

function describeStep(step: ParityStep | undefined): string {
  if (!step) return "<шага нет>";
  if (step.kind === "invoke") {
    return `invoke ${step.name}(${step.args.map(jsonOf).join(", ")})`;
  }
  return `return ${jsonOf(step.value)}`;
}

function jsonOf(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "undefined" : json;
}

/** Разрешение точки входа: как в `OsVbcVM.resolveProcedureIndex`. */
export function resolveEntryIndex(
  procedures: ReadonlyArray<{ name: string }>,
  entryProcedure?: string,
): number {
  if (entryProcedure !== undefined && entryProcedure !== "") {
    const i = procedures.findIndex((p) => p.name === entryProcedure);
    if (i < 0) throw new Error(`parity: процедура не найдена: ${entryProcedure}`);
    return i;
  }
  for (const name of ["главная", "main"]) {
    const i = procedures.findIndex((p) => p.name === name);
    if (i >= 0) return i;
  }
  if (procedures.length === 0) throw new Error("parity: модуль без процедур");
  return 0;
}

/**
 * Сверка стековой и регистровой VM на одном исходнике.
 *
 * @returns результат сверки или {@link ParitySkip}, если программа вне среза
 *          регистрового бэкенда.
 */
export async function runParity(
  source: string,
  options: ParityOptions = {},
): Promise<ParityResult | ParitySkip> {
  // Компилируется СТРОКА, переданная вызывающим: файла нет, каталога нет,
  // импортов такая строка не несёт (импорты разворачиваются ДО вызова parity —
  // сюда приходит уже развёрнутый источник). Поэтому `filename` и `baseDir` не
  // передаются намеренно, а не забыты (аудит `.tmp/call-sites-audit.ts`).
  // Имя модуля для parity не значимо: сверяются трассы, а не имена.
  const stackCompiled = compileSource(source);
  if (!stackCompiled.module || !stackCompiled.moduleAst) {
    throw new Error(
      `parity: исходник не компилируется (${formatCompileErrors(stackCompiled)})`,
    );
  }

  // Регистровый кодоген получает **тот же** расширенный AST, что ушёл в
  // стековый: типы и `когда` развёрнуты компилятором, а не оракулом.
  let regModule: RegModule;
  try {
    regModule = compileToReg(stackCompiled.moduleAst);
  } catch (e) {
    if (e instanceof RegCodegenError) {
      return { skipped: true, reason: e.message };
    }
    throw e;
  }

  const entryIndex = resolveEntryIndex(
    stackCompiled.module.procedures,
    options.entryProcedure,
  );
  const regEntry = regModule.procedures[entryIndex];
  if (!regEntry) {
    throw new Error(
      `parity: в регистровом модуле нет процедуры с индексом ${entryIndex}`,
    );
  }

  const invokeFactory = options.invokeFactory ?? createDefaultInvokeHandler;
  const stackTrace: ParityStep[] = [];
  const regTrace: ParityStep[] = [];
  const maxSteps = options.maxSteps ?? 1_000_000;
  const args = options.args ?? [];

  const stackInvoke = invokeFactory();
  const stackVm = new VM(stackCompiled.module, {
    invoke: (name, a) => {
      stackTrace.push({ kind: "invoke", name, args: a.slice() });
      return stackInvoke(name, a);
    },
    maxSteps,
    extraInvokes: options.extraInvokes,
  });

  const regInvoke = invokeFactory();
  const regVm = new RegVM(regModule, {
    invoke: (name, a) => {
      regTrace.push({ kind: "invoke", name, args: a.slice() });
      return regInvoke(name, a);
    },
    maxSteps,
    extraInvokes: options.extraInvokes,
  });

  let stackValue: StackValue | undefined;
  let regValue: StackValue | undefined;
  let stackError: string | null = null;
  let regError: string | null = null;

  try {
    stackValue = await stackVm.runProcedure(entryIndex, args.slice());
  } catch (e) {
    stackError = errorText(e);
  }
  try {
    regValue = await regVm.runProcedure(entryIndex, args.slice());
  } catch (e) {
    regError = errorText(e);
  }

  // Обе VM наблюдают возврат точки входа одинаковой формой (`undefined`, если
  // процедура завершилась без значения) — это и есть последний шаг трассы.
  stackTrace.push({ kind: "return", value: stackValue });
  regTrace.push({ kind: "return", value: regValue });

  const expectationFailed =
    options.expectedReturn !== undefined &&
    !Object.is(stackValue, options.expectedReturn);

  const finish = (
    ok: boolean,
    divergenceIndex: number,
    message: string,
    status: ParityStatus,
  ): ParityResult => ({
    ok,
    status,
    divergenceIndex,
    stackValue,
    regValue,
    stackTrace,
    regTrace,
    message,
    expectationFailed,
  });

  if (stackError !== null || regError !== null) {
    if (stackError !== null && regError !== null) {
      // Обе VM упали — это НЕ паритет: одинаковое падение ничего не доказывает
      // о совпадении поведения. Раньше здесь возвращалось `ok: true`, из-за чего
      // три фикстуры из восьми «проходили», ни разу не выполнившись.
      const bothHitLimit = isStepLimit(stackError) && isStepLimit(regError);
      return finish(
        false,
        -1,
        `обе VM упали с ошибкой — стековая «${stackError}», регистровая «${regError}»`,
        bothHitLimit ? "both_hit_step_limit" : "both_failed",
      );
    }
    return finish(
      false,
      0,
      stackError !== null
        ? `стековая VM упала: ${stackError}; регистровая вернула ${jsonOf(regValue)}`
        : `регистровая VM упала: ${regError}; стековая вернула ${jsonOf(stackValue)}`,
      "diverged",
    );
  }

  const n = Math.max(stackTrace.length, regTrace.length);
  for (let i = 0; i < n; i++) {
    if (!sameStep(stackTrace[i], regTrace[i])) {
      return finish(
        false,
        i,
        `расхождение трасс на шаге ${i}: стековая «${describeStep(stackTrace[i])}», ` +
          `регистровая «${describeStep(regTrace[i])}»`,
        "diverged",
      );
    }
  }

  if (!Object.is(stackValue, regValue)) {
    if (!sameValue(stackValue, regValue)) {
      return finish(
        false,
        -1,
        `значения разошлись: стековая ${jsonOf(stackValue)}, регистровая ${jsonOf(regValue)}`,
        "diverged",
      );
    }
  }

  if (expectationFailed) {
    return finish(
      false,
      -1,
      `оба бэкенда дали ${jsonOf(stackValue)}, но ожидалось ${jsonOf(options.expectedReturn)}`,
      "expectation_failed",
    );
  }

  return finish(
    true,
    -1,
    `совпало: ${jsonOf(stackValue)} (трасса ${stackTrace.length} шагов)`,
    "ok",
  );
}

/** Падение по лимиту шагов: обе VM не завершились — это не паритет. */
function isStepLimit(message: string): boolean {
  return /max steps/i.test(message);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sameStep(a: ParityStep | undefined, b: ParityStep | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "invoke" && b.kind === "invoke") {
    return a.name === b.name && sameArgs(a.args, b.args);
  }
  if (a.kind === "return" && b.kind === "return") {
    return sameValue(a.value, b.value);
  }
  return false;
}

/**
 * Равенство значений двух VM.
 *
 * `Object.is` ловит скаляры, `NaN` и `-0`, но объекты — это ссылки: две VM
 * строят **разные** объекты с одинаковым содержимым (у каждой свой кадр и свой
 * вывод хоста), поэтому сравниваем ещё и по структуре.
 */
function sameValue(a: StackValue | undefined, b: StackValue | undefined): boolean {
  if (Object.is(a, b)) return true;
  return shallowJsonEqual(a, b);
}

function sameArgs(a: StackValue[], b: StackValue[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => sameValue(v, b[i]));
}

function shallowJsonEqual(a: StackValue | undefined, b: StackValue | undefined): boolean {
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function formatCompileErrors(result: ReturnType<typeof compileSource>): string {
  const all: CompileError[] = [
    ...result.lexerErrors.map((e) => ({ message: e.message, line: e.line, column: e.column })),
    ...result.parserErrors.map((e) => ({ message: e.message })),
    ...result.compilerErrors,
  ];
  return all.map((e) => e.message).join("; ") || "неизвестная ошибка";
}
