<!-- doc-status: active -->
# AGENTS.md — карта проекта (читать первым)

> Последняя сверка с кодом и git-историей: 2026-09-19.

## Что это

**Основа** — кириллический язык программирования под VLIW-процессоры (модель
e2k/Эльбрус) и фабрика вокруг него: компилятор (`.osnova` → `.osvbc`), стековая и
регистровая VM, VLIW-планировщик, self-hosting компилятор. Дальняя цель — ОС, где
ИИ сам пишет приложения и управляет ими как единой библиотекой.

**Сейчас работа идёт через DSH-агента напрямую**, а не через LLM-пайплайн ниже.

## Три фазы — главное, что нужно понять

| Фаза | Статус | Что внутри |
|---|---|---|
| **Фронтир** | 🟢 active (сент 2026) | `src/e2k/**` — бэкенд под реальный Эльбрус (encoding / emitter / ELF / широкие команды / syscall-рантайм; «hello» в QEMU достигнут, сверка через `as`/`objdump`). `src/vliw/**` — планировщик с оракулами. `src/self-host/**` — компилятор на самой Основе (stage1–16). `src/oracle/parity.ts` + `src/runtime/vm/{regcode,reginterpreter}.ts` + `src/compiler/regcodegen.ts` — регистровый бэкенд, сверяется со стековой VM по трассам. Канон языка — v2.3.2. |
| **LLM-пайплайн** | 🟡 frozen (заморожен, вернёмся) | `src/pipeline/**`, `src/agents/**`, `src/llm/**`, `src/trace/**`, `src/intelligence/**`, `src/resident/**`, `src/self-improve/**`, `src/patch-agent/**`, `src/mcp-server.ts`, `src/center/**`, `src/steward/**`; Python-слой `forge/**` + `osnova/**` и состояние `.osnova/**`. Это весенний контур (март 2026). Будет пересобран под экосистему, но сейчас — **не источник истины для текущей работы**. |
| **Ядро ОС / экосистема** | ⚪ не начато | Ядро, драйверы, та самая экосистема, куда пайплайн встроится. |

## Как читать документацию (слои истины)

1. **Код** — абсолютная истина: `src/compiler/**`, `src/runtime/**`, `src/vliw/**`, `src/e2k/**`.
2. **Сгенерировано из кода**: `docs/osnova/language-schema.json` — проверяется `npm run check:language-schema`.
3. **Канон-проза** (подтверждён кодом): `docs/language-v2.md`.
4. **Статус/фронтир**: `BIG-PICTURE.md`, этот файл.
5. **Решения и замеры** (датированы, с числами): `docs/language-v2-requirements.md`, `docs/token-cost-report.md`.
6. **Легаси** (только история, НЕ источник истины): `docs/legacy/**`.

Документация управляется системой (`docs/DOCS.md`): реестр — `docs/manifest.yaml`,
сторож — `npm run docs:check`, индекс — `docs/README.md` (генерируется, руками не
править). Новый `.md` без записи в реестре — ошибка: так ничего не расползается.

⚠️ Доки про замороженный пайплайн — `docs/pipeline-v1.md`, `ARCHITECTURE-AS-IS.md`,
`docs/doc-status-plan.md` — помечены в шапке как `frozen`: они описывают весенний
контур, а не текущую работу.

## Как менять язык

Атомарно, по `docs/language-contributing-v2.md`:
компилятор/VM → `language-schema.json` → `language-v2.md` → golden-тесты → changelog.
Анти-паттерны: «только парсер», «фича без schema», «правки только в docs».

## Как верифицировать

```bash
npm test                                   # vitest run
npx tsc -p tsconfig.typecheck.json --noEmit
npm run lint
npm run golden
npm run ci
```

Полный список done-команд — в `OSNOVA.md`.

## Правила кода и коммитов

См. `.cursorrules`: запрещённые конструкции языка, частые ошибки LLM, формат коммитов.
