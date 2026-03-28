# OSNOVA Project Config

Эталонный формат для [`read_osnova_md`](osnova/state_reader.py) и для людей. Редактируйте секции ниже под свой репозиторий.

## Stack

- language: TypeScript
- runtime: Node.js 20
- test_runner: vitest
- package_manager: npm

## Executor Priority

- default: cursor
- for_docs: qwen
- for_p0: cursor
- for_large_scope: cursor

## Done Commands

- unit: npm test
- typecheck: npx tsc -p tsconfig.typecheck.json --noEmit
- compiler: npm run test -- src/compiler
- runtime: npm run test -- src/runtime
- ci: npm run ci

## Notouch

- .github/
- node_modules/
- dist/

## Brain

- cycle_minutes: 36
- atm_target: 10-12
- max_scope_files: 10
