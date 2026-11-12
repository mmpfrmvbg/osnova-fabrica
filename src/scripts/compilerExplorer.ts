/**
 * КЛИЕНТ COMPILER EXPLORER — для внешней проверки кодировки e2k.
 *
 * # Зачем модуль, а не проверка внутри теста
 *
 * Опрос сервиса нужен двум оракулам: «есть ли компилятор e2k» (`checkCompilerExplorer.test.ts`)
 * и «что записано про каждый образец» (`validateE2kExternal.test.ts`). Логика вынесена сюда,
 * чтобы обе проверки опирались на **один** код, а не на две расходящиеся копии.
 *
 * # Что здесь есть
 *
 * - {@link findE2kCompilers} — поиск компиляторов e2k по всем формам имени (метаправило проекта);
 * - {@link probeCompilerExplorer} — полный список компиляторов и результат поиска;
 * - {@link probeAssemblers} — отдельный список **ассемблеров** (вторая форма поиска: если
 *   компилятора e2k нет, ассемблер e2k всё равно дал бы внешнюю проверку — он собирал бы
 *   инструкцию в байты);
 * - {@link compileOnCompilerExplorer} — отправка исходника на компиляцию.
 *
 * # Ловушка, ради которой этот модуль написан аккуратно
 *
 * `/api/compilers/e2k` отвечает **200** и телом `[]`, а не 404. Проверка «сервис ответил 200»
 * дала бы ложное «компилятор есть». Критерий — только поиск по полному списку.
 *
 * # Чего этот клиент не делает
 *
 * Не проверяет кодировку e2k: компилятора e2k на сервисе нет (`docs/e2k-external-validation.md`
 * §1). Клиент умеет разговаривать с сервисом; применимость к e2k определяется наличием
 * компилятора, а не кодом.
 */

/** Записанный факт: компилятора e2k на Compiler Explorer нет (2026-09-15). */
export const CE_NO_E2K = 'НЕТ КОМПИЛЯТОРА e2k НА COMPILER EXPLORER';

/** Записанный факт: онлайн-дизассемблера для e2k не найдено. */
export const CE_NO_DISASSEMBLER = 'ОНЛАЙН-ДИЗАССЕМБЛЕР ДЛЯ e2k НЕ НАЙДЕН';

/** Одна запись из `/api/compilers`. */
export interface CeCompiler {
  readonly id: string;
  readonly name: string;
  readonly lang?: string;
  readonly compilerType?: string;
  readonly instructionSet?: string;
  readonly semver?: string;
}

/**
 * Поиск компиляторов e2k по всем формам, которыми предмет может быть назван
 * (метаправило проекта). Чистая функция — её же проверяет негативный контроль.
 *
 * Ловушка, ради которой функция вынесена: подстрока `isp` встречается в `ispc`
 * (Intel SPMD, архитектура `amd64`) — широкий шаблон дал бы ложное совпадение.
 */
export function findE2kCompilers(compilers: readonly CeCompiler[]): CeCompiler[] {
  const pattern = /(^|[^a-z0-9])(e2k|elbrus|mcst|vliw)([^a-z0-9]|$)/i;
  return compilers.filter((compiler) => {
    const haystack = [compiler.id, compiler.name, compiler.compilerType ?? '', compiler.instructionSet ?? ''].join(' ');
    return pattern.test(haystack);
  });
}

/** Результат опроса списка компиляторов. */
export type CeProbe =
  | { readonly status: 'reachable'; readonly total: number; readonly found: readonly CeCompiler[] }
  | { readonly status: 'unreachable'; readonly reason: string };

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw new Error(`${url} ответил ${response.status}`);
  return response.json();
}

/** Опрос Compiler Explorer: полный список компиляторов и поиск e2k в нём. */
export async function probeCompilerExplorer(timeoutMs = 30_000): Promise<CeProbe> {
  try {
    const root = await fetch('https://godbolt.org', {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (root.status !== 200) return { status: 'unreachable', reason: `godbolt.org ответил ${root.status}` };
    const compilers = (await getJson('https://godbolt.org/api/compilers', timeoutMs)) as CeCompiler[];
    if (!Array.isArray(compilers) || compilers.length === 0) {
      return { status: 'unreachable', reason: 'список компиляторов пуст — по нему нельзя судить' };
    }
    return { status: 'reachable', total: compilers.length, found: findE2kCompilers(compilers) };
  } catch (error) {
    return {
      status: 'unreachable',
      reason: `нет доступа: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Опрос списка ассемблеров: компилятора e2k нет, но ассемблер e2k дал бы внешнюю проверку. */
export async function probeAssemblers(timeoutMs = 30_000): Promise<CeProbe> {
  try {
    const assemblers = (await getJson('https://godbolt.org/api/compilers/assembly', timeoutMs)) as CeCompiler[];
    if (!Array.isArray(assemblers) || assemblers.length === 0) {
      return { status: 'unreachable', reason: 'список ассемблеров пуст' };
    }
    return { status: 'reachable', total: assemblers.length, found: findE2kCompilers(assemblers) };
  } catch (error) {
    return {
      status: 'unreachable',
      reason: `нет доступа: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Решение по записанному факту: что документ обязан утверждать при данном результате. */
export function requiredStatement(probe: CeProbe): string {
  if (probe.status === 'unreachable') return '';
  return probe.found.length > 0 ? probe.found[0]!.id : CE_NO_E2K;
}

/** Результат компиляции на сервисе. */
export interface CeCompileResult {
  readonly ok: boolean;
  readonly code?: number;
  readonly asm?: readonly string[];
  readonly stderr?: readonly string[];
  readonly problem?: string;
}

/**
 * Отправить исходник на компиляцию.
 *
 * Контракт сервиса проверен на **доступном** компиляторе (см. оракул): POST
 * `/api/compiler/<id>/compile` с телом `{source, options:{userArguments, filters,
 * compilerOptions}, lang}` отвечает 200 и JSON с полями `code`, `asm[]`, `stderr[]`.
 * Для e2k этот путь **не применялся**: компилятора e2k на сервисе нет.
 */
export async function compileOnCompilerExplorer(
  compilerId: string,
  source: string,
  options: { lang?: string; userArguments?: string; timeoutMs?: number } = {},
): Promise<CeCompileResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  try {
    const response = await fetch(`https://godbolt.org/api/compiler/${encodeURIComponent(compilerId)}/compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        source,
        lang: options.lang ?? 'c',
        options: {
          userArguments: options.userArguments ?? '-O2',
          filters: {
            binary: false,
            execute: false,
            intel: false,
            directives: false,
            labels: false,
            commentOnly: false,
            trim: false,
          },
          compilerOptions: { executorRequest: false },
        },
      }),
    });
    if (response.status !== 200) return { ok: false, problem: `сервис ответил ${response.status}` };
    const json = (await response.json()) as {
      code?: number;
      asm?: { text: string }[];
      stderr?: { text: string }[];
    };
    return {
      ok: (json.code ?? 1) === 0 && Array.isArray(json.asm) && json.asm.length > 0,
      code: json.code,
      asm: (json.asm ?? []).map((line) => line.text),
      stderr: (json.stderr ?? []).map((line) => line.text),
    };
  } catch (error) {
    return { ok: false, problem: `нет доступа: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Найти доступные компиляторы C на архитектуре amd64 — для проверки самого конвейера запроса.
 *
 * Фильтр по `compilerType` обязателен: в списке языка `c` на `amd64` есть записи, которые
 * **не являются компиляторами C** (`c2rust`, `movfuscator`, `aburi`), и запрос к ним падает
 * с ненулевым кодом возврата. Порядок — «сначала настоящие C-компиляторы».
 */
export async function findAmd64Compilers(timeoutMs = 30_000, limit = 3): Promise<string[]> {
  try {
    const list = (await getJson('https://godbolt.org/api/compilers/c', timeoutMs)) as CeCompiler[];
    const preferred = ['clang', 'gcc', 'cproc', 'tinyc', 'zigcc', 'ticlang', 'cc', 'clang-intel'];
    const amd64 = list.filter((compiler) => compiler.instructionSet === 'amd64');
    const ranked = preferred.flatMap((type) => amd64.filter((compiler) => compiler.compilerType === type));
    return ranked.slice(0, limit).map((compiler) => compiler.id);
  } catch {
    return [];
  }
}

/** Первый доступный C-компилятор amd64; `undefined` — список недоступен. */
export async function findAmd64Compiler(timeoutMs = 30_000): Promise<string | undefined> {
  return (await findAmd64Compilers(timeoutMs, 1))[0];
}
