# План статусов документации

Материал для реализации GETTING-STARTED. Конвенция: каждый документ в docs/ должен иметь в шапке:

```
status: canonical | deprecated | superseded-by | draft
last-synced-with: <файлы>
```

**Правило для разработчика (раздел «Как читать документацию» в GETTING-STARTED):** документы со статусом в шапке актуальны; документы без шапки — переходный период, доверяй коду больше чем документу.

---

## Назначенные статусы (сессия аудита)

| Документ | Статус |
|----------|--------|
| `language-v1.md` | canonical |
| `traces-v1.md` | canonical |
| `grammatika-v0.1.md` | deprecated |
| `trace-format-v0.1.md` | superseded-by: traces-v1.md |
| `spec-alignment.md` | canonical |
| `pipeline-llm-osnova.md` | draft — не соответствует реальному orchestrator |
| `training-llm-from-traces-v0.1.md` | canonical |

**Остальные документы** — требуют проверки при реализации GETTING-STARTED.

---

## Действие при реализации

1. Пройтись по всем файлам в docs/ и проставить статус в шапку.
2. Внести раздел «Как читать документацию» в GETTING-STARTED.
3. В training-llm-from-traces-v0.1.md добавить `last-synced-with: traces-v1.md, src/scripts/export-dataset.ts, src/trace/types.ts`.
