// ============================================================
// src/intelligence/planner.ts — чистое ядро плана (типы пайплайна + сборка шагов)
// Контракт фаз и шагов совпадает с {@link PlanAgent} / src/pipeline/types.ts
// Побочные эффекты intelligence (store / summarizer / lifecycle) — только через узкие порты ниже.
// ============================================================

import * as fsp from 'fs/promises';
import * as path from 'path';

import { applyDecay } from './decay';
import {
  updateLifecycle,
  type LifecycleTransition,
} from './lifecycle';
import type { RawItem } from './prefilter';
import { summarizeItem, type SummaryResult } from './summarizer';
import type { IntelligenceSignal, SignalStatus } from './store';

import type {
  ExecutionPlan,
  PlanAgentBuildOptions,
  PlanStep,
  PipelinePhase,
} from '../pipeline/types';

// ── Таймауты по умолчанию (fs / LLM) ──────────────────────

export const DEFAULT_PLANNER_FS_TIMEOUT_MS = 10_000;
export const DEFAULT_PLANNER_SUMMARIZE_TIMEOUT_MS = 120_000;

const DEFAULT_INTELLIGENCE_STORE_PATH = path.resolve('runs', 'intelligence.jsonl');

/** Оборачивает Promise: отклонение по таймауту. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label}: timeout after ${ms}ms`));
    }, ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

// ── Порты store / summarizer (инъекция зависимостей) ───────

/** Асинхронное чтение/запись сигналов; реализации обязаны уважать таймауты снаружи или внутри. */
export interface PlannerSignalStorePort {
  readSignals(storePath?: string): Promise<IntelligenceSignal[]>;
  writeSignals(signals: IntelligenceSignal[], storePath?: string): Promise<void>;
  upsertSignal(signal: IntelligenceSignal, storePath?: string): Promise<void>;
}

/** Граница summarizer (сеть / LLM) — одна операция на элемент. */
export interface PlannerSummarizerPort {
  summarizeItem(item: RawItem): Promise<SummaryResult>;
}

function parseIntelligenceJsonl(text: string): IntelligenceSignal[] {
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as IntelligenceSignal];
      } catch {
        return [];
      }
    });
}

export type { LifecycleTransition, SignalStatus };

/**
 * Адаптер хранилища на fs.promises + таймаут на каждую операцию.
 */
export function createDefaultPlannerSignalStoreAdapter(options?: {
  readonly timeoutMs?: number;
}): PlannerSignalStorePort {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PLANNER_FS_TIMEOUT_MS;

  const resolvePath = (storePath?: string): string => storePath ?? DEFAULT_INTELLIGENCE_STORE_PATH;

  return {
    async readSignals(storePath?: string): Promise<IntelligenceSignal[]> {
      const p = resolvePath(storePath);
      return withTimeout(
        (async () => {
          try {
            const data = await fsp.readFile(p, 'utf-8');
            return parseIntelligenceJsonl(data);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw e;
          }
        })(),
        timeoutMs,
        'store.readSignals',
      );
    },

    async writeSignals(signals: IntelligenceSignal[], storePath?: string): Promise<void> {
      const p = resolvePath(storePath);
      return withTimeout(
        (async () => {
          await fsp.mkdir(path.dirname(p), { recursive: true });
          const body = signals.map((s) => JSON.stringify(s)).join('\n') + '\n';
          await fsp.writeFile(p, body, 'utf-8');
        })(),
        timeoutMs,
        'store.writeSignals',
      );
    },

    async upsertSignal(signal: IntelligenceSignal, storePath?: string): Promise<void> {
      const p = resolvePath(storePath);
      return withTimeout(
        (async () => {
          let existing: IntelligenceSignal[];
          try {
            const data = await fsp.readFile(p, 'utf-8');
            existing = parseIntelligenceJsonl(data);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') existing = [];
            else throw e;
          }
          const idx = existing.findIndex((s) => s.id === signal.id);
          if (idx >= 0) {
            existing[idx] = signal;
            await fsp.mkdir(path.dirname(p), { recursive: true });
            await fsp.writeFile(p, existing.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');
          } else {
            await fsp.mkdir(path.dirname(p), { recursive: true });
            await fsp.appendFile(p, JSON.stringify(signal) + '\n', 'utf-8');
          }
        })(),
        timeoutMs,
        'store.upsertSignal',
      );
    },
  };
}

/**
 * Обертка над {@link summarizeItem} с таймаутом (сеть / провайдер LLM).
 */
export function createDefaultSummarizerPort(options?: {
  readonly timeoutMs?: number;
}): PlannerSummarizerPort {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PLANNER_SUMMARIZE_TIMEOUT_MS;
  return {
    summarizeItem: (item) =>
      withTimeout(summarizeItem(item), timeoutMs, 'summarizer.summarizeItem'),
  };
}

/**
 * Lifecycle + decay через порт хранилища (без прямого fs в этом слое).
 */
export async function runLifecycleWithStore(
  store: PlannerSignalStorePort,
  storePath?: string,
): Promise<{ transitions: LifecycleTransition[]; decayed: number }> {
  const signals = await store.readSignals(storePath);
  const { signals: afterDecay, result: decayResult } = applyDecay(signals);
  const { signals: afterLifecycle, transitions } = updateLifecycle(afterDecay);
  await store.writeSignals(afterLifecycle, storePath);
  return { transitions, decayed: decayResult.decayed };
}

/**
 * Аналог {@link update_rfc_status} с асинхронным портом store.
 */
export async function updateRfcStatusWithStore(
  store: PlannerSignalStorePort,
  signalId: string,
  newStatus: SignalStatus,
  storePath?: string,
): Promise<void> {
  const signals = await store.readSignals(storePath);
  const signal = signals.find((s) => s.id === signalId);
  if (!signal) {
    console.warn(`[planner:lifecycle] signal not found: ${signalId}`);
    return;
  }
  await store.upsertSignal({ ...signal, status: newStatus }, storePath);
}

/** Псевдоним под словарь «Plan» в задачах intelligence — тот же контракт, что {@link ExecutionPlan}. */
export type Plan = ExecutionPlan;

/** Псевдоним «Step» — тот же контракт, что {@link PlanStep}. */
export type Step = PlanStep;

export type { ExecutionPlan, PlanAgentBuildOptions, PlanStep, PipelinePhase } from '../pipeline/types';

/**
 * Упорядоченные шаги линейного пайплайна (без I/O).
 * Семантика и порядок совпадают с приватным buildExecutionSteps в PlanAgent.
 */
export function buildLinearPlanSteps(options: PlanAgentBuildOptions = {}): readonly PlanStep[] {
  const fromScratch = options.fromScratch ?? false;
  const includeRepair = options.includeRepair ?? true;
  const steps: PlanStep[] = [];
  let order = 1;
  const push = (phase: PipelinePhase, description?: string): void => {
    steps.push({ phase, order: order++, description });
  };

  if (fromScratch) {
    push('intake', 'parseIntent: RawText → OsnovaIntent');
    push('spec_generation', 'generateSpec: OsnovaIntent → OsnovaSpec');
    push('g1_spec_ready', 'gate G1_spec_ready: intent+spec → готовность к codegen');
  }

  push('codegen', 'generate: OsnovaSpec → OsnovaSource');
  push('build', 'Compiler.compile → CompileResult → BuildReport');
  push('golden_check', 'runGoldenCheck');

  if (includeRepair) {
    push('repair', 'RepairEngineer loop (до лимита попыток)');
  }

  return steps;
}

/**
 * Собирает {@link ExecutionPlan} с заданными идентификаторами и теми же опциями, что у PlanAgent.buildPlan.
 */
export function buildExecutionPlanCore(
  ids: { readonly planId: string; readonly intentId: string; readonly specId: string },
  options: PlanAgentBuildOptions = {},
): ExecutionPlan {
  const fromScratch = options.fromScratch ?? false;
  const includeRepair = options.includeRepair ?? true;
  return {
    planId: ids.planId,
    intentId: ids.intentId,
    specId: ids.specId,
    fromScratch,
    steps: buildLinearPlanSteps({ fromScratch, includeRepair }),
  };
}
