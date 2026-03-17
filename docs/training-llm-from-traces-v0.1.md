## Трейнинг LLM по трейсам Основа v0.1

Цель: описать **референтный тренинг‑скрипт**, который:

1. Читает `traces.jsonl` (формат в `trace-format-v0.1.md`).
2. Извлекает из него пары (вход → целевой код на Основа).
3. Токенизирует данные по `tokenization-v0.1.md`.
4. Дообучает выбранную базовую модель (LoRA или обычный SFT).

Документ не привязан к конкретной библиотеке (HF, vLLM и т.д.), но примеры даны в духе PyTorch + HuggingFace.

---

## 1. Что считаем «примером» для обучения

Из каждой записи в `traces.jsonl` (см. `trace-format-v0.1.md`) формируем один или несколько **обучающих примеров**:

```json
{
  "trace_id": "...",
  "meta": { ... },
  "input": { ... },
  "osnova": { "source": "модуль ..." },
  "compiler": { "success": true, ... },
  "feedback": { "rating": 4, ... }
}
```

Общее правило:

- берём **только успешные** примеры:
  - `compiler.success == true`,
  - (по желанию) `feedback.rating >= 3`.
- формируем **prompt** и **target**:
  - `prompt` = форматированная спека/IR + инструкции («сгенерируй модуль Основа…»),
  - `target` = `osnova.source` (или список файлов).

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

Функция `buildTrainingPromptFromTrace(record)` может переиспользовать логику из `pipeline-llm-osnova.md`:

```text
Сгенерируй модуль на языке «Основа» по следующей спецификации.

Требования:
- модуль должен начинаться с `модуль <имя>;`
- использовать только конструкции, описанные в грамматике v0.1
- код должен быть самодостаточным и компилироваться компилятором Основа v0.1

Спека:
<input.payload в удобном виде (YAML/JSON)>
```

### 2.2. Target

- Берём `record.osnova.source` (или конкатенацию всех файлов `osnova.files[*].source`).
- Можно обрамлять код блоком:

```text
```основа
<код>
```
```

либо оставить «голым» кодом — важно, чтобы это было **последовательным** во всём датасете.

---

## 3. Чтение `traces.jsonl` и сбор датасета

Псевдокод на Python:

```python
import json

def load_traces(path):
  with open(path, "r", encoding="utf-8") as f:
    for line in f:
      line = line.strip()
      if not line:
        continue
      yield json.loads(line)

def build_examples(traces_path):
  for rec in load_traces(traces_path):
    compiler = rec.get("compiler") or {}
    feedback = rec.get("feedback") or {}

    if not compiler.get("success", False):
      continue

    rating = feedback.get("rating", 3)
    if rating is not None and rating < 3:
      continue

    src = rec.get("osnova", {}).get("source")
    if not src:
      files = rec.get("osnova", {}).get("files") or []
      src = "\n\n".join(f.get("source", "") for f in files)
    if not src:
      continue

    prompt = build_prompt_from_input(rec["input"])
    target = src

    yield {
      "input_text": prompt,
      "target_text": target
    }
```

Функция `build_prompt_from_input` должна согласовываться по стилю с генерационным пайплайном (см. `pipeline-llm-osnova.md`).

---

## 4. Токенизация по `tokenization-v0.1.md`

Если базовая модель — обычная LLM (GPT‑подобная), можно:

- использовать её **родной токенайзер** для SFT;
- параллельно сохранять **Основа‑токены** в трейсе (для будущей кастомной модели).

Для **кастомной модели Основа** (с кастомным BPE по `tokenization-v0.1.md`):

- подготовить словарь:
  - базовый алфавит,
  - `KW_*`, `TYPE_*`, `OPER_*`, `DELIM_*`, `LIT_*`,
  - BPE‑мерджи (seed + дообученные).
- реализовать токенизатор:

```python
class OsnovaTokenizer:
  def __init__(self, vocab, merges):
    ...

  def encode(self, text: str) -> list[int]:
    # 1. Превратить text в последовательность базовых токенов (символы + _ / _NL)
    # 2. Применить BPE-мерджи
    # 3. Вернуть id из vocab
    ...

  def decode(self, ids: list[int]) -> str:
    ...
```

В тренинг‑скрипте:

```python
tokenizer = OsnovaTokenizer(vocab, merges)

def encode_example(example):
  prompt_ids = tokenizer.encode(example["input_text"])
  target_ids = tokenizer.encode(example["target_text"])
  # Формат для SFT: [BOS] + prompt + SEP + target + EOS
  input_ids = [vocab["<BOS>"]] + prompt_ids + [vocab["<SEP>"]] + target_ids + [vocab["<EOS>"]]
  # Можно также сделать mask, чтобы лосс считался только по target-части
  labels = [-100] * (1 + len(prompt_ids) + 1) + target_ids + [vocab["<EOS>"]]
  return {"input_ids": input_ids, "labels": labels}
```

---

## 5. Дообучение базовой модели (LoRA/SFT)

Псевдокод на HuggingFace (SFT + опционально LoRA):

```python
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

base_model_name = "some-base-llm"

model = AutoModelForCausalLM.from_pretrained(base_model_name)
hf_tokenizer = AutoTokenizer.from_pretrained(base_model_name)

examples = list(build_examples("traces.jsonl"))

def hf_preprocess(example):
  text = example["input_text"] + "\n```основа\n" + example["target_text"] + "\n```"
  enc = hf_tokenizer(
    text,
    truncation=True,
    max_length=2048
  )
  enc["labels"] = enc["input_ids"].copy()
  return enc

hf_dataset = Dataset.from_list(examples).map(hf_preprocess)

args = TrainingArguments(
  output_dir="llm-osnova-sft",
  per_device_train_batch_size=1,
  learning_rate=5e-5,
  num_train_epochs=3,
  logging_steps=50,
  save_steps=500,
  save_total_limit=3
)

trainer = Trainer(
  model=model,
  args=args,
  train_dataset=hf_dataset
)

trainer.train()
```

Для **LoRA** (PEFT):

```python
from peft import LoraConfig, get_peft_model

lora_config = LoraConfig(
  r=8,
  lora_alpha=16,
  target_modules=["q_proj", "v_proj"],  # зависит от архитектуры базовой модели
  lora_dropout=0.05,
  bias="none",
  task_type="CAUSAL_LM"
)

model = get_peft_model(model, lora_config)
trainer = Trainer(..., model=model, ...)
trainer.train()
```

---

## 6. Фильтрация и стратификация датасета

Рекомендуется:

- Отфильтровывать:
  - `compiler.success == false`;
  - `feedback.rating < 3` (или явно помечать такие примеры).
- Стратифицировать:
  - по `input.app_context.category` (crm/todo/game/utility);
  - по длине исходника (короткие/длинные модули);
  - по использованию фич (например, `tags` на основе AST: использует ли акторы, VLIW‑конструкции и т.п.).

Это позволит контролировать баланс при обучении (например, не переобучаться на одном типе приложений).

---

## 7. Резюме

Тренинг‑скрипт для дообучения AI‑ядра по трейсам Основа v0.1 должен:

1. Читать `traces.jsonl` и отфильтровывать только успешные (и при желании высоко оценённые) прогоны.
2. Строить пары (prompt, target) на основе `input` и `osnova.source`.
3. Токенизировать:
   - либо базовым токенайзером LLM (для быстрого SFT),
   - либо кастомным токенизатором по `tokenization-v0.1.md` (для специализированной модели Основа).
4. Обучать модель в режиме **инструкционного SFT** (prompt + желаемый код).
5. Опционально использовать LoRA для лёгкого дообучения без полного финтюна.

Все спецификации для этого уже есть в:

- `grammatika-v0.1.md`
- `lexer-v0.1.md`
- `parser-v0.1.md`
- `compiler-v0.1.md`
- `tokenization-v0.1.md`
- `trace-format-v0.1.md`
- `golden-tests.json`

