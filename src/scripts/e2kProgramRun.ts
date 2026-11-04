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
import { entryValueReturnsOf } from "../e2k/programImage";
import { LOWERING_CODES, refusalOf, type LoweringRefusal } from "../e2k/loweringRefusal";
import { loweredProgram } from "../e2k/lowered";
import type { CompileOptions } from "../compiler/compiler";
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
  /**
   * Сколько памяти отображает сегмент СВЕРХ файла: область записи (куча, арена, площадка печати и
   * слоты) лежит выше кода, и без этого числа обращение к ней — исключение. Берётся из отчёта
   * образа, а не из константы: у программ с ареной и без неё отображение одно и то же, но знание об
   * этом — у конвейера (`src/e2k/programImage.ts#imageOfCarriers`).
   */
  extraMemory: number;
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

/**
 * Собрать образ программы для цели. Бросает, если программа не компилируется или раскладка отказала.
 *
 * РАЗБОРЩИК ПЕРЕДАЁТСЯ СНАРУЖИ (`CompileOptions.parse`) — решение D10. Диалект исходника НЕ виден по
 * имени файла: и v2, и v3 лежат в `.osnova` (у v3-модуля нет шапки `модуль Имя`), поэтому «взять
 * другое расширение» обходом не является. По умолчанию — прежний (v2) разбор: кит и корпус не
 * двигаются ни на байт, это доказано сверкой 38 sha256. v3-потребитель (проба на железо, оракул)
 * передаёт свой разборщик явно.
 */
export function buildE2kImage(source: string, options: CompileOptions = {}): E2kImage {
  // Конвейер — общий с оракулом цели; здесь только перевод отказов в исключение
  // для программ с несколькими возвратами (см. {@link MultiReturnRefusal}).
  // Возвратов со значением может быть несколько — и тогда обход через регистр
  // неверен (см. MultiReturnRefusal). Отказываем ДО сборки: тихое неверное число
  // хуже названного отказа. Считаем по носителям, а не по тексту — И ТОЛЬКО В ТОЧКЕ ВХОДА:
  // у вызываемой процедуры возврат свой (`return %ctpr3`), и ранний возврат в ней — норма
  // (пример `08-факториал`), а не повод отказать программе.
  const returns = entryValueReturnsOf(source, options);
  if (returns > 1) throw new MultiReturnRefusal(returns);
  // ПУБЛИЧНАЯ ДВЕРЬ (D11): под отказом байтов нет. Кит — потребитель, а не сторож: ему нужен образ,
  // который можно исполнить. Отказы он при этом НЕ прячет — отдаёт диагностику наружу тем же полем
  // `refused` (код + причина), а `bytes` остаётся пустым: «собралось» и «исполнимо» — разные вещи.
  const итог = loweredProgram(source, options);
  if (!итог.ок) {
    return {
      bytes: new Uint8Array(0),
      refused: итог.отказ.отказы.map((запись) => refusalOf(запись.код, запись.причина)),
      used: 0,
      extraMemory: 0,
    };
  }
  return {
    bytes: итог.значение.bytes,
    refused: [],
    used: итог.значение.used,
    extraMemory: итог.значение.arena.extraMemory,
  };
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
 * (`buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: image.extraMemory })`).
 *
 * Разборщик — тот же, что у {@link buildE2kImage} (D10): по умолчанию прежний.
 */
export function buildElfImage(source: string, options: CompileOptions = {}): Uint8Array {
  const image = buildE2kImage(source, options);
  return buildElfFromCode(image.bytes, MINIMAL_BASE, { writable: true, extraMemory: image.extraMemory }).bytes;
}

/**
 * Исполнить программу из корпуса на цели.
 *
 * @param source текст программы (канон: файл = модуль)
 * @param fileName имя образа в `.tmp/` — по нему видно, чей прогон
 * @param options разборщик и прочие опции компилятора (D10): по умолчанию прежний (v2) разбор
 */
export function runOnE2k(source: string, fileName: string, options: CompileOptions = {}): E2kRun {
  const image = buildE2kImage(source, options);
  // БАЙТОВ ПОД ОТКАЗОМ НЕТ (D11) — и запускать нечего. Прежде кит исполнял такой образ и отдавал
  // наружу ЧИСЛО; под несущим отказом оно ЛЖЁТ (случаи 60 и 62), поэтому число под отказом добывается
  // теперь только сторожем (`src/e2k/guards/loweredUnchecked.ts`), а не прогоном корпуса.
  if (image.refused.length > 0) {
    return { status: undefined, refused: image.refused, used: image.used, file: "", output: "", exceptionIp: undefined };
  }
  const elf = path.join(ROOT, ".tmp", fileName);
  fs.writeFileSync(elf, buildElfImage(source, options));
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
