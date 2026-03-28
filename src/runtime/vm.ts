/**
 * Высокоуровневая обёртка над Interpreter для выполнения одного модуля (.osvbc):
 * точка входа execute(), последнее возвращаемое значение getReturnValue(),
 * глобальный контекст хоста и прокси для внешних вызовов (invoke / native).
 *
 * @remarks
 * ### Интеграция VM ↔ агенты (пайплайн)
 *
 * **Поток данных IntakeAgent → spec → VM → результат.** {@link import("../agents/IntakeAgent").IntakeAgent}
 * формирует {@link import("../pipeline/types").OsnovaSpec}; после фазы build тот же снимок попадает в
 * {@link import("../agents/exec-agent").ExecContext} и/или в {@link createPipelineVmFromSpec}. Перед прогоном байткода
 * {@link import("../pipeline/types").OsnovaSpec} передаётся в VM через
 * {@link applyPipelineSpecToVm} (запись в {@link OsVbcVM.globals} по {@link PIPELINE_VM_GLOBAL_KEYS}) и
 * обработчик {@link createPipelineInvokeHandlerForVm} для syscall `система.пайплайн.*`. Итог процедуры —
 * возврат из {@link OsVbcVM.execute} и {@link OsVbcVM.getReturnValue}; дальнейшие патчи контекста и отчёты
 * формирует слой фаз/оркестратора поверх VM.
 *
 * **Точки расширения:** цепочка `invoke` — {@link OsVbcVMOptions} / {@link createDefaultInvokeHandler} и обёртка
 * {@link createPipelineInvokeHandlerForVm}; произвольные ключи {@link OsVbcVM.globals}; лимиты и опции интерпретатора
 * через наследование {@link import("./interpreter").InterpreterOptions} в {@link OsVbcVMOptions}.
 */

import { Interpreter, InterpreterError } from "./interpreter";
import type { InterpreterOptions, StackValue, InvokeHandler } from "./interpreter";
import type { OsnovaSpec } from "../pipeline/types";
import { isOsVbcModule, type OsVbcModule } from "./vm/bytecode";
import { createDefaultInvokeHandler } from "./vm/interpreter";

/** Системный invoke по умолчанию; используйте для цепочки с пользовательским `invoke`. */
export { createDefaultInvokeHandler };
export type { InterpreterOptions, StackValue, InvokeHandler } from "./interpreter";

/** Фаза записи в {@link OsVbcVMOptions.onExecutionLog}. */
export type VmExecutionLogPhase = "start" | "done" | "error";

/** Событие логирования одного запуска {@link OsVbcVM.execute}. */
export interface VmExecutionLogEvent {
  phase: VmExecutionLogPhase;
  /** Имя процедуры или `#индекс`. */
  procedure: string;
  /** {@link OsVbcModule.moduleName} */
  moduleName: string;
  /** Прошедшее время (мс) для `done` и `error`. */
  elapsedMs?: number;
  /** Исключение при `error` (как есть). */
  error?: unknown;
}

/** Опции конструктора {@link OsVbcVM}: наследует {@link InterpreterOptions} (в т.ч. `invoke`, лимиты шагов) и стартовые `globals`. */
export interface OsVbcVMOptions extends InterpreterOptions {
  /** Глобальный контекст хоста (копируется в {@link OsVbcVM.globals}; можно мутировать снаружи). */
  globals?: Record<string, StackValue>;
  /**
   * Колбэк для наблюдения за выполнением (песочница / отладка). По умолчанию выключен.
   * Не передаётся в {@link Interpreter}.
   */
  onExecutionLog?: (e: VmExecutionLogEvent) => void;
}

/** Аргументы для {@link OsVbcVM.execute}: какую процедуру запустить и начальные значения стека. */
export interface OsVbcExecuteOptions {
  /** Имя процедуры; если не задано — `главная` / `main` / индекс 0. */
  procedure?: string;
  /** Аргументы, передаваемые в процедуру (стек вызова). */
  args?: StackValue[];
  /**
   * Лимит wall-clock (мс) на весь прогон, включая ожидание async в `invoke`.
   * Не задано или `≤ 0` — без лимита (остаётся только {@link InterpreterOptions.maxSteps}).
   */
  timeoutMs?: number;
}

/**
 * Результат {@link safeExecutePipelineVm}: успешный возврат из процедуры или ошибка без throw
 * (таймаут, {@link InterpreterError}, сбой `invoke` и т.д.).
 */
export type PipelineVmExecuteResult =
  | { readonly ok: true; readonly returnValue: StackValue | undefined }
  | { readonly ok: false; readonly error: string; readonly cause?: unknown };

/**
 * Обёртка над {@link OsVbcVM.execute}: перехватывает исключения и возвращает {@link PipelineVmExecuteResult}.
 * Контекст spec/globals должен быть уже применён ({@link applyPipelineSpecToVm} / {@link createPipelineVmFromSpec}).
 */
export async function safeExecutePipelineVm(
  vm: OsVbcVM,
  opts?: OsVbcExecuteOptions,
): Promise<PipelineVmExecuteResult> {
  try {
    const returnValue = await vm.execute(opts);
    return { ok: true, returnValue };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, cause: err };
  }
}

function runWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      // Прогон байткода может завершиться после таймаута — подавляем поздний reject, иначе unhandledRejection.
      void promise.catch(() => {});
      reject(new InterpreterError(message));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Строковые имена полей в {@link OsVbcVM.globals}, под которые кладётся снимок {@link OsnovaSpec} для байткода
 * и нативных вызовов `система.пайплайн.*`.
 *
 * Заполнение: {@link buildPipelineVmGlobals} / {@link applyPipelineSpecToVm}. Чтение: {@link createPipelineInvokeHandlerForVm}
 * и прямой доступ к `globals` из скомпилированного кода.
 *
 * @remarks
 * **Пайплайн агентов:** перед запуском VM оркестратор/исполнитель шага подаёт в VM тот же {@link OsnovaSpec}, что лежит
 * в `ExecContext.spec` ({@link import("../agents/exec-agent").ExecContext}), через {@link applyPipelineSpecToVm}.
 * Тогда байткод и тесты могут согласованно читать идентификатор спецификации, точку входа (главный модуль) и эталон возврата
 * для golden-проверок и отчётов — без дублирования структуры спецификации в коде VM.
 *
 * @property SPEC_ID — {@link OsnovaSpec.specId}; соответствует syscall `система.пайплайн.ид_спецификации`.
 * @property MAIN_MODULE — {@link OsnovaSpec.mainModule}; соответствует syscall `система.пайплайн.главный_модуль`.
 * @property EXPECT_RETURN — ожидаемое значение `ret`: сначала {@link OsnovaSpec.expectedReturnValue}, иначе
 *   `expectVM.returnValue` из {@link OsnovaSpec.expectVM}, иначе `null`; syscall `система.пайплайн.ожидаемый_возврат`.
 */
export const PIPELINE_VM_GLOBAL_KEYS = {
  /** Значение {@link OsnovaSpec.specId} → `система.пайплайн.ид_спецификации`. */
  SPEC_ID: "__osnova_pipeline_spec_id",
  /** Значение {@link OsnovaSpec.mainModule} → `система.пайплайн.главный_модуль`. */
  MAIN_MODULE: "__osnova_pipeline_main_module",
  /** Ожидаемый возврат: `expectedReturnValue` или `expectVM.returnValue` → `система.пайплайн.ожидаемый_возврат`. */
  EXPECT_RETURN: "__osnova_pipeline_expect_return",
} as const;

/**
 * Снимок полей {@link OsnovaSpec} для хоста VM (globals + syscalls `система.пайплайн.*`).
 */
export function buildPipelineVmGlobals(spec: OsnovaSpec): Record<string, StackValue> {
  const expect =
    spec.expectedReturnValue !== undefined
      ? spec.expectedReturnValue
      : spec.expectVM?.returnValue !== undefined
        ? spec.expectVM.returnValue
        : null;
  return {
    [PIPELINE_VM_GLOBAL_KEYS.SPEC_ID]: spec.specId,
    [PIPELINE_VM_GLOBAL_KEYS.MAIN_MODULE]: spec.mainModule,
    [PIPELINE_VM_GLOBAL_KEYS.EXPECT_RETURN]: expect as StackValue,
  };
}

/**
 * Заполняет {@link OsVbcVM.globals} снимком полей {@link OsnovaSpec} через {@link buildPipelineVmGlobals}: идентификатор спецификации,
 * главный модуль, ожидаемый возврат (для golden и syscall `система.пайплайн.*`). После вызова цепочку `invoke` нужно оборачивать
 * в {@link createPipelineInvokeHandlerForVm}, чтобы байткод видел те же значения.
 *
 * **Связь с OsnovaSpec:** в пайплайне и агентах сюда передаётся тот же {@link OsnovaSpec}, что в `ExecContext.spec`
 * ({@link import("../agents/exec-agent").ExecContext}), чтобы VM не дублировала структуру спецификации и читала один источник правды,
 * что и оркестратор.
 *
 * @param vm — экземпляр VM; мутирует только {@link OsVbcVM.globals}.
 * @param spec — спецификация задачи (intake / pipeline).
 * @returns Ничего (`void`).
 */
export function applyPipelineSpecToVm(vm: OsVbcVM, spec: OsnovaSpec): void {
  Object.assign(vm.globals, buildPipelineVmGlobals(spec));
}

/**
 * Цепочка invoke: читает актуальные `vm.globals` (после {@link applyPipelineSpecToVm}), затем `inner`.
 */
export function createPipelineInvokeHandlerForVm(
  vm: OsVbcVM,
  inner: InvokeHandler = createDefaultInvokeHandler(),
): InvokeHandler {
  return (name: string, args: StackValue[]): Promise<StackValue> | StackValue => {
    const g = vm.globals;
    if (name === "система.пайплайн.ид_спецификации") {
      return (g[PIPELINE_VM_GLOBAL_KEYS.SPEC_ID] as string) ?? "";
    }
    if (name === "система.пайплайн.главный_модуль") {
      return (g[PIPELINE_VM_GLOBAL_KEYS.MAIN_MODULE] as string) ?? "";
    }
    if (name === "система.пайплайн.ожидаемый_возврат") {
      const v = g[PIPELINE_VM_GLOBAL_KEYS.EXPECT_RETURN];
      return v === undefined ? null : v;
    }
    return inner(name, args);
  };
}

/**
 * Собирает {@link OsVbcVM} для пары «{@link OsnovaSpec} (выход {@link import("../agents/IntakeAgent").IntakeAgent} / spec_generation)
 * + байткод модуля». Эквивалентно {@link import("../agents/exec-agent").createPipelineVmFromExecContext}, когда уже известны
 * только `spec` и загруженный {@link OsVbcModule} (без полного {@link import("../agents/exec-agent").ExecContext}).
 *
 * Запуск: {@link OsVbcVM.execute} (async); результат процедуры — возврат `execute` и {@link OsVbcVM.getReturnValue}
 * (после ошибки — `undefined`, как у внутреннего {@link Interpreter#runProcedure}).
 *
 * @returns `null`, если `module` не проходит {@link isOsVbcModule}.
 */
export function createPipelineVmFromSpec(spec: OsnovaSpec, module: unknown): OsVbcVM | null {
  if (!isOsVbcModule(module)) {
    return null;
  }
  let pipelineInvoke: ReturnType<typeof createPipelineInvokeHandlerForVm> | undefined;
  const vm = new OsVbcVM(module, {
    invoke: (name, args) => {
      pipelineInvoke ??= createPipelineInvokeHandlerForVm(vm);
      return pipelineInvoke(name, args);
    },
  });
  applyPipelineSpecToVm(vm, spec);
  return vm;
}

/**
 * Высокоуровневая VM для одного скомпилированного модуля ({@link OsVbcModule}): обёртка над {@link Interpreter}
 * с явной точкой входа {@link OsVbcVM.execute} и сохранённым результатом {@link OsVbcVM.getReturnValue}.
 *
 * **Связь с ExecContext:** в агентах и пайплайне тот же снимок спецификации, что в `ExecContext.spec`
 * ({@link import("../agents/exec-agent").ExecContext}), передаётся в {@link applyPipelineSpecToVm} до запуска,
 * чтобы заполнить {@link OsVbcVM.globals} и syscall `система.пайплайн.*` (см. {@link PIPELINE_VM_GLOBAL_KEYS}).
 *
 * **execute:** запуск процедуры модуля (см. {@link OsVbcVM.execute}).
 *
 * **«evaluate»:** отдельного метода нет — выполнение байткода — это {@link OsVbcVM.execute}; итог процедуры
 * читают через {@link OsVbcVM.getReturnValue}.
 *
 * **«bind»:** привязка окружения — поле {@link OsVbcVM.globals} и опции {@link OsVbcVMOptions} (в т.ч. наследуемый
 * из {@link InterpreterOptions} обработчик `invoke`); для пайплайна дополнительно {@link applyPipelineSpecToVm}.
 *
 * Внешние вызовы из байткода — через `invoke` (по умолчанию {@link createDefaultInvokeHandler}).
 */
export class OsVbcVM {
  private readonly module: OsVbcModule;
  private readonly interpreter: Interpreter;
  private readonly onExecutionLog?: (e: VmExecutionLogEvent) => void;
  private lastReturnValue: StackValue | undefined;
  /** Один активный {@link OsVbcVM.execute}: интерпретатор не потокобезопасен (общий pc/stack/frames). */
  private executing = false;

  /**
   * Глобальный контекст хоста: копия из {@link OsVbcVMOptions.globals} при создании; мутации видны байткоду и `invoke`.
   * Ключи пайплайна — {@link PIPELINE_VM_GLOBAL_KEYS}; заполняются через {@link applyPipelineSpecToVm} из `ExecContext.spec`.
   */
  readonly globals: Record<string, StackValue>;

  /**
   * @param module — загруженный байткод одного модуля.
   * @param options — {@link OsVbcVMOptions}: стартовые `globals`, лимиты шагов, цепочка `invoke` и пр.
   */
  constructor(module: OsVbcModule, options: OsVbcVMOptions = {}) {
    const { globals: initial = {}, onExecutionLog, ...rest } = options;
    this.module = module;
    this.onExecutionLog = onExecutionLog;
    this.globals = Object.assign(Object.create(null) as Record<string, StackValue>, initial);
    this.interpreter = new Interpreter(module, rest);
  }

  /**
   * Запускает процедуру модуля и сохраняет возвращаемое значение для {@link OsVbcVM.getReturnValue}.
   *
   * Точка входа по умолчанию: `главная`, иначе `main`, иначе процедура с индексом 0.
   * При ошибке или таймауте сбрасывает {@link OsVbcVM.getReturnValue} и пробрасывает исключение.
   *
   * @param opts — имя процедуры и аргументы стека; без `procedure` используется разрешение по умолчанию.
   * @returns Значение `ret` из процедуры или `undefined`.
   */
  async execute(opts: OsVbcExecuteOptions = {}): Promise<StackValue | undefined> {
    if (this.executing) {
      throw new InterpreterError(
        "VM.execute: параллельный запуск запрещён — дождитесь завершения предыдущего прогона",
      );
    }
    this.executing = true;
    const t0 = Date.now();
    let procedure: string;

    try {
      let procedureIndex: number;
      try {
        procedureIndex = this.resolveProcedureIndex(opts.procedure);
      } catch (err) {
        this.onExecutionLog?.({
          phase: "error",
          procedure:
            opts.procedure !== undefined && opts.procedure !== "" ? opts.procedure : "#разрешение_входа",
          moduleName: this.module.moduleName,
          elapsedMs: Date.now() - t0,
          error: err,
        });
        throw err;
      }
      procedure = this.procedureLabel(procedureIndex);
      this.onExecutionLog?.({
        phase: "start",
        procedure,
        moduleName: this.module.moduleName,
      });

      const args = opts.args !== undefined ? opts.args.slice() : [];
      let run = this.interpreter.runProcedure(procedureIndex, args);
      const { timeoutMs } = opts;
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        run = runWithTimeout(
          run,
          timeoutMs,
          `VM.execute: превышен лимит времени (${timeoutMs} мс), процедура «${procedure}»`,
        );
      }

      try {
        this.lastReturnValue = await run;
        this.onExecutionLog?.({
          phase: "done",
          procedure,
          moduleName: this.module.moduleName,
          elapsedMs: Date.now() - t0,
        });
        return this.lastReturnValue;
      } catch (err) {
        this.lastReturnValue = undefined;
        this.onExecutionLog?.({
          phase: "error",
          procedure,
          moduleName: this.module.moduleName,
          elapsedMs: Date.now() - t0,
          error: err,
        });
        throw err;
      }
    } finally {
      this.executing = false;
    }
  }

  /**
   * Результат последнего успешного {@link OsVbcVM.execute} (аналог «значения вычисления» после прогона процедуры).
   * До первого `execute` — `undefined`. После неудачного `execute` — `undefined`.
   */
  getReturnValue(): StackValue | undefined {
    return this.lastReturnValue;
  }

  private procedureLabel(index: number): string {
    const name = this.module.procedures[index]?.name;
    return name !== undefined && name !== "" ? name : `#${index}`;
  }

  private resolveProcedureIndex(name?: string): number {
    if (name !== undefined && name !== "") {
      return this.interpreter.findProcedureIndex(name);
    }
    for (const candidate of ["главная", "main"]) {
      try {
        return this.interpreter.findProcedureIndex(candidate);
      } catch {
        /* try next */
      }
    }
    return 0;
  }
}
