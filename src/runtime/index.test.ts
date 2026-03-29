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
});
