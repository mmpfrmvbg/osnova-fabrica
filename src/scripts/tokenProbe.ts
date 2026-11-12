// ============================================================
// src/scripts/tokenProbe.ts
//
// Замер РЕАЛЬНОЙ цены конструкций языка Основа в токенах DeepSeek.
//
// Зачем: кириллица в BPE-токенайзере фрагментируется иначе, чем латиница.
// Вопрос «сколько именно» до сих пор не был измерен — на него отвечает этот
// зонд. Решение по языку принимается ПО ЧИСЛАМ, а не по интуиции; при этом
// читаемость человека — жёсткое ограничение, поэтому замеряется в том числе
// вариант с сокращениями, чтобы увидеть, сколько он на самом деле экономит.
//
// Метод: chat/completions с max_tokens=1, thinking выключен. Текст оборачивается
// в постоянную рамку, поэтому разница prompt_tokens между пробами — это цена
// текста. Погрешность ±1-2 токена на границе «рамка/текст»: склейка BPE через
// границу не детерминирована по составу, но стабильна для одной рамки.
//
// Запуск: npx tsx src/scripts/tokenProbe.ts
// Выход:  .tmp/token-probe.json + markdown-таблица в stdout
// ============================================================
import * as fs from 'fs';
import * as path from 'path';

const API = 'https://api.deepseek.com/beta/chat/completions';
const MODEL = process.env.OSNOVA_PROBE_MODEL ?? 'deepseek-flash';
const CONCURRENCY = 3;
const OUT = path.resolve('.tmp', 'token-probe.json');

// --- .env без зависимости dotenv (как в src/cli.ts) ---
function loadApiKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const p = path.resolve('.env');
  if (!fs.existsSync(p)) throw new Error('Нет DEEPSEEK_API_KEY и нет .env');
  for (const raw of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k === 'DEEPSEEK_API_KEY' && v.length > 0) return v;
  }
  throw new Error('DEEPSEEK_API_KEY не найден');
}

interface Measurement {
  prompt: number;
  cacheHit: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function measureOnce(apiKey: string, text: string): Promise<Measurement> {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: text }],
    max_tokens: 1,
    stream: false,
    thinking: { type: 'disabled' },
  };
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    usage?: { prompt_tokens?: number; prompt_cache_hit_tokens?: number };
  };
  return {
    prompt: data.usage?.prompt_tokens ?? -1,
    cacheHit: data.usage?.prompt_cache_hit_tokens ?? 0,
  };
}

async function measure(apiKey: string, text: string): Promise<Measurement> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await measureOnce(apiKey, text);
    } catch (err) {
      lastErr = err;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// --- постоянная рамка: разница между пробами = цена текста ---
const frame = (t: string) => `<osnova>\n${t}\n</osnova>`;

interface Probe {
  group: string;
  name: string;
  text: string;
}

// ============================================================
// Пробы
// ============================================================
const OP_BODY = [
  '  система.лог.вывести("Приложение Задачи v1")',
  '  пусть ключ = "задача:тест-001"',
  '  система.хранилище.записать(ключ, "x")',
  'конец',
].join('\n');

const TODO_AS_IS = `модуль ТудуПриложение

процедура главная()
  система.лог.вывести("Приложение Задачи v1")
  пусть ключ = "задача:тест-001"
  пусть значение = "Тестовая задача|osnova|inbox|3"
  система.хранилище.записать(ключ, значение)
  пусть прочитано = система.хранилище.прочитать(ключ)
  система.лог.вывести(система.строка.объединить("Прочитано: ", прочитано))
  пусть ключи = система.хранилище.ключи()
  пусть кол = система.массив.длина(ключи)
  система.лог.вывести(система.строка.объединить("Ключей в хранилище: ", кол))
конец

конец`;

const TODO_LATIN_IDS = `модуль TodoApp

процедура main()
  система.лог.вывести("Приложение Задачи v1")
  пусть key = "задача:тест-001"
  пусть value = "Тестовая задача|osnova|inbox|3"
  система.хранилище.записать(key, value)
  пусть readBack = система.хранилище.прочитать(key)
  система.лог.вывести(система.строка.объединить("Прочитано: ", readBack))
  пусть keys = система.хранилище.ключи()
  пусть count = система.массив.длина(keys)
  система.лог.вывести(система.строка.объединить("Ключей в хранилище: ", count))
конец

конец`;

const TODO_ABBREV = `модуль TdApp

процедура mn()
  система.лог.вывести("Приложение Задачи v1")
  пусть k = "задача:тест-001"
  пусть v = "Тестовая задача|osnova|inbox|3"
  система.хранилище.записать(k, v)
  пусть rb = система.хранилище.прочитать(k)
  система.лог.вывести(система.строка.объединить("Прочитано: ", rb))
  пусть ks = система.хранилище.ключи()
  пусть cnt = система.массив.длина(ks)
  система.лог.вывести(система.строка.объединить("Ключей в хранилище: ", cnt))
конец

конец`;

const TODO_ENGLISH = `module TodoApp

procedure main()
  log.print("Приложение Задачи v1")
  let key = "задача:тест-001"
  let value = "Тестовая задача|osnova|inbox|3"
  storage.write(key, value)
  let readBack = storage.read(key)
  log.print(concat("Прочитано: ", readBack))
  let keys = storage.keys()
  let count = array.length(keys)
  log.print(concat("Ключей в хранилище: ", count))
end

end`;

const TODO_RECOMMENDED = `модуль ТудуПриложение

использовать хранилище
использовать лог
использовать массив
использовать строка

процедура главная()
  лог.вывести("Приложение Задачи v1")
  пусть ключ = "задача:тест-001"
  пусть значение = "Тестовая задача|osnova|inbox|3"
  хранилище.записать(ключ, значение)
  пусть прочитано = хранилище.прочитать(ключ)
  лог.вывести(строка.объединить("Прочитано: ", прочитано))
  пусть ключи = хранилище.ключи()
  пусть кол = массив.длина(ключи)
  лог.вывести(строка.объединить("Ключей в хранилище: ", кол))
конец

конец`;

// --- механическая проверка namespace-алиасов на реальном файле ---
// Гипотеза «подключить namespace и писать короче» проверяется не рассуждением,
// а преобразованием настоящего файла: `система.X.` → `X.` + строки `использовать X`.
// ВНИМАНИЕ: \w в JS (без флага u) НЕ матчит кириллицу. Первая версия зонда
// использовала \w — пространства имён не находились, преобразование молча
// возвращало исходный текст, и обе пробы давали одинаковое число, которое
// читалось как «алиасы не влияют». Сторож ниже делает такое молчание громким.
const NS_RE = /система\.([а-яёА-ЯЁa-zA-Z0-9_]+)\./g;
const CORE_PATH = path.resolve('apps', 'task-manager', 'tasks_core.osnova');
const CORE_AS_IS = fs.readFileSync(CORE_PATH, 'utf-8').trimEnd();
const CORE_NS = [...new Set([...CORE_AS_IS.matchAll(NS_RE)].map((m) => m[1]!))].sort();
const CORE_USE_COUNTS: Record<string, number> = Object.fromEntries(
  CORE_NS.map((ns) => [ns, [...CORE_AS_IS.matchAll(new RegExp(`система\\.${ns}\\.`, 'g'))].length]),
);
const CORE_ALIASED = CORE_AS_IS
  .replace(/^(модуль .*)$/m, `$1\n\n${CORE_NS.map((ns) => `использовать ${ns}`).join('\n')}`)
  .replace(NS_RE, '$1.');

if (CORE_NS.length === 0 || CORE_ALIASED === CORE_AS_IS) {
  throw new Error(
    'tokenProbe: преобразование namespace не сработало (CORE_NS пуст или текст не изменился) — ' +
      'замер был бы ложным',
  );
}

const SKELETON = `модуль Тест

процедура главная()
конец

конец`;

const probes: Probe[] = [
  // --- одиночные ключевые слова: кириллица против латиницы ---
  { group: 'ключевое слово', name: 'если', text: 'если' },
  { group: 'ключевое слово', name: 'if', text: 'if' },
  { group: 'ключевое слово', name: 'иначе', text: 'иначе' },
  { group: 'ключевое слово', name: 'else', text: 'else' },
  { group: 'ключевое слово', name: 'пока', text: 'пока' },
  { group: 'ключевое слово', name: 'while', text: 'while' },
  { group: 'ключевое слово', name: 'вернуть', text: 'вернуть' },
  { group: 'ключевое слово', name: 'return', text: 'return' },
  { group: 'ключевое слово', name: 'процедура', text: 'процедура' },
  { group: 'ключевое слово', name: 'function', text: 'function' },
  { group: 'ключевое слово', name: 'конец', text: 'конец' },
  { group: 'ключевое слово', name: 'end', text: 'end' },
  { group: 'ключевое слово', name: 'пусть', text: 'пусть' },
  { group: 'ключевое слово', name: 'let', text: 'let' },
  { group: 'ключевое слово', name: 'прервать', text: 'прервать' },
  { group: 'ключевое слово', name: 'продолжить', text: 'продолжить' },
  { group: 'ключевое слово', name: 'истина', text: 'истина' },
  { group: 'ключевое слово', name: 'true', text: 'true' },

  // --- составные ключевые слова: подчёркивание против естественного русского ---
  { group: 'составное ключевое', name: 'для_каждого', text: 'для_каждого' },
  { group: 'составное ключевое', name: 'для каждого', text: 'для каждого' },
  { group: 'составное ключевое', name: 'foreach', text: 'foreach' },
  { group: 'составное ключевое', name: 'for each', text: 'for each' },
  { group: 'составное ключевое', name: 'иначе_попытка', text: 'иначе_попытка' },
  { group: 'составное ключевое', name: 'при ошибке', text: 'при ошибке' },
  { group: 'составное ключевое', name: 'catch', text: 'catch' },
  { group: 'составное ключевое', name: 'попробовать', text: 'попробовать' },
  { group: 'составное ключевое', name: 'try', text: 'try' },
  { group: 'составное ключевое', name: 'выбросить', text: 'выбросить' },
  { group: 'составное ключевое', name: 'throw', text: 'throw' },

  // --- системные вызовы: длинное точечное имя против короткого ---
  { group: 'системный вызов', name: 'система.лог.вывести', text: 'система.лог.вывести' },
  { group: 'системный вызов', name: 'log.print', text: 'log.print' },
  {
    group: 'системный вызов',
    name: 'система.хранилище.записать(ключ, значение)',
    text: 'система.хранилище.записать(ключ, значение)',
  },
  {
    group: 'системный вызов',
    name: 'storage.write(key, value)',
    text: 'storage.write(key, value)',
  },
  {
    group: 'системный вызов',
    name: 'система.массив.длина(ключи)',
    text: 'система.массив.длина(ключи)',
  },
  { group: 'системный вызов', name: 'array.length(keys)', text: 'array.length(keys)' },

  // --- строки кода целиком ---
  { group: 'строка кода', name: 'для_каждого x в arr', text: 'для_каждого x в arr' },
  { group: 'строка кода', name: 'for x in arr', text: 'for x in arr' },
  {
    group: 'строка кода',
    name: 'пусть сумма = система.массив.длина(arr)',
    text: 'пусть сумма = система.массив.длина(arr)',
  },
  {
    group: 'строка кода',
    name: 'пусть сумма = длина(arr)  (алиас/импорт)',
    text: 'пусть сумма = длина(arr)',
  },
  { group: 'строка кода', name: 'если x > 0 тогда', text: 'если x > 0 тогда' },
  { group: 'строка кода', name: 'если x > 0  (без тогда)', text: 'если x > 0' },

  // --- обряд: несущая конструкция против полезного тела ---
  { group: 'обряд', name: 'скелет модуля (модуль/процедура/2×конец)', text: SKELETON },
  { group: 'обряд', name: 'тело (4 строки без скелета)', text: OP_BODY },

  // --- алиасы системных вызовов: сокращать длину или подключать namespace ---
  { group: 'алиас вызова', name: 'использовать хранилище', text: 'использовать хранилище' },
  { group: 'алиас вызова', name: 'лог.вывести', text: 'лог.вывести' },
  { group: 'алиас вызова', name: 'хранилище.записать(ключ, значение)', text: 'хранилище.записать(ключ, значение)' },
  { group: 'алиас вызова', name: 'массив.длина(ключи)', text: 'массив.длина(ключи)' },
  { group: 'алиас вызова', name: 'строка.объединить("a", "b")', text: 'строка.объединить("a", "b")' },
  { group: 'строка кода', name: 'для каждого x в arr', text: 'для каждого x в arr' },

  // --- реальное приложение ---
  { group: 'приложение', name: 'todo.osnova — как есть', text: TODO_AS_IS },
  { group: 'приложение', name: 'todo — латинские идентификаторы', text: TODO_LATIN_IDS },
  { group: 'приложение', name: 'todo — сокращённые идентификаторы', text: TODO_ABBREV },
  { group: 'приложение', name: 'todo — всё латиницей (гипотетически)', text: TODO_ENGLISH },
  { group: 'приложение', name: 'todo — естественный русский + namespace (гипотеза)', text: TODO_RECOMMENDED },
  { group: 'приложение', name: 'tasks_core.osnova — как есть (72 строки)', text: CORE_AS_IS },
  { group: 'приложение', name: 'tasks_core.osnova — с namespace-алиасами', text: CORE_ALIASED },
];

// ============================================================
// Прогон
// ============================================================
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const apiKey = loadApiKey();

  process.stderr.write(`[token-probe] модель: ${MODEL}\n`);
  const base = await measure(apiKey, frame(''));
  process.stderr.write(`[token-probe] рамка без текста: ${base.prompt} токенов\n`);

  const results = await pool(probes, CONCURRENCY, async (p) => {
    const m = await measure(apiKey, frame(p.text));
    const cost = m.prompt - base.prompt;
    process.stderr.write(`[token-probe] ${p.group} / ${p.name}: ${m.prompt} (текст ≈ ${cost})\n`);
    return { ...p, prompt: m.prompt, cost, cacheHit: m.cacheHit };
  });

  // --- демонстрация контекстного кэша: тот же текст дважды ---
  const cacheText = frame(['// ' + 'я'.repeat(20)].join('\n') + '\n' + TODO_AS_IS.repeat(6));
  const c1 = await measure(apiKey, cacheText);
  await sleep(2000);
  const c2 = await measure(apiKey, cacheText);
  const cache = { first: c1, second: c2 };

  const payload = {
    model: MODEL,
    measuredAt: new Date().toISOString(),
    frameBaseline: base.prompt,
    results,
    cache,
    coreNamespaceUse: CORE_USE_COUNTS,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf-8');

  // --- markdown ---
  const lines: string[] = [];
  lines.push('| группа | проба | prompt_tokens | цена текста |');
  lines.push('|---|---|---:|---:|');
  for (const r of results) {
    lines.push(`| ${r.group} | \`${r.name}\` | ${r.prompt} | ${r.cost} |`);
  }
  const md = lines.join('\n');
  process.stdout.write('\n' + md + '\n');
  process.stdout.write(
    `\nрамка: ${base.prompt}; кэш: 1-й вызов prompt=${c1.prompt} hit=${c1.cacheHit}, ` +
      `2-й prompt=${c2.prompt} hit=${c2.cacheHit}\n`,
  );
  fs.writeFileSync(path.resolve('.tmp', 'token-probe.md'), md + '\n', 'utf-8');
  process.stderr.write(`[token-probe] записано: ${OUT}\n`);
}

main().catch((err) => {
  process.stderr.write(`[token-probe] ОШИБКА: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
