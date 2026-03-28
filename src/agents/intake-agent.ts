/**
 * Публичный вход intake-агента по пути epic scope (`intake-agent.ts`).
 * Реализация — {@link ./IntakeAgent}.
 */
export {
  IntakeAgent,
  SpecValidationError,
  detectAppTypeFromPrefix,
  parseLlmConfidence,
} from './IntakeAgent';
export type { AgentReport, BaseAgent } from '../types/agents';
export type { CompileResult } from './IntakeAgent';
