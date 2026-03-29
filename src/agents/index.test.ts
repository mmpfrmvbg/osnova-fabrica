/**
 * Тест единого экспортного интерфейса src/agents/index.ts
 */
import { describe, it, expect } from 'vitest';

// Проверяем что все экспорты доступны из единой точки импорта
import {
  // Классы агентов
  IntakeAgent,
  PlanAgent,
  ExecAgent,
  ReviewAgent,
  OsnovaCodegenAgent,
  RepairEngineerAgent,
  DiagnosticAgent,
  createOrchestratorAgentBundle,
  // Ошибки валидации
  IntakeValidationError,
  SpecValidationError,
  PlanValidationError,
  // Ошибки выполнения
  PhaseExecutionError,
  // Функции
  detectAppTypeFromPrefix,
  parseLlmConfidence,
  isValidPhaseTransition,
  compileOsnovaSource,
  formatCompileFailureMessage,
  createPipelineVmFromExecContext,
  safeExecutePipelineVm,
  safeExecutePipelineVmFromExecContext,
  EXEC_CONTEXT_VM_UNAVAILABLE,
  // Пространства имён
  intake,
  plan,
  repair,
  // Компилятор
  Compiler,
} from './index';

describe('src/agents/index.ts — единый экспортный интерфейс', () => {
  describe('Классы агентов экспортированы', () => {
    it('IntakeAgent — класс', () => {
      expect(typeof IntakeAgent).toBe('function');
      expect(new IntakeAgent()).toBeInstanceOf(IntakeAgent);
    });

    it('PlanAgent — класс', () => {
      expect(typeof PlanAgent).toBe('function');
      expect(new PlanAgent()).toBeInstanceOf(PlanAgent);
    });

    it('ExecAgent — класс', () => {
      expect(typeof ExecAgent).toBe('function');
      expect(new ExecAgent()).toBeInstanceOf(ExecAgent);
    });

    it('ReviewAgent — класс', () => {
      expect(typeof ReviewAgent).toBe('function');
      expect(new ReviewAgent()).toBeInstanceOf(ReviewAgent);
    });

    it('OsnovaCodegenAgent — класс', () => {
      expect(typeof OsnovaCodegenAgent).toBe('function');
      expect(new OsnovaCodegenAgent()).toBeInstanceOf(OsnovaCodegenAgent);
    });

    it('RepairEngineerAgent — класс', () => {
      expect(typeof RepairEngineerAgent).toBe('function');
      expect(new RepairEngineerAgent()).toBeInstanceOf(RepairEngineerAgent);
    });

    it('DiagnosticAgent — класс', () => {
      expect(typeof DiagnosticAgent).toBe('function');
      expect(new DiagnosticAgent()).toBeInstanceOf(DiagnosticAgent);
    });
  });

  describe('Ошибки экспортированы', () => {
    it('IntakeValidationError — класс ошибки', () => {
      expect(typeof IntakeValidationError).toBe('function');
      expect(new IntakeValidationError('test')).toBeInstanceOf(IntakeValidationError);
      expect(new IntakeValidationError('test')).toBeInstanceOf(Error);
    });

    it('SpecValidationError — класс ошибки', () => {
      expect(typeof SpecValidationError).toBe('function');
      expect(new SpecValidationError([], 'test')).toBeInstanceOf(SpecValidationError);
      expect(new SpecValidationError([], 'test')).toBeInstanceOf(Error);
    });

    it('PlanValidationError — класс ошибки', () => {
      expect(typeof PlanValidationError).toBe('function');
      expect(new PlanValidationError('test')).toBeInstanceOf(PlanValidationError);
      expect(new PlanValidationError('test')).toBeInstanceOf(Error);
    });

    it('PhaseExecutionError — класс ошибки выполнения', () => {
      expect(typeof PhaseExecutionError).toBe('function');
      expect(new PhaseExecutionError('test')).toBeInstanceOf(PhaseExecutionError);
      expect(new PhaseExecutionError('test')).toBeInstanceOf(Error);
    });
  });

  describe('Функции экспортированы', () => {
    it('detectAppTypeFromPrefix — функция', () => {
      expect(typeof detectAppTypeFromPrefix).toBe('function');
      expect(detectAppTypeFromPrefix('алгоритм: тест')).toBe('алгоритм');
    });

    it('parseLlmConfidence — функция', () => {
      expect(typeof parseLlmConfidence).toBe('function');
      expect(parseLlmConfidence(0.9)).toBe(0.9);
      expect(parseLlmConfidence('0.8')).toBe(0.8);
    });

    it('isValidPhaseTransition — функция', () => {
      expect(typeof isValidPhaseTransition).toBe('function');
      expect(isValidPhaseTransition('intake', 'spec_generation')).toBe(true);
      expect(isValidPhaseTransition('intake', 'codegen')).toBe(false);
    });

    it('compileOsnovaSource — функция', () => {
      expect(typeof compileOsnovaSource).toBe('function');
    });

    it('formatCompileFailureMessage — функция', () => {
      expect(typeof formatCompileFailureMessage).toBe('function');
    });

    it('createPipelineVmFromExecContext — функция', () => {
      expect(typeof createPipelineVmFromExecContext).toBe('function');
    });

    it('safeExecutePipelineVm — функция', () => {
      expect(typeof safeExecutePipelineVm).toBe('function');
    });

    it('safeExecutePipelineVmFromExecContext — функция', () => {
      expect(typeof safeExecutePipelineVmFromExecContext).toBe('function');
    });

    it('EXEC_CONTEXT_VM_UNAVAILABLE — строка', () => {
      expect(typeof EXEC_CONTEXT_VM_UNAVAILABLE).toBe('string');
      expect(EXEC_CONTEXT_VM_UNAVAILABLE.length).toBeGreaterThan(0);
    });
  });

  describe('Пространства имён экспортированы', () => {
    it('intake — пространство имён', () => {
      expect(intake).toBeDefined();
      expect(typeof intake).toBe('object');
      expect(intake.IntakeAgent).toBeDefined();
      expect(intake.detectAppTypeFromPrefix).toBeDefined();
    });

    it('plan — пространство имён', () => {
      expect(plan).toBeDefined();
      expect(typeof plan).toBe('object');
      expect(plan.PlanAgent).toBeDefined();
      expect(plan.Compiler).toBeDefined();
    });

    it('repair — пространство имён', () => {
      expect(repair).toBeDefined();
      expect(repair.RepairEngineerAgent).toBe(RepairEngineerAgent);
    });
  });

  describe('createOrchestratorAgentBundle', () => {
    it('возвращает intake, codegen, repair как в orchestrator.runPipeline', () => {
      const b = createOrchestratorAgentBundle('ctx');
      expect(b.intake).toBeInstanceOf(IntakeAgent);
      expect(b.codegen).toBeInstanceOf(OsnovaCodegenAgent);
      expect(b.repair).toBeInstanceOf(RepairEngineerAgent);
    });
  });

  describe('Компилятор экспортирован', () => {
    it('Compiler — класс', () => {
      expect(typeof Compiler).toBe('function');
      expect(new Compiler()).toBeInstanceOf(Compiler);
    });
  });
});
