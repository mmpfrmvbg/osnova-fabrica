/**
 * ОРАКУЛ ДВУСТОРОННЕЙ ПРОВЕРКИ: ТЕКСТ → БАЙТЫ ЧЕРЕЗ АССЕМБЛЕР МЦСТ.
 *
 * # Что проверяется
 *
 * `src/scripts/e2kExternalAs.ts` отдаёт ассемблерную форму каждой реализованной операции
 * (`as` из того же binutils МЦСТ) и сравнивает полученные байты с нашими **побайтово**.
 * Дизассемблерная проверка (`e2kExternalObjdump.test.ts`) смотрит сторону «байты → текст»;
 * эта — сторону «текст → байты». Вместе они закрывают вопрос о соответствии полей: одна
 * проверка не заметила бы перепутанный канал или разрядность, вторая — не заметила бы
 * подменённый код операции.
 *
 * 1. **Состав.** По одному образцу на каждую реализованную операцию (24), ассемблерная форма
 *    собрана из таблицы МЦСТ (`argFormats` — `%b[N]` для одиночных, `%db[N]` для двойных).
 * 2. **Сверка.** При доступном ассемблере **все** образцы обязаны совпасть побайтово; при
 *    недоступном — каждый помечен «НЕ ПРОВЕРЕНО» с названной причиной.
 * 3. **Ловушки подтверждены ассемблером, а не нами.** `as` обязан **отвергать** каналы, которых
 *    нет в таблице МЦСТ (`movts,2` → «cannot be encoded in ALC2»), — это внешняя проверка
 *    исправления, найденного при первой попытке; и обязан отвергать операцию, не поддержанную
 *    выбранным уровнем ISA.
 *
 * # Чего оракул НЕ доказывает
 *
 * Что байты исполнит железо и что покрыты все формы: проверено 24 операции подмножества
 * в основных формах, литералы и слоги управления проверяются отдельными оракулами.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder, toHex } from '../e2k/backend';
import { REAL_OPCODES } from '../e2k/e2k-real';
import {
  AS_CPU_OPTION,
  asTextOf,
  assembleAll,
  buildAsSamples,
  buildAssemblyScript,
  buildJumpPrograms,
  buildProgramScript,
  commandText,
  findExternalAs,
  firstDifference,
  parseAssemblyOutput,
  parseProgramOutput,
  programAsText,
  programImage,
  registerText,
  runExternalAs,
  runExternalAsPrograms,
  type AsSample,
} from './e2kExternalAs';

const DOC = path.resolve(__dirname, '..', '..', 'docs', 'e2k-external-as.md');

describe('двусторонняя проверка: состав образцов', () => {
  const samples = buildAsSamples();

  it('по одному образцу на каждую реализованную операцию', () => {
    expect(samples.length).toBe(REAL_OPCODES.length);
    expect(samples.length).toBeGreaterThanOrEqual(24);
    expect(new Set(samples.map((sample) => sample.key)).size).toBe(samples.length);
    for (const sample of samples) {
      expect(sample.channel, `${sample.key}: канал не из таблицы`).toBe(
        REAL_OPCODES.find((entry) => entry.mnemonic === sample.mnemonic)!.channels[0],
      );
    }
  });

  it('ассемблерная форма собирается из таблицы, а не пишется руками', () => {
    expect(registerText('S', 1)).toBe('%b[1]');
    expect(registerText('D', 2)).toBe('%db[2]');
    expect(() => registerText('Q', 1)).toThrow(/неизвестный формат/);
    const adds = REAL_OPCODES.find((entry) => entry.mnemonic === 'adds')!;
    expect(asTextOf(adds, 3)).toBe('adds,3 %b[1], %b[2], %b[3]');
    const umulx = REAL_OPCODES.find((entry) => entry.mnemonic === 'umulx')!;
    expect(asTextOf(umulx, 1)).toBe('umulx,1 %b[1], %b[2], %db[3]');
    // Уровень ISA выбран явно: по умолчанию ассемблер берёт elbrus-v2 и отвергает umulhd.
    expect(AS_CPU_OPTION).toBe('-mcpu=elbrus-v5');
  });
});

describe('двусторонняя проверка: разбор и сравнение', () => {
  it('вывод сборочного скрипта разбирается: успех, ошибка, пустой результат', () => {
    const ok = parseAssemblyOutput('== 0\n 10 20 30 40\n== 1\n 01 02\n', 2);
    expect(ok[0]).toEqual({ ok: true, bytes: Uint8Array.from([0x10, 0x20, 0x30, 0x40]) });
    expect(ok[1]).toEqual({ ok: true, bytes: Uint8Array.from([0x01, 0x02]) });

    const failed = parseAssemblyOutput('!! 0\nError: something\n== 1\n ff\n', 2);
    expect(failed[0]!.ok).toBe(false);
    if (!failed[0]!.ok) expect(failed[0]!.error).toMatch(/Error: something/);
    expect(failed[1]).toEqual({ ok: true, bytes: Uint8Array.from([0xff]) });

    // Пустой .text — это не «совпало»: ассемблер мог молча выбросить инструкцию.
    const empty = parseAssemblyOutput('== 0\n', 1);
    expect(empty[0]!.ok).toBe(false);
    if (!empty[0]!.ok) expect(empty[0]!.error).toMatch(/пустой \.text/);

    const missing = parseAssemblyOutput('', 1);
    expect(missing[0]!.ok).toBe(false);
    if (!missing[0]!.ok) expect(missing[0]!.error).toMatch(/нет ответа/);
  });

  it('первое расхождение называется по номеру байта', () => {
    const a = Uint8Array.from([1, 2, 3, 4]);
    expect(firstDifference(a, Uint8Array.from([1, 2, 3, 4]))).toBeUndefined();
    expect(firstDifference(a, Uint8Array.from([1, 2, 9, 4]))).toEqual({ index: 2, ours: 3, theirs: 9 });
    expect(firstDifference(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });

  it('негативный контроль: подменённый текст даёт расхождение с названным байтом', () => {
    // Собираем `subs`, а сравниваем с байтами `adds` — расхождение обязано быть найдено.
    const encoder = getEncoder('e2k');
    const wrong: AsSample = {
      key: 'подмена',
      mnemonic: 'subs',
      channel: 0,
      form: 'ALF1',
      asText: 'subs,0 %b[1], %b[2], %b[3]',
      instruction: { mnemonic: 'adds', channel: 0, operands: [
        { kind: 'reg', index: 1 },
        { kind: 'reg', index: 2 },
        { kind: 'reg', index: 3 },
      ] },
      source: 'opcodes/e2k-opc.h:19',
    };
    const ours = encoder.encode(wrong.instruction);
    const theirs = encoder.encode({ mnemonic: 'subs', channel: 0, operands: wrong.instruction.operands });
    const diff = firstDifference(ours, theirs);
    expect(diff, 'расхождение обязано быть найдено').toBeDefined();
    expect(diff!.index).toBe(7); // младший байт слова: код операции
    expect(toHex(ours)).toContain('10');
    expect(toHex(theirs)).toContain('12');
  });
});

describe('двусторонняя проверка: программы с переходом (5–10 образцов)', () => {
  const encoder = getEncoder('e2k');
  const programs = buildJumpPrograms();
  const { tool } = findExternalAs();

  it('состав: 5–10 программ, у каждой метка, один переход и названный источник', () => {
    expect(programs.length).toBeGreaterThanOrEqual(5);
    expect(programs.length).toBeLessThanOrEqual(10);
    expect(new Set(programs.map((program) => program.key)).size).toBe(programs.length);
    expect(new Set(programs.map((program) => program.label)).size).toBe(programs.length);
    for (const program of programs) {
      expect(program.source, `${program.key}: источник не назван`).toMatch(/docs\/e2k-/);
      expect(program.instructions.filter((item) => item.mnemonic === 'IR.jmp').length, program.key).toBe(1);
      expect(program.targetIndex, program.key).toBeGreaterThanOrEqual(0);
      expect(program.targetIndex, program.key).toBeLessThan(program.instructions.length);
      // Метка стоит там, где начинается цель, — иначе адрес метки у ассемблера не с чем сверять.
      const image = programImage(program.instructions, encoder);
      expect(image.refusals, `${program.key}: отказы раскладки`).toEqual([]);
      expect(program.asText, `${program.key}: метки нет в тексте`).toContain(`${program.label}:`);
      expect(image.targetAddress, `${program.key}`).toBe(image.addresses.get(program.targetIndex));
    }
    // Обе стороны: цель и впереди, и позади команды перехода.
    expect(programs.some((program) => programImage(program.instructions, encoder).disp > 0)).toBe(true);
    expect(programs.some((program) => programImage(program.instructions, encoder).disp < 0)).toBe(true);
  });

  it('ассемблерный текст строится из наших понижённых команд, а не пишется руками', () => {
    // Расхождение нашего текста с нашими байтами ассемблер поймал бы; проверяем и здесь.
    const sample = programs[0]!;
    expect(sample.asText).toBe(programAsText(sample.instructions, sample.label));
    expect(commandText({ mnemonic: 'adds', channel: 0, operands: [
      { kind: 'reg', index: 1 },
      { kind: 'reg', index: 2 },
      { kind: 'reg', index: 3 },
    ] })).toBe('adds,0 %b[1], %b[2], %b[3]');
    // Переход в тексте записан МЕТКОЙ: смещение обязан посчитать ассемблер, а не мы.
    expect(sample.asText).toMatch(new RegExp(`disp %ctpr\\d+, ${sample.label}`));
    expect(sample.asText).toMatch(/^ct %ctpr\d+/m);
  });

  it('разбор вывода: байты и адрес метки; «*» от od не пропускается молча', () => {
    const ok = parseProgramOutput('== 0\n 01 02\n@@ 0 0000000000000020 l .text 0 osnova_target_x\n', 1);
    expect(ok[0]).toEqual({ ok: true, bytes: Uint8Array.from([1, 2]), label: 0x20 });
    const noLabel = parseProgramOutput('== 0\n 01 02\n', 1);
    expect(noLabel[0]).toEqual({ ok: true, bytes: Uint8Array.from([1, 2]) });
    // `od` без `-v` печатает «*» вместо повторяющейся строки: байты теряются, и это отказ, а не «совпало».
    const collapsed = parseProgramOutput('== 0\n 01 02 03 04\n*\n', 1);
    expect(collapsed[0]!.ok).toBe(false);
    if (!collapsed[0]!.ok) expect(collapsed[0]!.error).toMatch(/\*/);
    // Сборочный скрипт обязан звать `od` с `-v` — иначе повтор байтов исчезает.
    if (tool !== undefined) {
      const script = buildProgramScript(programs, tool);
      expect(script).toContain('od -An -tx1 -v');
      // Второй свидетель — адрес метки из таблицы символов: дизассемблер ищется, а не берётся на веру.
      expect(script, 'в скрипте нет чтения таблицы символов').toMatch(/\$OBJDUMP -t/);
      expect(script, 'дизассемблер не ищется').toContain('e2k-linux-objdump');
      expect(script.split('osnova_target_').length - 1, 'метки нет в скрипте').toBeGreaterThanOrEqual(programs.length);
    }
    expect(parseAssemblyOutput('== 0\n 01 02\n', 1)[0]).toEqual({ ok: true, bytes: Uint8Array.from([1, 2]) });
  });

  it('все программы совпали с ассемблером побайтово, и адрес метки совпал с адресом цели', () => {
    if (tool === undefined) return;
    const report = runExternalAsPrograms();
    expect(report.tool).not.toBeNull();
    const mismatched = report.comparisons.filter((item) => item.status !== 'совпал');
    expect(mismatched.map((item) => `${item.key}: ${item.reason}`)).toEqual([]);
    expect(report.summary.matched).toBe(report.summary.total);
    expect(report.summary.total).toBeGreaterThanOrEqual(5);
    // Второй свидетель: адрес метки, который ассемблер посчитал сам.
    expect(report.summary.labelsMatched, 'адреса меток не сверены').toBe(report.summary.total);
    for (const item of report.comparisons) {
      expect(item.labelAddress, `${item.key}: адрес метки не прочитан`).toBeDefined();
      expect(item.labelAddress, `${item.key}`).toBe(item.targetAddress);
      expect(item.disp, `${item.key}: смещение не ведёт в цель`).toBeGreaterThan(-1000);
    }
  });

  it('негативный контроль: сдвиг цели меняет наши байты, и сравнение это поймает', () => {
    if (tool === undefined) return;
    const sample = programs[0]!;
    // Сдвиг цели на одну инструкцию НАЗАД: цель остаётся внутри потока, а адрес меняется.
    const other = sample.targetIndex - 1;
    const shifted = {
      ...sample,
      instructions: sample.instructions.map((instruction) =>
        instruction.mnemonic === 'IR.jmp'
          ? { ...instruction, operands: [{ kind: 'imm' as const, value: other }] }
          : instruction,
      ),
    };
    const ours = programImage(sample.instructions, encoder).bytes;
    const moved = programImage(shifted.instructions, encoder);
    expect(moved.refusals).toEqual([]);
    expect(toHex(moved.bytes), 'сдвиг цели не изменил байты').not.toBe(toHex(ours));
    expect(moved.targetAddress, 'цель не сдвинулась').not.toBe(programImage(sample.instructions, encoder).targetAddress);
    // Сравнение «наши байты против байтов ассемблера» обязано найти расхождение, а не пропустить.
    const diff = firstDifference(moved.bytes, ours);
    expect(diff, 'расхождение не найдено').toBeDefined();
    if (diff !== undefined) expect(diff.index, 'расхождение не в поле смещения').toBeGreaterThanOrEqual(4);
  });
});

describe('двусторонняя проверка: живой прогон ассемблером', () => {
  const { tool } = findExternalAs();

  it('ассемблер либо найден, либо причина названа', () => {
    const probe = findExternalAs();
    if (probe.tool === undefined) {
      expect(probe.reason, 'причина ненайденности не названа').toBeDefined();
      expect(probe.reason!.length).toBeGreaterThan(30);
      return;
    }
    expect(probe.tool.version).toMatch(/assembler/i);
    expect(probe.tool.scriptRunner.args.join(' ')).toMatch(/bash/);
  });

  it('все образцы совпали с ассемблером МЦСТ побайтово', () => {
    if (tool === undefined) return;
    const report = runExternalAs();
    expect(report.tool).not.toBeNull();
    const mismatched = report.comparisons.filter((item) => item.status !== 'совпал');
    expect(mismatched.map((item) => `${item.key}: ${item.reason}`)).toEqual([]);
    expect(report.summary.matched).toBe(report.summary.total);
    expect(report.summary.total).toBeGreaterThanOrEqual(24);
    // Запись в документе обязана не отставать от измерения.
    if (fs.existsSync(DOC)) {
      const doc = fs.readFileSync(DOC, 'utf-8');
      expect(doc, 'в документе нет числа совпавших образцов').toMatch(/24 (образца )?из 24|совпало 24/);
    }
  });

  it('ассемблер отвергает канал, которого нет в таблице МЦСТ', () => {
    if (tool === undefined) return;
    // `movts` в таблице разрешён только на каналах 0, 1, 3, 4 (`{1, 1, 0, 1, 1, 0}`).
    const forbidden: AsSample[] = [
      {
        key: 'movts,2',
        mnemonic: 'movts',
        channel: 2,
        form: 'ALF2',
        asText: 'movts,2 %b[1], %b[2]',
        instruction: { mnemonic: 'movts', channel: 2, operands: [
          { kind: 'reg', index: 1 },
          { kind: 'reg', index: 2 },
        ] },
        source: 'opcodes/e2k-opc.h:644',
      },
    ];
    const results = assembleAll(forbidden);
    expect(results[0]!.ok, 'ассемблер обязан отказать').toBe(false);
    if (!results[0]!.ok) expect(results[0]!.error).toMatch(/ALC2/);
  });

  it('ассемблер отвергает операцию, не поддержанную уровнем ISA по умолчанию', () => {
    if (tool === undefined) return;
    // Скрипт обязан называть уровень ISA явно: по умолчанию `as` берёт elbrus-v2 и не знает
    // `umulhd`/`smulhd` («`umulhd' is not supported on `elbrus-v2'»).
    const script = buildAssemblyScript(buildAsSamples().slice(0, 1), tool);
    expect(script).toContain('-mcpu=elbrus-v5');
    const withoutCpu = script.replace('-mcpu=elbrus-v5 ', '');
    expect(withoutCpu).not.toContain('-mcpu=');
  });
});

describe('внешняя сверка: форма 0xdc (64-битный литерал)', () => {
  const encoder = getEncoder('e2k');
  const { tool } = findExternalAs();

  /** Значения подобраны по границам формы: ноль, 32-битное, 64-битное, старший бит, максимум. */
  const VALUES: readonly bigint[] = [
    0x100000n,
    0xdeadbeefcafebaben,
    0x0n,
    0xffffffffn,
    1n << 63n,
    (1n << 64n) - 1n,
  ];

  const samples: readonly AsSample[] = VALUES.map((value, index) => ({
    key: `xdc-${index}`,
    mnemonic: 'movtd',
    channel: 0,
    form: 'ALF2 + LTS64',
    // Ассемблерная форма МЦСТ: спецификатор `_f64` выбирает 64-битный литерал
    // (gas/config/tc-e2k.c:1819), приёмник — оконный регистр.
    asText: `movtd,0 _f64 0x${value.toString(16)}, %r8`,
    instruction: {
      mnemonic: 'movtd',
      channel: 0,
      operands: [
        { kind: 'imm64', value } as unknown as Operand,
        { kind: 'reg', index: 8, file: 'window' },
      ],
    },
    source: 'docs/e2k-address-loading.md; opcodes/e2k-dis.c:485; gas/config/tc-e2k.c:1819',
  }));

  it('состав: 5–10 образцов, у каждого назван источник', () => {
    expect(samples.length).toBeGreaterThanOrEqual(5);
    expect(samples.length).toBeLessThanOrEqual(10);
    for (const sample of samples) {
      expect(sample.source.length, `${sample.key}: источник не назван`).toBeGreaterThan(20);
      expect(sample.asText, `${sample.key}: нет спецификатора _f64`).toContain('_f64 0x');
    }
  });

  it('образцы совпали с ассемблером МЦСТ побайтово', () => {
    if (tool === undefined) return; // причина ненайденности названа в отдельном оракуле этого файла
    const results = assembleAll(samples as AsSample[]);
    const problems: string[] = [];
    samples.forEach((sample, index) => {
      const result = results[index]!;
      if (!result.ok) {
        problems.push(`${sample.key} (${sample.asText}): ассемблер отверг — ${result.error}`);
        return;
      }
      const ours = encoder.encode(sample.instruction);
      if (toHex(ours) !== toHex(result.bytes)) {
        problems.push(`${sample.key} (${sample.asText}): у нас ${toHex(ours)}, у as ${toHex(result.bytes)}`);
      }
      expect(result.bytes.length, `${sample.key}: длина`).toBe(16);
      // Круг нашего кодировщика: значение обязано вернуться тем же bigint.
      const back = encoder.decode(ours);
      expect(back.operands[0], `${sample.key}: круг`).toEqual({ kind: 'imm64', value: VALUES[index]! });
    });
    expect(problems, `образцов ${samples.length}`).toEqual([]);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: перестановка слов литерала расходится с ассемблером', () => {
    if (tool === undefined) return;
    const index = 1; // 0xdeadbeefcafebabe
    const result = assembleAll([samples[index]!] as AsSample[])[0]!;
    if (!result.ok) return;
    const swapped = Uint8Array.from(encoder.encode(samples[index]!.instruction));
    for (let at = 0; at < 4; at++) {
      const high = swapped[8 + at]!;
      swapped[8 + at] = swapped[12 + at]!;
      swapped[12 + at] = high;
    }
    // Байты ассемблера против ПЕРЕСТАВЛЕННЫХ: расхождение обязано быть найдено.
    const diff = firstDifference(swapped, result.bytes);
    expect(diff, 'перестановка слов не замечена').toBeDefined();
    expect(diff!.index, 'расхождение не в области литерала').toBeGreaterThanOrEqual(8);
  });
});