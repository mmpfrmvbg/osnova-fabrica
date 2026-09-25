/**
 * Оракул согласованности реестров системных вызовов.
 *
 * Повод: 2026-09-25 в репозитории найдено живое противоречие —
 * `language-registry.ts` объявлял «`система.вывести` не существует», а
 * `SYSCALL_ALIASES` принимал это имя как синоним. Промпт кодогенерации рендерит
 * такую запись как «НЕЛЬЗЯ: `система.вывести(x)`», то есть учил модель тому, что
 * компилятор собирает.
 *
 * Проверки идут в двух слоях: сначала негативные контроли на ПОДСТАВНЫХ данных
 * (доказывают, что проверка всё ещё ловит), затем — на настоящих реестрах.
 * Без первого слоя оракул, который всегда зелёный, неотличим от работающего.
 */
import { describe, it, expect } from "vitest";
import { LANGUAGE_REGISTRY } from "./language-registry";
import { SYSCALL_ALIASES, SYSCALL_NO_CANON, INVOKE_ARG_COUNT } from "../runtime/vm/invokeRegistry";
import { checkRegistryConsistency } from "./registryConsistency";
import type { RegistryConsistencyInput } from "./registryConsistency";

/** Настоящие реестры: то, что реально видит компилятор и промпт. */
const REAL: RegistryConsistencyInput = {
  canonSyscalls: [
    ...new Set([
      ...LANGUAGE_REGISTRY.syscalls.map((s) => s.name),
      ...Object.keys(INVOKE_ARG_COUNT),
    ]),
  ],
  aliases: SYSCALL_ALIASES,
  noCanon: SYSCALL_NO_CANON,
  forbidden: LANGUAGE_REGISTRY.forbiddenPatterns,
};

/**
 * Подставной согласованный вход. Каждый контроль меняет в нём РОВНО одно —
 * иначе по падению нельзя понять, что поймано.
 */
function synthetic(over: Partial<RegistryConsistencyInput> = {}): RegistryConsistencyInput {
  return {
    canonSyscalls: ["система.лог.вывести", "система.строка.длина"],
    aliases: { "система.вывод.текст": "система.лог.вывести" },
    noCanon: { "система.окружение.получить": "не поддерживается: модуля нет" },
    forbidden: [],
    ...over,
  };
}

describe("checkRegistryConsistency: негативные контроли (подставные данные)", () => {
  it("согласованный вход — зелёный", () => {
    const r = checkRegistryConsistency(synthetic());
    expect(r.aliasTargetsMissing).toEqual([]);
    expect(r.aliasChains).toEqual([]);
    expect(r.aliasShadowsCanon).toEqual([]);
    expect(r.acceptedAndRejected).toEqual([]);
    expect(r.falseNonexistenceClaims).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("цель синонима, которой нет в реестре, — ловится", () => {
    const r = checkRegistryConsistency(
      synthetic({ aliases: { "система.вывод.текст": "система.нет.такого" } }),
    );
    expect(r.aliasTargetsMissing).toEqual(["система.вывод.текст -> система.нет.такого"]);
    expect(r.aliasChains, "цепочки здесь нет — поймана именно пропажа цели").toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("цепочка синонимов (цель сама синоним) — ловится", () => {
    const r = checkRegistryConsistency(
      synthetic({
        // `система.б` есть в каноне — иначе сработала бы ещё и проверка пропажи
        // цели, и по падению нельзя было бы понять, что поймано.
        canonSyscalls: ["система.лог.вывести", "система.строка.длина", "система.б"],
        aliases: { "система.а": "система.б", "система.б": "система.лог.вывести" },
      }),
    );
    // Цепочка ровно одна: у `система.б` цель каноническая, это не цепочка.
    expect(r.aliasChains).toEqual(["система.а -> система.б"]);
    expect(r.aliasTargetsMissing, "обе цели в реестре — поймана именно цепочка").toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("синоним, подменяющий канон, — ловится", () => {
    const r = checkRegistryConsistency(
      synthetic({ aliases: { "система.лог.вывести": "система.строка.длина" } }),
    );
    expect(r.aliasShadowsCanon).toEqual(["система.лог.вывести"]);
    expect(r.ok).toBe(false);
  });

  it("имя принимается и отвергается одновременно — ловится", () => {
    const r = checkRegistryConsistency(
      synthetic({
        noCanon: { "система.лог.вывести": "не поддерживается: модуля нет" },
      }),
    );
    expect(r.acceptedAndRejected).toEqual(["система.лог.вывести"]);
    expect(r.ok).toBe(false);
  });

  it("ложное утверждение о несуществовании принимаемого имени — ловится", () => {
    const r = checkRegistryConsistency(
      synthetic({
        forbidden: [
          {
            id: "wrong_alias_api",
            description: "система.вывод.текст не существует",
            bad: "система.вывод.текст(а)",
            good: "система.лог.вывести(а)",
          },
        ],
      }),
    );
    expect(r.falseNonexistenceClaims).toEqual([
      {
        id: "wrong_alias_api",
        name: "система.вывод.текст",
        description: "система.вывод.текст не существует",
      },
    ]);
    expect(r.ok).toBe(false);
  });

  it("правило СТИЛЯ на принимаемом имени — НЕ ловится (оракул не запрещает стиль)", () => {
    // Это главный разграничитель. Запись ниже запрещает ФОРМУ ЗАПИСИ, а не
    // утверждает несуществование: имя работает, и описание это говорит.
    // Оракул, краснеющий здесь, запретил бы половину осмысленных правил промпта.
    const r = checkRegistryConsistency(
      synthetic({
        forbidden: [
          {
            id: "array_index_style",
            description: "Не использовать система.лог.вывести, когда можно краткую форму",
            bad: "система.лог.вывести(а)",
            good: "краткая форма",
          },
        ],
      }),
    );
    expect(r.falseNonexistenceClaims, "стиль — не ложь о существовании").toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("запрет на имя, которого в реестре нет, — НЕ ловится (это верный запрет)", () => {
    const r = checkRegistryConsistency(
      synthetic({
        forbidden: [
          {
            id: "env_api_missing",
            description: "система.окружение.* не поддерживается",
            bad: 'система.окружение.получить("X")',
          },
        ],
      }),
    );
    expect(r.falseNonexistenceClaims).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("утверждение о ЦЕЛИ, а не о существовании, — НЕ ловится", () => {
    // «нет канонической цели» — утверждение про цель, и оно верно: имя
    // существует ровно настолько, чтобы получить точное сообщение об отказе.
    const r = checkRegistryConsistency(
      synthetic({
        forbidden: [
          {
            id: "no_target",
            description: "нет канонической цели: используйте другую форму",
            bad: "система.лог.вывести(а)",
          },
        ],
      }),
    );
    expect(r.falseNonexistenceClaims).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("реестры системных вызовов согласованы (настоящие данные)", () => {
  it("оракул не вакуумный: реестры непусты, и проверять есть что", () => {
    expect(REAL.canonSyscalls.length).toBeGreaterThan(0);
    expect(Object.keys(REAL.aliases).length).toBeGreaterThan(0);
    expect(Object.keys(REAL.noCanon).length).toBeGreaterThan(0);
    expect(REAL.forbidden.length).toBeGreaterThan(0);
  });

  it("каждое имя в SYSCALL_ALIASES имеет каноническую цель в реестре", () => {
    const r = checkRegistryConsistency(REAL);
    expect(r.aliasTargetsMissing, "цели синонимов").toEqual([]);
  });

  it("среди синонимов нет цепочек и нет подмены канона", () => {
    const r = checkRegistryConsistency(REAL);
    expect(r.aliasChains, "цепочки синонимов").toEqual([]);
    expect(r.aliasShadowsCanon, "синоним на каноническом имени").toEqual([]);
  });

  it("ни одно имя не принимается и не отвергается одновременно", () => {
    const r = checkRegistryConsistency(REAL);
    expect(r.acceptedAndRejected, "пересечение приёма и отказа").toEqual([]);
  });

  it("ни один запрет не утверждает несуществование ПРИНИМАЕМОГО имени", () => {
    const r = checkRegistryConsistency(REAL);
    const detail = r.falseNonexistenceClaims.map(
      (c) => `${c.id}: «${c.description}», а имя «${c.name}» компилятор принимает`,
    );
    expect(detail, "запрет и реестр синонимов не должны противоречить друг другу").toEqual([]);
  });

  it("вся картина вместе — ok", () => {
    expect(checkRegistryConsistency(REAL).ok).toBe(true);
  });
});
