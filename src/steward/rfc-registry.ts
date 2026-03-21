// ============================================================
// src/steward/rfc-registry.ts — реестр всех RFC проекта
// ============================================================

import type { RFC } from './rfc';

export const RFC_REGISTRY: RFC[] = [
  {
    id: 'RFC-001',
    type: 'anti-rfc',
    title: 'try/catch avoidance через few-shot промпты',
    status: 'phase_a',
    risk: 'low',
    author: 'lang-agent',
    created_at: '2026-03-21T15:29:02Z',
    updated_at: '2026-03-21T15:29:02Z',
    description:
      'LLM генерирует JavaScript try/catch вместо попробовать/иначе_попытка. ' +
      'Гипотеза: 3+ few-shot примера в промпте + явные антипаттерны решают проблему ' +
      'без изменения синтаксиса языка.',
    hypothesis:
      'Few-shot обучение в buildOsnovaPrompt снизит частоту js_try_catch паттерна ' +
      'до <5% на 50+ трейсах.',
    phase_a: {
      golden_count: 6,
      docs_updated: true,
      prompt_updated: true,
      commit_sha: '5347cb5',
    },
    triggers: ['catchVar'],
    result: 'Phase A завершена. Ожидание 50 canary-трейсов для подтверждения.',
  },
];

/**
 * Найти RFC по id.
 */
export function getRFC(id: string): RFC | undefined {
  return RFC_REGISTRY.find(r => r.id === id);
}
