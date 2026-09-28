/**
 * ПРОГОН ПРОГРАММЫ ИЗ КОРПУСА НА ЦЕЛИ e2k (через модель QEMU).
 *
 * # Зачем это отдельным модулем
 *
 * Оракул корпуса обязан проверять **сквозную** единицу: одна программа, два
 * исполнения, один эталон — на VM и на цели. VM-половина живёт в
 * `./programRunner`, а здесь — половина цели: собрать образ конвейером
 * (`src/e2k/programImage.ts`) и **исполнить** его в модели.
 *
 * # Конвейер — ОДИН
 *
 * Раньше здесь лежала копия конвейера, и она разошлась с оракулом цели: обвязка
 * выбирала одну точку возврата из нескольких — отсюда класс 3. Теперь сборка
 * образа живёт в `src/e2k/programImage.ts`, и этой копии нет: страховка по хешу
 * (сверка образа с артефактом оракула владельца) снята вместе с копией.
 *
 * # Чего модуль НЕ делает
 *
 * Не доказывает, что так поведёт себя железо: QEMU — модель. И не берётся за
 * программы с печатью или вызовом процедуры: `система.лог.вывести` на цель не
 * понижен, а вызов упирается в окно вызываемой (§3.24).
 */
import * as fs from "fs";
import * as path from "path";
import { buildElfFromCode, MINIMAL_BASE } from "../e2k/elfMinimal";
import { HEAP_OFFSET, entryValueReturnsOf, loweredProgram } from "../e2k/programImage";
import { LOWERING_CODES, type LoweringRefusal } from "../e2k/loweringRefusal";
import { buildShim, runInQemu } from "./e2kQemuExec";

const ROOT = path.resolve(__dirname, "..", "..");

/** Готов ли шлюз: без шима и модели прогон невозможен, и причина называется. */
export function shimAvailable(): boolean {
  return buildShim() !== undefined;
}

/** Причина недоступности шлюза — для отчёта оракула. */
export const SHIM_REASON =
  "шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)";

/** Образ программы: байты, отказы понижения (КОД плюс причина) и число занятых регистров. */
export interface E2kImage {
  bytes: Uint8Array;
  refused: LoweringRefusal[];
  used: number;
}

/**
 * ОТКАЗ ОБВЯЗКИ: в программе больше одного возврата со значением.
 *
 * `IR.ret` в e2k-бэкенде **не понижается вовсе** — возврата процедуры там ещё
 * нет, и образ получает значение возврата через регистр, который читает `exit`.
 * Обход верен ровно тогда, когда возврат ОДИН: при двух исполнение после первого
 * **проваливается** в запасной путь, тот пишет в тот же регистр — и `exit` отдаёт
 * значение неисполненной ветви (замер `.tmp/dump-carriers-two-returns.ts`).
 *
 * Канонический регистр этого не лечит: провал перезапишет и его. Нужен единый
 * блок выхода с переходами из каждой точки возврата — это отдельная работа в
 * конвейере, и до неё отказ остаётся названным, а не тихим.
 */
export class MultiReturnRefusal extends Error {
  /**
   * Код контракта отказа понижения (`OSN-LOW-006`, обвязка): канал другой — ИСКЛЮЧЕНИЕ, а не запись
   * в `refused`, — а личность одна, и её читает наблюдатель по полю `code`
   * (`src/e2k/loweringRefusal.ts`).
   */
  readonly code = LOWERING_CODES.wrapper;
  constructor(readonly returns: number) {
    super(
      `обвязка не умеет возврат из середины ТОЧКИ ВХОДА: возвратов со значением ${String(returns)}, ` +
        'а результат точки входа уходит кодом возврата процесса — одна точка выхода на прогон. ' +
        'У ВЫЗЫВАЕМОЙ процедуры возвратов может быть сколько угодно: там работает `return %ctpr3`',
    );
    this.name = "MultiReturnRefusal";
  }
}

/** Собрать образ программы для цели. Бросает, если программа не компилируется или раскладка отказала. */
export function buildE2kImage(source: string): E2kImage {
  // Конвейер — общий с оракулом цели; здесь только перевод отказов в исключение
  // для программ с несколькими возвратами (см. {@link MultiReturnRefusal}).
  // Возвратов со значением может быть несколько — и тогда обход через регистр
  // неверен (см. MultiReturnRefusal). Отказываем ДО сборки: тихое неверное число
  // хуже названного отказа. Считаем по носителям, а не по тексту — И ТОЛЬКО В ТОЧКЕ ВХОДА:
  // у вызываемой процедуры возврат свой (`return %ctpr3`), и ранний возврат в ней — норма
  // (пример `08-факториал`), а не повод отказать программе.
  const returns = entryValueReturnsOf(source);
  if (returns > 1) throw new MultiReturnRefusal(returns);
  const built = loweredProgram(source);
  return { bytes: built.bytes, refused: [...built.refused], used: built.used };
}

/** Результат прогона на цели: код возврата `exit` и что не понизилось. */
export interface E2kRun {
  status: number | undefined;
  refused: LoweringRefusal[];
  used: number;
  file: string;
  /**
   * ВЫВОД МОДЕЛИ — то, что она сказала о прогоне (причина отказа пишется в stderr, а код
   * возврата при этом может быть 0). Отдаётся наружу, потому что иначе причина недоступна:
   * на этом уже спотыкались — код 134 читался как «модель упала», хотя модель могла назвать
   * причину словами. Собирается раннером всегда; наружу не отдавался.
   */
  output: string;
  /** Адрес инструкции, на которой модель остановилась с исключением (если назвала). */
  exceptionIp: number | undefined;
}

/**
 * БАЙТЫ ОБРАЗА ELF — тем же вызовом, что у оракула цели
 * (`buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET })`).
 */
export function buildElfImage(source: string): Uint8Array {
  const image = buildE2kImage(source);
  return buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: HEAP_OFFSET }).bytes;
}

/**
 * Исполнить программу из корпуса на цели.
 *
 * @param source текст программы (канон: файл = модуль)
 * @param fileName имя образа в `.tmp/` — по нему видно, чей прогон
 */
export function runOnE2k(source: string, fileName: string): E2kRun {
  const image = buildE2kImage(source);
  const elf = path.join(ROOT, ".tmp", fileName);
  fs.writeFileSync(elf, buildElfImage(source));
  const run = runInQemu(elf, { shim: true, timeoutMs: 20_000 });
  return {
    status: run?.status ?? undefined,
    refused: image.refused,
    used: image.used,
    file: elf,
    output: run?.output ?? "",
    exceptionIp: run?.exceptionIp,
  };
}
