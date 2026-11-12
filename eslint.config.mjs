// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "src/compiler/generated/"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // D11, ПРАВИЛО ПО ПУТИ: сырой путь понижения отдаёт байты ПОД ОТКАЗОМ, а под несущим отказом наши
    // байты ЛГУТ (шестая и седьмая тихие лжи — случаи 60 и 62 реестра проверяемости). Публичная дверь
    // (`src/e2k/lowered.ts`) отдаёт `Результат<Образ, Отказ>`, и в `Отказе` байтов нет вовсе.
    //
    // Разрешено ровно там, где сторожам положено быть: `src/e2k/**` (сторожа и их оракулы) и
    // `tools/**`. Всё остальное дерево — потребители, и им нужна публичная дверь.
    //
    // Это БАРЬЕР, а не абсолютная защита: обойти его можно (динамический импорт, копия модуля), и
    // тогда это красный флаг на ревью. Задача барьера — не дать обойти дверь СЛУЧАЙНО.
    files: ["src/**/*.ts", "tools/**/*.ts"],
    ignores: ["src/e2k/**", "tools/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/guards/loweredUnchecked",
                "**/guards/loweredUnchecked.ts",
                "**/guards/loweredUnchecked.js",
                "**/loweredUnchecked",
                "**/loweredUnchecked.ts",
              ],
              message:
                "D11: сырой путь понижения (байты под отказом) — только для сторожей в src/e2k/**. " +
                "Потребителю нужна публичная дверь `src/e2k/lowered.ts` (Результат<Образ, Отказ>).",
            },
          ],
        },
      ],
    },
  },
  {
    // D11, ПРАВИЛО ПО ИДЕНТИФИКАТОРУ: добирает то, чего не видит правило по пути — `import { loweredProgramUnchecked as иначе }`,
    // обращение к свойству пространства имён и голое имя. Разрешено в стороже, в его оракулах
    // (`src/e2k/*.test.ts`) и в САМОЙ ПУБЛИЧНОЙ ДВЕРИ (`src/e2k/lowered.ts`): сторож ОБЯЗАН смотреть под
    // отказом — иначе ложь нечем поймать, — а дверь обязана позвать сырой путь, иначе она не дверь.
    files: ["src/**/*.ts", "tools/**/*.ts"],
    ignores: ["src/e2k/guards/**", "src/e2k/*.test.ts", "src/e2k/lowered.ts", "tools/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Identifier[name='loweredProgramUnchecked']",
          message:
            "D11: сырое понижение — только для сторожей (`src/e2k/guards/**` и `src/e2k/*.test.ts`). " +
            "Потребителю нужна публичная дверь `src/e2k/lowered.ts`.",
        },
      ],
    },
  },
);
