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

export interface OsVbcVMOptions extends InterpreterOptions {
  /** Глобальный контекст хоста (копируется в {@link OsVbcVM.globals}; можно мутировать снаружи). */
  globals?: Record<string, StackValue>;
}

export interface OsVbcExecuteOptions {
  procedure?: string;
  args?: StackValue[];
}

/** Глобальные ключи: данные спецификации агентов → доступ из байткода через {@link createPipelineInvokeHandlerForVm}. */
export const PIPELINE_VM_GLOBAL_KEYS = {
  SPEC_ID: "__osnova_pipeline_spec_id",
  MAIN_MODULE: "__osnova_pipeline_main_module",
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

/** Записывает в {@link OsVbcVM.globals} данные пайплайна (после вызова — используйте invoke с {@link createPipelineInvokeHandlerForVm}). */
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
 * Обёртка над {@link Interpreter}: один модуль, явный execute и сохранённый результат.
 * Внешние вызовы — поле `invoke` (по умолчанию системный обработчик из {@link createDefaultInvokeHandler}).
 */
export class OsVbcVM {
  private readonly interpreter: Interpreter;
  private lastReturnValue: StackValue | undefined;

  /** Глобальный контекст инициализируется из опций конструктора и доступен хосту и пользовательскому `invoke`. */
  readonly globals: Record<string, StackValue>;

  constructor(module: OsVbcModule, options: OsVbcVMOptions = {}) {
    const { globals: initial = {}, ...rest } = options;
    this.globals = Object.assign(Object.create(null) as Record<string, StackValue>, initial);
    this.interpreter = new Interpreter(module, rest);
  }

  /**
   * Выполняет процедуру модуля. Точка входа по умолчанию: `главная`, иначе `main`, иначе индекс 0.
   */
  async execute(opts: OsVbcExecuteOptions = {}): Promise<StackValue | undefined> {
    const procedureIndex = this.resolveProcedureIndex(opts.procedure);
    this.lastReturnValue = await this.interpreter.runProcedure(procedureIndex, opts.args ?? []);
    return this.lastReturnValue;
  }

  /** Значение, возвращённое последним успешным {@link execute} (или undefined). */
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
