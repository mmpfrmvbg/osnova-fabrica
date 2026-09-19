<!-- doc-status: frozen -->
# Трейнинг LLM по трейсам Основа v0.1

Цель: описать **референтный тренинг‑скрипт**, который:

1. Читает `traces.jsonl` (формат в `traces-v1.md`, источник истины: `src/trace/types.ts`).
2. Извлекает из него пары (вход → целевой код на Основа).
3. Токенизирует данные по `tokenization-v0.1.md`.
4. Дообучает выбранную базовую модель (LoRA или обычный SFT).

Эталонная реализация: `src/scripts/export-dataset.ts`, функция `filterAndTransform`.

---

## 1. Что считаем «примером» для обучения

Из каждой записи в `traces.jsonl` (см. `traces-v1.md`) формируем один **обучающий пример**:

```json
{
  "runId": "uuid-...",
  "status": "success",
  "task": "создай TODO-приложение",
  "spec": { "mainModule": "todo", "procedures": [...], "syscalls": ["система.хранилище"] },
  "source": { "source": "модуль todo\nпроцедура главная()\n  ...\nконец" },
  "buildReport": { "success": true, "compilerSuccess": true, ... }
}
```

Общее правило:

- берём **только успешные** примеры:
  - `status === "success"`,
  - `buildReport.success === true` (без ошибок лексера/парсера; не `compilerSuccess`!),
  - `source.source` не пустой;
- (опционально) фильтр по `goldenReport.qualityScore >= minQuality`;
- формируем **prompt** из `task` и `spec`;
- **target** = `source.source`.

Структура обучающего примера:

```json
{
  "input_text": "<PROMPT>",
  "target_text": "<КОД_ОСНОВА>"
}
```

---

## 2. Формирование текста prompt/target

### 2.1. Prompt

Функция `buildInputText(record)` — см. реализацию в `export-dataset.ts`:

```text
Сгенерируй код на языке Основа для следующей задачи.

Задача: <task>

Спецификация:
- Главный модуль: <spec.mainModule>
- Процедуры: <spec.procedures[].name>
- Syscalls: <spec.syscalls>

Верни ТОЛЬКО код модуля, без объяснений.
```

**Важно:** в языке Основа блоки закрываются `конец`, не `{ }`; операторы разделяются переводом строки, не `;`. Модуль: `модуль имя` (без точки с запятой). См. `language-v1.md`.

### 2.2. Target

- Берём `record.source.source` (строка с кодом).
- Можно обрамлять код блоком `` ```основа ... ``` `` либо оставить «голым» — важно **последовательность** во всём датасете.

---

## 3. Чтение `traces.jsonl` и сбор датасета

Псевдокод (соответствует `filterAndTransform` в `export-dataset.ts`):

```python
import json

def load_traces(path):
  with open(path, "r", encoding="utf-8") as f:
    for line in f:
      line = line.strip()
      if not line:
        continue
      yield json.loads(line)

def filter_and_transform(records, min_quality=0):
  examples = []
  for rec in records:
    if rec.get("status") != "success":
      continue
    src = (rec.get("source") or {}).get("source", "").strip()
    if not src:
      continue
    # success = полная успешность билда (без lexer/parser errors)
    if (rec.get("buildReport") or {}).get("success") != True:
      continue
    quality = (rec.get("goldenReport") or {}).get("qualityScore") or 0
    if quality < min_quality:
      continue
    prompt = build_input_text(rec)
    examples.append({"input_text": prompt, "target_text": src})
  return examples

def build_input_text(rec):
  task = rec.get("task") or "(нет задачи)"
  spec = rec.get("spec") or {}
  main_module = spec.get("mainModule") or "?"
  procedures = ", ".join(p.get("name", "?") for p in (spec.get("procedures") or [])) or "(нет)"
  syscalls = ", ".join(spec.get("syscalls") or []) or "(нет)"
  return (
    "Сгенерируй код на языке Основа для следующей задачи.\n\n"
    f"Задача: {task}\n\n"
    "Спецификация:\n"
    f"- Главный модуль: {main_module}\n"
    f"- Процедуры: {procedures}\n"
    f"- Syscalls: {syscalls}\n\n"
    "Верни ТОЛЬКО код модуля, без объяснений."
  )
```

---

## 4. Токенизация по `tokenization-v0.1.md`

Если базовая модель — обычная LLM (GPT‑подобная), можно использовать её **родной токенайзер** для SFT.

Для **кастомной модели Основа** — см. `tokenization-v0.1.md` (словарь, BPE-мерджи).

---

## 5. Дообучение базовой модели (LoRA/SFT)

Стандартный SFT на HuggingFace — см. примеры в `export-dataset.ts` (формат `input_text`/`target_text`) и HF Trainer.

---

## 6. Фильтрация и стратификация датасета

- **Фильтр:** `status === "success"`, `buildReport.success === true`, `source.source` не пустой; опционально `goldenReport.qualityScore >= minQuality`.
- **Стратификация:** по `intent.appType` (утилита, хранилище, ui_приложение и т.д.), по длине исходника, по `modelId` (анализ качества по провайдерам).

Поле `input.app_context` в формате traces-v1 **отсутствует** — используйте `intent` и `spec`.

---

## 7. Резюме

Тренинг‑скрипт для дообучения по трейсам Основа v0.1 должен:

1. Читать `traces.jsonl` в формате `traces-v1`.
2. Фильтровать: `status === "success"`, `buildReport.success === true`, `source.source` не пустой.
3. Строить пары (prompt, target) из `task` и `spec` → `source.source`.
4. Токенизировать и обучать (SFT / LoRA).

Источники истины:

- `traces-v1.md`, `src/trace/types.ts` — формат трейсов;
- `language-v1.md` — синтаксис языка (без `;`, без `{ }`, `конец` для блоков);
- `src/scripts/export-dataset.ts` — эталонная логика фильтрации и преобразования;
- `lexer-v0.1.md`, `parser-v0.1.md`, `compiler-v0.1.md`, `tokenization-v0.1.md` — тулчейн;
- `golden-tests.json` — примеры валидного кода.
