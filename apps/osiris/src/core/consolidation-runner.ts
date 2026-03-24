// apps/osiris/src/core/consolidation-runner.ts
import { consolidateFacts, getDistinctUserIds } from './memory-engine';

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 часа

export function startConsolidationCron(): void {
  console.log('[osiris:consolidation] cron started, interval=24h');
  setInterval(() => {
    void runConsolidationNow();
  }, INTERVAL_MS);
}

export async function runConsolidationNow(userId?: string): Promise<void> {
  const userIds = userId ? [userId] : getDistinctUserIds();
  if (userIds.length === 0) {
    console.log('[osiris:consolidation] no users with facts, skipping');
    return;
  }
  for (const uid of userIds) {
    try {
      const result = await consolidateFacts(uid);
      if (result.skipped) {
        console.log(`[osiris:consolidation] userId=${uid} skipped (too few facts)`);
      } else {
        console.log(
          `[osiris:consolidation] userId=${uid} removed=${result.factsRemoved} coreUpdated=${result.coreUpdated} summary="${result.summary}"`,
        );
      }
    } catch (e) {
      console.error(`[osiris:consolidation] userId=${uid} failed:`,
        e instanceof Error ? e.message : String(e));
    }
  }
}
