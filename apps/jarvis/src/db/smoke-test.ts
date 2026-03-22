// apps/jarvis/src/db/smoke-test.ts
// Smoke-тест SQLite layer. Запустить: npm run db:smoke

import { migrate, closeDb } from './migrations';
import { saveMessage, saveFacts, getRelevantFacts, getRecentMessages } from '../core/memory-engine';

async function main(): Promise<void> {
  console.log('─── Jarvis SQLite smoke-test ───');

  migrate();
  console.log('✅ migrate() done');

  const msgId = await saveMessage({
    userId: 'test-user',
    chatId: 'test-chat',
    messageId: '1',
    role: 'user',
    text: 'нужно сфокусироваться на фабрике кодогенерации',
    timestamp: new Date().toISOString(),
    tags: ['osnova', 'фабрика'],
    projectHint: 'osnova',
    sessionId: null,
    rawJson: null,
  });
  console.log(`✅ saveMessage() → id=${msgId}`);

  const facts = await saveFacts(
    [
      {
        kind: 'decision',
        project: 'osnova',
        text: 'фокус на фабрике кодогенерации',
        importance: 5,
        sourceMessageId: msgId,
      },
      {
        kind: 'tech',
        project: 'osnova',
        text: 'язык Основа компилируется в байткод',
        importance: 4,
      },
    ],
    msgId,
  );
  console.log(`✅ saveFacts() → ids=${facts.map((f) => f.id).join(', ')}`);

  const found = await getRelevantFacts('фабрика', 'osnova', 5);
  console.log(`✅ getRelevantFacts('фабрика', 'osnova') → ${found.length} facts`);
  if (found.length > 0) {
    console.log('   первый факт:', found[0]!.text);
  }

  const msgs = await getRecentMessages('osnova', 5);
  console.log(`✅ getRecentMessages('osnova') → ${msgs.length} messages`);

  closeDb();
  console.log('─── SQLite OK ✅ ───');
}

main().catch((e) => {
  console.error('❌ smoke-test FAILED:', e);
  process.exit(1);
});
