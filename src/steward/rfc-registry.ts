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
  {
    id: 'RFC-002',
    type: 'anti-rfc',
    title: 'sentinel pattern — пусто вместо попробовать',
    status: 'draft',
    risk: 'low',
    author: 'lang-agent',
    created_at: '2026-03-21T15:55:00Z',
    updated_at: '2026-03-21T15:55:00Z',
    description:
      '77 трейсов используют == пусто как sentinel вместо попробовать/иначе_попытка. ' +
      'Гипотеза: 3 few-shot примера снизят паттерн до <20%.',
    hypothesis:
      'Few-shot примеры с попробовать для задач поиска/чтения снизят sentinel rate до <20% без RFC синтаксиса.',
    triggers: ['sentinel'],
  },
  {
    id: 'RFC-003',
    type: 'anti-rfc',
    title: 'invented syntax — структура/данные/система.типы',
    status: 'draft',
    risk: 'medium',
    author: 'lang-agent',
    created_at: '2026-03-21T15:55:00Z',
    updated_at: '2026-03-21T15:55:00Z',
    description:
      'LLM изобретает несуществующие конструкции при сложных задачах. ' +
      'Объясняет 95% unknown в repair_exhausted. ' +
      'Гипотеза: FORBIDDEN блок + few-shot сложных задач снизят invented_syntax.',
    hypothesis:
      'Явный список запрещённых invented-конструкций в промпте снизит unknown_kind до <30%.',
    triggers: ['flag_loop'],
  },
];

/**
 * Найти RFC по id.
 */
export function getRFC(id: string): RFC | undefined {
  return RFC_REGISTRY.find(r => r.id === id);
}
