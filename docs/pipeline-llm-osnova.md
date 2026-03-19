---
> ⚠️ **Статус: исторический референтный дизайн-документ.**
> Описывает архитектуру предыдущего поколения пайплайна (trace-format-v0.1, богатый IR-трейс).
> 
> **Актуальная реализация:** [`src/pipeline/orchestrator.ts`](../src/pipeline/orchestrator.ts)  
> **Актуальная спецификация:** [`docs/pipeline-v1.md`](pipeline-v1.md)  
> **Актуальный формат трейсов:** [`docs/traces-v1.md`](traces-v1.md)
>
> ⚠️ Внимание: примеры в этом документе используют `модуль <имя>;` (с точкой с запятой)
> и `grammatika-v0.1` — это устаревший синтаксис. Актуальный синтаксис — без `;`,
> блоки через `конец`. Источник истины: [`docs/language-v1.md`](language-v1.md).
---

## Скрипт пайплайна: спека → LLM → Основа → тулчейн → golden‑тесты

Этот документ описывает **референтный скрипт/пайплайн**, который:

1. Берёт входную спеки/IR (например, `spec.yaml` или JSON‑IR фабрики).
2. Формирует промпт под базовую LLM.
3. Вызывает LLM (через HTTP API или локальный рантайм).
4. Сохраняет ответ как `osnova.source`.
5. Прогоняет через тулчейн Основа (лексер → парсер → компилятор).
6. Сравнивает результат с `docs/osnova/golden-tests.json` (если есть `golden.id`).
7. Пишет трейс в формате `trace-format-v0.1.md` в файл `traces.jsonl` (одна строка JSON на один прогон).

Файл не привязан к конкретному языку реализации, но ниже есть пример на псевдо‑TypeScript/Node.

---

## 1. Высокоуровневая схема

```text
spec.yaml / IR
    ↓
buildPrompt(spec, ir)        // формирование промпта
    ↓
callLLM(prompt)              // HTTP / локальная модель
    ↓
osnovaSource                 // текст на языке Основа
    ↓
runToolchain(osnovaSource)   // лексер → парсер → компилятор
    ↓
compareWithGolden(...)       // опционально, если golden.id задан
    ↓
writeTraceJsonl(...)         // по trace-format-v0.1.md
```

---

## 2. Формирование промпта (`buildPrompt`) с few‑shot из трейсов

Промпт имеет три уровня:

1. **Базовый** — требования + спека.
2. **Выдержка из реестра языка** (рекомендуется) — список реализованных ключевых слов и шаблоны конструкций из единого источника правды (`docs/osnova/language-registry.md`, `language-schema.json`). При изменении языка достаточно обновить реестр — генератор автоматически получит актуальный синтаксис без ручного правления промптами.
3. **Few‑shot** — несколько (2–4) лучших прошлых прогонов из трейсов/golden‑тестов.

### 2.1. Реестр языка в промпте

Источник правды о языке: `src/tools/osnova-compiler/language-registry.ts` и экспорт `docs/osnova/language-schema.json`. В промпт можно подставлять:

- перечень **реализованных ключевых слов** (`keywords[].implemented === true`): `модуль`, `процедура`, `пусть`, `если`, `иначе`, `пока`, `для_каждого`, `в`, `цикл`, `конец`, `вернуть`, `истина`, `ложь`, `пусто`, `и`, `или`, `не`;
- **шаблоны конструкций** (`constructs[].syntax` и при необходимости `bytecodePattern`): например «`для_каждого <переменная> в <выражение> ... конец`», «`<левый> и <правый>` (short-circuit)», «`не <выражение>`».

Так LLM ограничивается только допустимым синтаксисом; при добавлении новых конструкций в реестр достаточно перегенерировать JSON (`npx tsx src/tools/osnova-compiler/export-language-schema.ts`) и подставлять его (или выдержку) в промпт. Версия языка в реестре согласована с `meta.osnova_version` в трейсах и с `minOsnovaVersion` в реестре приложений.

### 2.2. Базовый промпт

Каркас (когда нет примеров):

```text
Сгенерируй модуль на языке «Основа» по следующей спецификации.

Требования:
- модуль должен начинаться с `модуль <имя>;`
- использовать только конструкции, описанные в грамматике v0.1
- код должен быть самодостаточным и компилироваться компилятором Основа v0.1

Спека:
```yaml
<SPec-YAML/IR как текст или краткая выжимка>
```

Ответь только кодом на языке «Основа» в одном блоке:
```основа
...
```
```

### 2.3. Банк лучших примеров из трейсов

Отдельным процессом собирается `best-examples.json` (на основе `traces.jsonl`):

- критерии попадания:
  - `compiler.success == true`;
  - если есть `golden`: `golden.results.lexer_ok && parser_ok && compiler_ok`;
  - `feedback.rating >= 4` (или нет фидбека, но golden‑проверка прошла).
- структура примера:

```json
{
  "id": "test3_proc_let_assign_call",
  "category": "crm",
  "spec_snippet": "<укороченный YAML спеки>",
  "osnova_snippet": "<укороченный модуль Основа>"
}
```

### 2.4. Выбор few‑shot под текущую спека

```ts
interface Example {
  id: string;
  category: string;
  spec_snippet: string;
  osnova_snippet: string;
}

function inferCategoryFromSpec(spec: any): string {
  // грубая эвристика по полям spec.yaml (crm/todo/game/utility/...)
  return "generic";
}

function selectFewShotExamples(
  spec: any,
  examplesBank: Example[],
  k: number = 3
): Example[] {
  const category = inferCategoryFromSpec(spec);
  const same = examplesBank.filter(e => e.category === category);
  const pool = same.length ? same : examplesBank;
  return pool.slice(0, k); // далее можно усложнить сортировку по длине/рангу
}
```

### 2.5. Полный `buildPrompt` с few‑shot

```ts
function buildPrompt(spec: any, ir: any, examplesBank: Example[]): string {
  const specSnippet = YAML.stringify(spec).slice(0, 2000); // ограничить длину
  const fewShots = selectFewShotExamples(spec, examplesBank, 2); // 2–4 примера

  const parts: string[] = [];

  parts.push("Ты — генератор модулей на языке «Основа».", "");

  if (fewShots.length) {
    parts.push(
      "Ниже несколько примеров спецификаций и соответствующих модулей на Основе.",
      "Следуй их стилю, синтаксису и структуре.",
      ""
    );

    fewShots.forEach((ex, idx) => {
      parts.push(`=== Пример ${idx + 1} ===`);
      parts.push("Спека:");
      parts.push("```yaml");
      parts.push(ex.spec_snippet);
      parts.push("```", "");
      parts.push("Модуль на «Основа»:");
      parts.push("```основа");
      parts.push(ex.osnova_snippet);
      parts.push("```", "");
    });
  }

  parts.push("=== Твоя задача ===");
  parts.push("Сгенерируй модуль на языке «Основа» по следующей спецификации.", "");
  parts.push("Требования:");
  parts.push("- модуль должен начинаться с `модуль <имя>;`");
  parts.push("- использовать только конструкции, описанные в грамматике v0.1");
  parts.push("- код должен быть самодостаточным и компилироваться компилятором Основа v0.1", "");
  parts.push("Спека:");
  parts.push("```yaml");
  parts.push(specSnippet);
  parts.push("```", "");
  parts.push("Ответь только кодом на языке «Основа» в одном блоке:");
  parts.push("```основа");
  parts.push("// твой код здесь");
  parts.push("```");

  return parts.join("\n");
}
```

Если `examplesBank` пуст (мало трейсов) — функция автоматически даёт базовый промпт без примеров.

---

## 3. Вызов LLM (`callLLM`)

Абстрактный интерфейс:

```ts
interface LLMResponse {
  raw: string;        // полный ответ
  code: string;       // извлечённый блок кода Основа
}

async function callLLM(prompt: string): Promise<LLMResponse> {
  const res = await fetch(LLM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: "base-llm-name",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  }).then(r => r.json());

  const raw = res.choices[0].message.content as string;
  const code = extractOsnovaCode(raw); // вырезать ```основа ... ```
  return { raw, code };
}
```

Функция `extractOsnovaCode(raw)`:

- ищет первый блок вида ` ```основа ... ``` ` или ` ``` ... ``` `;
- если не находит — использует весь ответ как код.

---

## 4. Прогон через тулчейн (`runToolchain`)

Интерфейс:

```ts
interface ToolchainResult {
  source: string;
  lexer: {
    tokens: LexerToken[];
    errors: LexerError[];
  };
  ast: any;           // сериализованный AST
  types?: any;        // опционально, результаты типизации
  compiler: {
    success: boolean;
    errors: CompilerError[];
    bytecode?: {
      summary: any;
      functions?: any[];
    };
  };
}
```

Пайплайн:

```ts
function runToolchain(osnovaSource: string): ToolchainResult {
  const lexerResult = tokenize(osnovaSource);    // по lexer-v0.1.md
  const parseResult = parse(lexerResult.tokens); // по parser-v0.1.md

  let types = null;
  let compiler = { success: false, errors: [], bytecode: undefined };

  if (!parseResult.errors.length) {
    const typeCheckResult = typeCheck(parseResult.ast);
    const compileResult = compileToBytecode(parseResult.ast);
    types = typeCheckResult;
    compiler = compileResult;
  } else {
    compiler.errors = parseResult.errors;
  }

  return {
    source: osnovaSource,
    lexer: lexerResult,
    ast: parseResult.ast,
    types,
    compiler
  };
}
```

Реальные функции `tokenize/parse/typeCheck/compileToBytecode` — это конкретная реализация тулчейна Основа.

---

## 5. Сравнение с golden‑тестами (`compareWithGolden`)

Если для текущего запуска известно, какой **golden‑тест** применим (например, `golden_id` в спеках), скрипт может сверить результат с `docs/osnova/golden-tests.json`.

```ts
interface GoldenResult {
  id: string;
  lexer_ok: boolean;
  parser_ok: boolean;
  compiler_ok: boolean;
}

function compareWithGolden(
  goldenId: string | null,
  toolchain: ToolchainResult,
  goldenSuite: any
): GoldenResult | null {
  if (!goldenId) return null;
  const test = goldenSuite.tests.find((t: any) => t.id === goldenId);
  if (!test) return null;

  const lexer_ok = compareLexer(toolchain.lexer, test.expectLexer);
  const parser_ok = compareParser(toolchain.ast, test.expectParser);
  const compiler_ok = compareCompiler(toolchain.compiler, test.expectCompiler);

  return { id: goldenId, lexer_ok, parser_ok, compiler_ok };
}
```

Функции `compareLexer/compareParser/compareCompiler` должны:

- сравнивать только те части, которые заданы в golden (kind/sequence/nodes/opcodes);
- быть достаточно «мягкими», чтобы выдерживать несущественные отличия.

---

## 6. Запись трейса (`writeTraceJsonl`)

Формат трейсинга описан в `trace-format-v0.1.md`. Скрипт должен собрать соответствующий объект и дописать строку в файл:

```ts
async function writeTraceJsonl(
  tracePath: string,
  base: {
    trace_id: string;
    timestamp: string;
    meta: any;
    input: any;
  },
  toolchain: ToolchainResult,
  goldenResult: GoldenResult | null,
  feedback?: any
) {
  const record = {
    // обязательный минимум по trace-format-v0.1.md, п.13
    trace_id: base.trace_id,
    timestamp: base.timestamp,
    meta: base.meta,       // osnova_version, fabrica_version, model_version
    input: base.input,     // kind + payload (нормализованный spec/IR)

    osnova: { source: toolchain.source },
    lexer: {
      tokens: toolchain.lexer.tokens,
      errors: toolchain.lexer.errors
    },
    tokenization: {
      // если есть модельная токенизация — пишем input_tokens,
      // иначе можно опустить или заполнить позже
      input_tokens: []
    },
    ast: { root: toolchain.ast },
    compiler: {
      success: toolchain.compiler.success,
      errors: toolchain.compiler.errors,
      bytecode: toolchain.compiler.bytecode?.summary
        ? { summary: toolchain.compiler.bytecode.summary }
        : undefined
    },
    golden: goldenResult,
    feedback: feedback || null,
    env: {
      os: process.platform,
      arch: process.arch
    }
  };

  await fs.promises.appendFile(tracePath, JSON.stringify(record) + "\n", "utf8");
}
```

---

## 7. Объединённый псевдокод `runPipeline`

```ts
async function runPipeline(specPath: string, options: { goldenId?: string }) {
  const spec = await loadSpec(specPath);          // прочитать spec.yaml
  const ir = buildIR(spec);                      // опционально, если есть IR

  const prompt = buildPrompt(spec, ir);
  const llm = await callLLM(prompt);

  const toolchain = runToolchain(llm.code);

  const goldenSuite = await loadGoldenSuite("docs/osnova/golden-tests.json");
  const goldenResult = compareWithGolden(options.goldenId || null, toolchain, goldenSuite);

  const now = new Date().toISOString();
  await writeTraceJsonl("traces.jsonl",
    {
      trace_id: generateUuid(),
      timestamp: now,
      meta: {
        osnova_version: "0.1.0",
        fabrica_version: "dev",
        model_version: "base-llm-name"
      },
      input: { kind: "spec_yaml", payload: spec }
    },
    toolchain,
    goldenResult
  );

  return { llm, toolchain, goldenResult };
}
```

---

## 8. Итог

Этот документ задаёт **каркас скрипта**, который:

- автоматически прогоняет цепочку «спека → LLM → Основа → тулчейн → golden‑тесты»;
- записывает всё нужное в трейс‑формате для будущего обучения;
- использует уже описанные спеки: `grammatika-v0.1.md`, `lexer-v0.1.md`, `parser-v0.1.md`, `compiler-v0.1.md`, `golden-tests.json`, `trace-format-v0.1.md`, `tokenization-v0.1.md`, реестр языка `language-registry.md` / `language-schema.json`. Golden-приложения (TODO, File Viewer, Notifications, **Micro-CRM**, **Game Rounds**) описаны в `golden-tests.md` и в отдельных файлах `golden-app-todo.md`, `golden-app-viewer.md`, `golden-app-micro-crm.md`, `golden-app-game-rounds.md`; Micro-CRM — пример категории **crm** (`для_каждого`, `и`/`или`, объекты, хранилище); Game Rounds — пример категории **game** (раунды, очки, победы, условие с `и`).

Реальная реализация может быть на TypeScript/Node, Python или любом другом языке, пока соблюдается этот формат ввода/вывода и логика шагов.

