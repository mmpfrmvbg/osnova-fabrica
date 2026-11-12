/**
 * Согласованность реестров системных вызовов.
 *
 * # Дефект, ради которого это написано
 *
 * 2026-09-25 найдено противоречие, живущее в репозитории: `language-registry.ts`
 * в списке запретов утверждал «`система.вывести` не существует», а
 * `SYSCALL_ALIASES` (`invokeRegistry.ts`) это же имя **принимал** как синоним
 * `система.лог.вывести`. Промпт кодогенерации рендерит запрет как
 * «✗ … / НЕЛЬЗЯ: `система.вывести(x)` / ПРАВИЛЬНО: …», то есть учил модель тому,
 * что компилятор тут же собирает.
 *
 * # Почему это отдельная проверка, а не часть `registryAgreement`
 *
 * `registryAgreement.ts` сверяет **два** реестра: `LANGUAGE_REGISTRY.syscalls` и
 * `INVOKE_ARG_COUNT` (имена и арность). Реестры ПРИЁМА и реестры ОТКАЗА он не
 * видит вовсе: `SYSCALL_ALIASES`, `SYSCALL_NO_CANON` и `forbiddenPatterns` не
 * сверяются ни с чем. Именно в этом зазоре противоречие и прожило.
 *
 * # Что именно считается противоречием
 *
 * Не «любое упоминание принимаемого имени в запрете». Запрет запрету рознь:
 *
 * | запись | описание | `bad` | противоречие? |
 * |---|---|---|---|
 * | `array_index_syscall_direct` | «Не использовать `система.массив.получить`, когда можно `arr[i]`» | принимаемое имя | **нет**: это правило СТИЛЯ, и описание говорит правду — имя работает |
 * | `wrong_log_api` | «`система.вывести` **не существует**» | принимаемое имя | **да**: описание утверждает ФАКТ, и факт ложный |
 *
 * Поэтому проверяется не наличие имени в `bad`, а **ложное утверждение о
 * несуществовании**: если описание записи заявляет «не существует» / «не
 * поддерживается», то имена из её `bad` обязаны быть компилятором НЕ приняты.
 * Различение стиля и факта закреплено негативным контролем: запись-стиль на
 * принимаемом имени красной быть не должна, иначе оракул запретит половину
 * осмысленных правил промпта.
 *
 * Логика вынесена из оракула отдельным модулем — как `registryAgreement.ts` и
 * `languageV2Requirements.ts`: чистую функцию можно прогнать на подставных
 * данных и убедиться, что она всё ещё ЛОВИТ расхождение, а не только молчит на
 * текущем состоянии репозитория.
 */

/** Минимум полей записи запрета, нужный проверке (полный `ForbiddenPatternSpec` подходит). */
export interface ForbiddenPatternLike {
  readonly id: string;
  readonly description: string;
  readonly bad: string;
  readonly good?: string;
}

export interface RegistryConsistencyInput {
  /** Канонические имена системных вызовов (реестр языка И рантайма). */
  readonly canonSyscalls: readonly string[];
  /** Синонимы: что модель пишет → каноническое имя. */
  readonly aliases: Readonly<Record<string, string>>;
  /** Имена, у которых канонической цели нет: переписать нельзя, молчать нельзя тоже. */
  readonly noCanon: Readonly<Record<string, string>>;
  /** Запреты для промпта кодогенерации. */
  readonly forbidden: readonly ForbiddenPatternLike[];
}

/** Ссылка на запись запрета, утверждающую несуществование принимаемого имени. */
export interface NonexistenceClaim {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export interface RegistryConsistencyReport {
  /** Цель синонима не является известным системным вызовом. */
  readonly aliasTargetsMissing: readonly string[];
  /** Цель синонима сама является синонимом: разрешение в один шаг не сработает. */
  readonly aliasChains: readonly string[];
  /** Ключ синонима — уже каноническое имя: синоним подменял бы канон. */
  readonly aliasShadowsCanon: readonly string[];
  /** Имя одновременно принимается и объявлено как «канонической цели нет». */
  readonly acceptedAndRejected: readonly string[];
  /** Запрет утверждает, что имени нет, а компилятор его принимает. */
  readonly falseNonexistenceClaims: readonly NonexistenceClaim[];
  /**
   * Запрет утверждает, что имени нет, а точной причины отказа у компилятора нет:
   * имени не нашлось ни в реестре вызовов, ни в `SYSCALL_NO_CANON`.
   *
   * Почему это дефект, а не придирка. Промпт говорит модели «этого нет», а
   * компилятор, встретив такое имя, отвечает общим «системный вызов '…' не
   * существует». Модель не узнаёт, ЧТО писать вместо, — то есть точная причина,
   * уже написанная в описании запрета, до неё не доходит. Записи запрета и
   * `SYSCALL_NO_CANON` — две стороны одного сообщения и обязаны быть согласованы.
   */
  readonly nonexistenceWithoutReason: readonly NonexistenceClaim[];
  readonly ok: boolean;
}

/**
 * Утверждает ли описание записи, что имени НЕ СУЩЕСТВУЕТ.
 *
 * Проверяются ровно две формулировки, которыми это говорится в реестре:
 * «не существует» и «не поддерживается». Список намеренно узкий: широкое «нет»
 * поймало бы «нет канонической цели» — а это утверждение о ЦЕЛИ, а не о
 * существовании имени, и оно верно для `SYSCALL_NO_CANON`.
 */
const NONEXISTENCE_CLAIM = /не существует|не поддерживается/i;

/** Имена системных вызовов, упомянутые в тексте примера. */
function syscallNamesIn(text: string): string[] {
  const found = text.match(/система\.[A-Za-zА-Яа-яЁё0-9_.]+/g) ?? [];
  return found.map((name) => name.replace(/\.$/, ""));
}

export function checkRegistryConsistency(
  input: RegistryConsistencyInput,
): RegistryConsistencyReport {
  const canon = new Set(input.canonSyscalls);
  const aliasKeys = new Set(Object.keys(input.aliases));
  const accepted = new Set<string>([...canon, ...aliasKeys]);

  const aliasTargetsMissing: string[] = [];
  const aliasChains: string[] = [];
  const aliasShadowsCanon: string[] = [];
  for (const [from, to] of Object.entries(input.aliases).sort(([a], [b]) => a.localeCompare(b))) {
    if (!canon.has(to)) aliasTargetsMissing.push(`${from} -> ${to}`);
    if (aliasKeys.has(to)) aliasChains.push(`${from} -> ${to}`);
    if (canon.has(from)) aliasShadowsCanon.push(from);
  }

  const acceptedAndRejected = [...accepted]
    .filter((name) => name in input.noCanon)
    .sort();

  const falseNonexistenceClaims: NonexistenceClaim[] = [];
  const nonexistenceWithoutReason: NonexistenceClaim[] = [];
  for (const pattern of input.forbidden) {
    if (!NONEXISTENCE_CLAIM.test(pattern.description)) continue;
    for (const name of syscallNamesIn(pattern.bad)) {
      if (accepted.has(name)) {
        falseNonexistenceClaims.push({ id: pattern.id, name, description: pattern.description });
      } else if (!(name in input.noCanon)) {
        nonexistenceWithoutReason.push({ id: pattern.id, name, description: pattern.description });
      }
    }
  }

  const ok =
    aliasTargetsMissing.length === 0 &&
    aliasChains.length === 0 &&
    aliasShadowsCanon.length === 0 &&
    acceptedAndRejected.length === 0 &&
    falseNonexistenceClaims.length === 0 &&
    nonexistenceWithoutReason.length === 0;

  return {
    aliasTargetsMissing,
    aliasChains,
    aliasShadowsCanon,
    acceptedAndRejected,
    falseNonexistenceClaims,
    nonexistenceWithoutReason,
    ok,
  };
}
