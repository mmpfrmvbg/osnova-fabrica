/**
 * МИНИМАЛЬНЫЙ ELF ДЛЯ e2k: `_start`, который делает `exit(42)`.
 *
 * # Зачем
 *
 * Прогон в QEMU (`docs/e2k-qemu-run.md`) упирался в две вещи: **нечем** запускать (QEMU не был
 * собран) и **нечего** запускать (у конвейера нет e2k-бинарника). Первое снято — `qemu-e2k`
 * собран. Здесь делается второе: минимальный ELF64 с `e_machine = 175`, секцией `.text`
 * и точкой входа.
 *
 * # Статус: `exit(42)` ВЫПОЛНЕН
 *
 * Прогон с шимом для `mmap` даёт **код возврата 42** (`docs/e2k-minimal-elf.md` §7). Программа —
 * пять инструкций, и каждая форма извлечена из источников и сверена ассемблером МЦСТ:
 * `setbn` (CS1, окно вращаемых регистров), `movts` с литералом LTS в **оконные** `%r8`/`%r9`,
 * `sdisp` (CS0 с `ctp_opc = 2`, ставит тег `CTPSL`), `call` (CS1, `wbs=4`).
 *
 * Номер системного вызова — **1** (`exit`), не 60: числа берутся из порта QEMU
 * (`qemu/linux-user/e2k/syscall_nr.h:9` — `TARGET_NR_exit 1`; `:293` — `TARGET_NR_exit_group 300`).
 *
 * # Чем это далось — две послабления со стороны ХОСТА, не программы
 *
 * 1. **Шим для `mmap`**: WSL1 не знает `MAP_FIXED_NOREPLACE` (`errno=95`), на котором стоит поиск
 *    гостевого резерва (`linux-user/elfload.c:792`), поэтому QEMU не размещает гостя вовсе.
 * 2. **Правка порта QEMU**: поля `WD.size_d/base_d` порт только читает
 *    (`reg-index.h:64-79`, `translate-ct.c:71-73`), а сам строит `WD` из `_q`-полей; без правки
 *    системный вызов умирает на чтении номера из оконного `r0` — «syscall without proper WD
 *    configuration» (`cpu_loop.c:164-169`).
 *
 * Оба послабления — на стороне хоста; байты ELF при этом не меняются, и без них тот же ELF
 * останавливается с названной причиной, а не «работает иначе».
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AsmInstruction, Operand } from './backend';
import { getEncoder } from './backend';

const ROOT = path.resolve(__dirname, "..", "..");

/** Базовый адрес загрузки — НАШЕ РЕШЕНИЕ (у загрузчика linux-user он свободный). */
export const MINIMAL_BASE = 0x100000;

/**
 * Где в памяти лежит КОД образа: `base + 0x1000`.
 *
 * Это не «заголовочная» величина, а измеренная: три печати подряд (432 команды, 4208 байт) доходят
 * до `0x102070`, а площадка печати стоит на `0x101EC0` — значит код начинается на `0x101000`
 * (`docs/hardware-debt.md` §3.40.6). Той же границей считается сторож печати
 * (`src/e2k/programImage.ts`: код не имеет права дорасти до площадки).
 */
export const IMAGE_TEXT_OFFSET = 0x1000;

/**
 * Хвост образа: `extraMemory` сегмента кода, байт. В его начале встаёт **куча** рантайма массивов
 * (`src/e2k/arrayRuntime.ts`: `%b[15]` = `MINIMAL_BASE + IMAGE_TAIL_OFFSET`).
 *
 * # Почему 0x11000, а не 0x2000 (замер 2026-09-29, `docs/hardware-debt.md` §3.91)
 *
 * По этому адресу считается **вся область записи**: куча, слоты вытеснения (`−0x100`), площадка
 * печати (`−0x140`) и сохранения сайтов печати. Модель делает **страницу** переведённого кода
 * защищённой, поэтому область записи обязана лежать на странице, где кода нет: при прежних
 * `0x2000` она стояла на `0x101000` — первой странице ПОСЛЕ кода, — и любая программа, чей код
 * заходил в эту страницу, падала на первой же записи в площадку печати
 * (`QEMU internal SIGSEGV {code=ACCERR, addr=0x101ecb}`). Замер: конец кода `0x1008d0` — работает,
 * `0x101480` и `0x101c60` — падают, `0x100dc0` — работает.
 *
 * Теперь область записи стоит на `0x110000`: страница (`0x110000`) под площадку, слоты и буфер
 * склейки, следующая (`0x111000`) — под кучу и арену. Код волен расти до `0x110000` (64 КиБ), и
 * граница эта названа сторожем (`src/e2k/programImage.ts`), а не молчанием.
 *
 * Величина — не «на глаз»: она равна `HEAP_OFFSET` всех шлюзовых образов (`src/e2k/programImage.ts`
 * берёт её отсюда же), и тем самым адреса, зашитые раскладкой, и адреса, которыми живёт прогон, —
 * одни и те же числа.
 */
export const IMAGE_TAIL_OFFSET = 0x11000;

/**
 * `extraMemory` образа, который ЧТО-ТО пишет: куча, арена и область записи — по одной странице.
 *
 * `p_memsz` сегмента данных считается от `DATA_SEGMENT_BASE`, и этой величины хватает и области
 * записи (площадка, слоты, буфер склейки), и странице кучи с ареной за ней.
 *
 * **ОГОВОРКА 2026-09-30 (§3.93):** с появлением отдельного сегмента данных это число стало
 * ИЗБЫТОЧНЫМ для отображения — сегмент данных отображается сам (`p_filesz = 0`). Здесь оно осталось
 * затем, что им пользуется отчёт образа и кит; разбор «убрать или объяснить» — отдельная карточка,
 * и вызовы `buildElfFromCode` его больше не требуют.
 */
export const WRITE_ZONE_EXTRA_MEMORY = IMAGE_TAIL_OFFSET + 0x1000;

/**
 * НАЧАЛО СЕГМЕНТА ДАННЫХ — страница области записи, на страницу ниже кучи.
 *
 * Область записи считается от кучи: площадка печати — `куча − 0x140`, слоты вытеснения — `куча −
 * 0x100`, буфер склейки — `куча − 0x14`. Все три попадают на страницу НИЖЕ кучи, поэтому начало
 * сегмента данных и есть начало этой страницы. Число выведено из геометрии, а не выбрано: сдвинь
 * куча — сдвинется и сегмент.
 */
export const DATA_SEGMENT_BASE = MINIMAL_BASE + IMAGE_TAIL_OFFSET - 0x1000;

/**
 * РАЗМЕР СЕГМЕНТА ДАННЫХ ПО УМОЛЧАНИЮ: страница области записи и КУЧА С АРЕНОЙ.
 *
 * Две страницы — потому что за областью записи сразу идёт куча массивов (`MINIMAL_BASE +
 * IMAGE_TAIL_OFFSET`), и на той же странице начинается арена (§3.88.4: они начинаются там же).
 * Этого хватает программам с маленькими списками.
 *
 * САЙТ МОЖЕТ ПОДНЯТЬ РАЗМЕР ЧЕРЕЗ `buildElfFromCode({ dataSegmentBytes })` (2026-11-08, D49). Замер
 * полного одно-проходного лексера: вход на 3219 кодовых точек — это 3219·8 = **25752** байта списка
 * кодов плюс список токенов (~53 КБ кучи), и на двух страницах прогон падал кодом 9 (запись за
 * отображённую страницу), то есть тихой ложью, а не отказом. Умолчание оставлено прежним НАМЕРЕННО:
 * `p_memsz` сегмента данных входит в файл, поэтому смена умолчания сдвинула бы `sha256/16` образов всех
 * прочих программ (и закреплённые пины приёмочных проб) — лексер просит `0x14000` сам.
 */
export const DATA_SEGMENT_BYTES = 0x2000;

/**
 * Область слотов вытеснения — **под указателем кучи**, 256 байт (32 слота по 8).
 *
 * Почему под кучей, а не над: куча растёт ВВЕРХ (`создать` и `добавить` двигают `%b[15]`), поэтому
 * всё, что ниже её начала, не будет занято никогда — а место выше кучи она со временем съест. Почему
 * не «в коде»: сегмент образа один, и запись в код испортила бы команды. Нижняя граница области —
 * начало СТРАНИЦЫ области записи (`IMAGE_TAIL_OFFSET` округлён вниз до 4 КиБ), и это стережёт
 * `src/e2k/programImage.ts`: код не имеет права войти в эту страницу (`§3.91`).
 */
export const SPILL_AREA_BYTES = 0x100;

/** Адрес области слотов вытеснения при данном адресе кучи. */
export function spillBaseOf(heapAddress: number): number {
  return heapAddress - SPILL_AREA_BYTES;
}

/**
 * Адрес области слотов **по умолчанию** — по конвенции образа (куча в начале хвоста).
 *
 * Нужен там, где образ не собирается, а только считается (конвейер `src/e2k/e2kRealRun.ts`,
 * замеры). Размеры команд от значения адреса не зависят: адрес слота кладётся литералом `movtd`
 * (16 байт) при любом значении, поэтому числа конвейера и числа прогона совпадают.
 */
export const DEFAULT_SPILL_BASE = spillBaseOf(MINIMAL_BASE + IMAGE_TAIL_OFFSET);

/** `e_machine = 175` — `EM_E2K` (`qemu/include/elf.h:195`) = `EM_MCST_ELBRUS` (`binutils-gdb/include/elf/common.h:295`). */
export const EM_E2K = 175;

/**
 * Номер машины в `e_flags` — **уровень ISA**, биты 24..31 (`binutils-gdb/include/elf/e2k.h:113-115`,
 * `E_E2K_MACH_EV5 = 5`). Номера `bfd_mach_e2k_*` совпадают с `E_E2K_MACH_*` ПО ЗНАЧЕНИЮ
 * («It's crucial that the underlying `bfd_mach_e2k*' have the same values as the corresponding
 * `E_E2K_MACH_*'s», `bfd/bfd-in2.h:1783-1784`) — поэтому одно и то же число здесь значит одно и то же.
 *
 * **БЫЛО `MACH_8C = 19`, и это был дефект.** Заголовок разделяет два рода кодов:
 * `E_E2K_MACH_EV2…EV7 = 2…7` помечены как «`-march=…` code» (уровень ISA), а
 * `E_E2K_MACH_8C = 19` (`e2k.h:135`), `1CPLUS = 20`, `12C = 21`… — как «`-mtune=…` code»
 * (конкретный кристалл). В `e_flags` стоит код ПЕРВОГО рода; мы клали код второго.
 *
 * **Почему 5, а не 19 — замерено на живом железе e2k, разбор `docs/hardware-debt.md` §3.108:**
 * ядро отвергает ELF с 19 (`ENOEXEC`, код возврата 126) и принимает с 5; LCC на той же машине
 * пишет в свои бинари 5 (`elbrus-v5`), и все её бинари несут 5; `-march=elbrus-8c` тулчейн
 * вовсе не принимает, а `-mtune=elbrus-8c` линковщик объявляет несовместимым с выходом
 * `elbrus-v5`. Плюс 5 согласуется с нашим же кодом: `AS_CPU_OPTION = -mcpu=elbrus-v5`
 * (`src/scripts/e2kExternalAs.ts`) — заголовок перестаёт противоречить содержимому.
 *
 * Смена значения на внешний дизассемблер НЕ влияет: `objdump -d` на одном и том же образе
 * с 19 и с 5 даёт посимвольно один и тот же разбор (107 строк-команд, отличий нет).
 */
export const MACH_V5 = 5;

/** Номер системного вызова `exit` в e2k Linux — `qemu/linux-user/e2k/syscall_nr.h:9`. */
export const SYS_EXIT = 1;

/** Регистр, из которого e2k-порт QEMU читает номер вызова (`cpu_loop.c:166`). */
export const ABI_NUMBER_REGISTER = 'r0';

/**
 * Сдвиг окна на системном вызове, в квадрословах (`call …, wbs=N`).
 *
 * Требование порта: `psize_q ≤ wbs ≤ size_q` (`translate-ct.c:908-917`), а начальные значения —
 * `psize_q = 4`, `size_q = 12` (паспорт). Стоит **`4`**, и это НЕ оптимум, а ЗАВИСИМОСТЬ.
 *
 * ЧТО ИЗМЕРЕНО 2026-10-09 (§3.117), когда `wbs` пробовали поднять до `8` при нашей базе вращения
 * (`rbs + rcur = 0`):
 *
 * | плоскость | что сказала про `wbs = 8` |
 * |---|---|
 * | **железо** | ловушку берёт и отдаёт **42** (проба `zb-post-nosetbn`), но при законном `wsz = 12` закон `wsz − wbs = 4` требует ровно `8`: с `wbs = 4` проба `za-w12-t3-wbs4` даёт **137** |
 * | **модель** | **ломается**: массивы 5/11, кадр вызова 3/8, печать 20/27 красные; сторож возвращает **92** вместо 91 — то есть после вызова `%b[]` вызывающего СДВИНУЛСЯ |
 *
 * Разгадка в вендорском коде: в `/lib64/libc.so.6` `wbs` сайта системного вызова РАВЕН `rbs + rcur`
 * (`longjmp`: `setbn rbs = 0x5` → `call wbs = 0x5` — 169 раз; `0x6` — 77 раз). Именно это совпадение
 * и держит `%b[]` на месте после вызова: оконный `r0` ядра — ровно `%b[0]` вызывающего. Наша
 * раскладка построена на обратном (`rbs + rcur = 0`, то есть `%b[N]` = единица `N`), поэтому поднять
 * `wbs` без сдвига базы вращения нельзя, а сдвиг базы — переработка раскладки (отложенный путь Б).
 * Проба `zp-kadr-trap3` это показывала заранее: 42 выходит при `rcur = 4`, то есть при `wbs = rbs + rcur`.
 */
export const SYSCALL_WBS = 4;

/**
 * Номер ловушки в `sdisp` (`sdisp %ctpr1, <номер>`), то есть какой вход ядра дёргается.
 *
 * **`3`, а не `0`** — измерено на железе: с нулём порт/машина опознаёт команду как недопустимую
 * (`SIGILL`, `ILL_ILLOPC`) и до вызова дело не доходит — так умирали все 38 образов кита (§3.116.3).
 * У вендора эта же тройка: в `/lib64/libc.so.6` **517** раз `sdisp %ctpr1, 0x3` и лишь 4 раза
 * `sdisp %ctpr1, 0x6`; в `/bin/true`, `/usr/bin/ld`, `/usr/bin/as`, `/bin/bash`, `/bin/ls`
 * системных вызовов нет вовсе (они в libc) (§3.117.1).
 */
export const SYSCALL_TRAP = 3;

/**
 * Номер регистра, в который кладётся номер вызова, **в окне вызываемого**.
 *
 * ABI читает его как оконный `r0` (`cpu_loop.c:164-170`), а `call` сдвигает окно на `wbs`
 * квадрослов, то есть на `2 * wbs` регистровых единиц (`MAXNR_D = MAXNR_Q * 2`,
 * `target/e2k/cpu.h:58`). Поэтому вызывающий пишет не в `%r0`, а в `%r(2 * wbs + 0)`: у нас это `%r8`.
 */
export const SYSCALL_NUMBER_REGISTER = 2 * SYSCALL_WBS;

/** Регистр аргумента (оконный `r1` вызываемого): `2 * wbs + 1`. */
export const SYSCALL_ARGUMENT_REGISTER = SYSCALL_NUMBER_REGISTER + 1;

/**
 * Размер области вращаемых регистров для `setbn` (`rsz=…`).
 *
 * `rsz = 4` даёт `(rsz + 1) * 2 = 10` доступных регистровых единиц (`e2k_calc_reg_idx_rotatable`,
 * `target/e2k/reg-index.h:30-52`) — этого хватает, чтобы записать `%r8` и `%r9` до вызова.
 */
export const SYSCALL_SETBN_RSZ = 4;

const imm = (value: number): Operand => ({ kind: 'imm', value });
const wreg = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });

/** Программа минимального ELF: инструкции и текст, который должен получиться у дизассемблера. */
export interface MinimalProgram {
  readonly instructions: readonly AsmInstruction[];
  readonly code: Uint8Array;
  /** Что обязан напечатать `objdump` для каждой инструкции. */
  readonly expectDisasm: readonly string[];
  /** Что требуется от **окружения**, чтобы этот ELF действительно сделал `exit(42)`. */
  readonly blockers: readonly string[];
}

/**
 * Собрать программу минимального ELF: `_start`, который делает `exit(42)`.
 *
 * Последовательность собирается из извлечённых и проверенных форм:
 *
 * | шаг | инструкция | зачем |
 * |---|---|---|
 * | 1 | `setbn rsz=4, rbs=0, rcur=0` | окно вращаемых регистров: `%r0`…`%r9` → абсолютные 0…9 |
 * | 2 | `movts,0 1, %r8` | номер вызова `exit` в **оконный** `r0` вызываемого |
 * | 3 | `movts,0 <код>, %r9` | аргумент в оконный `r1` вызываемого |
 * | 4 | `sdisp %ctpr1, 0` | подготовка `%ctpr1` с тегом `CTPSL` — это и есть признак системного вызова |
 * | 5 | `call %ctpr1, wbs=4` | передача управления: с тегом `CTPSL` порт уходит в `do_syscall` |
 *
 * Почему именно так (измерено, а не выведено):
 * `ct` без подготовки — исключение (`translate-ct.c:840-844`), поэтому нужен `disp`/`sdisp`;
 * тег `CTPSL` ставит только `sdisp` (`translate-ctp.c:174`); номер вызова ABI читает из **оконного**
 * `r0` (`cpu_loop.c:164-170`), а `call` сдвигает окно на `wbs`, поэтому запись идёт в `%r8`/`%r9`,
 * и для этого окно вращаемых регистров должно быть расширено `setbn` (`reg-index.h:30-52`).
 *
 * Форма записи значения тоже замерена: 1 влезает в 4 бита и кодируется короткой непосредственной
 * формой (8 байт), 42 — литеральным полем LTS (16 байт). Обе формы сверены с `as` побайтно.
 */
export function buildMinimalProgram(exitCode = 42): MinimalProgram {
  const encoder = getEncoder('e2k');
  const instructions: AsmInstruction[] = [
    { mnemonic: 'setbn', channel: 0, operands: [imm(SYSCALL_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(SYS_EXIT), wreg(SYSCALL_NUMBER_REGISTER)] },
    { mnemonic: 'movts', channel: 0, operands: [imm(exitCode), wreg(SYSCALL_ARGUMENT_REGISTER)] },
    { mnemonic: 'sdisp', channel: 0, operands: [imm(1), imm(SYSCALL_TRAP)] },
    { mnemonic: 'call', channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
  ];
  const chunks = instructions.map((instruction) => encoder.encode(instruction));
  const code = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    code.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    instructions,
    code,
    expectDisasm: [
      'setbn rbs = 0x0, rsz = 0x4, rcur = 0x0',
      // Короткая непосредственная форма: внешний дизассемблер МЦСТ печатает её без `_f16s`
      // («movts,0 0x1, %r8»), а `_f16s` — признак литерального поля LTS. Обе формы замерены.
      `movts,0 0x${SYS_EXIT.toString(16)}, %r${SYSCALL_NUMBER_REGISTER}`,
      `movts,0 _f16s 0x${exitCode.toString(16)}, %r${SYSCALL_ARGUMENT_REGISTER}`,
      'sdisp %ctpr1',
      'call %ctpr1, wbs = 0x4',
    ],
    blockers: [
      'окружение: на WSL1 нужен шим для mmap (MAP_FIXED_NOREPLACE не поддерживается, errno=95) — ' +
        'без него QEMU не размещает гостя вовсе (docs/e2k-qemu-run.md §2.5, §2.8); ' +
        'это преграда ХОСТА, а не программы',
      'окружение: сборке QEMU нужна правка полей WD.size_d/base_d — порт их только читает ' +
        '(reg-index.h:64-79, translate-ct.c:71-73), а сам строит WD из _q-полей; без правки ' +
        'системный вызов умирает на чтении номера: «syscall without proper WD configuration» ' +
        '(cpu_loop.c:164-169). Замер и текст правки — docs/e2k-qemu-run.md §2.9',
    ],
  };
}

/** Собранный ELF: байты и что в нём лежит. */
export interface MinimalElf {
  readonly bytes: Uint8Array;
  readonly entry: number;
  readonly program: MinimalProgram;
  readonly sections: readonly { readonly name: string; readonly offset: number; readonly size: number }[];
}

function align(value: number, to: number): number {
  return Math.ceil(value / to) * to;
}

/**
 * Собрать ELF64 с `_start`: заголовок, один сегмент `PT_LOAD`, секции `.text`, `.symtab`,
 * `.strtab`, `.shstrtab`.
 *
 * Заголовки — ровно те, что нужны загрузчику: `ELFCLASS64`, `ELFDATA2LSB`, `e_machine = 175`,
 * `e_entry` в начале `.text`, `PT_LOAD` с флагами `R|X`.
 */
export function buildMinimalElf(exitCode = 42, base = MINIMAL_BASE): MinimalElf {
  const program = buildMinimalProgram(exitCode);
  return { ...buildElfFromCode(program.code, base), program };
}

/**
 * Собрать ELF64 вокруг **произвольного** кода — тем же заголовком и теми же секциями.
 *
 * Нужен для опытов с передачей управления: точка входа — начало кода, поэтому опыт знает адрес
 * каждой инструкции. Обычный путь (`buildMinimalElf`) — частный случай с тремя инструкциями.
 */
export function buildElfFromCode(
  code: Uint8Array,
  base = MINIMAL_BASE,
  options: { readonly writable?: boolean; readonly extraMemory?: number; readonly dataSegmentBytes?: number } = {},
): Omit<MinimalElf, 'program'> {
  const textOffset = IMAGE_TEXT_OFFSET;
  const sections: { name: string; offset: number; size: number }[] = [];

  // .text
  const text = code;
  sections.push({ name: '.text', offset: textOffset, size: text.length });

  // .symtab: одна запись — `_start` в начале .text
  const strtab = Buffer.from('\u0000_start\u0000', 'latin1');
  const symtabOffset = align(textOffset + text.length, 8);
  const symbol = Buffer.alloc(24);
  symbol.writeUInt32LE(1, 0); // st_name = 1 (после начального NUL)
  symbol.writeUInt8(0x12, 4); // STB_GLOBAL | STT_FUNC
  symbol.writeUInt8(0, 5); // st_other
  symbol.writeUInt16LE(1, 6); // st_shndx = 1 (.text)
  symbol.writeBigUInt64LE(BigInt(base), 8);
  symbol.writeBigUInt64LE(BigInt(text.length), 16);
  const symtab = Buffer.concat([Buffer.alloc(24), symbol]);
  sections.push({ name: '.symtab', offset: symtabOffset, size: symtab.length });

  // .strtab
  const strtabOffset = symtabOffset + symtab.length;
  sections.push({ name: '.strtab', offset: strtabOffset, size: strtab.length });

  // .shstrtab
  const names = ['\u0000', '.text\u0000', '.symtab\u0000', '.strtab\u0000', '.shstrtab\u0000'];
  const shstr = Buffer.from(names.join(''), 'latin1');
  const shstrOffset = strtabOffset + strtab.length;
  sections.push({ name: '.shstrtab', offset: shstrOffset, size: shstr.length });

  const shoff = align(shstrOffset + shstr.length, 8);
  // Секции: 0 — null, 1 — .text, 2 — .symtab, 3 — .strtab, 4 — .shstrtab.
  const shnum = 5;
  const file = Buffer.alloc(shoff + shnum * 64);

  // ELF-заголовок
  file[0] = 0x7f;
  file.write('ELF', 1, 'latin1');
  file[4] = 2; // ELFCLASS64
  file[5] = 1; // ELFDATA2LSB
  file[6] = 1; // EV_CURRENT
  file.writeUInt16LE(2, 16); // ET_EXEC
  file.writeUInt16LE(EM_E2K, 18);
  file.writeUInt32LE(1, 20);
  file.writeBigUInt64LE(BigInt(base), 24); // e_entry
  file.writeBigUInt64LE(0x40n, 32); // e_phoff
  file.writeBigUInt64LE(BigInt(shoff), 40);
  file.writeUInt32LE(MACH_V5 << 24, 48); // e_flags: уровень ISA (5 = elbrus-v5), не -mtune-код
  file.writeUInt16LE(64, 52);
  file.writeUInt16LE(56, 54);
  file.writeUInt16LE(1, 56);
  file.writeUInt16LE(64, 58);
  file.writeUInt16LE(shnum, 60);
  file.writeUInt16LE(4, 62); // e_shstrndx = индекс .shstrtab (4 из 5 секций)

  // Заголовки программы: ДВА сегмента `PT_LOAD` — код и данные (§3.92, ниже).
  //
  // Флаги: код — `R|X` (5), данные — `R|W` (6). Параметры `writable`/`extraMemory` этой функции
  // СЕГОДНЯ НЕ ЧИТАЮТСЯ (остались от односегментной редакции): записываемая область живёт в сегменте
  // данных целиком (`DATA_SEGMENT_BYTES`), поэтому флаги и размеры заданы по построению. Это
  // названный долг, а не действующая настройка — оракулы передают их по привычке.
  // ── ГРАНИЦЫ СЕГМЕНТА КОДА — РОВНО КОД, БЕЗ МЕТАДАННЫХ ELF (замер на железе 2026-10-29) ───────
  //
  // Было: `segmentSize = shstrOffset + shstr.length - textOffset`, то есть в сегмент кода попадали и
  // метаданные ELF (`symtab` 48 + `strtab` 10 + `shstrtab` 31 = 89 байт), лежащие в файле ЗА кодом.
  // Пока образ мал, это незаметно; но со СТАТИКОЙ (литералы строк, таблица продолжений) код занимает
  // ровно 65536 байт и кончается на `DATA_SEGMENT_BASE`, а 89 байт метаданных уводят `p_memsz` за неё
  // — сегмент кода ПЕРЕКРЫВАЕТ сегмент данных.
  //
  // Замер 2026-10-29 (живая машина, `.tmp/a4s4-elf-fix.ts` + `.tmp/a4s4-iron4.sh`): образ со статикой
  // (код 65536, `p_memsz` 65625) падает на цели кодом **139**, а тот же образ с зажатым сегментом
  // (65536) исполняется — `fix_p4` → **2**, `fix_p1` → **0** и вывод «привет». Модель разницы не
  // видит ни до, ни после (2 и 0 соответственно), поэтому дефект жил незамеченным: он виден ТОЛЬКО
  // цели. Плата за это была ложной: записи корпуса 02 и 04 (печать строк) объявлены «работает» по
  // модели, а на цели падали тем же кодом 139.
  const segmentSize = text.length;
  const extra = options.extraMemory ?? 0;
  if (!Number.isInteger(extra) || extra < 0) {
    throw new Error(`дополнительная память сегмента обязана быть неотрицательным целым, получено ${String(extra)}`);
  }
  // ── ДВА СЕГМЕНТА: КОД `R|X` И ДАННЫЕ `R|W` (замер `docs/hardware-debt.md` §3.92) ───────────────
  //
  // Было: ОДИН сегмент `R|W|X` — то есть writable там, где лежит код. Отсюда оба падения модели с
  // одним корнем: `ACCERR` при записи в площадку печати (§3.90.7) и `assert(!(flags & PAGE_WRITE))`
  // в книге блоков трансляции (§3.91.3, сам комментарий: «translator_loop() must have made all TB
  // pages non-writable»). Замер: 79 сайтов печати — один сегмент: код 134 и 58 строк из 79; два
  // сегмента: код 0 и все 79 строк (`.tmp/two-segment-probe.ts`).
  //
  // Статика (литералы строк, таблица продолжений) лежит в СЕГМЕНТЕ КОДА, сразу за командами, и это
  // правильно: её только ЧИТАЮТ, а читать из `R|X` можно. Всё, что ПИШЕТСЯ (площадка печати, слоты
  // вытеснения, буфер склейки, куча массивов, арена), живёт в сегменте данных на странице
  // `DATA_SEGMENT_BASE` — там кода нет по построению, а не по договорённости (§3.91).
  file.writeUInt16LE(2, 56); // e_phnum = 2
  const phdr = (at: number, flags: number, offset: number, vaddr: number, filesz: number, memsz: number): void => {
    file.writeUInt32LE(1, at); // PT_LOAD
    file.writeUInt32LE(flags, at + 4);
    file.writeBigUInt64LE(BigInt(offset), at + 8);
    file.writeBigUInt64LE(BigInt(vaddr), at + 16);
    file.writeBigUInt64LE(BigInt(vaddr), at + 24);
    file.writeBigUInt64LE(BigInt(filesz), at + 32);
    file.writeBigUInt64LE(BigInt(memsz), at + 40);
    file.writeBigUInt64LE(0x1000n, at + 48);
  };
  // Первый: КОД. `p_offset % page == p_vaddr % page` — иначе загрузчик положит сегмент не туда.
  phdr(0x40, 5, textOffset, base, segmentSize, segmentSize);
  // Второй: ДАННЫЕ. В файле их нет (`p_filesz = 0`) — отображается нулями (`p_memsz`).
  // РАЗМЕР СЕГМЕНТА ДАННЫХ МОЖЕТ БЫТЬ ПОДНЯТ САЙТОМ (2026-11-08, D49): полный одно-проходный лексер
  // держит в куче весь вход и весь выход, и прежних двух страниц ему не хватает — прогон падал кодом 9
  // (запись за отображённую страницу), то есть тихой ложью, а не отказом. Умолчание оставлено прежним,
  // чтобы образы всех прочих программ не сдвинулись байт в байт (в ELF входит `p_memsz` сегмента данных).
  phdr(0x78, 6, 0, DATA_SEGMENT_BASE, 0, options.dataSegmentBytes ?? DATA_SEGMENT_BYTES);

  file.set(text, textOffset);
  file.set(symtab, symtabOffset);
  file.set(strtab, strtabOffset);
  file.set(shstr, shstrOffset);

  const sh = (
    at: number,
    name: number,
    type: number,
    flags: bigint,
    addr: bigint,
    offset: number,
    size: number,
    link: number,
    info: number,
    entsize: bigint,
  ): void => {
    file.writeUInt32LE(name, at);
    file.writeUInt32LE(type, at + 4);
    file.writeBigUInt64LE(flags, at + 8);
    file.writeBigUInt64LE(addr, at + 16);
    file.writeBigUInt64LE(BigInt(offset), at + 24);
    file.writeBigUInt64LE(BigInt(size), at + 32);
    file.writeUInt32LE(link, at + 40);
    file.writeUInt32LE(info, at + 44);
    file.writeBigUInt64LE(8n, at + 48);
    file.writeBigUInt64LE(entsize, at + 56);
  };
  sh(shoff, 0, 0, 0n, 0n, 0, 0, 0, 0, 0n);
  sh(shoff + 64, 1, 1, 6n, BigInt(base), textOffset, text.length, 0, 0, 0n);
  sh(shoff + 128, 7, 2, 0n, 0n, symtabOffset, symtab.length, 3, 1, 24n);
  sh(shoff + 192, 15, 3, 0n, 0n, strtabOffset, strtab.length, 0, 0, 0n);
  sh(shoff + 256, 23, 3, 0n, 0n, shstrOffset, shstr.length, 0, 0, 0n);

  return { bytes: new Uint8Array(file), entry: base, sections };
}

/** Записать минимальный ELF в `.tmp` и вернуть путь. */
export function writeMinimalElf(file = path.join(ROOT, '.tmp', 'e2k-minimal.elf'), exitCode = 42): string {
  const elf = buildMinimalElf(exitCode);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, elf.bytes);
  return file;
}

/** Разбор заголовка ELF — тем же способом, что и в оракуле: без внешних инструментов. */
export interface ElfHeader {
  readonly magic: string;
  readonly elfClass: number;
  readonly data: number;
  readonly type: number;
  readonly machine: number;
  readonly entry: number;
  readonly flags: number;
  readonly phoff: number;
  readonly shoff: number;
  readonly shnum: number;
  readonly shstrndx: number;
}

/** Прочитать заголовок ELF64. */
export function readElfHeader(bytes: Uint8Array): ElfHeader {
  if (bytes.length < 64) throw new Error(`файл короче заголовка ELF64: ${bytes.length} байт`);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: buffer.subarray(0, 4).toString('latin1'),
    elfClass: buffer[4]!,
    data: buffer[5]!,
    type: buffer.readUInt16LE(16),
    machine: buffer.readUInt16LE(18),
    entry: Number(buffer.readBigUInt64LE(24)),
    phoff: Number(buffer.readBigUInt64LE(32)),
    shoff: Number(buffer.readBigUInt64LE(40)),
    flags: buffer.readUInt32LE(48),
    shnum: buffer.readUInt16LE(60),
    shstrndx: buffer.readUInt16LE(62),
  };
}

function main(): void {
  const file = writeMinimalElf();
  const elf = buildMinimalElf();
  const header = readElfHeader(elf.bytes);
  console.log(`записано: ${path.relative(ROOT, file)} (${elf.bytes.length} байт)`);
  console.log(
    `заголовок: magic=${header.magic} class=${header.elfClass} data=${header.data} ` +
      `machine=${header.machine} entry=0x${header.entry.toString(16)} flags=0x${header.flags.toString(16)}`,
  );
  console.log(`код: ${elf.program.code.length} байт, инструкций ${elf.program.instructions.length}`);
  for (const blocker of elf.program.blockers) console.log(`препятствие: ${blocker}`);
}

if (require.main === module) {
  main();
}
