/**
 * ГЕНЕРАТОР ЗОНДОВ ОКНА: шесть файлов пробы — не шесть рукописей, а ОДНА форма с параметрами.
 *
 * # Зачем
 *
 * `tools/e2k-hardware/probes/d12-window/` держит шесть `.s`, и все шесть — один и тот же зонд с
 * другим номером клетки (и один — без холостого вызова). Рукописей шесть, форма одна; расхождение
 * между ними невидимо, потому что сравнивать не с чем.
 *
 * Отсюда и требование §7.2: геометрия должна быть ПАРАМЕТРОМ, а не повтором. Параметры здесь —
 * `wsz`, `rsz`, `rbs`, клетка и число вызовов, — то есть ровно те числа, которые придётся поднять в
 * день, когда сменится порт (сегодня `setwd wsz = 0x10`, клетки 12…15).
 *
 * # Что этот файл делает и чего не делает
 *
 * ДЕЛАЕТ: печатает текст пробы по параметрам и сверяет его с файлом в репозитории БАЙТ-В-БАЙТ.
 * Сверка байт — и есть оракул: если генератор и закоммиченные пробы разойдутся, правка была в одном
 * из двух мест, и это видно сразу.
 *
 * НЕ ДЕЛАЕТ: не собирает и не запускает. Сборка требует вендорского `as` под e2k, которого на этой
 * машине нет (`as` в WSL — x86 binutils: `no such instruction: 'setwd wsz = 0x10'`), а замер на
 * железе требует ssh-ключа, которого тоже нет. Это названо, а не обойдено молча.
 *
 * # Откуда форма команд
 *
 * Дословно из закоммиченных проб (`probe-b12.s`): `setwd` открывает окно, `setbn` ставит область
 * вращения, четыре `movts` кладут значения в клетки блока, `movts` в `%r8..%r11` — аргументы
 * системного вызова, `setwd wsz = wbs + 4` сужает окно ПЕРЕД `sdisp` (закон §3.113),
 * `sdisp` + `ipd 3` + `call %ctpr1, wbs = 0x4` делают вызов, затем окно восстанавливается.
 *
 * Ширина кадра везде **4**, поэтому местное окно вызова — **8**: это и есть `wsz − wbs = 4`.
 */

/** Одна проба: что положить и сколько раз вызвать. */
export interface ProbeSpec {
  /** Имя файла без `.s` — оно же имя пробы в отчёте (`exit(<имя>) = <код>`). */
  readonly name: string;
  /** Клетка, которую читает `exit`; она же — предмет пробы. */
  readonly cell: number;
  /** Значение, положенное в эту клетку ДО вызова. */
  readonly value: number;
  /**
   * Сколько системных вызовов делает проба: **2** — вопрос (холостой `write` + `exit`),
   * **1** — контроль (только `exit`).
   *
   * Почему именно счётчик, а не булево «есть вызов»: в контроле вызов ВСЁ РАВНО есть — это сам
   * `exit`, и он возвращает код наружу. Отличие в том, ЧТО сделав вызов до чтения. Первая редакция
   * сторожа держала `withCall: boolean` и краснела на контроле словами «системный вызов есть, а по
   * реестру должен отсутствовать» — ошибка была в модели признака, а не в пробе.
   */
  readonly calls: number;
}

/** Геометрия окна: числа, которые поднимают при смене порта. */
export interface WindowGeometrySpec {
  /** Окно пролога образа, квадрослов (`setwd wsz`). */
  readonly wsz: number;
  /** Область вращения (`setbn rsz`). */
  readonly rsz: number;
  /** База области вращения (`setbn rbs`). */
  readonly rbs: number;
  /** Ширина кадра вызова (`call wbs`). */
  readonly wbs: number;
}

/** Геометрия, закреплённая пробами 2026-11-08 (`setwd wsz = 0x10`, `setbn rsz = 0x7`). */
export const PROBE_GEOMETRY: WindowGeometrySpec = { wsz: 0x10, rsz: 0x7, rbs: 0x0, wbs: 0x4 };

/** Клетки блока рантайма массивов: `ENTRY_ARRAY_CELLS` плюс адрес ячейки кучи (`heapSlot`). */
export const PROBE_BLOCK_CELLS: readonly { readonly cell: number; readonly value: number }[] = [
  { cell: 12, value: 0x0 },
  { cell: 13, value: 0x1 },
  { cell: 14, value: 0x8 },
  { cell: 15, value: 0x11 },
];

/** Значение, которое проба кладёт в СВОЮ клетку (если она не в блоке). */
export const PROBE_DEFAULT_VALUE = 0x11;

/** Шесть проб: четыре вопроса по клеткам блока и контроль для клетки 14. */
export const PROBE_SPECS: readonly ProbeSpec[] = [
  { name: 'probe-b12', cell: 12, value: 0x0, calls: 2 },
  { name: 'probe-b13', cell: 13, value: 0x1, calls: 2 },
  { name: 'probe-b14', cell: 14, value: 0x8, calls: 2 },
  { name: 'probe-b15', cell: 15, value: 0x11, calls: 2 },
  { name: 'probe-b14-nowrite', cell: 14, value: 0x8, calls: 1 },
];

/** Число в шестнадцатеричной записи вида `0x10` — так пишет вендорский `as`, так пишут и пробы. */
export function hex(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`hex: ожидалось неотрицательное целое, получено ${String(value)}`);
  }
  return `0x${value.toString(16)}`;
}

/**
 * Текст пробы по параметрам. Разделители — ТАБ и `\n`, как в закоммиченных файлах.
 *
 * `calls = 2` — вопрос: холостой `write(1, NULL, 0)` перед чтением клетки.
 * `calls = 1` — контроль: чтение клетки сразу, вызовом будет только `exit`.
 */
export function probeSource(spec: ProbeSpec, geometry: WindowGeometrySpec = PROBE_GEOMETRY): string {
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(line);
  };

  push('\t.text');
  push('\t.globl _start');
  push('_start:');
  push(`\tsetwd wsz = ${hex(geometry.wsz)}, nfx = 0x0`);
  push(`\tsetbn rbs = ${hex(geometry.rbs)}, rsz = ${hex(geometry.rsz)}, rcur = 0x0`);

  // БЛОК РАНТАЙМА: все четыре клетки кладутся ВСЕГДА, даже когда проба читает одну из них —
  // иначе проба мерила бы не «уцелел ли блок», а «что лежало в клетке до записи».
  for (const block of PROBE_BLOCK_CELLS) {
    push(`\tmovts,0 ${hex(block.value)}, %b[${String(block.cell)}]`);
  }

  if (spec.calls >= 2) {
    push('\t# --- write(1, NULL, 0): холостой системный вызов, ровно та же форма, что у сайта печати ---');
    push('\tmovts,0 0x4, %r8');
    push('\tmovts,0 0x1, %r9');
    push('\tmovts,0 0x0, %r10');
    push('\tmovts,0 0x0, %r11');
    push(`\tsetwd wsz = ${hex(geometry.wbs + 4)}, nfx = 0x0`);
    push('\tsdisp %ctpr1, 0x3');
    push('\tipd 3');
    push(`\tcall %ctpr1, wbs = ${hex(geometry.wbs)}`);
    push(`\tsetwd wsz = ${hex(geometry.wsz)}, nfx = 0x0`);
  }

  push(`\t# --- exit(%b[${String(spec.cell)}]): что уцелело в блоке рантайма после системного вызова ---`);
  push('\tmovts,0 0x0, %b[11]');
  push('\tmovts,0 0x1, %r8');
  push(`\tadds,0 %b[${String(spec.cell)}], %b[11], %r9`);
  push(`\tsetwd wsz = ${hex(geometry.wbs + 4)}, nfx = 0x0`);
  push('\tsdisp %ctpr1, 0x3');
  push('\tipd 3');
  push(`\tcall %ctpr1, wbs = ${hex(geometry.wbs)}`);
  push('\tnop');

  // Завершающий перевод строки обязателен: без него `read` в стенде теряет последнюю строку
  // (TD-0003), а `as` предупреждает о файле без новой строки.
  return `${lines.join('\n')}\n`;
}

/**
 * Строка отчёта, которую проба печатает на машине: `exit(<имя>) = <код>`.
 *
 * Генератор её не вычисляет — код знает только прогон. Здесь она собирается для сверки ОТЧЁТА с
 * набором проб: сторож требует, чтобы у каждой пробы в отчёте была ровно одна строка.
 */
export function reportLine(name: string, code: number): string {
  return `exit(${name}) = ${String(code)}`;
}
