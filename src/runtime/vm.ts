/**
 * Высокоуровневая обёртка над Interpreter для выполнения одного модуля (.osvbc):
 * точка входа execute(), последнее возвращаемое значение getReturnValue(),
 * глобальный контекст хоста и прокси для внешних вызовов (invoke / native).
 */

import { Interpreter } from "./interpreter";
import type { InterpreterOptions, StackValue, InvokeHandler } from "./interpreter";
import type { OsnovaSpec } from "../pipeline/types";
import type { OsVbcModule } from "./vm/bytecode";
import { createDefaultInvokeHandler } from "./vm/interpreter";

/** Системный invoke по умолчанию; используйте для цепочки с пользовательским `invoke`. */
export { createDefaultInvokeHandler };
export type { InterpreterOptions, StackValue, InvokeHandler } from "./interpreter";

/** Опции конструктора {@link OsVbcVM}: наследует {@link InterpreterOptions} (в т.ч. `invoke`, лимиты шагов) и стартовые `globals`. */
export interface OsVbcVMOptions extends InterpreterOptions {
  /** Глобальный контекст хоста (копируется в {@link OsVbcVM.globals}; можно мутировать снаружи). */
  globals?: Record<string, StackValue>;
}

/** Аргументы для {@link OsVbcVM.execute}: какую процедуру запустить и начальные значения стека. */
export interface OsVbcExecuteOptions {
  /** Имя процедуры; если не задано — `главная` / `main` / индекс 0. */
  procedure?: string;
  /** Аргументы, передаваемые в процедуру (стек вызова). */
  args?: StackValue[];
}

/**
 * Контракт ключей в {@link OsVbcVM.globals} для снимка {@link OsnovaSpec}, доступного байткоду и syscall `система.пайплайн.*`.
 *
 * Заполнение: {@link buildPipelineVmGlobals} / {@link applyPipelineSpecToVm}. Чтение: {@link createPipelineInvokeHandlerForVm}
 * и прямой доступ к `globals` из скомпилированного кода.
 *
 * Связь с пайплайном: обычно `OsnovaSpec` берут из `ExecContext.spec` (агент выполнения, `src/agents/exec-agent.ts`) и передают в `applyPipelineSpecToVm`.
 */
export const PIPELINE_VM_GLOBAL_KEYS = {
  /** {@link OsnovaSpec.specId} → `система.пайплайн.ид_спецификации`. */
  SPEC_ID: "__osnova_pipeline_spec_id",
  /** {@link OsnovaSpec.mainModule} → `система.пайплайн.главный_модуль`. */
  MAIN_MODULE: "__osnova_pipeline_main_module",
  /** Ожидаемое значение возврата: `expectedReturnValue` либо `expectVM.returnValue` → `система.пайплайн.ожидаемый_возврат`. */
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
 * Записывает в {@link OsVbcVM.globals} данные пайплайна (после вызова — используйте invoke с {@link createPipelineInvokeHandlerForVm}).
 * Точка стыковки с агентами: тот же `OsnovaSpec`, что в `ExecContext.spec`, подаётся сюда перед запуском VM.
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
  private readonly interpreter: Interpreter;
  private lastReturnValue: StackValue | undefined;

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
    const { globals: initial = {}, ...rest } = options;
    this.globals = Object.assign(Object.create(null) as Record<string, StackValue>, initial);
    this.interpreter = new Interpreter(module, rest);
  }

  /**
   * Запускает процедуру модуля и сохраняет возвращаемое значение для {@link OsVbcVM.getReturnValue}.
   *
   * Точка входа по умолчанию: `главная`, иначе `main`, иначе процедура с индексом 0.
   * @param opts — имя процедуры и аргументы стека; без `procedure` используется разрешение по умолчанию.
   * @returns Значение `ret` из процедуры или `undefined`.
   */
  async execute(opts: OsVbcExecuteOptions = {}): Promise<StackValue | undefined> {
    const procedureIndex = this.resolveProcedureIndex(opts.procedure);
    this.lastReturnValue = await this.interpreter.runProcedure(procedureIndex, opts.args ?? []);
    return this.lastReturnValue;
  }

  /**
   * Результат последнего успешного {@link OsVbcVM.execute} (аналог «значения вычисления» после прогона процедуры).
   * До первого `execute` — `undefined`.
   */
  getReturnValue(): StackValue | undefined {
    return this.lastReturnValue;
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
