/**
 * Цепочка шагов, которая НЕ обрывается на первом падении.
 *
 * Зачем отдельный модуль. `npm test` был записан как
 * `vitest && check:test-files && check:language-schema`: при падении vitest
 * (`&&`) последующие сторожа не запускались вообще — и находка сторожа счёта
 * файлов (2 файла без исключения) была скрыта не прогоном, а знаком `&&`. Это
 * класс «проверок не было ≠ проверки прошли» (docs/verification-debt.md).
 *
 * Здесь каждый шаг выполняется **независимо**, а код возврата — 1, если красным
 * оказался хотя бы один. Логика отделена от запуска процессов, чтобы её можно
 * было проверить оракулом (`stepChain.test.ts`) и настоящими процессами тоже.
 */

export interface StepOutcome {
  command: string;
  code: number;
  ok: boolean;
}

export interface ChainOutcome {
  steps: StepOutcome[];
  /** Команды, завершившиеся ненулевым кодом, — в порядке выполнения. */
  failed: string[];
  /** 0 — все шаги зелёные; 1 — есть красные. */
  code: number;
}

/**
 * Выполнить все команды по порядку и собрать итог.
 *
 * Ключевое свойство: `run` вызывается для КАЖДОЙ команды, независимо от кодов
 * предыдущих. Никакого раннего выхода здесь быть не должно.
 */
export function runSteps(
  commands: readonly string[],
  run: (command: string) => number,
  report: (line: string) => void = (line) => console.log(line),
): ChainOutcome {
  const steps: StepOutcome[] = [];
  commands.forEach((command, index) => {
    const code = run(command);
    const ok = code === 0;
    steps.push({ command, code, ok });
    report(`[шаги] ${index + 1}/${commands.length} ${command} — ${ok ? 'OK' : `КРАСНО (код ${code})`}`);
  });

  const failed = steps.filter((s) => !s.ok).map((s) => s.command);
  if (failed.length === 0) {
    report(`[шаги] ИТОГ: все ${commands.length} шагов зелёные`);
  } else {
    report(`[шаги] ИТОГ: красных ${failed.length} из ${commands.length} — ${failed.join('; ')}`);
    report('[шаги] остальные шаги всё равно выполнены: цепочка не обрывается');
  }
  return { steps, failed, code: failed.length === 0 ? 0 : 1 };
}
