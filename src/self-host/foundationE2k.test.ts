/**
 * ФУНДАМЕНТ SELF-HOST НА ЦЕЛИ: ФАЙЛЫ, СТРОКИ, КОЛЛЕКЦИИ — ЧТО РАБОТАЕТ И ГДЕ СТЕНА.
 *
 * # Зачем этот файл
 *
 * Компилятор — это чтение файла, работа со строками, коллекции и запись файла. Прежде чем писать
 * self-host на v3, надо знать, **что из этого уже стоит на цели**, а что — названная стена. Здесь
 * ровно это: каждая способность либо ИЗМЕРЕНА прогоном на модели e2k, либо названа отказом с
 * точным местом. Третьего состояния («наверное, работает») в файле нет.
 *
 * # Две стороны, а не одна
 *
 * Там, где ответ модели можно сверить с эталоном языка, сверяется: содержимое файла, принесённое
 * `read`, сравнивается с байтами, которые положил тест; ноль на конце файла — с нулём, который
 * даёт обычное чтение файла до конца. Где эталона нет (отказ ядра `-errno`) — наблюдение
 * сравнивается со СВОИМ контрольным опытом: тот же вызов без знака даёт другое число.
 *
 * # Канал наблюдения назван
 *
 * Код возврата процесса несёт **младший байт** (`AGENTS.md`): им нельзя наблюдать дескриптор или
 * адрес. Поэтому широкие величины наблюдаются **делом** — чтением файла этим дескриптором и байтами
 * вывода (`stdout` модели), — а кодом возврата только маленькие счётчики (сколько прочитано).
 *
 * # Чего файл НЕ доказывает
 *
 * Ничего о железе: QEMU — модель. И ничего о языке: все опыты собраны носителями напрямую, потому
 * что **в языке v3 файловых операций нет вовсе** — это названо отдельно, в
 * `foundation.test.ts` (реестр) и `docs/hardware-debt.md`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getEncoder, type AsmInstruction, type Operand } from '../e2k/backend';
import { MINIMAL_BASE, buildElfFromCode, DATA_SEGMENT_BASE } from '../e2k/elfMinimal';
import { SYS_EXIT, ENTRY_SYSCALL_FRAME, syscallWindowOf } from '../e2k/syscallRuntime';
import { buildShim, runInQemu, toWslPath } from '../scripts/e2kQemuExec';
import { parseV3 } from '../compiler-v3/index';
import { tokenizeV3 } from '../compiler-v3/lexer';
import { loweredProgram } from '../e2k/programImage';
import {
  O_RDONLY,
  SYS_CLOSE,
  SYS_OPEN,
  SYS_READ,
  SYS_WRITE_FILE,
  SYS_X86_64_OPEN,
  closeInstructions,
  fileCallProblems,
  openInstructions,
  outcomeOf,
  readInstructions,
  type FileCallOutcome,
} from './fileRuntime';

const ROOT = path.resolve(__dirname, '..', '..');
const encoder = getEncoder('e2k');
const shim = buildShim();

const imm = (value: number): Operand => ({ kind: 'imm', value });
const reg = (index: number): Operand => ({ kind: 'reg', index });
const literal = (value: number): Operand => ({ kind: 'imm64', value: BigInt(value) } as unknown as Operand);
const window_ = (index: number): Operand => ({ kind: 'reg', index, file: 'window' });
const a = (mnemonic: string, operands: readonly Operand[], channel = 0): AsmInstruction => ({
  mnemonic,
  channel,
  operands,
});

/** Буфер чтения — В СЕГМЕНТЕ ДАННЫХ: в сегменте кода `read` отвечает `EFAULT` (см. `fileRuntime.ts`). */
const BUFFER = DATA_SEGMENT_BASE + 0x100;

/** `write(fd, buf, count)` — вывод наружу. Адрес — ЛИТЕРАЛОМ: он известен на сборке. */
function writeOut(fd: number, address: number, length: number): AsmInstruction[] {
  const frame = ENTRY_SYSCALL_FRAME;
  return [
    a('movts', [imm(SYS_WRITE_FILE), window_(syscallWindowOf(frame, 0))]),
    a('movts', [imm(fd), window_(syscallWindowOf(frame, 1))]),
    a('movtd', [literal(address), window_(syscallWindowOf(frame, 2))]),
    a('movts', [imm(length), window_(syscallWindowOf(frame, 3))]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(frame.wbs)]),
  ];
}

/** `exit(код)` — младший байт значения: для маленьких чисел канал честный. */
function exitWith(source: number): AsmInstruction[] {
  return [
    a('movts', [imm(SYS_EXIT), window_(8)]),
    a('adds', [reg(source), reg(0), window_(9)]),
    a('sdisp', [imm(1), imm(0)]),
    a('call', [imm(1), imm(4)]),
  ];
}

/** Данные образа: [путь][буфер чтения 64 Б]. Адрес пути считается от длины кода. */
function assemble(
  build: (адреса: { путь: number; буфер: number }) => readonly AsmInstruction[],
  путь: string,
  bufferBytes = 64,
): Uint8Array {
  const length = (list: readonly AsmInstruction[]): number =>
    list.reduce((sum, instruction) => sum + encoder.encode(instruction).length, 0);
  const догадка = length(build({ путь: MINIMAL_BASE, буфер: BUFFER }));
  const путьАдрес = MINIMAL_BASE + догадка;
  const final = build({ путь: путьАдрес, буфер: BUFFER });
  const code = new Uint8Array(length(final));
  let offset = 0;
  for (const instruction of final) {
    const chunk = encoder.encode(instruction);
    code.set(chunk, offset);
    offset += chunk.length;
  }
  const pathBytes = Buffer.concat([Buffer.from(путь, 'utf8'), Buffer.from([0])]);
  const bytes = new Uint8Array(code.length + pathBytes.length + bufferBytes);
  bytes.set(code, 0);
  bytes.set(pathBytes, code.length);
  return bytes;
}

interface Прогон {
  readonly код: number | undefined;
  readonly stdout: string;
  readonly журнал: string;
}

function run(name: string, bytes: Uint8Array): Прогон {
  const elf = path.join(ROOT, '.tmp', `foundation-e2k-${name}.elf`);
  fs.writeFileSync(
    elf,
    buildElfFromCode(bytes, MINIMAL_BASE, { writable: true, extraMemory: 0 }).bytes,
  );
  const result = runInQemu(elf, { shim: true, timeoutMs: 30_000 });
  return {
    код: result?.status ?? undefined,
    stdout: result?.stdout ?? '',
    журнал: result?.output ?? '',
  };
}

/** Файл-исходник для опытов: свои байты, а не чужие, — иначе сверять было бы нечего. */
const СОДЕРЖИМОЕ = 'ОСНОВА\n';
function файлДляЧтения(name: string, содержимое = СОДЕРЖИМОЕ): string {
  const file = path.join(ROOT, '.tmp', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, содержимое, 'utf8');
  return toWslPath(file);
}

const ОТСУТСТВУЮЩИЙ = toWslPath(path.join(ROOT, '.tmp', 'foundation-нет-такого-файла.txt'));

describe('файловые системные вызовы на цели: что стоит, чем измерено', () => {
  it('шим и модель доступны — иначе причина названа, а не «пропущено»', () => {
    if (shim === undefined) {
      expect(shim, 'шим не собран: в WSL-дистрибутиве нет компилятора C (docs/e2k-qemu-run.md §2.5)').toBeUndefined();
      return;
    }
    expect(shim.length).toBeGreaterThan(3);
  });

  it('НОМЕРА: e2k и x86_64 РАЗНЫЕ — опечатка «как на x86_64» видна здесь', () => {
    // Номера взяты из `linux-user/e2k/syscall_nr.h` и сверены с `docs/e2k-syscalls-minimal.md`.
    // Проверка эталонного значения: если кто-то подставит привычные x86_64-номера, это красное.
    expect([SYS_READ, SYS_WRITE_FILE, SYS_OPEN, SYS_CLOSE]).toEqual([3, 4, 5, 6]);
    expect(SYS_X86_64_OPEN, 'на x86_64 open = 2, и это ДРУГОЙ номер').toBe(2);
    expect(SYS_OPEN).not.toBe(SYS_X86_64_OPEN);
  });

  it('ФОРМА: у каждого вызова номер в оконном r0 кадра, `sdisp` перед `call`', () => {
    const выз = openInstructions({ pathAddress: 0x100200, result: 1 });
    expect(fileCallProblems(выз), 'форма вызова open').toEqual([]);
    expect(fileCallProblems(readInstructions({ fd: 1, bufferAddress: BUFFER, count: 4, result: 2 }))).toEqual([]);
    expect(fileCallProblems(closeInstructions({ fd: 1, result: 2 }))).toEqual([]);
    // НЕГАТИВНЫЙ КОНТРОЛЬ: у вызова без `sdisp` сторож обязан покраснеть — иначе он мёртв.
    const безSdisp = выз.filter((instruction) => instruction.mnemonic !== 'sdisp');
    expect(fileCallProblems(безSdisp).join(' ')).toContain('CTPSL');
    // И контроль второго дефекта: `sdisp` ПОСЛЕ `call` — тег не выставлен к моменту передачи.
    // Перестановка строится ПО ИМЕНАМ, а не по индексам от конца: иначе контроль повторил бы
    // первый дефект (в конце оказался бы лишний `movts`) и «покраснел» бы не по той причине,
    // которая записана, — то есть был бы мёртвым.
    const sdisp = выз.findIndex((instruction) => instruction.mnemonic === 'sdisp');
    const call = выз.findIndex((instruction) => instruction.mnemonic === 'call');
    expect([sdisp, call], 'в собранном вызове sdisp идёт непосредственно перед call').toEqual([sdisp, sdisp + 1]);
    const перевёрнут = [...выз];
    перевёрнут[sdisp] = выз[call]!;
    перевёрнут[call] = выз[sdisp]!;
    expect(fileCallProblems(перевёрнут).join(' ')).toContain('ДО sdisp');
  });

  it('OUTCOME: три состояния — «прочитано 0», «прочитано N», «отказ -errno»', () => {
    // Разбор ответа ядра проверяется ДО прогона: знак ответа — единственный признак отказа.
    expect(outcomeOf(0)).toEqual<FileCallOutcome>({ kind: 'ok', value: 0 });
    expect(outcomeOf(4)).toEqual<FileCallOutcome>({ kind: 'ok', value: 4 });
    expect(outcomeOf(-2)).toEqual<FileCallOutcome>({ kind: 'error', errno: 2 });
    // Различающая пара: 0 (конец файла) и -2 (ENOENT) — РАЗНЫЕ состояния, а не «оба ноль».
    expect(outcomeOf(0).kind).not.toBe(outcomeOf(-2).kind);
  });

  it('OPEN+READ+CLOSE: байты файла приходят на цель — сверил СВОЙ файл, а не «что-то»', () => {
    if (shim === undefined) return;
    const путь = файлДляЧтения('foundation-read.txt');
    // Ожидание — из файла, а не из строки в тесте: тест и программа смотрят на ОДНИ байты.
    const ожидаемые = fs.readFileSync(path.join(ROOT, '.tmp', 'foundation-read.txt'));
    const bytes = assemble(
      (адреса) => [
        ...openInstructions({ pathAddress: адреса.путь, result: 1, flags: O_RDONLY }),
        ...readInstructions({ fd: 1, bufferAddress: адреса.буфер, count: 16, result: 2 }),
        a('movtd', [literal(адреса.буфер), reg(7)]),
        ...writeOut(1, адреса.буфер, ожидаемые.length),
        ...closeInstructions({ fd: 1, result: 3 }),
        ...exitWith(2),
      ],
      путь,
    );
    const прогон = run('open-read-close', bytes);
    expect(прогон.stdout, 'вывод модели — байты нашего файла').toBe(ожидаемые.toString('utf8'));
    expect(прогон.код, 'число прочитанных байт').toBe(ожидаемые.length);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ к чтению: тот же образ БЕЗ read даёт НУЛИ, а не байты файла', () => {
    if (shim === undefined) return;
    const путь = файлДляЧтения('foundation-read.txt');
    const ожидаемые = fs.readFileSync(path.join(ROOT, '.tmp', 'foundation-read.txt'));
    // Единственное отличие от опыта выше — отсутствует `read`.
    const bytes = assemble(
      (адреса) => [
        ...openInstructions({ pathAddress: адреса.путь, result: 1, flags: O_RDONLY }),
        a('movtd', [literal(адреса.буфер), reg(7)]),
        ...writeOut(1, адреса.буфер, ожидаемые.length),
        ...exitWith(0),
      ],
      путь,
    );
    const прогон = run('без-read', bytes);
    expect(прогон.stdout, 'без read в буфере обязаны быть нули').not.toBe(ожидаемые.toString('utf8'));
    expect([...прогон.stdout].every((символ) => символ === '\u0000'), 'в буфере именно нули').toBe(true);
    expect(прогон.код, 'свой exit(0)').toBe(0);
  });

  it('ОТКАЗ НАЗВАН: `open` несуществующего файла — `-errno`, а не «дескриптор» и не тишина', () => {
    if (shim === undefined) return;
    // Знак ответа наблюдается УСИЛИТЕЛЕМ: `shrs 63` даёт 1 у отрицательного и 0 у положительного.
    // Без усилителя оба состояния слились бы: `exit` отдал бы младший байт дескриптора (3) и
    // младший байт `-2` (254) — их ещё можно различить, но «0 против 1» различает САМ ЗНАК.
    const bytes = assemble(
      (адреса) => [
        ...openInstructions({ pathAddress: адреса.путь, result: 1, flags: O_RDONLY }),
        a('movts', [imm(63), reg(3)]),
        a('shrs', [reg(1), reg(3), reg(4)]),
        ...exitWith(4),
      ],
      ОТСУТСТВУЮЩИЙ,
    );
    const прогон = run('open-отсутствующий-знак', bytes);
    expect(прогон.код, 'отрицательный ответ ядра: знак выставлен').toBe(1);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ к отказу: существующий файл тем же усилителем даёт 0', () => {
    if (shim === undefined) return;
    // Та же программа, только файл ЕСТЬ. Различие ровно одно — существование файла.
    const путь = файлДляЧтения('foundation-read.txt');
    const bytes = assemble(
      (адреса) => [
        ...openInstructions({ pathAddress: адреса.путь, result: 1, flags: O_RDONLY }),
        a('movts', [imm(63), reg(3)]),
        a('shrs', [reg(1), reg(3), reg(4)]),
        ...exitWith(4),
      ],
      путь,
    );
    const прогон = run('open-существующий-знак', bytes);
    expect(прогон.код, 'дескриптор — положительный: знака нет').toBe(0);
  });

  it('КОНЕЦ ФАЙЛА: чтение счётчика больше файла даёт число байт файла, затем 0', () => {
    if (shim === undefined) return;
    const содержимое = 'abc';
    const путь = файлДляЧтения('foundation-eof.txt', содержимое);
    // Первое чтение с запасом (16 > 3): ядро обязано вернуть 3, а не отказать.
    // Второе чтение: за концом файла — 0, и это НЕ ошибка (усилитель знака даёт 0).
    const bytes = assemble(
      (адреса) => [
        ...openInstructions({ pathAddress: адреса.путь, result: 1, flags: O_RDONLY }),
        ...readInstructions({ fd: 1, bufferAddress: адреса.буфер, count: 16, result: 2 }),
        ...readInstructions({ fd: 1, bufferAddress: адреса.буфер, count: 16, result: 3 }),
        a('movts', [imm(10), reg(5)]),
        // Код = сколько_во_втором·10 + сколько_в_первом: 0·10 + 3 = 3 у правильной пары,
        // 255·10 + 3 = 2553 → младший байт 249, если второе чтение вернуло -1.
        a('muls', [reg(3), reg(5), reg(6)]),
        a('adds', [reg(6), reg(2), reg(6)]),
        ...exitWith(6),
      ],
      путь,
    );
    const прогон = run('конец-файла', bytes);
    expect(прогон.код, 'первое чтение — 3 байта, второе (за концом) — 0, а не ошибка').toBe(3);
  });
});

/**
 * ЛЕКСЕР v3 НА ЦЕЛИ: ЧТО УЖЕ ИСПОЛНЯЕТСЯ, А ЧТО — СТЕНА (§3.132 — 2026-10-10, §3.133 — 2026-10-23;
 * ПЕРЕМЕР A4-5в — 2026-10-29).
 *
 * Лексер целиком на цель НЕ собирается и после переписи знаков на коды, но СТЕНА СДВИНУЛАСЬ, и это
 * записано замером, а не пересказом:
 *
 *  1. **`подстрока` на цели понижения не имеет** — отказ по имени (`OSN-LOW-003`): срез даёт строку
 *     длины, известной только в рантайме, а строковая модель цели требует длины, известной на СБОРКЕ
 *     (§3.47, §3.48). Это не «пока не дошли»: способа нет (решение владельца 2026-10-10).
 *  2. **Место образа**: на теле БЕЗ срезов код дорос до **7472** байт при статических строках,
 *     начинающихся на смещении **7099** (было 8064/6938 — числа прежней редакции лексера). Но первой
 *     стены МЕСТА здесь нет и не было — первой вставала ДРУГАЯ.
 *  3. **Первая стена — УЖЕ НЕ утверждение арены** (сдвиг 2026-10-29, A4-5в). Прежняя редакция
 *     стерегла здесь `арена нужна образу, а регистры её не закреплены` (разведка планирования строк и
 *     поток после раскладки разошлись — случай 46). Починка распределителя
 *     (`src/e2k/liveness.ts#mergeLoopCarriedSegments` — слияние отрезков через ПРЯМУЮ дугу, sha256
 *     `CCCD4F4F…`) изменила и раскладку, и поток ПОСЛЕ неё, а план строк читает значения ЧЕРЕЗ
 *     РЕГИСТРЫ, поэтому расхождение у этой программы исчезло: замер `.tmp/pins5v-arena.ts` —
 *     разведка `arenaConcats = 0` и итог `arena.used = false` (обе стороны СОГЛАСНЫ), тогда как на
 *     дереве HEAD `d311187` разведка давала 0, а пост-раскладочный план — 1, и утверждение
 *     срабатывало. Теперь конвейер доходит до НАЗВАННЫХ отказов, и они измерены:
 *     файл целиком — **83** отказа (первый: `#142 система.строка.длина: аргумент не строка`),
 *     тело с закреплённой ареной — **109** отказов (было 153, затем 108 после починки; +1 — названный
 *     отказ раскладки вызываемой, правка `programImage.ts` того же среза, см. П7 в `spillCallee`).
 *
 * Здесь спрашивается то, что РАБОТАЕТ, и спрашивается у ЭТАЛОНА — TS-лексера v3:
 * форматирование токена — это шаг лексера (`с_токеном`), а не «похожая программа».
 */
describe('лексер v3 на цели: первые куски (сверка с TS-лексером)', () => {
  const опцииV3 = (src: string) => {
    const р = parseV3(src, 'лексер-проба.osnova');
    return { filename: 'лексер-проба.osnova', parse: () => ({ ast: р.program ?? null, errors: р.errors }) };
  };

  /** Собрать программу на Основе для цели и исполнить в модели: либо отказы, либо ответ. */
  function прогонНаЦели(имя: string, src: string): { код: number | undefined; отказы: string[]; беда: string | undefined } {
    let образ;
    try {
      образ = loweredProgram(src, опцииV3(src));
    } catch (error) {
      return { код: undefined, отказы: [], беда: error instanceof Error ? error.message : String(error) };
    }
    if (образ.refused.length > 0) {
      return { код: undefined, отказы: образ.refused.map((item) => item.reason), беда: undefined };
    }
    const elf = path.join(ROOT, '.tmp', `self-host-лексер-${имя}.elf`);
    fs.writeFileSync(
      elf,
      buildElfFromCode(образ.bytes, MINIMAL_BASE, { writable: true, extraMemory: образ.arena.extraMemory }).bytes,
    );
    const результат = runInQemu(elf, { shim: true, timeoutMs: 30_000 });
    return { код: результат?.status ?? undefined, отказы: [], беда: undefined };
  }

  /** Текст стены: либо исключение конвейера, либо отказы по имени — одним полем для проверки. */
  function итог(р: { беда: string | undefined; отказы: string[] }): string {
    return р.беда ?? р.отказы.join('\n');
  }

  it('ЛОГИКА: сторож НАЗЫВАЕТ причину — отказ вместо прежней лжи на 3 из 4 входов', () => {
    // СДВИГ 2026-10-29 (A4-5в). Прежняя редакция требовала «отказов быть не должно» и код 11 —
    // и оба утверждения СТАЛИ ЛОЖНЫМИ не потому, что программа сломалась, а потому, что раскладка
    // перестала молча отдавать неверную клетку: починка распределителя (`src/e2k/liveness.ts`,
    // слияние отрезков через ПРЯМУЮ дугу) сделала значение живым на ребре взятого перехода, и сторож
    // пар предикатов (`src/e2k/predicatePairing.ts`) назвал то, что раньше было скрыто.
    //
    // ЛОЖЬ НАЗВАНА ЧИСЛОМ, и это мой прогон (`.tmp/pins5v-logic2.ts`; тот же файл запущен на дереве
    // HEAD `d311187` — ДО починки): на закреплённом входе (а=3, б=5) до починки было верно (0 отказов,
    // модель 11 = эталон обеих VM), но на ДРУГИХ входах та же программа лгала — модель против эталона
    // ОБЕИХ VM (стек и регистры совпали): (3,7) → **7 вместо 0**; (7,5) → **17 вместо 10**;
    // (7,7) → **7 вместо 0**. После починки — по ДВА отказа на КАЖДОМ из этих входов (проверка ниже).
    // Поэтому проверка не ослаблена и не удалена: она стережёт ту же границу («выражение v3 с
    // `и`/`или` на цели»), но в новых условиях граница проходит по ОТКАЗУ, а не по числу.
    const логика = (а: number, б: number): string => `действие главная()
  пусть а = ${String(а)}
  пусть б = ${String(б)}
  пусть н = 0
  если а < 4 и б < 6
    н = н + 1
  конец если
  если 1 > 2 или б == 5
    н = н + 10
  конец если
  вернуть н
конец
`;
    const итог = прогонНаЦели('логика', логика(3, 5));
    expect(итог.беда, 'стена — ОТКАЗ понижения, а не останов оболочки').toBeUndefined();
    expect(итог.код, 'образа НЕТ: отказ, а не число').toBeUndefined();
    expect(итог.отказы.length, 'отказов сторожа').toBe(2);
    expect(итог.отказы[0] ?? '', 'первая причина — «склейка» на ребре взятого перехода').toContain('#16 IR.gt');
    expect(итог.отказы[0] ?? '').toContain('склейка');
    expect(итог.отказы[1] ?? '', 'вторая — условие перешло не из сравнения').toContain('#17 IR.jmp_if');
    expect(итог.отказы[1] ?? '').toContain('пришло не из сравнения');
    // МАТРИЦА ВХОДОВ: отказ НЕ зависит от значений — иначе «отказывает» не отличить от «отказывает
    // на одном удачно выбранном входе». Та же матрица, что нашла ложь до починки.
    for (const [а, б] of [[3, 5], [3, 7], [7, 5], [7, 7]] as const) {
      const вход = прогонНаЦели(`логика-${String(а)}-${String(б)}`, логика(а, б));
      expect(вход.беда, `а=${String(а)} б=${String(б)}: отказ, а не останов оболочки`).toBeUndefined();
      expect(вход.отказы.length, `а=${String(а)} б=${String(б)}: отказов`).toBe(2);
      expect(вход.отказы[0] ?? '', `а=${String(а)} б=${String(б)}: первая причина`).toContain('IR.gt');
    }
  });

  it('ЛОГИКА: `нет` и `не` на цели (булева константа — числом из пула)', () => {
    if (shim === undefined) return;
    const итог = прогонНаЦели(
      'нет',
      `действие главная()
  пусть т = нет
  пусть н = 0
  если не т
    н = 7
  конец если
  вернуть н
конец
`,
    );
    expect(итог.отказы).toEqual([]);
    expect(итог.код).toBe(7);
  });

  it('ТОКЕН ЛЕКСЕРА: строка `вид|лексема` строится в рантайме и её длина равна эталону TS', () => {
    if (shim === undefined) return;
    // Эталон берётся у TS-лексера, а не выписан числом: `kind|lexeme` + перевод строки.
    const токены = tokenizeV3('пусть сумма = 1\n', 'проба.osnova').tokens;
    const строкаТокена = `${токены[1]!.kind}|${токены[1]!.lexeme}\n`;
    const итог = прогонНаЦели(
      'токен',
      `действие главная()
  пусть вид = "имя"
  пусть лексема = "сумма"
  пусть строка = вид + "|" + лексема + "\\n"
  вернуть длина строка
конец
`,
    );
    expect(итог.отказы).toEqual([]);
    expect(итог.код, `длина «${строкаТокена.replace('\n', '\\n')}» по TS-лексеру`).toBe([...строкаТокена].length);
  });

  it('ХВОСТ ЛЕКСЕРА: последний токен потока (`конец_файла|<конец файла>`) равен эталону TS', () => {
    if (shim === undefined) return;
    const итог = прогонНаЦели(
      'хвост',
      `действие главная()
  пусть хвост = "конец_файла" + "|" + "<конец файла>"
  вернуть длина хвост
конец
`,
    );
    expect(итог.отказы).toEqual([]);
    expect(итог.код).toBe([...'конец_файла|<конец файла>'].length);
  });

  it('СТЕНА НАЗВАНА: лексер целиком отказывает ПО ИМЕНИ — стена сдвинулась и измерена числами', () => {
    const текст = fs.readFileSync(path.join(ROOT, 'src', 'self-host', 'lexer.osnova'), 'utf-8');
    const безФайла = текст.slice(0, текст.indexOf('// ЛЕКСИРОВАТЬ ФАЙЛ'));
    const целиком = прогонНаЦели(
      'целиком',
      `${безФайла}
действие главная()
  пусть т = лексировать("пусть а = 1\\n")
  вернуть длина т
конец
`,
    );
    // Стена обязана быть НАЗВАНА: отказ конвейера или отказ по имени операции. Молчаливой
    // подстановки здесь быть не может — иначе проверки выше были бы не о том.
    //
    // СДВИГ 2026-10-29 (A4-5в). Прежняя редакция требовала /арена нужна образу/ — и это утверждение
    // СТАЛО ЛОЖНЫМ, поэтому оно заменено, а не удалено: стена по-прежнему обязана быть названа, но
    // называется теперь ПО-ДРУГОМУ и в другом месте.
    //   ЧТО СДВИНУЛО: починка распределителя `src/e2k/liveness.ts#mergeLoopCarriedSegments` (слияние
    //   отрезков жизни через ПРЯМУЮ дугу, sha256 `CCCD4F4F…`). План строк читает значения ЧЕРЕЗ
    //   РЕГИСТРЫ, поэтому изменение раскладки изменило и пост-раскладочный план.
    //   ПОЧЕМУ УТВЕРЖДЕНИЕ ПЕРЕСТАЛО СРАБАТЫВАТЬ (замер `.tmp/pins5v-arena.ts`, обе стороны):
    //   разведка арены `arenaConcats = 0` и пост-раскладочный план `arena.used = false` — СОГЛАСНЫ;
    //   на дереве HEAD `d311187` было 0 в разведке и 1 в плане, и утверждение срабатывало.
    //   Прежний замер: без ручки — ИСКЛЮЧЕНИЕ «арена нужна образу» (0 отказов), с ручкой — 156.
    //   НОВЫЙ ЗАМЕР (тот же инструмент на двух деревьях, `.tmp/pins5v-measure.ts`): отказ не
    //   исключение, а СПИСОК отказов; первый — строка, значение которой известно только в рантайме.
    expect(целиком.беда, 'стена — ОТКАЗ по имени, а не останов конвейера').toBeUndefined();
    expect(целиком.отказы[0] ?? '', 'первый отказ — строка, известная только в рантайме').toContain(
      '#142 система.строка.длина: аргумент не строка',
    );
    expect(итог(целиком), 'утверждение арены у этой программы больше не срабатывает').not.toMatch(/арена нужна образу/);
    // И это утверждение — НЕ «почти влезло»: место образа проверяется отдельно ниже, с закреплённой
    // ареной, и там место названо исчерпывающе.
    expect(итог(целиком), 'место образа не должно быть стеной').not.toMatch(/код дорос до них/);
    // ЧИСЛО ОТКАЗОВ У ФАЙЛА ЦЕЛИКОМ: 83 = 82 (после починки распределителя) + 1 названный отказ
    // раскладки вызываемой «лексировать» (правка `src/e2k/programImage.ts`, сторож — П7 в
    // `src/e2k/spillCallee.test.ts`). До починки здесь было ИСКЛЮЧЕНИЕ (0 отказов).
    expect(целиком.отказы.length, 'отказов у файла целиком').toBe(83);
    // Тот же названный отказ раскладки виден и у ТЕЛА: он девятый по виду (было 8 видов).
    expect(
      целиком.отказы.filter((отказ) => отказ.startsWith('раскладка отказала')).length,
      'названных отказов раскладки у файла целиком',
    ).toBe(1);

    // МЕСТО И ОТКАЗЫ — С ЗАКРЕПЛЁННОЙ АРЕНОЙ (`assumeArenaReserved`), и это не подмена: ручка
    // закрепляет ЛИШНЕЕ (безопасная сторона), а нужна она затем, чтобы измерить СЛЕДУЮЩУЮ стену —
    // сколько кода и сколько отказов у программы, когда разведка арены не мешает. Числа закреплены
    // замером 2026-10-23 (§3.134) и воспроизводятся пробой `.tmp/osnova-3134-lexer-refusals.ts`.
    // Сдвинулись — это ОТДЕЛЬНЫЙ датированный коммит с объяснением (§3.131), а не подгонка ожидания.
    const сАреною = loweredProgram(`${безФайла}
действие главная()
  пусть т = лексировать("пусть а = 1\\n")
  вернуть длина т
конец
`, { ...опцииV3(безФайла), assumeArenaReserved: true });
    expect(сАреною.bytes.length, 'байт образа со статикой').toBe(65536);
    // 109 отказа у ТЕЛА. Было 141 → 157 — сдвиг 2026-10-29 (A4-5а) от ВКЛЮЧЕНИЯ сторожа K5 (окно
    // живости по рёбрам: предикатных 27 вместо 11, `IR.invoke` 28 вместо 19); затем 157 → **151** —
    // тот же день и тот же срез, но ДРУГАЯ правка: значение сравнения кладётся в регистр
    // материализацией (`cmp*` + predicated `movts 0/1`), поэтому предикатных стало **21**
    // (`IR.ne` 1 → 0, `IR.ge` 7 → 6, `IR.jmp_if_not` 15 → 13). Затем 151 → **153** — 2026-10-29
    // (A4-5б), сторож ВТОРОЙ тихой лжи (накопитель конъюнкции на ребре взятого перехода, случай 55):
    // ровно +2 отказа, по одному НОВОМУ виду — `OSN-LOW-004 IR.eq` (1) и `OSN-LOW-004 IR.lt` (1);
    // предикатных 21 → 23. Затем 153 → **108** — 2026-10-29 (A4-5в), починка распределителя
    // `src/e2k/liveness.ts` (слияние отрезков через прямую дугу): состав сдвинулся вместе с
    // раскладкой, см. `src/e2k/callWindowRefusals.test.ts` П7, где он разобран по подвидам.
    // Затем 108 → **109** — тем же срезом, но ДРУГОЙ правкой: `src/e2k/programImage.ts` теперь
    // называет отказ раскладки ЛЮБОЙ процедуры, а не только `report[0]`, поэтому у тела лексера
    // появился девятый вид — `OSN-LOW-004 —` (неназванный прежде отказ `лексировать`: «вытеснение не
    // минимально … живы 13 отрезков, свободных регистров 8»). Замер РАЗВОДЯЩИЙ, на одном дереве:
    // со сторожем 109 / без сторожа 108; доказательство ДОпочиночности стены — на дереве HEAD
    // `d311187` (0 отказов вытеснения, исключение без ручки, 156 с ручкой).
    expect(сАреною.refused.length, 'отказов понижения').toBe(109);
    // Первая по частоте причина — не место, а СТРОКА, значение которой известно только в рантайме:
    // у лексера 19 таких мест (`с[и]` по строке, пришедшей из памяти, а не из литерала).
    const поСимволу = сАреною.refused.filter((отказ) => отказ.reason.includes('символ: аргумент не строка'));
    expect(поСимволу.length, '`с[и]` по значению, известному только в рантайме').toBe(19);
    // НАЗВАННЫЙ ОТКАЗ РАСКЛАДКИ ВЫЗЫВАЕМОЙ — теперь назван и здесь, вместе с ИМЕНЕМ процедуры:
    // до правки `programImage.ts` он не назывался нигде (проверялся только `report[0]`), и это
    // была ТРЕТЬЯ тихая ложь: образ с неразложенной вызываемой уходил в ELF. Сторож — П7.
    const раскладка = сАреною.refused.filter((отказ) => отказ.reason.startsWith('раскладка отказала'));
    expect(раскладка.length, 'названных отказов раскладки в теле').toBe(1);
    expect(раскладка[0]?.reason ?? '', 'имя процедуры в отказе').toContain('процедура «лексировать»');
    expect(раскладка[0]?.reason ?? '', 'причина отказа раскладки').toContain('вытеснение не минимально');
  });
});
