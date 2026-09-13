// ============================================================
// src/resident/core.ts — Резидент: автономный цикл самоулучшения
//
// Модель сама ведёт систему: на каждом раунде решает следующую цель
// (править ядро / писать приложение / закончить), исполняет её через
// уже построенные контуры (selfImprove / runLoop), читает результат и
// ставит следующую цель. Человек задаёт только стартовое направление.
//
// Ядро провайдер-агностик: планировщик и исполнитель приходят как порты.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_TRACE_FILE = 'runs/resident-traces.jsonl';

export type ResidentMode = 'improve' | 'loop' | 'eval' | 'done';

/** Решение планировщика: что делать следующим раундом. */
export interface ResidentAction {
  readonly mode: ResidentMode;
  readonly goal: string;
}

export interface PlannerPort {
  /** По истории раундов решает следующий шаг (или done). */
  plan(history: readonly string[]): Promise<ResidentAction>;
}

export interface ExecutorPort {
  /** Исполняет действие контуром improve или loop. */
  execute(action: { mode: 'improve' | 'loop' | 'eval'; goal: string }): Promise<{
    status: string;
    summary: string;
  }>;
}

export interface ResidentOptions {
  readonly maxRounds?: number;
  readonly traceFile?: string;
}

export interface ResidentRound {
  readonly round: number;
  readonly mode: string;
  readonly goal: string;
  readonly status: string;
  readonly durationMs: number;
}

export interface ResidentResult {
  readonly status: 'done' | 'limit' | 'error';
  readonly rounds: readonly ResidentRound[];
  readonly totalDurationMs: number;
  readonly error?: string;
}

function trace(round: ResidentRound, traceFile: string, startGoal: string, runId: string): void {
  try {
    const target = path.resolve(traceFile);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      target,
      JSON.stringify({
        runId,
        timestamp: new Date().toISOString(),
        startGoal,
        round: round.round,
        mode: round.mode,
        goal: round.goal,
        status: round.status,
        durationMs: round.durationMs,
      }) + '\n',
      'utf-8',
    );
  } catch (err) {
    console.warn('[resident] trace write failed:', err);
  }
}

/**
 * Автономный резидент: plan → execute → история → plan, до `done` или лимита раундов.
 */
export async function resident(
  startGoal: string,
  opts: ResidentOptions,
  ports: { plan: PlannerPort; exec: ExecutorPort },
): Promise<ResidentResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const traceFile = opts.traceFile ?? DEFAULT_TRACE_FILE;
  const runId = `res-${Date.now().toString(36)}`;
  const startTime = Date.now();

  const history: string[] = [startGoal];
  const rounds: ResidentRound[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const t0 = Date.now();

    let action: ResidentAction;
    try {
      action = await ports.plan.plan(history);
    } catch (err) {
      return {
        status: 'error',
        rounds,
        totalDurationMs: Date.now() - startTime,
        error: `plan error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (action.mode === 'done') {
      const r: ResidentRound = { round, mode: 'done', goal: action.goal || '', status: 'done', durationMs: Date.now() - t0 };
      rounds.push(r);
      trace(r, traceFile, startGoal, runId);
      return { status: 'done', rounds, totalDurationMs: Date.now() - startTime };
    }

    let result: { status: string; summary: string };
    try {
      result = await ports.exec.execute({ mode: action.mode, goal: action.goal });
    } catch (err) {
      return {
        status: 'error',
        rounds,
        totalDurationMs: Date.now() - startTime,
        error: `exec error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    history.push(`${action.mode}: ${action.goal} → ${result.status}`);
    const r: ResidentRound = { round, mode: action.mode, goal: action.goal, status: result.status, durationMs: Date.now() - t0 };
    rounds.push(r);
    trace(r, traceFile, startGoal, runId);
  }

  return { status: 'limit', rounds, totalDurationMs: Date.now() - startTime };
}
