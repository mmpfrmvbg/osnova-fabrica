import { describe, it, expect } from 'vitest';
import type { RepairKind, RepairTarget } from './repairTarget';
import { getRepairTarget, formatRepairTarget } from './repairTarget';
import { LANGUAGE_REGISTRY } from '../compiler/language-registry';

/** Все kind из repairTarget — контракт промпта LLM-ремонта. */
const ALL_REPAIR_KINDS = [
  'undeclared_var',
  'redeclare_var',
  'assign_before_let',
  'unknown_syscall',
  'forbidden_keyword_as_ident',
  'missing_module_end',
  'return_with_parens',
  'js_try_catch',
  'invented_syntax',
  'unknown',
] as const satisfies readonly RepairKind[];

function assertRepairTargetSpec(t: RepairTarget): void {
  expect(t).toEqual(
    expect.objectContaining({
      kind: expect.any(String),
      instruction: expect.any(String),
    }),
  );
  expect(t.kind.length).toBeGreaterThan(0);
  expect(t.instruction.trim().length).toBeGreaterThan(0);
  if (t.example !== undefined) {
    expect(typeof t.example).toBe('string');
  }
}

const STABLE_SYSCALL_NAMES = LANGUAGE_REGISTRY.syscalls
  .filter((s) => s.status === 'stable')
  .map((s) => s.name);

describe('getRepairTarget', () => {
  it('undeclared_var → правильная инструкция', () => {
    const t = getRepairTarget('undeclared_var');
    expect(t.kind).toBe('undeclared_var');
    expect(t.instruction).toContain('пусть');
  });
  it('js_try_catch → упоминает попробовать', () => {
    const t = getRepairTarget('js_try_catch');
    expect(t.instruction).toContain('попробовать');
  });
  it('invented_syntax → упоминает структура', () => {
    const t = getRepairTarget('invented_syntax');
    expect(t.instruction).toContain('структура');
  });
  it('unknown kind → fallback на unknown', () => {
    const t = getRepairTarget('nonexistent_kind_xyz');
    expect(t.kind).toBe('unknown');
  });
  it('unknown → инструкция содержит модуль', () => {
    const t = getRepairTarget('unknown');
    expect(t.instruction).toContain('модуль');
  });

  it.each(['', '   ', 'Undeclared_Var'] as const)(
    'неканоничный kind %j → unknown',
    (kind) => {
      expect(getRepairTarget(kind).kind).toBe('unknown');
    },
  );

  it('каждый известный RepairKind возвращает spec с полями kind / instruction / example', () => {
    for (const k of ALL_REPAIR_KINDS) {
      const t = getRepairTarget(k);
      assertRepairTargetSpec(t);
      expect(t.kind).toBe(k);
    }
  });

  it('unknown_syscall: инструкция перечисляет все stable syscalls из LANGUAGE_REGISTRY', () => {
    const t = getRepairTarget('unknown_syscall');
    expect(t.instruction).toContain('система.');
    expect(t.instruction).toContain('LANGUAGE_REGISTRY');
    for (const name of STABLE_SYSCALL_NAMES) {
      expect(t.instruction).toContain(name);
    }
  });

  it('unknown: example — пустая строка (в промпт не попадает как блок примера)', () => {
    const t = getRepairTarget('unknown');
    expect(t.example).toBe('');
  });
});

describe('formatRepairTarget', () => {
  it('форматирует один kind', () => {
    const s = formatRepairTarget(['undeclared_var']);
    expect(s).toContain('ЦЕЛЕВЫЕ ИНСТРУКЦИИ');
    expect(s).toContain('UNDECLARED_VAR');
  });
  it('дедуплицирует дублирующиеся kinds', () => {
    const s = formatRepairTarget(['undeclared_var', 'undeclared_var']);
    const count = (s.match(/UNDECLARED_VAR/g) ?? []).length;
    expect(count).toBe(1);
  });
  it('пустой массив → только заголовок', () => {
    const s = formatRepairTarget([]);
    expect(s).toContain('ЦЕЛЕВЫЕ ИНСТРУКЦИИ');
  });

  it('сохраняет порядок первого появления уникальных kind', () => {
    const s = formatRepairTarget(['return_with_parens', 'undeclared_var', 'return_with_parens']);
    const idxReturn = s.indexOf('RETURN_WITH_PARENS');
    const idxUndeclared = s.indexOf('UNDECLARED_VAR');
    expect(idxReturn).toBeGreaterThan(-1);
    expect(idxUndeclared).toBeGreaterThan(idxReturn);
  });

  it('блок промпта: заголовок, маркер ▶ KIND:, инструкция и пример для kind с example', () => {
    const s = formatRepairTarget(['missing_module_end']);
    expect(s).toMatch(/═══ ЦЕЛЕВЫЕ ИНСТРУКЦИИ ПО ОШИБКАМ ═══/);
    expect(s).toContain('▶ MISSING_MODULE_END:');
    expect(s).toContain('модуль Имя');
  });

  it('неизвестный kind в списке даёт секцию UNKNOWN без лишнего примера (example пустой)', () => {
    const s = formatRepairTarget(['totally_unknown_kind']);
    expect(s).toContain('▶ UNKNOWN:');
    expect(s).not.toMatch(/▶ UNKNOWN:[\s\S]*\n\n\/\//);
  });
});
