/**
 * КОДОВЫЕ ТОЧКИ — ЕДИНИЦА ДЛИНЫ И ИНДЕКСАЦИИ СТРОК В ЯЗЫКЕ ОСНОВА.
 *
 * **Решение владельца 2026-09-28 (принято, не обсуждается):** длина и индексация строк
 * считаются **кодовыми точками** — не единицами UTF-16, не графемами и не байтами UTF-8.
 * Python как независимый эталон отдаёт ровно кодовые точки, и человек думает символами.
 *
 * **Что было до этого — измерено** (`.tmp/t19-units.ts`, разбор §3.47.3):
 *
 * | выражение | было (UTF-16) | стало (кодовые точки) | Python |
 * |---|---|---|---|
 * | `длина("🙂")` | **2** | **1** | 1 |
 * | `длина("👨‍👩‍👧")` | **8** | **5** | 5 |
 * | `подстрока("🙂", 0, 1)` | `"\ud83d"` — **половина суррогатной пары** | `"🙂"` | `"🙂"` |
 * | `подстрока("🙂x", 1, 2)` | `"\ude42"` — младший суррогат | `"x"` | `"x"` |
 * | `найти("🙂x", "x")` | **2** | **1** | 1 |
 * | `"🙂" > "\uFFFD"` | **ложь** (единица 0xD83D < 0xFFFD) | **истина** (кодовая точка 0x1F642 > 0xFFFD) | истина |
 *
 * Последняя строка — **отдельный класс расхождения, не про длину**: порядок строк по единицам
 * UTF-16 и по кодовым точкам различается, потому что суррогаты (0xD800–0xDFFF) стоят в UTF-16
 * **ниже** 0xE000–0xFFFF, а кодовые точки астральных символов — **выше**. Сравнение приведено к
 * кодовым точкам тем же решением, иначе VM разошлась бы с эталоном на первой же паре «эмодзи
 * против символа из области Private Use / замены».
 *
 * **Почему это дешево на цели.** Представление строки на цели — байты UTF-8, а **порядок байтов
 * UTF-8 совпадает с порядком кодовых точек**: `memcmp` двух строк даёт ровно тот же ответ, что
 * этот компаратор. То есть единица «кодовая точка» не требует разбора UTF-8 ни для сравнения,
 * ни для равенства — только для длины и индексов.
 *
 * **Границы, названные явно.** Графемы не считаются: `👨‍👩‍👧` — пять кодовых точек (три символа и
 * два ZWJ), и это правильно по решению владельца. Нормализация (NFC/NFD) не делается: `е + U+0308`
 * — две кодовые точки, как в Python. Индекс `найти` — в кодовых точках; если искомая подстрока
 * начинается с одиночного суррогата, ответ определён как «число кодовых точек до совпадения» и
 * остаётся корректным числом, а не отказом.
 */

/** Сколько КОДОВЫХ ТОЧЕК в строке. Не `.length`: там единицы UTF-16. */
export function codePointLength(value: string): number {
  let count = 0;
  // Итерация строки идёт по кодовым точкам, поэтому суррогатная пара считается за одну.
  for (const _ of value) count += 1;
  return count;
}

/** Строка как массив кодовых точек (каждая — целая, пара не рвётся). */
export function toCodePoints(value: string): string[] {
  return [...value];
}

/**
 * Срез по КОДОВЫМ ТОЧКАМ с теми же краями, что у прежнего `String.prototype.slice`: отрицательный
 * индекс считается от конца, `undefined` в конце — до конца строки, выход за границы обрезается.
 * Суррогатная пара не разрезается никогда: элементов-половин в результате быть не может.
 */
export function codePointSlice(value: string, start: number, end?: number): string {
  const points = toCodePoints(value);
  const normalize = (raw: number, fallback: number): number => {
    // Края повторяют `String.prototype.slice` по числам, кроме единицы счёта: NaN считается
    // нулём (у JS `slice` это так же), `undefined` (только у конца) — «до конца строки»,
    // отрицательное — от конца, выход за границы обрезается.
    if (Number.isNaN(raw)) return 0;
    if (!Number.isFinite(raw)) return fallback;
    const whole = Math.trunc(raw);
    return whole < 0 ? Math.max(points.length + whole, 0) : Math.min(whole, points.length);
  };
  const from = normalize(start, 0);
  const to = end === undefined ? points.length : normalize(end, points.length);
  if (to <= from) return "";
  return points.slice(from, to).join("");
}

/**
 * Индекс первого вхождения ПОДСТРОКИ, посчитанный в КОДОВЫХ ТОЧКАХ (`-1` — не найдено).
 * Так же отвечает Python `str.find`.
 */
export function codePointIndexOf(value: string, needle: string): number {
  const unitIndex = value.indexOf(needle);
  if (unitIndex < 0) return -1;
  // До совпадения не может быть разорванной пары: `indexOf` нашёл целую подстроку.
  return codePointLength(value.slice(0, unitIndex));
}

/** Сравнение строк по КОДОВЫМ ТОЧКАМ: −1, 0, 1. Тот же ответ, что у Python `<`. */
export function compareCodePoints(left: string, right: string): number {
  const a = codePointIterator(left);
  const b = codePointIterator(right);
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done === true && y.done === true) return 0;
    if (x.done === true) return -1;
    if (y.done === true) return 1;
    const xc = x.value as number;
    const yc = y.value as number;
    if (xc !== yc) return xc < yc ? -1 : 1;
  }
}

/** Итератор кодовых точек без создания массива. */
function codePointIterator(value: string): Iterator<number> {
  let index = 0;
  return {
    next(): IteratorResult<number> {
      if (index >= value.length) return { done: true, value: undefined };
      const code = value.codePointAt(index) as number;
      index += code > 0xffff ? 2 : 1;
      return { done: false, value: code };
    },
  };
}

/** Оператор порядка, какой понимает VM. */
export type OrderOp = "<" | "<=" | ">" | ">=";

/**
 * Порядок ДВУХ значений языка: строки — по кодовым точкам, числа — численно, прочее — как раньше
 * (сравнение JS, чтобы поведение на не-строках не сдвинулось ни на шаг).
 */
export function orderedCompare(a: unknown, b: unknown, op: OrderOp): boolean {
  if (typeof a === "string" && typeof b === "string") {
    const c = compareCodePoints(a, b);
    switch (op) {
      case "<":
        return c < 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
      case ">=":
        return c >= 0;
    }
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  switch (op) {
    case "<":
      return (a as any) < (b as any);
    case "<=":
      return (a as any) <= (b as any);
    case ">":
      return (a as any) > (b as any);
    case ">=":
      return (a as any) >= (b as any);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
