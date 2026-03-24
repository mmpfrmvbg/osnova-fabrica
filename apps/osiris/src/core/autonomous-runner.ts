// apps/osiris/src/core/autonomous-runner.ts
import { call as callLlm } from './llm-router';
import type { ChatMessage } from './llm-router';
import { getDb, ensureInit } from '../db/migrations';
import type { AutonomousJob, JobStep } from '../types';
import {
  shellExec,
  fileRead,
  gitStatus,
  gitCommitDiff,
  notifyPush,
} from './tools/system-tools';
import * as memory from './memory-engine';

// ── DB helpers ────────────────────────────────────────────────────────────

function rowToJob(row: Record<string, unknown>): AutonomousJob {
  let steps: JobStep[] = [];
  try {
    steps = JSON.parse(row['steps'] as string) as JobStep[];
  } catch {
    steps = [];
  }
  return {
    id: row['id'] as string,
    userId: row['user_id'] as string,
    goal: row['goal'] as string,
    status: row['status'] as AutonomousJob['status'],
    steps,
    result: (row['result'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    iteration: row['iteration'] as number,
    maxIterations: row['max_iterations'] as number,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function saveJobRow(job: AutonomousJob): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO autonomous_jobs
      (id, user_id, goal, status, steps, result, error,
       iteration, max_iterations, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.userId,
    job.goal,
    job.status,
    JSON.stringify(job.steps),
    job.result,
    job.error,
    job.iteration,
    job.maxIterations,
    job.createdAt,
    job.updatedAt,
  );
}

export async function getJobStatus(jobId: string): Promise<AutonomousJob | null> {
  ensureInit();
  const db = getDb();
  const row = db.prepare('SELECT * FROM autonomous_jobs WHERE id = ?')
    .get(jobId) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

// ── Tool dispatcher (не зависит от message-handler) ───────────────────────

async function dispatchAction(
  userId: string,
  action: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (action) {
    case 'shell_exec': {
      const cmd = typeof args['cmd'] === 'string' ? args['cmd'] : '';
      if (!cmd) return 'Ошибка: cmd обязателен.';
      return JSON.stringify(await shellExec(cmd));
    }
    case 'file_read': {
      const p = typeof args['path'] === 'string' ? args['path'] : '';
      if (!p) return 'Ошибка: path обязателен.';
      const r = await fileRead(p);
      return r.error ? `Ошибка: ${r.error}` : r.content.slice(0, 8000);
    }
    case 'git_status':
      return await gitStatus();
    case 'git_commit_diff': {
      const sha = typeof args['sha'] === 'string' ? args['sha'] : '';
      return await gitCommitDiff(sha);
    }
    case 'notify_push': {
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      const urgency = args['urgency'] === 'low' || args['urgency'] === 'high'
        ? args['urgency'] : 'normal';
      await notifyPush(text, urgency);
      return 'Уведомлено.';
    }
    case 'remember_fact': {
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      if (!content) return 'Ошибка: content обязателен.';
      await memory.saveFacts(
        [{ kind: 'user_profile', project: 'assistant', text: content, importance: 3 }],
        0,
        userId,
      );
      return 'Факт сохранён.';
    }
    case 'recall_facts': {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      const facts = await memory.getRelevantFacts(query, 'unknown', 5);
      return JSON.stringify(facts);
    }
    default:
      return `Действие не поддерживается в автономном режиме: ${action}`;
  }
}

// ── Job loop ───────────────────────────────────────────────────────────────

async function runJobLoop(jobId: string, userId: string, goal: string): Promise<void> {
  ensureInit();
  const db = getDb();

  let job = await getJobStatus(jobId);
  if (!job) return;

  try {
    while (job.iteration < job.maxIterations) {
      const stepsText = job.steps.length > 0
        ? job.steps.map((s) =>
          `Итерация ${s.iteration}: мысль="${s.thought}" действие=${s.action} наблюдение="${s.observation}"`)
          .join('\n')
        : 'Шагов ещё не было.';

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'Ты выполняешь задачу автономно, шаг за шагом.\n' +
            `Цель: ${goal}\n\n` +
            `История шагов:\n${stepsText}\n\n` +
            'Если задача ПОЛНОСТЬЮ выполнена — ответь ТОЛЬКО валидным JSON (без markdown):\n' +
            '{"done":true,"result":"итог"}\n\n' +
            'Если нужно следующее действие — ответь ТОЛЬКО валидным JSON:\n' +
            '{"done":false,"thought":"...","action":"tool_name","args":{...}}\n\n' +
            'Доступные действия: shell_exec, file_read, git_status, git_commit_diff, ' +
            'notify_push, remember_fact, recall_facts.',
        },
      ];

      let llmText = '';
      try {
        const result = await callLlm(messages, 'chat', { tool_choice: 'none' });
        llmText = result.text.trim();
      } catch (e) {
        throw new Error(`LLM error: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Извлечь JSON из ответа
      const jsonMatch = llmText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`LLM вернул невалидный ответ: ${llmText.slice(0, 200)}`);
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        done?: boolean;
        result?: string;
        thought?: string;
        action?: string;
        args?: Record<string, unknown>;
      };

      if (parsed.done === true) {
        // Задача выполнена
        job.status = 'done';
        job.result = parsed.result ?? 'выполнено';
        job.updatedAt = new Date().toISOString();
        saveJobRow(job);
        await notifyPush(`✅ Задача выполнена: ${goal}\n${job.result}`, 'normal');
        return;
      }

      // Выполнить действие
      const action = parsed.action ?? 'noop';
      const args = parsed.args ?? {};
      const thought = parsed.thought ?? '';
      let observation = '';

      try {
        observation = await dispatchAction(userId, action, args);
      } catch (e) {
        observation = `Ошибка действия: ${e instanceof Error ? e.message : String(e)}`;
      }

      const step: JobStep = {
        iteration: job.iteration,
        thought,
        action,
        args,
        observation: observation.slice(0, 500), // ограничение в истории
        timestamp: new Date().toISOString(),
      };

      job.steps.push(step);
      job.iteration += 1;
      job.updatedAt = new Date().toISOString();
      saveJobRow(job);

      // Обновить локальную копию из БД
      const refreshed = await getJobStatus(jobId);
      if (refreshed) job = refreshed;
    }

    // Достигли max_iterations
    job.status = 'stalled';
    job.updatedAt = new Date().toISOString();
    saveJobRow(job);
    await notifyPush(`⚠️ Задача застряла: ${goal}`, 'high');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[osiris:autonomous] jobId=${jobId} failed:`, msg);
    const staleJob = await getJobStatus(jobId);
    if (staleJob) {
      staleJob.status = 'error';
      staleJob.error = msg;
      staleJob.updatedAt = new Date().toISOString();
      saveJobRow(staleJob);
    } else {
      // Если вдруг не нашли — обновить напрямую
      db.prepare(
        "UPDATE autonomous_jobs SET status='error', error=?, updated_at=? WHERE id=?",
      ).run(msg, new Date().toISOString(), jobId);
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function startAutonomousJob(
  userId: string,
  goal: string,
  jobId?: string,
): Promise<string> {
  ensureInit();
  const id = jobId ?? `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const job: AutonomousJob = {
    id,
    userId,
    goal,
    status: 'running',
    steps: [],
    result: null,
    error: null,
    iteration: 0,
    maxIterations: 20,
    createdAt: now,
    updatedAt: now,
  };
  saveJobRow(job);
  setImmediate(() => { void runJobLoop(id, userId, goal); });
  return id;
}
