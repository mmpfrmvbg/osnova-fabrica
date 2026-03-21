export const BLOCKING_SEMANTIC_KINDS = [
  'unknown_syscall',
  'undeclared_var',
  'unknown_procedure',
  'syscall_argc',
  'redeclare_var',
] as const;

export type BlockingSemanticKind = typeof BLOCKING_SEMANTIC_KINDS[number];

