/**
 * Высокоуровневая обёртка над Interpreter для выполнения одного модуля (.osvbc):
 * точка входа execute(), последнее возвращаемое значение getReturnValue(),
 * глобальный контекст хоста и прокси для внешних вызовов (invoke / native).
 */

import { Interpreter } from "./interpreter";
import type { InterpreterOptions, StackValue } from "./interpreter";
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
