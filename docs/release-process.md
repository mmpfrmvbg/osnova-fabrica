# Release Process

В проекте используется централизованная версия через файл `VERSION` в корне репозитория.

## Source of truth

- Главная версия продукта хранится только в `VERSION`.
- Из `VERSION` версия синхронизируется в:
  - `package.json`
  - `apps/osiris/package.json`
  - `apps/osiris-android/app/build.gradle.kts` (`versionName`)

Для этого используется helper:

```bash
node scripts/get-version.mjs
```

## Helper `get-version`

Основные режимы:

```bash
# 0.1.1
node scripts/get-version.mjs --raw

# v0.1.1
node scripts/get-version.mjs --tag

# Android versionCode из semver (major*10000 + minor*100 + patch)
node scripts/get-version.mjs --android-code
```

Синхронизация без bump:

```bash
node scripts/get-version.mjs --sync --raw
```

Bump + запись:

```bash
node scripts/get-version.mjs --bump patch --write --sync --raw
node scripts/get-version.mjs --bump minor --write --sync --raw
node scripts/get-version.mjs --bump major --write --sync --raw
```

## Manual release via CI

Релизы выполняются вручную через workflow `.github/workflows/release.yml`.

### Через GitHub UI

1. Actions -> `Release`
2. `Run workflow`
3. Выбрать `bump`: `patch` | `minor` | `major`

### Через CLI

```bash
gh workflow run release.yml --ref main -f bump=patch
```

## Что делает `release.yml`

1. Читает текущую версию из `VERSION`
2. Делает semver bump
3. Синхронизирует version-файлы
4. Коммитит изменения в `main`
5. Создаёт и пушит git tag (`vX.Y.Z`)
6. Создаёт GitHub Release

## Политика частоты версий

Чтобы версии не росли слишком быстро:

- Не bump-ать версию на каждый мелкий коммит.
- Делать release батчами (например, по необходимости или раз в неделю).
- Для маленьких изменений использовать `patch` в рамках одного релизного окна.
