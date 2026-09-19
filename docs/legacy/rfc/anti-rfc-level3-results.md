<!-- doc-status: deprecated -->
# Anti-RFC Уровень 3 — результаты проверок

**Дата:** 2026-03-21
**Трейсов в базе:** 942
**Агент:** lang-agent

---

## Сводка

| ID | Статус | Ключевая метрика |
|----|--------|-----------------|
| A-1 | baseline зафиксирован, ждёт canary | 16 трейсов с 2026-03-21, error-категория: 0 |
| A-2 | измерено | 83 exhausted: unknown 79, unknown_syscall 2, undeclared_var 1, redeclare_var 1 |
| A-3 | 🚨 СТОП-СИГНАЛ | semantic_errors_in_success = 37 (из 633 success) |
| A-4 | закрыта | teachability_score = 86.4% (выше порога 70%) |
| A-5 | baseline зафиксирован, ждёт canary | 16 трейсов с 2026-03-21 |

---

## A-3: СТОП-СИГНАЛ — semantic_errors_in_success = 37

**Критичность: HIGH.** 37 трейсов со статусом `success` содержат
`semanticErrors` в `buildReport`. Это нарушение инварианта: успешный прогон
не должен содержать семантических ошибок.

**Возможные причины:**
1. GateChecker засчитывает `success` по `compilerSuccess=true` без проверки
   `semanticErrors.length === 0`
2. Семантические ошибки генерируются пост-фактум (после compile-шага)
   и не блокируют статус
3. Некорректная классификация ошибок в компиляторе

**Требуемое действие:** эскалация PM. Языковой агент не трогает компилятор.

---

## A-2: repair_exhausted кластеры

83 трейса со статусом `repair_exhausted`.

| kind | count | доля |
|------|-------|------|
| unknown | 79 | 95.2% |
| unknown_syscall | 2 | 2.4% |
| undeclared_var | 1 | 1.2% |
| redeclare_var | 1 | 1.2% |

**Вывод:** кластер однородный — 95.2% ошибок типа `unknown`.
Это значит что компилятор не классифицирует ошибки при exhaustion.
Repair-промпту нечего исправлять без конкретного `kind`.
**Рекомендация PM:** улучшить error reporting в компиляторе для exhausted-трейсов.

---

## A-4: teachability_score = 86.4% ✅

Выше порога 70%. Из 633 success-трейсов 547 решены с первой попытки.
A-4 закрыта: фильтр --max-repairs корректен, датасет чистый.

---

## A-1: try/catch avoidance

top_workaround_patterns:
- sentinel: 104 (сравнение с пусто вместо ошибок)
- flag_loop: 26 (флаговые циклы)
- catchVar: 5 (переменная-флаг вместо try/catch)

`catchVar = 5` — низкий показатель. Few-shot A-1 (коммит 5347cb5) вероятно
уже работает. Canary-подтверждение ждёт 50+ recent трейсов.

`sentinel = 104` — доминирующий паттерн. Требует отдельного Anti-RFC (A-6).

---

## A-5: spec completeness

Baseline зафиксирован. Few-shot добавлен (5a7298b).
Ждёт накопления 50+ трейсов с 2026-03-21.

---

## Новые сигналы для PM

1. **A-3 стоп-сигнал** — semantic_errors_in_success=37, нужна инфра-правка
2. **A-2 unknown=95%** — компилятор не даёт kind при exhaustion
3. **sentinel=104** — новый кандидат Anti-RFC A-6
