/**
 * Оракул app-runner'а на `для_каждого` (регресс `7853a50`).
 *
 * Что было сломано. `для_каждого` компилируется в вызов `система.итератор.из`
 * (`src/compiler/codegen.ts`). В `7853a50` перегенерировали байткод-фикстуры
 * приложений — вызов появился в `micro_crm.osvbc.json` и
 * `game_rounds.osvbc.json`, — но app-runner (`src/runtime/vm-runner.ts`) своего
 * случая для него не получил: вызов проваливался в `default` и печатал
 * `invoke stub: система.итератор.из`, возвращая `null`. Ни один `для` не делал
 * ни одной итерации, Micro-CRM писал `total_balance = 0` вместо 65.
 *
 * Почему это не поймали. `npm run golden` — скрипт, а не тест: в `npm test` его
 * путь не участвует, поэтому провал дошёл до `npm run ci` и до выкладки. Здесь
 * приложения гоняются **тем же** путём, что в golden (`--in-process`, манифест
 * с аргументами), и проверяются те же ключи хранилища.
 *
 * Хранилище чистится перед прогоном: иначе ключ, оставшийся от прошлого запуска,
 * мог бы «пройти» проверку за приложение, которое ничего не записало.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { run } from './run';
import { storageRead, getStorageDir } from './storage';
import { GOLDEN_STORAGE_ROOT } from './goldenApps';

const FIXTURES = path.join(__dirname, 'fixtures');

async function cleanStore(appId: string): Promise<void> {
  await fs.rm(getStorageDir(GOLDEN_STORAGE_ROOT, appId), { recursive: true, force: true });
}

async function runApp(manifest: string): Promise<number> {
  return run(['--manifest', path.join(FIXTURES, manifest), '--ui', 'cli', '--in-process']);
}

async function readAll(appId: string, keys: readonly string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const key of keys) out[key] = await storageRead(GOLDEN_STORAGE_ROOT, appId, key);
  return out;
}

describe('app-runner: `для_каждого` через `система.итератор.из` (регресс 7853a50)', () => {
  it('Micro-CRM: считает по четырём клиентам, а не по нулю', async () => {
    await cleanStore('osnova.micro_crm');
    const code = await runApp('micro_crm.osapp.yaml');
    expect(code, 'приложение завершилось без ошибки').toBe(0);
    expect(
      await readAll('osnova.micro_crm', [
        'total_balance',
        'active_count',
        'balance_active',
        'active_or_new_count',
      ]),
      'те же ключи, что проверяет golden',
    ).toEqual({
      total_balance: '65',
      active_count: '2',
      balance_active: '30',
      active_or_new_count: '3',
    });
  });

  it('Game Rounds: считает по трём раундам', async () => {
    await cleanStore('osnova.game_rounds');
    const code = await runApp('game_rounds.osapp.yaml');
    expect(code).toBe(0);
    expect(await readAll('osnova.game_rounds', ['total_points', 'wins', 'bonus_wins'])).toEqual({
      total_points: '30',
      wins: '2',
      bonus_wins: '2',
    });
  });
});
