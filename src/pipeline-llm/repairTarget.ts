// ============================================================
// src/pipeline-llm/repairTarget.ts — T-2
// Целевые инструкции repair-промпту по last_error_kind
// ============================================================

import { LANGUAGE_REGISTRY } from '../compiler/language-registry';

export type RepairKind =
  | 'undeclared_var'
  | 'redeclare_var'
  | 'assign_before_let'
  | 'unknown_syscall'
  | 'forbidden_keyword_as_ident'
  | 'missing_module_end'
  | 'return_with_parens'
  | 'js_try_catch'
  | 'invented_syntax'
  | 'unknown';

export interface RepairTarget {
  kind: RepairKind;
  instruction: string;
  example?: string;
}

const STABLE_SYSCALL_NAMES = LANGUAGE_REGISTRY.syscalls
  .filter((s) => s.status === 'stable')
  .map((s) => s.name);

const REPAIR_TARGETS: Record<RepairKind, RepairTarget> = {
  undeclared_var: {
    kind: 'undeclared_var',
    instruction:
      'Переменная используется до объявления. Добавь пусть имя = значение перед первым использованием.',
    example:
      '// НЕЛЬЗЯ: x = x + 1 (без пусть)\n// ПРАВИЛЬНО: пусть x = 0\n// x = x + 1',
  },
  redeclare_var: {
    kind: 'redeclare_var',
    instruction:
      'Переменная объявлена повторно через пусть. Первое объявление — пусть имя = значение, далее только имя = новое_значение.',
    example: '// НЕЛЬЗЯ: пусть x = 1 / пусть x = 2\n// ПРАВИЛЬНО: пусть x = 1 / x = 2',
  },
  assign_before_let: {
    kind: 'assign_before_let',
    instruction:
      'Присваивание до объявления пусть. Убедись что первая строка с переменной — пусть имя = значение.',
    example: '// НЕЛЬЗЯ: x = 5 (без предшествующего пусть x)\n// ПРАВИЛЬНО: пусть x = 5',
  },
  unknown_syscall: {
    kind: 'unknown_syscall',
    instruction:
      `Системный вызов не существует. Имя должно начинаться с "система." и быть из списка stable syscalls LANGUAGE_REGISTRY: ${STABLE_SYSCALL_NAMES.join(', ')}.`,
    example:
      '// НЕЛЬЗЯ: система.типы.создать("X") — не существует\n// ПРАВИЛЬНО: пусть obj = { поле: значение }',
  },
  forbidden_keyword_as_ident: {
    kind: 'forbidden_keyword_as_ident',
    instruction: 'Ключевое слово используется как имя переменной/процедуры. Переименуй переменную.',
    example: '// НЕЛЬЗЯ: пусть если = 1\n// ПРАВИЛЬНО: пусть условие = 1',
  },
  missing_module_end: {
    kind: 'missing_module_end',
    instruction: 'Отсутствует закрывающий конец модуля. Структура: модуль Имя / процедуры / конец.',
    example: 'модуль Имя\nпроцедура главная()\n  вернуть 0\nконец\nконец  ← не забыть',
  },
  return_with_parens: {
    kind: 'return_with_parens',
    instruction: 'вернуть не принимает скобки. Пиши: вернуть значение (без скобок).',
    example: '// НЕЛЬЗЯ: вернуть(сумма)\n// ПРАВИЛЬНО: вернуть сумма',
  },
  js_try_catch: {
    kind: 'js_try_catch',
    instruction:
      'JavaScript try/catch недопустим. Используй попробовать / иначе_попытка е / конец.',
    example:
      '// НЕЛЬЗЯ: try { } catch(e) { }\n// ПРАВИЛЬНО: попробовать\n//   ...\n// иначе_попытка е\n//   ...\n// конец',
  },
  invented_syntax: {
    kind: 'invented_syntax',
    instruction:
      'Несуществующая конструкция: структура(), данные, система.типы.создать. Используй объект-литерал { поле: значение } вместо структура/тип/класс.',
    example:
      '// НЕЛЬЗЯ: структура(а, б) / данные x = 0 / система.типы.создать("T")\n// ПРАВИЛЬНО: пусть obj = { а: 0, б: 0 }',
  },
  unknown: {
    kind: 'unknown',
    instruction:
      'Неизвестная ошибка. Проверь: структуру модуля (модуль/процедура главная/конец/конец), все пусть перед использованием, отсутствие JS-синтаксиса.',
    example: '',
  },
};

/**
 * Получить целевую инструкцию по kind ошибки.
 * Если kind неизвестен — вернуть инструкцию для 'unknown'.
 */
export function getRepairTarget(kind: string): RepairTarget {
  return REPAIR_TARGETS[kind as RepairKind] ?? REPAIR_TARGETS.unknown;
}

/**
 * Форматировать блок целевых инструкций для repair-промпта.
 * Принимает массив kind из текущих ошибок трейса.
 */
export function formatRepairTarget(kinds: string[]): string {
  const unique = Array.from(new Set(kinds));
  const targets = unique.map((k) => getRepairTarget(k));
  const lines: string[] = ['═══ ЦЕЛЕВЫЕ ИНСТРУКЦИИ ПО ОШИБКАМ ═══'];
  for (const t of targets) {
    lines.push('');
    lines.push(`▶ ${t.kind.toUpperCase()}: ${t.instruction}`);
    if (t.example) lines.push(t.example);
  }
  return lines.join('\n');
}
