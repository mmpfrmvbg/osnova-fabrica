/**
 * ОРАКУЛ СЕГМЕНТОВ ELF: КОД `R|X`, ДАННЫЕ `R|W` — ДВА `PT_LOAD`, А НЕ ОДИН `R|W|X`.
 *
 * # Зачем это отдельный сторож, и почему он написан ПЕРВЫМ
 *
 * Наш образ был **одним сегментом `R|W|X`**, то есть writable там, где лежит код. Отсюда — оба
 * падения модели с ОДНИМ корнем (`docs/hardware-debt.md` §3.92):
 *
 * | что видели | что это было |
 * |---|---|
 * | `QEMU internal SIGSEGV {code=ACCERR}` при записи в площадку печати | страница, в которую гость пишет, содержит код (§3.90.7) |
 * | `Assertion failed: !(flags & PAGE_WRITE) (tb-maint.c: tb_record)` на 79 сайтах печати | тот же корень, другая стадия: `/* translator_loop() must have made all TB pages non-writable *​/` |
 *
 * Замер, которым это доказано (`.tmp/two-segment-probe.ts`): 79 сайтов печати — один сегмент:
 * код **134** и 58 строк из 79; два сегмента (код `R|X`, данные `R|W`): код **0** и все 79 строк.
 *
 * # Что утверждается — семью проверками, и две из них негативные
 *
 * 1. `PT_LOAD` ровно **два** (и это проверяется, а не предполагается).
 * 2. Сегмент кода: `p_flags & PF_W == 0`, `p_flags & PF_X != 0`, `p_vaddr == MINIMAL_BASE`.
 * 3. Сегмент данных: `p_flags & PF_X == 0`, `p_flags & PF_W != 0`, `p_filesz == 0`,
 *    `p_memsz` ≥ страницы, `p_vaddr` — начало страницы области записи (`0x110000`).
 * 4. **Согласование**: `p_vaddr % page == p_offset % page` у КАЖДОГО сегмента — классическая
 *    ловушка загрузчика ELF (несовпадение остатков → сегмент кладётся не туда).
 * 5. Негативные контроли — на самом разборе, а не на словах: снять `PF_W` у данных → разбор
 *    обязан покраснеть; поставить `PF_W` коду → обязан покраснеть. Сторож, который не различает,
 *    выглядит зелёным так же, как работающий (`docs/verification-debt.md`, случай 22).
 *
 * # ЧТО ЭТОТ СТОРОЖ ПРОСМОТРЕЛ (найдено 2026-10-29 срезом A4-4 на ЖЕЛЕЗЕ)
 *
 * Проверка наложения сегментов тут БЫЛА с самого начала — но образец у неё был `new Uint8Array(64)`,
 * то есть до границы страницы данных не доставал: `p_memsz` кончался на 0x100098, а данные
 * начинаются на 0x110000. Между тем в образе СО СТАТИКОЙ код занимает ровно весь промежуток до
 * данных (65536 байт), и попадавшие в сегмент МЕТАДАННЫЕ ELF (`symtab` 48 + `strtab` 10 +
 * `shstrtab` 31 = 89 байт) уводили `p_memsz` за `DATA_SEGMENT_BASE` — сегменты накладывались.
 * Модель наложение терпит, цель — нет: образы со статикой падали кодом **139**, в том числе записи
 * корпуса 02 и 04, объявленные «работает» (замер `.tmp/a4s4-elf-fix.ts` + `.tmp/a4s4-iron4.sh`:
 * зажатый сегмент → `fix_p4` 2, `fix_p1` 0 при выводе «привет»). Починено в `buildElfFromCode`
 * (`p_filesz = p_memsz = длина кода`), а здесь образец доведён до границы И добавлен негативный
 * контроль, возвращающий прежнюю геометрию.
 */
import { describe, it, expect } from 'vitest';
import { IMAGE_TAIL_OFFSET, IMAGE_TEXT_OFFSET, MINIMAL_BASE, buildElfFromCode } from './elfMinimal';
import { loweredProgram } from './lowered';
import { parseV3 } from '../compiler-v3/index';

/** Размер страницы гостя. Подтверждён независимо: порт (`target/e2k/cpu-param.h`: `TARGET_PAGE_BITS 12`) и ядро (`arch/e2k/include/asm/page_size.h`: `E2K_4K_PAGE_SHIFT 12`). */
const PAGE = 0x1000;
/** Начало страницы области записи: на страницу ниже кучи (`printAreaOf(heap)` попадает в неё). */
const WRITE_PAGE_BASE = MINIMAL_BASE + IMAGE_TAIL_OFFSET - PAGE;

interface Segment {
  readonly type: number;
  readonly flags: number;
  readonly offset: number;
  readonly vaddr: number;
  readonly filesz: number;
  readonly memsz: number;
  readonly align: number;
}

const PT_LOAD = 1;
const PF_X = 1;
const PF_W = 2;
const PF_R = 4;

/** Прочитать заголовки программы — руками, потому что читаем ровно то, что пишем. */
function segmentsOf(bytes: Uint8Array): Segment[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const phoff = Number(view.getBigUint64(32, true));
  const phentsize = view.getUint16(54, true);
  const phnum = view.getUint16(56, true);
  const segments: Segment[] = [];
  for (let index = 0; index < phnum; index++) {
    const at = phoff + index * phentsize;
    segments.push({
      type: view.getUint32(at, true),
      flags: view.getUint32(at + 4, true),
      offset: Number(view.getBigUint64(at + 8, true)),
      vaddr: Number(view.getBigUint64(at + 16, true)),
      filesz: Number(view.getBigUint64(at + 32, true)),
      memsz: Number(view.getBigUint64(at + 40, true)),
      align: Number(view.getBigUint64(at + 48, true)),
    });
  }
  return segments;
}

/**
 * РАЗБОР ОБРАЗА: что в нём не так. Пустой список — образ годен.
 *
 * Вынесено функцией, чтобы негативные контроли били по ТОМУ ЖЕ разбору: они правят байты
 * готового ELF и требуют красного от этой же функции.
 */
function segmentProblems(bytes: Uint8Array): string[] {
  const problems: string[] = [];
  const loads = segmentsOf(bytes).filter((segment) => segment.type === PT_LOAD);
  if (loads.length !== 2) {
    problems.push(`PT_LOAD ${String(loads.length)}, а обязано быть 2 (код R|X и данные R|W)`);
    return problems;
  }
  const [code, data] = loads as [Segment, Segment];
  if ((code.flags & PF_W) !== 0) problems.push(`сегмент кода writable: p_flags = ${String(code.flags)}`);
  if ((code.flags & PF_X) === 0) problems.push('сегмент кода не исполняемый');
  if ((code.flags & PF_R) === 0) problems.push('сегмент кода не читаемый');
  if (code.vaddr !== MINIMAL_BASE) problems.push(`код не на MINIMAL_BASE: ${code.vaddr.toString(16)}`);
  if ((code.offset & 0xfff) !== (code.vaddr & 0xfff)) {
    problems.push('у кода не совпали остатки p_offset и p_vaddr — загрузчик положит сегмент не туда');
  }
  if (data.vaddr !== WRITE_PAGE_BASE) {
    problems.push(`данные не на странице области записи: ${data.vaddr.toString(16)}, а надо ${WRITE_PAGE_BASE.toString(16)}`);
  }
  if ((data.flags & PF_X) !== 0) problems.push('сегмент данных исполняемый');
  if ((data.flags & PF_W) === 0) problems.push('сегмент данных не writable — писать будет некуда');
  if (data.filesz !== 0) problems.push(`у данных p_filesz = ${String(data.filesz)}, а в файле их нет: обязано быть 0`);
  if (data.memsz < PAGE) problems.push(`у данных p_memsz = ${String(data.memsz)} — меньше страницы`);
  if ((data.offset & 0xfff) !== (data.vaddr & 0xfff)) {
    problems.push('у данных не совпали остатки p_offset и p_vaddr');
  }
  if (data.vaddr < code.vaddr + code.filesz) {
    problems.push('сегменты накладываются: код заходит в данные');
  }
  return problems;
}

describe('ELF: два сегмента — код R|X и данные R|W', () => {
  const bytes = buildElfFromCode(new Uint8Array(64).fill(0x01), MINIMAL_BASE, { writable: true, extraMemory: 0x12000 }).bytes;

  it('ОРАКУЛ: разбор не находит ни одной ошибки в собранном образе', () => {
    expect(segmentProblems(bytes), 'образ обязан быть годен целиком').toEqual([]);
  });

  it('заголовки названы числами: два PT_LOAD, флаги, адреса, размеры', () => {
    const loads = segmentsOf(bytes).filter((segment) => segment.type === PT_LOAD);
    expect(loads, 'ровно два сегмента').toHaveLength(2);
    expect(loads[0]?.flags, 'код: R|X').toBe(PF_R | PF_X);
    expect(loads[0]?.vaddr).toBe(MINIMAL_BASE);
    expect(loads[0]?.offset, 'код лежит по файловому смещению .text').toBe(IMAGE_TEXT_OFFSET);
    expect(loads[1]?.flags, 'данные: R|W').toBe(PF_R | PF_W);
    expect(loads[1]?.vaddr, 'данные — на странице области записи').toBe(WRITE_PAGE_BASE);
    expect(loads[1]?.filesz, 'в файле данных нет').toBe(0);
    expect(loads[1]?.memsz, 'данных не меньше страницы').toBeGreaterThanOrEqual(PAGE);
    for (const segment of loads) {
      expect(segment.align, 'выравнивание — страница').toBe(PAGE);
      expect(segment.vaddr % PAGE, 'остатки p_offset и p_vaddr совпадают').toBe(segment.offset % PAGE);
    }
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: снять PF_W у ДАННЫХ — разбор обязан покраснеть', () => {
    const broken = Uint8Array.from(bytes);
    const view = new DataView(broken.buffer);
    const dataPhdr = Number(view.getBigUint64(32, true)) + 56; // второй заголовок программы
    view.setUint32(dataPhdr + 4, PF_R | PF_X, true); // R|X вместо R|W
    expect(segmentProblems(broken).length, 'без записи данные — отказ').toBeGreaterThan(0);
    expect(segmentProblems(broken).join(' | ')).toMatch(/данных/iu);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: поставить PF_W КОДУ — разбор обязан покраснеть', () => {
    const broken = Uint8Array.from(bytes);
    const view = new DataView(broken.buffer);
    const codePhdr = Number(view.getBigUint64(32, true)); // первый заголовок программы
    view.setUint32(codePhdr + 4, PF_R | PF_W | PF_X, true); // R|W|X — то, чем образ был раньше
    expect(segmentProblems(broken).length, 'writable код — отказ').toBeGreaterThan(0);
    expect(segmentProblems(broken).join(' | ')).toMatch(/кода writable/iu);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: сдвинуть данные на страницу — разбор обязан покраснеть', () => {
    const broken = Uint8Array.from(bytes);
    const view = new DataView(broken.buffer);
    const dataPhdr = Number(view.getBigUint64(32, true)) + 56;
    view.setBigUint64(dataPhdr + 16, BigInt(WRITE_PAGE_BASE + PAGE), true);
    expect(segmentProblems(broken).join(' | '), 'данные не на своей странице').toMatch(/области записи/iu);
  });

  // ── ГРАНИЦА, КОТОРУЮ ПРЕЖНИЙ ОБРАЗЕЦ НЕ ДОСТАВАЛ (A4, срез 4, 2026-10-29) ──────────────────
  /** Программа со СТАТИЧЕСКОЙ строкой: её образ занимает весь промежуток до страницы данных. */
  const СТАТИКА = ['действие главная()', '  пусть с = "ба"', '  вернуть длина с', 'конец главная', ''].join('\n');

  function образСтатики(): Uint8Array {
    const разбор = parseV3(СТАТИКА, 'проба.osnova');
    expect(разбор.errors, 'разбор программы').toEqual([]);
    // ПОТРЕБИТЕЛЬ (D11): под отказом байтов нет — дверь отдаёт Результат<Образ, Отказ>.
    const итог = loweredProgram(СТАТИКА, {
      filename: 'проба.osnova',
      parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
    });
    expect(
      итог.ок,
      итог.ок ? '' : `непонижённые носители: ${итог.отказ.отказы.map((запись) => запись.причина).join('; ')}`,
    ).toBe(true);
    if (!итог.ок) throw new Error(`понижение отказало: ${итог.отказ.причина}`);
    return buildElfFromCode(итог.значение.bytes, MINIMAL_BASE).bytes;
  }

  it('СТАТИКА: образ со строковым литералом доходит ВПЛОТНУЮ до страницы данных — и годен', () => {
    const соCтатикой = образСтатики();
    const loads = segmentsOf(соCтатикой).filter((segment) => segment.type === PT_LOAD);
    expect(loads[0]?.filesz, 'код со статикой занимает ровно промежуток до данных').toBe(WRITE_PAGE_BASE - MINIMAL_BASE);
    expect(loads[0]?.memsz, 'p_memsz не больше кода').toBe(loads[0]?.filesz);
    expect(
      (loads[0]?.vaddr ?? 0) + (loads[0]?.memsz ?? 0),
      'конец сегмента кода ровно на начале данных, а не за ним',
    ).toBe(loads[1]?.vaddr);
    expect(
      segmentProblems(соCтатикой),
      'образ со статикой обязан быть годен целиком: прежняя редакция давала тут наложение сегментов, ' +
        'а цель — падение кодом 139',
    ).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: вернуть метаданные ELF в сегмент кода — разбор обязан покраснеть', () => {
    // 89 байт = `symtab` 48 + `strtab` 10 + `shstrtab` 31: ровно то, что лежит в файле ЗА кодом и
    // попадало в сегмент до правки 2026-10-29.
    const broken = Uint8Array.from(образСтатики());
    const view = new DataView(broken.buffer);
    const codePhdr = Number(view.getBigUint64(32, true));
    const длинаКода = Number(view.getBigUint64(codePhdr + 32));
    view.setBigUint64(codePhdr + 32, BigInt(длинаКода + 89), true);
    view.setBigUint64(codePhdr + 40, BigInt(длинаКода + 89), true);
    expect(
      segmentProblems(broken).join(' | '),
      'наложение сегментов обязано быть поймано ИМЕННО на образе со статикой',
    ).toMatch(/накладываются/iu);
  });
});
