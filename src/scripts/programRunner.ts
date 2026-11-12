/**
 * ОДИН ЗАПУСК ПРОГРАММЫ НА VM — общий для оракулов, которые исполняют примеры.
 *
 * # Почему отдельным модулем
 *
 * Учебник и корпус примеров запускают программы **одним и тем же путём**: собрать
 * исходники в каталог, скомпилировать точку входа, выполнить её на VM и снять
 * вывод. Две копии этого кода разошлись бы при первой же правке компилятора или
 * VM — и тогда «пример работает» означало бы разное в двух местах.
 *
 * # Чего здесь нет
 *
 * Здесь нет `vi` и вообще ничего из vitest: перехват вывода сделан подменой
 * `console.log` с восстановлением в `finally`. Модуль обязан быть пригоден и для
 * прогона вне теста (например, из скрипта), а зависимость от тест-раннера этого
 * не позволяет.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compileSource } from "../compiler/compiler";
import { VM, createDefaultInvokeHandler } from "../runtime/vm/interpreter";

/** Результат прогона: строки вывода, значение точки входа и ошибка. */
export interface ProgramRun {
  output: string[];
  /**
   * Что вернула точка входа. Нужно там, где программа НЕ печатает: у примера
   * корпуса результат может быть возвратом (`expected.via: "возврат"`), и
   * сравнивать тогда надо значение, а не вывод.
   */
  value: unknown;
  error: string | null;
}

/** Значение точки входа строкой — так, как его напечатал бы `вывести`. */
export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "пусто";
  return JSON.stringify(value) ?? String(value);
}

/** Имена точки входа — те же, что ищет CLI. */
const ENTRY_NAMES = ["главная", "старт", "main"];

function formatArg(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Собрать и выполнить программу на VM.
 *
 * @param sources имя файла → текст (имена — как в `использовать модуль … из "…"`)
 * @param entry имя файла с точкой входа
 * @param maxSteps предел шагов VM: пример, который зациклился, обязан падать, а не висеть
 */
export async function runProgramOnVm(
  sources: Map<string, string>,
  entry: string,
  maxSteps = 200_000,
): Promise<ProgramRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osnova-program-"));
  const out: string[] = [];
  const originalLog = console.log;
  try {
    for (const [name, text] of sources) fs.writeFileSync(path.join(dir, name), text, "utf-8");
    console.log = (...args: unknown[]): void => {
      out.push(args.map(formatArg).join(" "));
    };
    try {
      const source = sources.get(entry);
      if (source === undefined) return { output: out, value: undefined, error: `нет точки входа ${entry}` };
      const r = compileSource(source, { baseDir: dir, filename: entry });
      if (r.lexerErrors.length > 0) {
        return { output: out, value: undefined, error: `лексер: ${r.lexerErrors[0]!.message}` };
      }
      if (r.parserErrors.length > 0) {
        return { output: out, value: undefined, error: `парсер: ${r.parserErrors[0]!.message}` };
      }
      if (r.semanticErrors.length > 0) {
        return { output: out, value: undefined, error: `семантика: ${r.semanticErrors[0]!.message}` };
      }
      if (!r.module || !r.compilerSuccess) return { output: out, value: undefined, error: "модуль не собран" };
      const vm = new VM(r.module, { invoke: createDefaultInvokeHandler(), maxSteps });
      const index = (() => {
        for (const name of ENTRY_NAMES) {
          try {
            return vm.findProcedureIndex(name);
          } catch {
            /* пробуем следующее имя */
          }
        }
        return 0;
      })();
      const value = await vm.runProcedure(index, []);
      return { output: out, value, error: null };
    } catch (e) {
      return { output: out, value: undefined, error: e instanceof Error ? e.message : String(e) };
    } finally {
      console.log = originalLog;
    }
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
