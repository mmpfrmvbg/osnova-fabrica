// apps/osiris/src/core/proactive-engine.ts
import {
  getTasks,
  getRecentMessages,
  getRecentFacts,
  getCoreMemory,
  updateCoreMemory,
  generateRecurrenceNextIfNeeded,
} from './memory-engine';
import { shellExec, notifyPush } from './tools/system-tools';
import { getDb } from '../db/migrations';

// ── helpers ────────────────────────────────────────────────────────────────

function daysBetween(isoA: string, isoB: string): number {
  return Math.abs(Date.parse(isoB) - Date.parse(isoA)) / (1000 * 60 * 60 * 24);
}

function hoursBetween(isoA: string, isoB: string): number {
  return Math.abs(Date.parse(isoB) - Date.parse(isoA)) / (1000 * 60 * 60);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ── triggers ───────────────────────────────────────────────────────────────

async function triggerStaleTask(userId: string): Promise<void> {
  const tasks = getTasks(userId, 'open');
  const now = new Date().toISOString();
  const stale = tasks.find((t) => daysBetween(t.updatedAt, now) > 3);
  if (!stale) return;
  await notifyPush(`Задача без активности: "${stale.title}"`, 'low');
  console.log(`[osiris:proactive] stale task triggered userId=${userId} taskId=${stale.id}`);
}

async function triggerNewCommit(userId: string): Promise<void> {
  let lastKnown: string | null = null;
  try {
    const core = await getCoreMemory(userId);
    const meta = core.meta as unknown as Record<string, unknown>;
    lastKnown = typeof meta['last_known_commit'] === 'string'
      ? meta['last_known_commit']
      : null;
  } catch {
    lastKnown = null;
  }

  // Получить последний коммит через git log
  let newSha = '';
  let commitMsg = '';
  try {
    const result = await shellExec('git log -1 --format="%H %s"');
    const line = (result.stdout ?? '').trim();
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx > 0) {
      newSha = line.slice(0, spaceIdx);
      commitMsg = line.slice(spaceIdx + 1).replace(/^"|"$/g, '');
    }
  } catch {
    return; // git недоступен — пропускаем триггер
  }

  if (!newSha || newSha === lastKnown) return;

  const shortSha = newSha.slice(0, 7);
  await notifyPush(`Новый коммит: ${shortSha} — ${commitMsg}`, 'normal');
  await updateCoreMemory(userId, {
    meta: { last_known_commit: newSha } as unknown as Parameters<typeof updateCoreMemory>[1]['meta'],
  });
  console.log(`[osiris:proactive] new commit triggered userId=${userId} sha=${shortSha}`);
}

async function triggerSilence(userId: string): Promise<void> {
  const core = await getCoreMemory(userId);
  const meta = core.meta as unknown as Record<string, unknown>;
  const lastSilencePush = typeof meta['last_silence_push'] === 'string'
    ? meta['last_silence_push']
    : null;
  const now = new Date().toISOString();

  // Не спамить чаще раза в 12 часов
  if (lastSilencePush && hoursBetween(lastSilencePush, now) < 12) return;

  const messages = await getRecentMessages(userId, 1);
  if (messages.length === 0) return;
  const lastMsg = messages[0];
  if (hoursBetween(lastMsg.timestamp, now) < 12) return;

  await notifyPush('Всё ок?', 'low');
  await updateCoreMemory(userId, {
    meta: { last_silence_push: now } as unknown as Parameters<typeof updateCoreMemory>[1]['meta'],
  });
  console.log(`[osiris:proactive] silence triggered userId=${userId}`);
}

async function triggerDailySummary(userId: string): Promise<void> {
  const hour = new Date().getHours();
  if (hour < 22) return;

  const core = await getCoreMemory(userId);
  const meta = core.meta as unknown as Record<string, unknown>;
  const lastSummaryDate = typeof meta['last_daily_summary'] === 'string'
    ? meta['last_daily_summary']
    : null;
  const today = todayIso();
  if (lastSummaryDate === today) return; // уже отправляли сегодня

  const openTasks = getTasks(userId, 'open');
  const recentFacts = await getRecentFacts(userId, 5);
  const factsText = recentFacts.length > 0
    ? recentFacts.map((f) => f.text).join('; ')
    : 'нет новых фактов';
  const text =
    `Итог дня: ${openTasks.length} задач открыто. ` +
    `Последние факты: ${factsText}`;

  await notifyPush(text, 'normal');
  await updateCoreMemory(userId, {
    meta: { last_daily_summary: today } as unknown as Parameters<typeof updateCoreMemory>[1]['meta'],
  });
  console.log(`[osiris:proactive] daily summary triggered userId=${userId}`);
}

async function triggerBlockedTasks(userId: string): Promise<void> {
  const tasks = getTasks(userId, 'open');
  const now = new Date().toISOString();
  const blocked = tasks.find((t) => t.workflowStatus === 'blocked' && daysBetween(t.updatedAt, now) >= 1);
  if (!blocked) return;
  await notifyPush(`Задача заблокирована: "${blocked.title}"`, 'normal');
  console.log(`[osiris:proactive] blocked task triggered userId=${userId} taskId=${blocked.id}`);
}

async function triggerRecurrenceDue(userId: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const rows = db.prepare(
    `SELECT id
     FROM tasks
     WHERE user_id = ?
       AND workflow_status = 'done'
       AND recurrence_rule IS NOT NULL
       AND recurrence_last_generated_at IS NULL
     LIMIT 20`,
  ).all(userId) as Array<{ id: number }>;

  for (const r of rows) {
    try {
      const newTaskId = generateRecurrenceNextIfNeeded(userId, r.id, { actor: 'system' });
      if (newTaskId) {
        console.log(`[osiris:proactive] recurrence generated userId=${userId} fromTaskId=${r.id} newTaskId=${newTaskId}`);
      }
    } catch (e) {
      console.error(`[osiris:proactive] recurrence failed for taskId=${r.id}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

// ── public API ─────────────────────────────────────────────────────────────

export async function checkProactiveTriggers(userId: string): Promise<void> {
  try { await triggerStaleTask(userId); } catch (e) {
    console.error('[osiris:proactive] triggerStaleTask failed:', e instanceof Error ? e.message : String(e));
  }
  try { await triggerNewCommit(userId); } catch (e) {
    console.error('[osiris:proactive] triggerNewCommit failed:', e instanceof Error ? e.message : String(e));
  }
  try { await triggerSilence(userId); } catch (e) {
    console.error('[osiris:proactive] triggerSilence failed:', e instanceof Error ? e.message : String(e));
  }
  try { await triggerDailySummary(userId); } catch (e) {
    console.error('[osiris:proactive] triggerDailySummary failed:', e instanceof Error ? e.message : String(e));
  }
  try { await triggerBlockedTasks(userId); } catch (e) {
    console.error('[osiris:proactive] triggerBlockedTasks failed:', e instanceof Error ? e.message : String(e));
  }
  try { await triggerRecurrenceDue(userId); } catch (e) {
    console.error('[osiris:proactive] triggerRecurrenceDue failed:', e instanceof Error ? e.message : String(e));
  }
}
