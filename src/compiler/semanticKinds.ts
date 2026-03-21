// ============================================================
// src/compiler/semanticKinds.ts
// Источник правды: kinds семантических ошибок компилятора.
// Эти kinds порождает компилятор; pipeline их потребляет через
// реэкспорт в src/pipeline/semanticKinds.ts.
// ============================================================

/**
 * Blocking semantic error kinds.
 * При наличии хотя бы одного — pipeline маршрутизирует в repair-цикл.
 * Добавлять новый kind сюда + обновить промпты RepairEngineer.
 */
export const BLOCKING_SEMANTIC_KINDS = [
  'unknown_syscall',    // вызов несуществующего syscall
  'undeclared_var',     // использование необъявленной переменной
  'unknown_procedure',  // вызов необъявленной процедуры
  'syscall_argc',       // неверное число аргументов syscall
  'redeclare_var',      // повторное объявление переменной
  'invented_syntax',    // RFC-003: вымышленные конструкции (структура, система.типы.*, …)
] as const;

export type BlockingSemanticKind = typeof BLOCKING_SEMANTIC_KINDS[number];
