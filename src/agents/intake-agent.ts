/**
 * Публичный вход intake-агента по пути epic scope (`intake-agent.ts`).
 * Реализация — {@link ./IntakeAgent}.
 *
 * Runtime: связка выданной spec с VM — {@link createPipelineVmFromSpec} и {@link OsVbcVM.execute}.
 */
export {
  IntakeAgent,
  SpecValidationError,
  detectAppTypeFromPrefix,
  parseLlmConfidence,
} from './IntakeAgent';
export {
  OsVbcVM,
  applyPipelineSpecToVm,
  buildPipelineVmGlobals,
  createDefaultInvokeHandler,
  createPipelineInvokeHandlerForVm,
  createPipelineVmFromSpec,
  PIPELINE_VM_GLOBAL_KEYS,
} from '../runtime/vm';
export type { OsVbcExecuteOptions, OsVbcVMOptions, VmExecutionLogEvent } from '../runtime/vm';
export { Interpreter, InterpreterError } from '../runtime/interpreter';
export type { InterpreterOptions, StackValue, InvokeHandler } from '../runtime/interpreter';
export type { AgentReport, BaseAgent } from '../types/agents';
export type { CompileResult } from './IntakeAgent';
