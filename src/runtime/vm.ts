/**
 * Высокоуровневая обёртка над Interpreter для выполнения одного модуля (.osvbc):
 * точка входа execute(), последнее возвращаемое значение getReturnValue(),
 * глобальный контекст хоста и прокси для внешних вызовов (invoke / native).
 *
 * @remarks
 * ### Интеграция VM ↔ агенты (пайплайн)
 *
 * **Поток данных ExecContext → VM → результат.** После фазы build в {@link import("../agents/exec-agent").ExecContext}
 * лежат `spec` и байткод в `buildReport`; {@link import("../agents/exec-agent").createPipelineVmFromExecContext} собирает
 * {@link OsVbcVM} через {@link createPipelineVmFromSpec}. Перед прогоном {@link import("../pipeline/types").OsnovaSpec}
 * передаётся в VM через {@link applyPipelineSpecToVm} (запись в {@link OsVbcVM.globals} по {@link PIPELINE_VM_GLOBAL_KEYS}) и
 * {@link createPipelineInvokeHandlerForVm} для syscall `система.пайплайн.*`. Итог — возврат из {@link OsVbcVM.execute} и
 * {@link OsVbcVM.getReturnValue} (либо {@link PipelineVmExecuteResult} из {@link safeExecutePipelineVm}); патчи контекста и отчёты
 * формирует слой фаз/оркестратора поверх VM. Вверх по пайплайну тот же снимок spec задаёт
 * {@link import("../agents/IntakeAgent").IntakeAgent} (intake / spec_generation).
 *
 * **Точки расширения:** цепочка `invoke` — {@link OsVbcVMOptions} / {@link createDefaultInvokeHandler} и обёртка
 * {@link createPipelineInvokeHandlerForVm}; произвольные ключи {@link OsVbcVM.globals}; лимиты и опции интерпретатора
 * через наследование {@link import("./interpreter").InterpreterOptions} в {@link OsVbcVMOptions}.
 *
 * **Публичная связка с агентами:** фабрика `createPipelineVmFromExecContext` и `safeExecutePipelineVm` экспортируются из
 * {@link import("../agents/index")} и {@link import("../pipeline/pipeline")} (фасад пайплайна); реализация — в
 * {@link import("../agents/exec-agent")}, сборка VM — {@link createPipelineVmFromSpec} + {@link applyPipelineSpecToVm}.
 *
 * ### Индекс контракта (обзор поверхности)
 *
 * **Класс:** {@link OsVbcVM}. **Интерфейс:** {@link VM}. **Типы:** {@link OsVbcVMOptions}, {@link OsVbcExecuteOptions}, {@link VmExecutionLogEvent},
 * {@link VmExecutionLogPhase}, {@link PipelineVmExecuteResult}. **Константы/утилиты:** {@link VM_ERROR_CONCURRENT_EXECUTE},
 * {@link PIPELINE_VM_GLOBAL_KEYS}, {@link formatVmRuntimeError}, {@link vmExecuteTimeoutMessage}. **Пайплайн из spec:**
 * {@link defaultPipelineProcedureFromSpec}, {@link mergePipelineVmExecuteOptions}, {@link safeExecutePipelineVm},
 * {@link buildPipelineVmGlobals}, {@link applyPipelineSpecToVm}, {@link createPipelineInvokeHandlerForVm},
 * {@link createPipelineVmFromSpec}, {@link createGoldenCheckVm}. Реэкспорты: {@link createDefaultInvokeHandler}, {@link OpCode},
 * типы интерпретатора.
 *
 * **Фасад ExecContext → VM:** {@link import("../agents/exec-agent").createPipelineVmFromExecContext},
 * {@link import("../agents/exec-agent").safeExecutePipelineVmFromExecContext}.
 *
 * **JSDoc у {@link PIPELINE_VM_GLOBAL_KEYS}:** есть (ключи globals, соответствие полям {@link OsnovaSpec} и syscall).
 */

import { Interpreter, InterpreterError } from "./interpreter";
import type { InterpreterOptions, StackValue, InvokeHandler } from "./interpreter";
import type { OsnovaSpec } from "../pipeline/types";
import { isOsVbcModule, type OsVbcModule } from "./vm/bytecode";
import { createDefaultInvokeHandler } from "./vm/interpreter";
import {
  TimeoutError,
  RecoveryManager,
  toRuntimeError,
  isRecoverableError,
} from "./runtimeRecovery";

/** Сообщение при повторном входе в {@link OsVbcVM.execute}, пока идёт прогон (единый текст для throw и пайплайна). */
export const VM_ERROR_CONCURRENT_EXECUTE =
  "VM.execute: параллельный запуск запрещён — дождитесь завершения предыдущего прогона";

/** Текст таймаута wall-clock для {@link OsVbcVM.execute} (совпадает с {@link runWithTimeout}). */
export function vmExecuteTimeoutMessage(timeoutMs: number, procedure: string): string {
  return `VM.execute: превышен лимит времени (${timeoutMs} мс), процедура «${procedure}»`;
}

/**
 * Единый текст ошибки VM для {@link safeExecutePipelineVm}, логов и отчётов пайплайна.
 * Для {@link InterpreterError} добавляет `op` и `pc`, чтобы совпадать с диагностикой интерпретатора.
 */
export function formatVmRuntimeError(err: unknown): string {
  if (err instanceof InterpreterError) {
    const parts: string[] = [err.message];
    if (err.op !== undefined) parts.push(`op=${err.op}`);
    if (err.pc !== undefined) parts.push(`pc=${err.pc}`);
    return parts.join(" ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Системный invoke по умолчанию; используйте для цепочки с пользовательским `invoke`. */
export { createDefaultInvokeHandler } from "./vm/interpreter";
/** Имена опкодов в поле `op` байткода; совпадают с emit в {@link import("../compiler/codegen")} и списком opcodes в language-schema. */
export { OpCode } from "./interpreter";
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

/**
 * Опции конструктора {@link OsVbcVM}: наследует {@link InterpreterOptions} (в т.ч. `invoke`, лимиты шагов) и стартовые `globals`.
 *
 * **Интеграция с агентами:** передаётся в {@link createPipelineVmFromSpec} и {@link createGoldenCheckVm} для настройки
 * обработчика `invoke` и лимитов интерпретатора; `globals` заполняется через {@link applyPipelineSpecToVm}.
 */
export interface OsVbcVMOptions extends InterpreterOptions {
  /**
   * Глобальный контекст хоста (копируется в {@link OsVbcVM.globals}; можно мутировать снаружи).
   * Ключи пайплайна — {@link PIPELINE_VM_GLOBAL_KEYS}; заполняются из {@link OsnovaSpec}.
   */
  globals?: Record<string, StackValue>;
  /**
   * Колбэк для наблюдения за выполнением (песочница / отладка). По умолчанию выключен.
   * Не передаётся в {@link Interpreter}.
   */
  onExecutionLog?: (e: VmExecutionLogEvent) => void;
}

/**
 * Аргументы для {@link OsVbcVM.execute}: какую процедуру запустить и начальные значения стека.
 *
 * **Интеграция с агентами:** используется в {@link safeExecutePipelineVm} и
 * {@link import("../agents/exec-agent").createPipelineVmFromExecContext} для запуска процедур с таймаутом и аргументами из
 * спецификации {@link OsnovaSpec}.
 */
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
 * Точка входа по спецификации пайплайна: имя первой процедуры в {@link OsnovaSpec.procedures}, если задано.
 * Используется {@link import("../agents/exec-agent").safeExecutePipelineVmFromExecContext}, когда в опциях нет `procedure`.
 */
export function defaultPipelineProcedureFromSpec(spec: OsnovaSpec | undefined): string | undefined {
  const name = spec?.procedures?.[0]?.name;
  return name !== undefined && name !== "" ? name : undefined;
}

/**
 * Объединяет опции {@link OsVbcVM.execute} с контекстом пайплайна: при отсутствии или пустом `procedure`
 * подставляет {@link defaultPipelineProcedureFromSpec} (тот же снимок spec, что попал в VM через {@link applyPipelineSpecToVm}).
 *
 * **Связь с ExecContext / OsnovaSpec:** в {@link import("../agents/exec-agent").safeExecutePipelineVmFromExecContext} сюда передаётся
 * {@link import("../agents/exec-agent").ExecContext.spec} — тот же {@link OsnovaSpec}, что уже согласован с VM.
 *
 * @param spec — снимок {@link OsnovaSpec} (часто {@link import("../agents/exec-agent").ExecContext.spec}).
 * @param opts — опции execute; при необходимости дополняется `procedure` из spec.
 */
export function mergePipelineVmExecuteOptions(
  spec: OsnovaSpec | undefined,
  opts?: OsVbcExecuteOptions,
): OsVbcExecuteOptions {
  const out: OsVbcExecuteOptions = { ...opts };
  const needProcedure = opts?.procedure === undefined || opts.procedure === "";
  if (needProcedure) {
    const d = defaultPipelineProcedureFromSpec(spec);
    if (d !== undefined) out.procedure = d;
  }
  return out;
}

/**
 * Результат {@link safeExecutePipelineVm}: успешный возврат из процедуры или ошибка без throw
 * (таймаут, {@link InterpreterError}, сбой `invoke` и т.д.).
 *
 * **Интеграция с агентами:** используется в {@link import("../agents/exec-agent").ExecAgent} для безопасного
 * выполнения VM и формирования отчёта пайплайна без проброса исключений.
 */
export type PipelineVmExecuteResult =
  | { readonly ok: true; readonly returnValue: StackValue | undefined }
  | { readonly ok: false; readonly error: string; readonly cause?: unknown };

/**
 * Обёртка над {@link OsVbcVM.execute}: перехватывает исключения и возвращает {@link PipelineVmExecuteResult}.
 * Контекст spec/globals должен быть уже применён ({@link applyPipelineSpecToVm} / {@link createPipelineVmFromSpec}) —
 * обычно это тот же {@link OsnovaSpec}, что в {@link import("../agents/exec-agent").ExecContext.spec} до прогона.
 *
 * **Интеграция с агентами:** вызывается в {@link import("../agents/exec-agent").ExecAgent} для безопасного
 * прогона VM без throw; ошибка возвращается через `result.error` для отчёта пайплайна.
 */
export async function safeExecutePipelineVm(
  vm: OsVbcVM,
  opts?: OsVbcExecuteOptions,
): Promise<PipelineVmExecuteResult> {
  try {
    const returnValue = await vm.execute(opts);
    return { ok: true, returnValue };
  } catch (err) {
    return { ok: false, error: formatVmRuntimeError(err), cause: err };
  }
}

/**
 * Расширенный результат выполнения с поддержкой recovery.
 * Включает информацию о попытках восстановления.
 */
export type PipelineVmExecuteResultWithRecovery = (
  | { readonly ok: true; readonly returnValue: StackValue | undefined }
  | { readonly ok: false; readonly error: string; readonly cause?: unknown }
) & {
  /** Количество попыток восстановления. */
  readonly recoveryAttempts?: number;
  /** Была ли успешная попытка восстановления. */
  readonly recoverySuccess?: boolean;
};

/**
 * Опции для выполнения с восстановлением.
 */
export interface ExecuteWithRecoveryOptions extends OsVbcExecuteOptions {
  /** Менеджер восстановления. */
  recoveryManager?: RecoveryManager;
  /** Максимальное количество попыток восстановления. */
  maxRecoveryAttempts?: number;
}

/**
 * Выполнение VM с механизмом восстановления после ошибок.
 * Пытается восстановить выполнение при recoverable ошибках через {@link RecoveryManager}.
 *
 * **Интеграция с пайплайном:** используется в оркестраторе для устойчивого выполнения
 * с автоматическим восстановлением после таймаутов и временных сбоев.
 *
 * @param vm — экземпляр VM.
 * @param opts — опции выполнения с recovery.
 * @returns Результат выполнения с информацией о восстановлении.
 */
export async function executeWithRecovery(
  vm: OsVbcVM,
  opts?: ExecuteWithRecoveryOptions,
): Promise<PipelineVmExecuteResultWithRecovery> {
  const recoveryManager = opts?.recoveryManager;
  const maxAttempts = opts?.maxRecoveryAttempts ?? 3;
  let recoveryAttempts = 0;
  let lastError: unknown;

  while (recoveryAttempts <= maxAttempts) {
    try {
      const returnValue = await vm.execute(opts);
      return {
        ok: true,
        returnValue,
        recoveryAttempts,
        recoverySuccess: recoveryAttempts > 0,
      };
    } catch (err) {
      lastError = err;
      const runtimeError = toRuntimeError(err);

      // Пытаемся восстановить только recoverable ошибки
      if (!isRecoverableError(err) || !recoveryManager) {
        break;
      }

      const recovered = await recoveryManager.attemptRecovery(runtimeError);
      if (!recovered) {
        break;
      }

      recoveryAttempts++;

      // Обновляем метаданные для следующей попытки
      if (runtimeError.metadata) {
        runtimeError.metadata.retries = recoveryAttempts;
      }

      // Для TimeoutError увеличиваем таймаут
      if (runtimeError.code === "TIMEOUT_ERROR") {
        const currentTimeout = runtimeError.metadata?.timeoutMs as number | undefined;
        if (currentTimeout && Number.isFinite(currentTimeout)) {
          opts = { ...opts, timeoutMs: currentTimeout * 2 };
        }
      }
    }
  }

  return {
    ok: false,
    error: formatVmRuntimeError(lastError),
    cause: lastError,
    recoveryAttempts,
    recoverySuccess: false,
  };
}

function runWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  procedure?: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let settled = false;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Прогон байткода и ожидание invoke могут завершиться после таймаута — гасим поздний reject, иначе unhandledRejection.
      void promise.catch(() => {});
      reject(new TimeoutError(message, { timeoutMs: ms, procedure, recoverable: true }));
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
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
 * Строковые литералы ключей с префиксом `__osnova_pipeline_` резервируют имена в {@link OsVbcVM.globals} и не должны совпадать с пользовательскими глобалами модуля.
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
 *
 * **Интеграция с агентами:** используется в {@link applyPipelineSpecToVm} для заполнения
 * {@link OsVbcVM.globals} перед запуском VM в {@link createPipelineVmFromSpec}.
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
 * @see {@link buildPipelineVmGlobals} — какие поля {@link OsnovaSpec} кладутся в {@link OsVbcVM.globals} и под какими ключами
 * ({@link PIPELINE_VM_GLOBAL_KEYS}).
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
 *
 * **Интеграция с агентами:** обрабатывает syscall `система.пайплайн.*` из байткода, возвращая значения
 * из {@link OsnovaSpec} (идентификатор спецификации, главный модуль, ожидаемый возврат).
 * Используется в {@link OsVbcVM.execute} и {@link createPipelineVmFromSpec}.
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
    // Единый async-путь: sync/async/thenable от inner всегда даёт Promise, чтобы интерпретатор стабильно ждал завершения.
    return Promise.resolve(inner(name, args));
  };
}

/**
 * Собирает {@link OsVbcVM} для пары «{@link OsnovaSpec} (выход {@link import("../agents/IntakeAgent").IntakeAgent} / spec_generation)
 * + байткод модуля». Эквивалентно {@link import("../agents/exec-agent").createPipelineVmFromExecContext}, когда уже известны
 * только `spec` и загруженный {@link OsVbcModule} (без полного {@link import("../agents/exec-agent").ExecContext}).
 *
 * **Интеграция с агентами:** фабричный метод для создания VM из спецификации пайплайна; применяет
 * {@link applyPipelineSpecToVm} и настраивает {@link createPipelineInvokeHandlerForVm} для syscall.
 *
 * Запуск: {@link OsVbcVM.execute} (async); результат процедуры — возврат `execute` и {@link OsVbcVM.getReturnValue}
 * (после ошибки — `undefined`, как у внутреннего {@link Interpreter#runProcedure}).
 *
 * @param spec — спецификация {@link OsnovaSpec} из {@link import("../agents/IntakeAgent").IntakeAgent} или пайплайна.
 * @param module — загруженный байткод модуля ({@link OsVbcModule}).
 * @returns Экземпляр VM или `null` при невалидном модуле.
 */
export function createPipelineVmFromSpec(spec: OsnovaSpec, module: unknown): OsVbcVM | null {
  if (!isOsVbcModule(module)) {
    return null;
  }
  // Один слой pipeline-invoke задаётся в {@link OsVbcVM.execute} (createPipelineInvokeHandlerForVm + base invoke).
  const vm = new OsVbcVM(module, {});
  applyPipelineSpecToVm(vm, spec);
  return vm;
}

/**
 * VM для golden-проверок (`runGoldenCheck` в `goldenApps.ts`): тот же контракт, что у {@link createPipelineVmFromSpec}
 * — {@link applyPipelineSpecToVm} и цепочка `система.пайплайн.*` в {@link OsVbcVM.execute} — плюс пользовательский
 * `invoke` из `options` (временное хранилище, время, расширенные массивы и т.д.).
 *
 * **Интеграция с агентами:** используется в тестах пайплайна и golden-проверках для запуска VM с кастомным
 * окружением (моки времени, storage, расширенные массивы).
 *
 * @param spec — спецификация {@link OsnovaSpec} для заполнения globals.
 * @param module — загруженный байткод модуля ({@link OsVbcModule}).
 * @param options — опции VM ({@link OsVbcVMOptions}), включая кастомный `invoke`.
 * @returns Экземпляр VM или `null` при невалидном модуле.
 */
export function createGoldenCheckVm(
  spec: OsnovaSpec,
  module: unknown,
  options: OsVbcVMOptions = {},
): OsVbcVM | null {
  if (!isOsVbcModule(module)) {
    return null;
  }
  const vm = new OsVbcVM(module, {
    maxSteps: 50_000,
    ...options,
  });
  applyPipelineSpecToVm(vm, spec);
  return vm;
}

/**
 * Публичный контракт VM байткода: одна процедура модуля за раз, результат последнего прогона, хост-окружение.
 *
 * Реализация — {@link OsVbcVM}. Отдельных методов с именами `evaluate` и `bind` нет:
 * - **execute** — {@link VM.execute}
 * - **evaluate** — после {@link VM.execute} итог процедуры читают через {@link VM.getReturnValue}
 * - **bind** — привязка окружения: {@link VM.globals} и опции конструктора {@link OsVbcVMOptions}
 *   (`invoke`, лимиты из {@link InterpreterOptions}); в пайплайне спецификация подмешивается через {@link applyPipelineSpecToVm}
 *
 * **Связь с ExecContext:** тот же {@link OsnovaSpec}, что в {@link import("../agents/exec-agent").ExecContext.spec},
 * до {@link VM.execute} попадает в VM через {@link applyPipelineSpecToVm}, заполняя {@link OsVbcVM.globals}
 * по {@link PIPELINE_VM_GLOBAL_KEYS} и syscall `система.пайплайн.*`.
 *
 * @see {@link import("../agents/exec-agent").ExecContext}
 */
export interface VM {
  /** Глобальный контекст хоста; «bind» для байткода вместе с опциями {@link OsVbcVMOptions} при создании {@link OsVbcVM}. */
  readonly globals: Record<string, StackValue>;

  /** Запуск процедуры модуля; см. {@link OsVbcVM.execute}. */
  execute(opts?: OsVbcExecuteOptions): Promise<StackValue | undefined>;

  /** Результат последнего успешного execute (роль «evaluate» для возвращаемого значения); см. {@link OsVbcVM.getReturnValue}. */
  getReturnValue(): StackValue | undefined;
}

/**
 * Высокоуровневая VM для одного скомпилированного модуля ({@link OsVbcModule}): обёртка над {@link Interpreter}.
 * Реализует {@link VM}. Внешние вызовы из байткода — через `invoke` (по умолчанию {@link createDefaultInvokeHandler}).
 *
 * Детали execute / evaluate / bind и связь с {@link import("../agents/exec-agent").ExecContext} — в {@link VM}.
 */
export class OsVbcVM implements VM {
  private readonly module: OsVbcModule;
  /** Опции интерпретатора без `globals` / `onExecutionLog`; на каждый {@link OsVbcVM.execute} создаётся новый {@link Interpreter}, чтобы после прерванного прогона (throw) не оставались грязные frames/pc. */
  private readonly interpreterOptions: InterpreterOptions;
  private interpreter: Interpreter;
  private readonly onExecutionLog?: (e: VmExecutionLogEvent) => void;
  private lastReturnValue: StackValue | undefined;
  /** Один активный {@link OsVbcVM.execute}: интерпретатор не потокобезопасен (общий pc/stack/frames). */
  private executing = false;

  /**
   * Глобальный контекст хоста: копия из {@link OsVbcVMOptions.globals} при создании; мутации видны байткоду и `invoke`.
   * Ключи пайплайна — {@link PIPELINE_VM_GLOBAL_KEYS}; заполняются через {@link applyPipelineSpecToVm} из
   * {@link import("../agents/exec-agent").ExecContext.spec}.
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
    this.interpreterOptions = rest;
    this.interpreter = new Interpreter(module, this.interpreterOptions);
  }

  /**
   * Запускает процедуру модуля и сохраняет возвращаемое значение для {@link OsVbcVM.getReturnValue}.
   *
   * **Интеграция с агентами:** основная точка входа для {@link safeExecutePipelineVm} и
   * {@link import("../agents/exec-agent").ExecAgent}; применяет {@link createPipelineInvokeHandlerForVm}
   * для syscall `система.пайплайн.*` и логирует фазы через {@link VmExecutionLogEvent}.
   *
   * Точка входа по умолчанию: `главная`, иначе `main`, иначе процедура с индексом 0.
   * При ошибке или таймауте сбрасывает {@link OsVbcVM.getReturnValue} и пробрасывает исключение.
   *
   * @param opts — имя процедуры и аргументы стека; без `procedure` используется разрешение по умолчанию.
   * @returns Значение `ret` из процедуры или `undefined`.
   */
  async execute(opts: OsVbcExecuteOptions = {}): Promise<StackValue | undefined> {
    if (this.executing) {
      throw new InterpreterError(VM_ERROR_CONCURRENT_EXECUTE);
    }
    this.executing = true;
    const t0 = Date.now();
    let procedure: string;

    try {
      const baseInvoke = this.interpreterOptions.invoke ?? createDefaultInvokeHandler();
      this.interpreter = new Interpreter(this.module, {
        ...this.interpreterOptions,
        invoke: createPipelineInvokeHandlerForVm(this, baseInvoke),
      });
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
        run = runWithTimeout(run, timeoutMs, vmExecuteTimeoutMessage(timeoutMs, procedure), procedure);
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
   *
   * **Интеграция с агентами:** используется в {@link safeExecutePipelineVm} для возврата
   * {@link PipelineVmExecuteResult.returnValue} и в отчётах пайплайна.
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
