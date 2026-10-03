/**
 * ФАЙЛОВЫЕ ОПЕРАЦИИ ЯЗЫКА: ИМЕНА, РЕЖИМЫ И ОТКАЗ — ОДНИ НА VM И НА ЦЕЛЬ.
 *
 * # Что здесь решается и почему именно здесь
 *
 * Владелец задал форму как ВСТРОЕННЫЕ СЛОВА v3 (`открыть`, `читать`, `писать`, `закрыть`), а не как
 * пути `система.файл.открыть`: в v3 точка — квалификация модуля, и `система.файл.открыть` дал бы
 * цепочку из двух точек, которую разбор отвергает (долг §3.105.5). Слова разворачивает фронтенд v3
 * (`src/compiler-v3/parser.ts`), а КАНОНИЧЕСКИЕ имена, в которые они разворачиваются, живут здесь —
 * затем, чтобы у VM, у семантики и у цели был ОДИН источник, а не три похожих списка.
 *
 * # Режимы — ЛИТЕРАЛЫ, а не строки
 *
 * `открыть("файл", чтение)` — слово в позиции аргумента, и оно превращается в ЧИСЛО флагов на
 * разборе. Три режима и их числа:
 *
 * | слово | флаги | значение | источник чисел |
 * |---|---|---|---|
 * | `чтение` | `O_RDONLY` | 0 | `linux-user/generic/fcntl.h` |
 * | `запись` | `O_WRONLY \| O_CREAT \| O_TRUNC` | 577 | там же |
 * | `дописать` | `O_WRONLY \| O_APPEND` | 1025 | там же |
 *
 * Числа — общие для Linux: у e2k своего `target_fcntl.h` нет, порт включает общий заголовок
 * (`linux-user/e2k/target_fcntl.h:9`; `docs/e2k-syscalls-minimal.md`, строка `open`). То есть это
 * не «взяли похожие» — это те же числа, что увидит ядро.
 *
 * # Длина при чтении — КОДОВЫЕ ТОЧКИ
 *
 * `читать(дескриптор, длина)` считает длину в КОДОВЫХ ТОЧКАХ, как и `длина` строки
 * (`система.строка.длина`: `длина("🙂")` = 1). Иначе лексер, читающий файл порциями, разрезал бы
 * двухбайтовую букву пополам и получил бы невалидный текст — а заметить это было бы нечем.
 *
 * # Чего здесь НЕТ
 *
 * Здесь нет ни доступа к настоящей файловой системе, ни syscall'ов: и то и другое приходит
 * ПОРТАМИ ({@link FilePorts}). Хост-прогон отдаёт порты на `node:fs`, цель — на системные вызовы
 * 5/3/4/6 (`src/self-host/fileRuntime.ts`). Так «что значит операция» и «чем она исполняется»
 * разведены: расхождение между сторонами видно как расхождение ПОРТОВ, а не как разный текст двух
 * реализаций.
 */
import type { InvokeHandler, StackValue } from './interpreter';

/**
 * КАНОНИЧЕСКИЕ ИМЕНА. В программе на v3 их не пишут — их ставит разворот встроенных слов; в
 * написании v2 они работают напрямую.
 *
 * Модуль — `система.файлы` (множественное число), как у существующих `прочитать_все` /
 * `записать_все` / `существует`: второй модуль для того же предмета развёл бы канон надвое.
 */
export const FILE_CALLS = {
  open: 'система.файлы.открыть',
  read: 'система.файлы.читать',
  write: 'система.файлы.писать',
  close: 'система.файлы.закрыть',
} as const;

/**
 * Арность: `открыть(путь, режим)`, `читать(дескриптор, длина)`, `писать(дескриптор, текст)`,
 * `закрыть(дескриптор)`.
 *
 * Проверяется ДО прогона: неверное число аргументов — отказ семантики с числом, а не тихая порча
 * стека VM (у неё `getInvokeArgCount` снимает со стека ровно столько, сколько объявлено).
 */
export const FILE_ARITY: Readonly<Record<string, number>> = {
  [FILE_CALLS.open]: 2,
  [FILE_CALLS.read]: 2,
  [FILE_CALLS.write]: 2,
  [FILE_CALLS.close]: 1,
};

/** Флаги `open` — те же числа, что у Linux (см. таблицу в шапке). */
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_CREAT = 0o100;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;

/** Флаги по режиму: одно место, где режим превращается в число. */
export const FILE_MODE_FLAGS: Readonly<Record<string, number>> = {
  чтение: O_RDONLY,
  запись: O_WRONLY | O_CREAT | O_TRUNC,
  дописать: O_WRONLY | O_APPEND,
};

/**
 * Слова режимов в написании v3. Список ЗАКРЫТ: неизвестное слово в позиции режима — отказ разбора,
 * а не молчаливый ноль. Ноль здесь особенно опасен: это `O_RDONLY`, то есть «файл только для
 * чтения», и опечатка в слове открыла бы файл на запись как «ничего не сказал».
 */
export const FILE_MODE_WORDS: readonly string[] = Object.keys(FILE_MODE_FLAGS);

/**
 * НАЗВАННЫЙ ОТКАЗ ФАЙЛОВЫХ ОПЕРАЦИЙ.
 *
 * Отдельный класс, а не общий с коллекциями и строками: у файла СВОЯ причина («файла нет»,
 * «дескриптор не от открытия», «чтение после закрытия»), и смешивать её с «индекс вне ёмкости»
 * значило бы потерять различие — тот же урок, что у строк отказа арены и коллекций (случай 34).
 */
export class FileRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileRefusal';
  }
}

/**
 * ПОРТЫ ФАЙЛОВОЙ СИСТЕМЫ — то, чем операция исполняется.
 *
 * `open` возвращает ДЕСКРИПТОР (число); отрицательный ответ означает отказ, и его `errno` едет
 * третьим полем — так у хоста и у цели один и тот же контракт: «отказ есть отрицательное число».
 * Это ровно тот ABI, что у системного вызова e2k (`-errno`, `docs/e2k-syscalls-minimal.md`).
 */
export interface FilePorts {
  /** `open(путь, флаги)` → дескриптор ≥ 0 либо `{ error: errno }`. */
  open(path: string, flags: number): { fd: number } | { error: number };
  /** `read(дескриптор, длина_в_кодпоинтах)` → прочитанный текст (пустой на конце файла). */
  read(fd: number, length: number): { text: string } | { error: number };
  /** `write(дескриптор, текст)` → сколько записано либо отказ. */
  write(fd: number, text: string): { written: number } | { error: number };
  /** `close(дескриптор)` → `null` при успехе либо отказ. */
  close(fd: number): { error: number } | null;
}

/** Разбор целочисленного аргумента: нечисло — НАЗВАННЫЙ отказ, а не молчаливый ноль. */
function integerOr(value: StackValue, operation: string, role: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new FileRefusal(`файлы.${operation}: ${role} = ${String(value)} — не число`);
  }
  return Math.trunc(number);
}

/**
 * Обработчик `invoke` для файловых операций поверх портов.
 *
 * Возвращается ГОТОВЫЙ `InvokeHandler`, а не набор функций: обе VM принимают обработчик одним
 * параметром, и подключается он одинаково (`new VM(code, { invoke })`).
 */
export function createFileInvokeHandler(ports: FilePorts): InvokeHandler {
  return (name: string, args: StackValue[]): StackValue | null => {
    switch (name) {
      case FILE_CALLS.open: {
        const path = String(args[0] ?? '');
        const flags = integerOr(args[1] as StackValue, 'открыть', 'режим');
        const answer = ports.open(path, flags);
        if ('error' in answer) {
          throw new FileRefusal(
            `файлы.открыть: файл ${JSON.stringify(path)} не открыт, отказ ${String(answer.error)} ` +
              '(отрицательный ответ ядра: файла нет, нет прав или режим недоступен)',
          );
        }
        return answer.fd;
      }
      case FILE_CALLS.read: {
        const fd = integerOr(args[0] as StackValue, 'читать', 'дескриптор');
        const length = integerOr(args[1] as StackValue, 'читать', 'длина');
        if (length < 0) {
          throw new FileRefusal(`файлы.читать: длина ${String(length)} отрицательна`);
        }
        const answer = ports.read(fd, length);
        if ('error' in answer) {
          throw new FileRefusal(
            `файлы.читать: дескриптор ${String(fd)} не читается, отказ ${String(answer.error)}`,
          );
        }
        return answer.text;
      }
      case FILE_CALLS.write: {
        const fd = integerOr(args[0] as StackValue, 'писать', 'дескриптор');
        const text = typeof args[1] === 'string' ? args[1] : String(args[1] ?? '');
        const answer = ports.write(fd, text);
        if ('error' in answer) {
          throw new FileRefusal(
            `файлы.писать: дескриптор ${String(fd)} не пишется, отказ ${String(answer.error)}`,
          );
        }
        return answer.written;
      }
      case FILE_CALLS.close: {
        const fd = integerOr(args[0] as StackValue, 'закрыть', 'дескриптор');
        const answer = ports.close(fd);
        if (answer !== null) {
          throw new FileRefusal(
            `файлы.закрыть: дескриптор ${String(fd)} не закрыт, отказ ${String(answer.error)}`,
          );
        }
        return null;
      }
      default:
        return null;
    }
  };
}

/**
 * Тип возврата файловой операции — для вывода типов в семантике.
 *
 * `читать` возвращает Строку, `открыть` и `писать` — Число, `закрыть` — ничего (`пусто`). Без
 * этой таблицы `длина читать(д, 100)` отверглась бы с «тип не выведен», как это уже было у символа
 * строки (`src/compiler/compiler.ts#syscallReturnType`).
 */
export const FILE_RETURN_TYPES: Readonly<Record<string, 'Число' | 'Строка' | 'пусто'>> = {
  [FILE_CALLS.open]: 'Число',
  [FILE_CALLS.read]: 'Строка',
  [FILE_CALLS.write]: 'Число',
  [FILE_CALLS.close]: 'пусто',
};
