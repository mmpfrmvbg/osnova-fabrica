/**
 * Публичный вход зоны compiler: один контракт для компиляции (compile API), codegen и VM.
 * Re-export совпадает с публичными экспортами `compiler.ts`, `codegen.ts`, `vm.ts`
 * (имена не пересекаются между этими модулями).
 *
 * Явный type-only re-export `CompileResult` и `OsnovaIrModule` для `import type` из точки входа `compiler`.
 */
export type { CompileResult, OsnovaIrModule } from "./compiler";
export * from "./compiler";
export * from "./codegen";
export * from "./vm";
