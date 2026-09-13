// ============================================================
// src/resident/adapters.ts — Реальные порты резидента
//
// Планировщик — LLM решает следующий шаг (improve/loop/done) по истории.
// Исполнитель — запускает selfImprove (правка ядра) или runLoop (приложение).
// ============================================================

import { getLLMProvider } from '../llm/index';
import { createDefaultInvokeHandler } from '../runtime/vm/interpreter';
import { selfImprove } from '../self-improve/core';
import { runLoop } from '../pipeline/loop';
import {
  createLlmPatchGen,
  createFilePatchPort,
  createCommandGate,
  assertCleanWorkingTree,
} from '../self-improve/adapters';
import type { PlannerPort, ExecutorPort } from './core';

const DEFAULT_SCOPE = ['src/compiler', 'src/runtime/vm'];
const FORBIDDEN = ['.qwen', 'forge', 'Fabrika2.0', 'apps', 'dist', 'node_modules'];

/** Планировщик: LLM по истории решает следующий шаг (JSON {mode, goal}). */
export function createLlmPlanner(opts?: { model?: string }): PlannerPort {
  return {
    async plan(history) {
      const provider = getLLMProvider();
      const model = opts?.model ?? process.env.OSNOVA_MODEL ?? 'qwen-coder-plus';

      const historyBlock = history.map((h, i) => `#${i + 1} ${h}`).join('\n');
      const userPrompt =
        `История:\n${historyBlock}\n\n` +
        `Реши следующий шаг. Верни строго JSON:\n` +
        `{"mode": "improve" | "loop" | "eval" | "done", "goal": "..."}\n` +
        `improve — править ядро, loop — писать приложение, eval — исполнить выражение/код, done — закончить.`;

      const resp = await provider.complete({
        model,
        messages: [
          {
            role: 'system',
            content: 'Ты — резидент-планировщик языка Основа. По истории решай следующий шаг строго JSON {"mode","goal"}.',
          },
          { role: 'user', content: userPrompt },
        ],
        maxTokens: 500,
        temperature: 0.2,
      });

      const m = resp.content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('нет JSON в ответе планировщика');
      const parsed = JSON.parse(m[0]) as { mode: string; goal: string };
      const mode = parsed.mode;
      if (mode !== 'improve' && mode !== 'loop' && mode !== 'eval' && mode !== 'done') {
        throw new Error(`неизвестный mode: ${mode}`);
      }
      return { mode, goal: parsed.goal ?? '' };
    },
  };
}

/** Исполнитель: selfImprove для improve, runLoop для loop. */
export function createResidentExecutor(opts?: { model?: string; scope?: string[] }): ExecutorPort {
  const scope = opts?.scope ?? DEFAULT_SCOPE;
  const env: Record<string, unknown> = {};

  return {
    async execute(action) {
      if (action.mode === 'improve') {
        await assertCleanWorkingTree(scope);
        const result = await selfImprove(
          action.goal,
          { allowedPaths: scope, forbiddenPaths: FORBIDDEN, maxIterations: 4 },
          {
            gen: createLlmPatchGen({ model: opts?.model }),
            patch: createFilePatchPort(),
            gate: createCommandGate(['npx vitest run src/compiler src/runtime/vm']),
          },
        );
        return {
          status: result.status,
          summary: result.error ?? `${result.iterations.length} итераций`,
        };
      }

      if (action.mode === 'eval') {
        const handler = createDefaultInvokeHandler();
        const value = await handler('система.оценить_в', [action.goal, env]);
        return { status: 'ok', summary: String(value ?? '') };
      }

      const result = await runLoop(action.goal);
      return { status: result.status, summary: result.source?.filename ?? '' };
    },
  };
}
