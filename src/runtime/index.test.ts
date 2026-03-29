import { describe, it, expect } from "vitest";
import * as runtime from "./index";

describe("runtime/index exports", () => {
  it("should export VM types and classes", () => {
    expect(runtime.OsVbcVM).toBeDefined();
    expect(runtime.Interpreter).toBeDefined();
    expect(runtime.InterpreterError).toBeDefined();
  });

  it("should export pipeline-related functions", () => {
    expect(runtime.createPipelineVmFromSpec).toBeDefined();
    expect(runtime.applyPipelineSpecToVm).toBeDefined();
    expect(runtime.createPipelineInvokeHandlerForVm).toBeDefined();
    expect(runtime.safeExecutePipelineVm).toBeDefined();
    expect(runtime.createGoldenCheckVm).toBeDefined();
  });

  it("should export pipeline constants and types", () => {
    expect(runtime.PIPELINE_VM_GLOBAL_KEYS).toBeDefined();
    expect(runtime.defaultPipelineProcedureFromSpec).toBeDefined();
    expect(runtime.mergePipelineVmExecuteOptions).toBeDefined();
  });

  it("should export invoke handler", () => {
    expect(runtime.createDefaultInvokeHandler).toBeDefined();
  });

  it("should export OpCode", () => {
    expect(runtime.OpCode).toBeDefined();
  });

  it("should export pipeline types from pipeline/types", () => {
    // Типы TypeScript не существуют в runtime, проверяем только runtime экспорты
    // Type-only экспорты недоступны в runtime
  });

  it("should export pipeline constants from pipeline/types", () => {
    expect(runtime.PIPELINE_STATUS_FOR_DIAGNOSTIC).toBeDefined();
    expect(runtime.ALL_DIAGNOSTIC_CODES).toBeDefined();
    expect(runtime.SPEC_G1_CONFIDENCE_MIN).toBeDefined();
    expect(runtime.SPEC_QUALITY_PASS).toBeDefined();
  });

  it("should export validation functions", () => {
    expect(runtime.RuntimeConfigError).toBeDefined();
    expect(runtime.validateVmOptions).toBeDefined();
    expect(runtime.validateExecuteOptions).toBeDefined();
    expect(runtime.validateBytecode).toBeDefined();
    expect(runtime.validateRuntimeConfig).toBeDefined();
  });

  it("should validate runtime config correctly", () => {
    const validModule = { instructions: [] };
    expect(() => runtime.validateRuntimeConfig(validModule)).not.toThrow();
  });

  it("should throw on invalid runtime config", () => {
    expect(() => runtime.validateRuntimeConfig(null)).toThrow(runtime.RuntimeConfigError);
    expect(() => runtime.validateRuntimeConfig({})).toThrow(runtime.RuntimeConfigError);
  });

  it("should export runtime error classes", () => {
    expect(runtime.RuntimeErrorBase).toBeDefined();
    expect(runtime.ExecutionError).toBeDefined();
    expect(runtime.TimeoutError).toBeDefined();
    expect(runtime.InvokeError).toBeDefined();
  });

  it("should export recovery manager and strategies", () => {
    expect(runtime.RecoveryManager).toBeDefined();
    expect(runtime.TimeoutRetryStrategy).toBeDefined();
    expect(runtime.ExecutionLogStrategy).toBeDefined();
  });

  it("should export error utility functions", () => {
    expect(runtime.toRuntimeError).toBeDefined();
    expect(runtime.isRecoverableError).toBeDefined();
  });

  it("should create runtime errors correctly", () => {
    const err = new runtime.ExecutionError("test", { pc: 10, op: "add", recoverable: true });
    expect(err.code).toBe("EXECUTION_ERROR");
    expect(err.metadata?.pc).toBe(10);
    expect(err.recoverable).toBe(true);
  });

  it("should handle timeout error with recovery metadata", () => {
    const err = new runtime.TimeoutError("timeout", { timeoutMs: 1000, procedure: "main" });
    expect(err.code).toBe("TIMEOUT_ERROR");
    expect(err.recoverable).toBe(true);
    expect(err.metadata?.timeoutMs).toBe(1000);
  });

  it("should convert unknown errors to runtime errors", () => {
    const err1 = runtime.toRuntimeError(new Error("test"));
    expect(err1.code).toBe("UNKNOWN_ERROR");
    expect(err1.message).toBe("test");

    const err2 = runtime.toRuntimeError("string error");
    expect(err2.code).toBe("UNKNOWN_ERROR");
    expect(err2.message).toBe("string error");
  });

  it("should check recoverable errors correctly", () => {
    const recoverable = new runtime.TimeoutError("timeout");
    const nonRecoverable = new runtime.ExecutionError("error");
    expect(runtime.isRecoverableError(recoverable)).toBe(true);
    expect(runtime.isRecoverableError(nonRecoverable)).toBe(false);
    expect(runtime.isRecoverableError(new Error("plain"))).toBe(false);
  });

  it("should use recovery manager with strategies", async () => {
    const manager = new runtime.RecoveryManager();
    const strategy = new runtime.TimeoutRetryStrategy({ maxRetries: 2, backoffMs: 10 });
    manager.register(strategy);

    const timeoutError = new runtime.TimeoutError("timeout");
    expect(await manager.attemptRecovery(timeoutError)).toBe(true);
    expect(manager.getStrategies()).toHaveLength(1);

    manager.clear();
    expect(manager.getStrategies()).toHaveLength(0);
  });

  it("should handle execution log strategy", () => {
    let logged: runtime.RuntimeError | undefined;
    const strategy = new runtime.ExecutionLogStrategy((err) => {
      logged = err;
    });

    const execError = new runtime.ExecutionError("exec error", { recoverable: true });
    expect(strategy.canHandle(execError)).toBe(true);
    expect(strategy.recover(execError)).toBe(true);
    expect(logged).toBe(execError);
  });

  it("should export executeWithRecovery function", () => {
    expect(runtime.executeWithRecovery).toBeDefined();
  });

  it("should export recovery result types", () => {
    // Типы не существуют в runtime, проверяем что экспорты определены
    expect(typeof runtime.executeWithRecovery).toBe("function");
  });
});
