/**
 * Публичный вход зоны compiler: один контракт для компиляции (compile API), codegen и VM.
 * Re-export совпадает с публичными экспортами `compiler.ts`, `codegen.ts`, `vm.ts`
 * (имена не пересекаются между этими модулями).
 */
export * from "./compiler";
export * from "./codegen";
export * from "./vm";
