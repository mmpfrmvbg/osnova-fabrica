// ============================================================
// src/steward/rfc.ts — RFC-схема языкового процесса
// Уровень 2: каждое изменение языка оформляется как RFC
// ============================================================

export type RFCType = 'rfc' | 'anti-rfc';
export type RFCStatus = 'draft' | 'phase_a' | 'shadow' | 'phase_b' | 'closed' | 'rejected';
export type RFCRisk = 'low' | 'medium' | 'high';

export interface RFC {
  id: string;              // RFC-001, RFC-002, ...
  type: RFCType;           // 'rfc' | 'anti-rfc'
  title: string;
  status: RFCStatus;
  risk: RFCRisk;
  author: string;          // агент или человек
  created_at: string;      // ISO-8601
  updated_at: string;      // ISO-8601
  description: string;
  hypothesis?: string;     // для anti-rfc: что проверяем
  phase_a?: {
    golden_count: number;
    docs_updated: boolean;
    prompt_updated: boolean;
    commit_sha?: string;
  };
  phase_b?: {
    compiler_changes?: string[];
    shadow_mode_pct?: number;   // % корректного использования в shadow
    commit_sha?: string;
  };
  triggers?: string[];         // какие workaround_patterns запустили RFC
  result?: string;             // итог после закрытия
}

/**
 * Авто-approve: RFC с risk=low и пустой phase_b одобряется без участия человека.
 */
export function isAutoApprovable(rfc: RFC): boolean {
  return rfc.risk === 'low' && !rfc.phase_b;
}

/**
 * Валидация RFC перед записью.
 */
export function validateRFC(rfc: RFC): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!rfc.id.match(/^RFC-\d{3,}$/)) errors.push('id должен быть RFC-NNN');
  if (!rfc.title || rfc.title.trim().length === 0) errors.push('title обязателен');
  if (!rfc.description || rfc.description.trim().length === 0) errors.push('description обязателен');
  if (rfc.type === 'anti-rfc' && !rfc.hypothesis) errors.push('anti-rfc требует hypothesis');
  return { valid: errors.length === 0, errors };
}
