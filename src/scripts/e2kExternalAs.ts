/**
 * ДВУСТОРОННЯЯ ВНЕШНЯЯ ПРОВЕРКА КОДИРОВКИ e2k: ТЕКСТ → БАЙТЫ.
 *
 * # Зачем вторая сторона
 *
 * `src/scripts/e2kExternalObjdump.ts` проверяет сторону **байты → текст**: наш кодировщик
 * выдаёт байты, дизассемблер МЦСТ печатает инструкцию. Этого мало: дизассемблер мог бы
 * «узнать» нашу инструкцию по коду операции и не заметить, что **остальные поля** (канал,
 * регистры, разрядность, литералы) разложены иначе. Здесь проверяется обратная сторона:
 * **ассемблер МЦСТ** собирает ту же инструкцию, и байты сравниваются **побайтово**.
 *
 * Совпадение с двух сторон означает: наш кодировщик выдаёт то же, что MCST-`as`, а MCST-`objdump`
 * читает это как ту же инструкцию. Расхождение — находка, которую нельзя списать на
 * самосогласованность.
 *
 * # Что подаётся на вход
 *
 * Ассемблерная форма МЦСТ: `мнемоника,канал %b[1], %b[2], %r-подобные операнды`. Регистры
 * записываются так, как их понимает `as`: **`%b[N]`** для одиночных и **`%db[N]`** для двойных.
 * Форма регистра берётся из поля `ARGS_*` записи таблицы МЦСТ (`REAL_OPCODES[].argFormats`),
 * а не выбирается нами: `as` различает `%b[1]` (поле `0x01`) и `%r1` (поле `0x81`) и кодирует
 * их по-разному — это измерено (`docs/e2k-external-as.md` §2).
 *
 * # Чего проверка не делает
 *
 * Не проверяет исполнение и не покрывает формы, которых в таблице нет. Двадцать четыре
 * образца — по одному на каждую реализованную операцию; полный перебор каналов и литералов
 * проверяется отдельно в `src/e2k/e2kReal.test.ts`.
 *
 * Использование:
 *   npx tsx src/scripts/e2kExternalAs.ts     # собрать ассемблером и сравнить, записать отчёт
 *   E2K_AS=/путь/к/as npx tsx src/scripts/e2kExternalAs.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getEncoder, toHex, type AsmInstruction, type Encoder, type Operand } from '../e2k/backend';
import { REAL_OPCODES, type RealOpcodeEntry } from '../e2k/e2k-real';
import { layoutOf, secondPass } from '../e2k/twoPassLayout';
import { lowerCarrier, type LoweringContext } from '../e2k/e2kRealRun';

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT_FILE = path.join(ROOT, '.tmp', 'e2k-external-as.json');
const PROGRAM_REPORT_FILE = path.join(ROOT, '.tmp', 'e2k-external-as-programs.json');
const WSL = 'C:\\Program Files\\WSL\\wsl.exe';
const WSL_AS = '/root/build-gas/gas/as-new';
const WSL_OBJCOPY = '/root/build/binutils/objcopy';
const WSL_OBJDUMP = '/root/build/binutils/objdump';

/** Формат отчёта — НАШЕ РЕШЕНИЕ. */
export const AS_REPORT_FORMAT = 'osnova-e2k-external-as';

/** Один образец внешней сверки: ассемблерный текст и наша инструкция. */
export interface AsSample {
  readonly key: string;
  readonly mnemonic: string;
  readonly channel: number;
  readonly form: string;
  readonly asText: string;
  readonly instruction: AsmInstruction;
  readonly source: string;
}

const reg = (index: number): Operand => ({ kind: 'reg', index });
const pred = (index: number): Operand => ({ kind: 'pred', index });

/**
 * Текст операнда по формату записи: `S` → `%b`, `D` → `%db` (`opcodes/e2k-dis.c:417,454`),
 * `P` → `%pred` (приёмник сравнения, поле `pdst[4:0]` формы ALF7).
 */
export function registerText(format: string, index: number): string {
  if (format === 'S') return `%b[${index}]`;
  if (format === 'D') return `%db[${index}]`;
  if (format === 'P') return `%pred${index}`;
  throw new Error(`неизвестный формат операнда «${format}» — в таблице только S, D и P`);
}

/**
 * Ассемблерный текст образца: `мнемоника,канал` и операнды в порядке формы.
 * Регистры нумеруются с 1 (`%b[1], %b[2], …`) — так образец читается человеком и совпадает
 * с образцами дизассемблерной проверки.
 */
export function asTextOf(entry: RealOpcodeEntry, channel: number): string {
  const operands = entry.operands.map((_, index) => registerText(entry.argFormats[index]!, index + 1));
  return `${entry.mnemonic},${channel} ${operands.join(', ')}`;
}

/** Инструкция в терминах интерфейса, соответствующая этому же образцу. */
export function instructionOf(entry: RealOpcodeEntry, channel: number): AsmInstruction {
  return {
    mnemonic: entry.mnemonic,
    channel,
    // Приёмник сравнения — предикат, а не регистр: вид операнда берётся из формы.
    operands: entry.operands.map((slot, index) => (slot === 'pdst' ? pred(index + 1) : reg(index + 1))),
  };
}

/** Образцы: по одному на каждую реализованную операцию, канал — первый разрешённый. */
export function buildAsSamples(): AsSample[] {
  return REAL_OPCODES.map((entry) => {
    const channel = entry.channels[0]!;
    return {
      key: `${entry.mnemonic},${channel}`,
      mnemonic: entry.mnemonic,
      channel,
      form: entry.form,
      asText: asTextOf(entry, channel),
      instruction: instructionOf(entry, channel),
      source: entry.source,
    };
  });
}

/** Внешний ассемблер. */
export interface ExternalAs {
  readonly path: string;
  readonly version: string;
  /** Запуск ассемблера напрямую. */
  readonly runner: { readonly command: string; readonly args: readonly string[] };
  /** Запуск скрипта, который собирает много образцов сразу (через `bash -s`). */
  readonly scriptRunner: { readonly command: string; readonly args: readonly string[] };
  /** Ассемблер живёт внутри WSL — пути и `objcopy` берутся из дистрибутива. */
  readonly inWsl: boolean;
}

/** Запустить команду, вернуть вывод (вывод `wsl.exe` приходит в UTF-16LE). */
function run(command: string, args: readonly string[], input?: string): string | undefined {
  try {
    const buffer = execFileSync(command, [...args], {
      timeout: 180_000,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      ...(input === undefined ? {} : { input }),
    });
    if (buffer.length >= 2 && buffer[1] === 0 && buffer[0] !== 0) return buffer.toString('utf16le');
    return buffer.toString('utf-8');
  } catch {
    return undefined;
  }
}

/** Найти `e2k-linux-as`: `E2K_AS` → собранный в WSL → `e2k-linux-as` в PATH. */
export function findExternalAs(): { tool?: ExternalAs; reason?: string } {
  const explicit = process.env.E2K_AS;
  if (explicit !== undefined && explicit !== '') {
    const version = run(explicit, ['--version']);
    if (version === undefined) return { reason: `E2K_AS=${explicit}: файл не запускается` };
    return {
      tool: {
        path: explicit,
        version: version.split('\n')[0]!,
        runner: { command: explicit, args: [] },
        scriptRunner: { command: 'bash', args: ['-s'] },
        inWsl: false,
      },
    };
  }
  const wslVersion = run(WSL, ['-d', 'e2k', '--', WSL_AS, '--version']);
  if (wslVersion !== undefined) {
    const first = wslVersion.split(/\r?\n/).map((line) => line.replace(/\u0000/g, '').trim()).filter(Boolean)[0]!;
    return {
      tool: {
        path: WSL_AS,
        version: first,
        runner: { command: WSL, args: ['-d', 'e2k', '--', WSL_AS] },
        scriptRunner: { command: WSL, args: ['-d', 'e2k', '--', 'bash', '-s'] },
        inWsl: true,
      },
    };
  }
  const pathVersion = run('e2k-linux-as', ['--version']);
  if (pathVersion !== undefined) {
    return {
      tool: {
        path: 'e2k-linux-as',
        version: pathVersion.split('\n')[0]!,
        runner: { command: 'e2k-linux-as', args: [] },
        scriptRunner: { command: 'bash', args: ['-s'] },
        inWsl: false,
      },
    };
  }
  return {
    reason:
      `ассемблер e2k не найден: нет E2K_AS, нет ${WSL_AS} в WSL-дистрибутиве «e2k», ` +
      'нет e2k-linux-as в PATH',
  };
}

/** Результат сборки одного образца ассемблером. */
export type AsResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: string };

/**
 * Собрать все образцы **одним** вызовом ассемблера: по одному `.s` на образец, затем
 * `objcopy -O binary --only-section=.text` и `od -An -tx1`.
 *
 * Один вызов вместо N: запуск `wsl.exe` стоит около секунды, и 24 запуска сделали бы проверку
 * невыносимой.
 */
export function assembleAll(samples: readonly AsSample[]): AsResult[] {
  const { tool, reason } = findExternalAs();
  if (tool === undefined) throw new Error(reason!);
  const script = buildAssemblyScript(samples, tool);
  const output = run(tool.scriptRunner.command, tool.scriptRunner.args, script) ?? '';
  return parseAssemblyOutput(output, samples.length);
}

/** Номер запуска сборки в этом процессе: каталог обязан быть своим у каждого вызова. */
let assemblyRun = 0;

/**
 * Каталог для `.s`/`.o`/`.bin` внутри WSL.
 *
 * Каталог **уникален на каждый вызов**: `/tmp` в WSL один на все процессы, и общий каталог
 * (`/tmp/e2k-as`) давал гонку — параллельные тесты затирали файлы друг друга, а ассемблер
 * отвечал «can't open /tmp/e2k-as/s5.s» или читал чужие байты. Это наблюдалось на полном
 * прогоне, поэтому в имя входят pid и номер вызова.
 */
export function scriptDirectory(): string {
  assemblyRun += 1;
  return `/tmp/e2k-as-${process.pid}-${assemblyRun}`;
}

/** Текст сборочного скрипта: по одному файлу на образец и разметка результатов. */
export function buildAssemblyScript(samples: readonly AsSample[], tool: ExternalAs): string {
  const dir = scriptDirectory();
  const as = tool.inWsl ? WSL_AS : tool.path;
  const objcopy = tool.inWsl ? WSL_OBJCOPY : 'e2k-linux-objcopy';
  const lines: string[] = ['set -u', `D=${dir}`, 'rm -rf "$D"', 'mkdir -p "$D"'];
  samples.forEach((sample, index) => {
    lines.push(`cat > "$D/s${index}.s" <<'OSNOVA_EOF'`);
    lines.push('.text');
    lines.push(sample.asText);
    lines.push('OSNOVA_EOF');
  });
  samples.forEach((_, index) => {
    // `-mcpu=elbrus-v5` обязателен: ассемблер по умолчанию берёт `elbrus-v2` (int mcpu = 2
    // в opcodes/e2k-opc.c:30), а `umulhd`/`smulhd` в нём не поддерживаются. Проверено:
    // `as` отвечает «`umulhd' is not supported on `elbrus-v2'».
    lines.push(`if ${as} ${AS_CPU_OPTION} -o "$D/s${index}.o" "$D/s${index}.s" 2>"$D/s${index}.err"; then`);
    lines.push(`  ${objcopy} -O binary --only-section=.text "$D/s${index}.o" "$D/s${index}.bin" 2>>"$D/s${index}.err" \\`);
    // `-v` обязателен: без него `od` сворачивает повторяющиеся строки в `*`, и повтор байтов
    // теряется — 48 байт программы читались бы как 32 (замер: см. docs/e2k-external-as.md §5).
    lines.push(`    && { echo "== ${index}"; od -An -tx1 -v "$D/s${index}.bin"; } \\`);
    lines.push(`    || { echo "!! ${index}"; head -2 "$D/s${index}.err"; }`);
    lines.push('else');
    lines.push(`  echo "!! ${index}"; head -2 "$D/s${index}.err"`);
    lines.push('fi');
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Уровень ISA для ассемблера. `elbrus-v5` покрывает все реализованные операции:
 * `umulhd`/`smulhd` требуют не ниже `elbrus-v3` (маска набора `0xfc`), остальные — с `v2`.
 */
export const AS_CPU_OPTION = '-mcpu=elbrus-v5';

/** Разобрать вывод сборочного скрипта в результаты по образцам. */
export function parseAssemblyOutput(output: string, expected: number): AsResult[] {
  const results: AsResult[] = Array.from({ length: expected }, () => ({ ok: false, error: 'нет ответа ассемблера' }));
  let current = -1;
  let failed = false;
  /** Причина отказа текущего образца: пустая — «ассемблер не выдал байтов». */
  let failureReason = '';
  let buffer: number[] = [];
  const flush = (): void => {
    if (current < 0) return;
    if (failed) {
      // Отказ ассемблера сохраняется как отказ: пустой поток байтов — это не «совпало».
      results[current] = { ok: false, error: failureReason === '' ? 'ассемблер не выдал байтов' : failureReason };
    } else if (buffer.length === 0) {
      results[current] = { ok: false, error: 'ассемблер выдал пустой .text' };
    } else {
      results[current] = { ok: true, bytes: Uint8Array.from(buffer) };
    }
    buffer = [];
    failureReason = '';
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\u0000/g, '').trim();
    const marker = /^==\s*(\d+)$/.exec(line);
    if (marker !== null) {
      flush();
      current = Number.parseInt(marker[1]!, 10);
      failed = false;
      continue;
    }
    const failure = /^!!\s*(\d+)$/.exec(line);
    if (failure !== null) {
      flush();
      current = Number.parseInt(failure[1]!, 10);
      failed = true;
      continue;
    }
    if (current < 0) continue;
    // `od` без `-v` сворачивает повторяющиеся строки в `*` и теряет повторы. Молча пропустить
    // это нельзя: программа из 48 байт прочиталась бы как 32 и «совпала» бы сама с собой.
    if (/^\*$/.test(line)) {
      failed = true;
      failureReason = 'od свернул повторяющуюся строку в «*»: байты потеряны (нужен od -v)';
      buffer = [];
      continue;
    }
    if (/^[0-9a-f]{2}(\s+[0-9a-f]{2})*$/.test(line)) {
      buffer.push(...line.split(/\s+/).map((byte) => Number.parseInt(byte, 16)));
      continue;
    }
    if (failed && (line.startsWith('Error') || line.includes('Error:'))) {
      if (failureReason === '') failureReason = line;
    }
  }
  flush();
  return results;
}

/** Итог сверки одного образца. */
export interface AsComparison {
  readonly key: string;
  readonly asText: string;
  readonly ours: string;
  readonly theirs?: string;
  readonly status: 'совпал' | 'не совпал' | 'НЕ ПРОВЕРЕНО';
  readonly reason: string;
  /** Первое расхождение: номер байта, наш байт, байт ассемблера. */
  readonly firstDiff?: { readonly index: number; readonly ours: number; readonly theirs: number };
}

/** Сравнить два потока байтов. Чистая функция — её проверяет негативный контроль. */
export function firstDifference(ours: Uint8Array, theirs: Uint8Array): AsComparison['firstDiff'] {
  const length = Math.min(ours.length, theirs.length);
  for (let index = 0; index < length; index++) {
    if (ours[index] !== theirs[index]) {
      return { index, ours: ours[index]!, theirs: theirs[index]! };
    }
  }
  return undefined;
}

/** Отчёт о двусторонней проверке. */
export interface AsReport {
  readonly format: string;
  readonly version: number;
  readonly tool: ExternalAs | null;
  readonly unavailableReason?: string;
  readonly comparisons: readonly AsComparison[];
  readonly summary: {
    readonly total: number;
    readonly matched: number;
    readonly mismatched: number;
    readonly unverified: number;
  };
}

/** Прогнать сверку «текст → байты» через ассемблер МЦСТ. */
export function runExternalAs(): AsReport {
  const samples = buildAsSamples();
  const encoder = getEncoder('e2k');
  const { tool, reason } = findExternalAs();
  if (tool === undefined) {
    return {
      format: AS_REPORT_FORMAT,
      version: 1,
      tool: null,
      unavailableReason: reason!,
      comparisons: samples.map((sample) => ({
        key: sample.key,
        asText: sample.asText,
        ours: toHex(encoder.encode(sample.instruction)),
        status: 'НЕ ПРОВЕРЕНО' as const,
        reason: reason!,
      })),
      summary: { total: samples.length, matched: 0, mismatched: 0, unverified: samples.length },
    };
  }

  const results = assembleAll(samples);
  const comparisons: AsComparison[] = samples.map((sample, index) => {
    const ours = encoder.encode(sample.instruction);
    const result = results[index]!;
    if (!result.ok) {
      return {
        key: sample.key,
        asText: sample.asText,
        ours: toHex(ours),
        status: 'НЕ ПРОВЕРЕНО' as const,
        reason: result.error === '' ? 'ассемблер отверг образец' : result.error,
      };
    }
    const diff = firstDifference(ours, result.bytes);
    if (diff === undefined && ours.length === result.bytes.length) {
      return {
        key: sample.key,
        asText: sample.asText,
        ours: toHex(ours),
        theirs: toHex(result.bytes),
        status: 'совпал' as const,
        reason: `байт ${ours.length} — совпали`,
      };
    }
    const where =
      diff === undefined
        ? `длины: у нас ${ours.length}, у ассемблера ${result.bytes.length}`
        : `байт ${diff.index}: у нас 0x${diff.ours.toString(16).padStart(2, '0')}, у ассемблера 0x${diff.theirs.toString(16).padStart(2, '0')}`;
    return {
      key: sample.key,
      asText: sample.asText,
      ours: toHex(ours),
      theirs: toHex(result.bytes),
      status: 'не совпал' as const,
      reason: where,
      ...(diff === undefined ? {} : { firstDiff: diff }),
    };
  });

  return {
    format: AS_REPORT_FORMAT,
    version: 1,
    tool,
    comparisons,
    summary: {
      total: comparisons.length,
      matched: comparisons.filter((item) => item.status === 'совпал').length,
      mismatched: comparisons.filter((item) => item.status === 'не совпал').length,
      unverified: comparisons.filter((item) => item.status === 'НЕ ПРОВЕРЕНО').length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРОГРАММЫ С ПЕРЕХОДОМ: одна инструкция тут не годится
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Образец-программа: несколько инструкций, **метка** и переход на неё.
 *
 * Одной инструкцией переход не проверить: `disp` несёт смещение **до адреса цели**, а адрес
 * зависит от размеров всех команд перед ней. Поэтому образец — программа целиком, а его
 * ассемблерный текст строится **из наших же понижённых команд**: если наш текст и наши байты
 * разойдутся, `as` это покажет.
 */
export interface AsProgramSample {
  readonly key: string;
  /** Имя метки цели в ассемблерном тексте. */
  readonly label: string;
  /** Ассемблерный текст МЦСТ: несколько строк, метка — на своём месте. */
  readonly asText: string;
  /** Наш поток носителей IR. */
  readonly instructions: readonly AsmInstruction[];
  /** Индекс инструкции, на которую указывает метка. */
  readonly targetIndex: number;
  readonly source: string;
}

/** Наш образ программы: байты, адреса и вычисленная цель. */
export interface ProgramImage {
  readonly bytes: Uint8Array;
  readonly addresses: ReadonlyMap<number, number>;
  readonly targetAddress: number;
  readonly commandAddress: number;
  readonly disp: number;
  /** Отказы раскладки и понижения — обязаны быть пустыми, иначе образ неполон. */
  readonly refusals: readonly string[];
}

const imm = (value: number): Operand => ({ kind: 'imm', value });
const regOperand = (index: number): Operand => ({ kind: 'reg', index });
const ir = (mnemonic: string, operands: readonly Operand[]): AsmInstruction => ({
  mnemonic,
  channel: 0,
  operands,
});

/**
 * Собрать наш образ программы: раскладка (адреса, затем смещения) → понижение → байты.
 *
 * Это тот же путь, что в сквозном прогоне (`src/e2k/e2kRealRun.ts`), но без отчётов: нужны
 * только байты и адрес цели, чтобы сравнить их с ассемблером.
 */
export function programImage(
  instructions: readonly AsmInstruction[],
  encoder: Encoder,
  context: LoweringContext = {},
): ProgramImage {
  const layout = layoutOf(instructions);
  const resolved = secondPass(instructions, layout.addresses);
  const refusals = [
    ...layout.unplaced.map((item) => `#${item.index} ${item.carrier}: ${item.reason}`),
    ...resolved.refusals.map((item) => `#${item.index}: ${item.reason}`),
  ];
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
  const chunks: number[] = [];
  let offset = 0;
  instructions.forEach((instruction, index) => {
    const address = layout.addresses.get(index);
    if (address === undefined) return;
    if (address !== offset) throw new Error(`#${index}: раскладка ${address} разошлась с байтами ${offset}`);
    const displacement = displacementAt.get(index);
    const lowered = lowerCarrier(instruction, {
      ...context,
      ...(displacement === undefined ? {} : { displacement }),
    });
    if (!lowered.ok) throw new Error(`#${index} ${instruction.mnemonic}: ${lowered.reason}`);
    for (const command of lowered.instructions) {
      const encoded = encoder.encode(command);
      chunks.push(...encoded);
      offset += encoded.length;
    }
  });
  const jump = resolved.displacements[0];
  if (jump === undefined) throw new Error('в программе нет перехода — сравнивать нечего');
  return {
    bytes: Uint8Array.from(chunks),
    addresses: layout.addresses,
    targetAddress: jump.targetAddress,
    commandAddress: jump.commandAddress,
    disp: jump.disp,
    refusals,
  };
}

/** Ассемблерный текст одной понижённой команды (кроме перехода) — по таблице МЦСТ. */
export function commandText(command: AsmInstruction): string {
  const entry = REAL_OPCODES.find((item) => item.mnemonic === command.mnemonic);
  if (entry === undefined) throw new Error(`нет записи таблицы МЦСТ для «${command.mnemonic}»`);
  if (entry.operands.length !== command.operands.length) {
    throw new Error(`«${command.mnemonic}»: операндов ${command.operands.length}, форма несёт ${entry.operands.length}`);
  }
  const operands = command.operands.map((operand, index) => {
    if (operand.kind === 'pred') return `%pred${operand.index}`;
    // 64-битный литерал печатается формой `_f64` — так его собирает ассемблер МЦСТ
    // (`movtd,0 _f64 0x100000, %r8`), и именно эта форма сверяется в оракуле формы 0xdc.
    if (operand.kind === 'imm64') return `_f64 0x${operand.value.toString(16)}`;
    if (operand.kind === 'imm') return String(operand.value);
    return registerText(entry.argFormats[index]!, operand.index);
  });
  return `${command.mnemonic},${command.channel} ${operands.join(', ')}`;
}

/**
 * Ассемблерный текст программы: команды в порядке выдачи, метка — перед командой по адресу цели.
 *
 * У `disp` в тексте стоит **метка**, а не число: смещение обязан посчитать сам ассемблер — иначе
 * сравнение проверяло бы нашу арифметику против нашей же.
 */
export function programAsText(instructions: readonly AsmInstruction[], label: string): string {
  const layout = layoutOf(instructions);
  const resolved = secondPass(instructions, layout.addresses);
  const displacementAt = new Map(resolved.displacements.map((item) => [item.index, item.disp]));
  const targetAddress = resolved.displacements[0] === undefined ? undefined : resolved.displacements[0].targetAddress;
  if (targetAddress === undefined) throw new Error('в программе нет перехода — метку ставить некуда');
  const lines: string[] = [];
  instructions.forEach((instruction, index) => {
    const address = layout.addresses.get(index);
    if (address === undefined) return;
    // Метка — перед первой командой цели: адрес метки у ассемблера совпадёт с адресом цели.
    if (address === targetAddress) lines.push(`${label}:`);
    const displacement = displacementAt.get(index);
    const lowered = lowerCarrier(instruction, displacement === undefined ? {} : { displacement });
    if (!lowered.ok) throw new Error(`#${index} ${instruction.mnemonic}: ${lowered.reason}`);
    for (const command of lowered.instructions) {
      if (command.mnemonic === 'disp') {
        lines.push(`disp %ctpr${ctprOf(command)}, ${label}`);
      } else if (command.mnemonic === 'ct') {
        lines.push(`ct %ctpr${ctprOf(command)}`);
      } else {
        lines.push(commandText(command));
      }
    }
  });
  return lines.join('\n');
}

/** Номер `%ctpr` из команды перехода: первый операнд (число). */
function ctprOf(command: AsmInstruction): number | string {
  const operand = command.operands[0];
  return operand !== undefined && operand.kind === 'imm' ? operand.value : '?';
}

/** Описание программы-образца в терминах носителей IR: тело, позиция перехода, цель. */
interface JumpProgramSpec {
  readonly key: string;
  /** Тело: чем заполнять, кроме перехода. `A` — `adds` (8), `S` — `subs` (8), `M` — `movts` (8), `L` — `muls` (16). */
  readonly body: string;
  /** Позиция перехода в потоке. */
  readonly jumpAt: number;
  /** Индекс цели. */
  readonly targetIndex: number;
}

/** Тело программы по буквам: `A` adds, `S` subs, `M` movts, `L` muls (длинная форма). */
function bodyOf(body: string): AsmInstruction[] {
  return [...body].map((letter) => {
    if (letter === 'A') return ir('IR.add', [regOperand(1), regOperand(2), regOperand(3)]);
    if (letter === 'S') return ir('IR.sub', [regOperand(1), regOperand(2), regOperand(3)]);
    if (letter === 'M') return ir('IR.move', [regOperand(1), regOperand(2)]);
    if (letter === 'L') return ir('IR.mul', [regOperand(1), regOperand(2), regOperand(3)]);
    throw new Error(`неизвестная буква тела программы «${letter}»`);
  });
}

/** Программы-образцы: цель вперёд и назад, короткие и длинные команды на пути. */
const JUMP_PROGRAMS: readonly JumpProgramSpec[] = [
  { key: 'вперёд-через-одну', body: 'AMM', jumpAt: 1, targetIndex: 3 },
  { key: 'вперёд-через-две', body: 'AAMMA', jumpAt: 2, targetIndex: 5 },
  { key: 'вперёд-через-длинную', body: 'LAMM', jumpAt: 2, targetIndex: 4 },
  { key: 'назад-на-одну', body: 'AMM', jumpAt: 2, targetIndex: 1 },
  { key: 'назад-через-длинную', body: 'LAM', jumpAt: 2, targetIndex: 0 },
  { key: 'назад-через-три', body: 'AAAA', jumpAt: 4, targetIndex: 2 },
];

/**
 * Собрать образцы-программы: тело, переход на нужную позицию, метка и ассемблерный текст.
 *
 * Текст строится **из наших понижённых команд** (`programAsText`): расхождение нашего текста с
 * нашими байтами ассемблер поймает, а расхождение смещения — сравнение с его байтами.
 */
export function buildJumpPrograms(): AsProgramSample[] {
  return JUMP_PROGRAMS.map((spec) => {
    const instructions = bodyOf(spec.body);
    instructions.splice(spec.jumpAt, 0, ir('IR.jmp', [imm(spec.targetIndex)]));
    const label = `osnova_target_${spec.key.replace(/[^a-zа-я0-9]/gi, '_')}`;
    return {
      key: spec.key,
      label,
      asText: programAsText(instructions, label),
      instructions,
      targetIndex: spec.targetIndex,
      source: 'docs/e2k-real-run.md §2.3 (решение про пары), docs/e2k-syllables-real.md §5 (`disp`)',
    };
  });
}

/** Результат сборки одной программы: байты и адрес метки (если удалось его прочитать). */
export type ProgramResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly label?: number }
  | { readonly ok: false; readonly error: string };

/**
 * Сборочный скрипт для программ: `.text` целиком, затем байты и — если дизассемблер доступен —
 * адрес метки из таблицы символов (`objdump -t`).
 *
 * Два независимых свидетеля на одну программу: байты ассемблера (сравниваются с нашими) и адрес
 * метки, который ассемблер посчитал сам (сравнивается с адресом цели нашей раскладки).
 */
export function buildProgramScript(samples: readonly AsProgramSample[], tool: ExternalAs): string {
  const dir = scriptDirectory();
  const as = tool.inWsl ? WSL_AS : tool.path;
  const objcopy = tool.inWsl ? WSL_OBJCOPY : 'e2k-linux-objcopy';
  const lines: string[] = ['set -u', `D=${dir}`, 'rm -rf "$D"', 'mkdir -p "$D"'];
  lines.push('OBJDUMP=""');
  lines.push(`if [ -x ${WSL_OBJDUMP} ]; then OBJDUMP=${WSL_OBJDUMP}`);
  lines.push('elif command -v e2k-linux-objdump >/dev/null 2>&1; then OBJDUMP=e2k-linux-objdump; fi');
  samples.forEach((sample, index) => {
    lines.push(`cat > "$D/p${index}.s" <<'OSNOVA_EOF'`);
    lines.push('.text');
    lines.push(sample.asText);
    lines.push('OSNOVA_EOF');
  });
  samples.forEach((sample, index) => {
    lines.push(`if ${as} ${AS_CPU_OPTION} -o "$D/p${index}.o" "$D/p${index}.s" 2>"$D/p${index}.err"; then`);
    lines.push(`  ${objcopy} -O binary --only-section=.text "$D/p${index}.o" "$D/p${index}.bin" 2>>"$D/p${index}.err" \\`);
    lines.push(`    && { echo "== ${index}"; od -An -tx1 -v "$D/p${index}.bin"; } \\`);
    lines.push(`    || { echo "!! ${index}"; head -2 "$D/p${index}.err"; }`);
    // Адрес метки: строка вида `0000000000000020 l .text 0000... osnova_target_…`.
    lines.push('  if [ -n "$OBJDUMP" ]; then');
    lines.push(
      `    L=$($OBJDUMP -t "$D/p${index}.o" 2>/dev/null | grep -w ${sample.label} || true); ` +
        `[ -n "$L" ] && echo "@@ ${index} $L"`,
    );
    lines.push('  fi');
    lines.push('else');
    lines.push(`  echo "!! ${index}"; head -2 "$D/p${index}.err"`);
    lines.push('fi');
  });
  return `${lines.join('\n')}\n`;
}

/** Разобрать вывод сборочного скрипта: байты программы и адрес метки. */
export function parseProgramOutput(output: string, expected: number): ProgramResult[] {
  const bytes: AsResult[] = parseAssemblyOutput(output, expected);
  const labels = new Map<number, number>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\u0000/g, '').trim();
    const marker = /^@@\s*(\d+)\s+([0-9a-f]+)\b/i.exec(line);
    if (marker !== null) labels.set(Number.parseInt(marker[1]!, 10), Number.parseInt(marker[2]!, 16));
  }
  return bytes.map((result, index) => {
    if (!result.ok) return result;
    const label = labels.get(index);
    return label === undefined ? { ok: true, bytes: result.bytes } : { ok: true, bytes: result.bytes, label };
  });
}

/** Собрать программы ассемблером МЦСТ: один вызов на все образцы. */
export function assemblePrograms(samples: readonly AsProgramSample[]): ProgramResult[] {
  const { tool, reason } = findExternalAs();
  if (tool === undefined) throw new Error(reason!);
  const output = run(tool.scriptRunner.command, tool.scriptRunner.args, buildProgramScript(samples, tool)) ?? '';
  return parseProgramOutput(output, samples.length);
}

/** Формат отчёта о программах с переходом — НАШЕ РЕШЕНИЕ. */
export const PROGRAM_REPORT_FORMAT = 'osnova-e2k-external-as-programs';

/** Итог сверки одной программы. */
export interface ProgramComparison {
  readonly key: string;
  readonly asText: string;
  readonly ours: string;
  readonly theirs?: string;
  readonly status: 'совпал' | 'не совпал' | 'НЕ ПРОВЕРЕНО';
  readonly reason: string;
  /** Смещение, вычисленное нашей раскладкой. */
  readonly disp: number;
  /** Адрес цели по нашей раскладке. */
  readonly targetAddress: number;
  /** Адрес метки, прочитанный `objdump -t` у ассемблера. */
  readonly labelAddress?: number;
}

/** Отчёт о сверке программ с переходом. */
export interface ProgramReport {
  readonly format: string;
  readonly version: number;
  readonly tool: ExternalAs | null;
  readonly unavailableReason?: string;
  readonly comparisons: readonly ProgramComparison[];
  readonly summary: {
    readonly total: number;
    readonly matched: number;
    readonly mismatched: number;
    readonly unverified: number;
    readonly labelsMatched: number;
  };
}

/** Прогнать сверку программ с переходом через ассемблер МЦСТ. */
export function runExternalAsPrograms(): ProgramReport {
  const encoder = getEncoder('e2k');
  const samples = buildJumpPrograms();
  const { tool, reason } = findExternalAs();
  const empty = {
    format: PROGRAM_REPORT_FORMAT,
    version: 1,
    tool: null,
    unavailableReason: reason ?? 'ассемблер не найден',
  };
  if (tool === undefined) {
    return {
      ...empty,
      comparisons: samples.map((sample) => {
        const image = programImage(sample.instructions, encoder);
        return {
          key: sample.key,
          asText: sample.asText,
          ours: toHex(image.bytes),
          status: 'НЕ ПРОВЕРЕНО' as const,
          reason: reason!,
          disp: image.disp,
          targetAddress: image.targetAddress,
        };
      }),
      summary: { total: samples.length, matched: 0, mismatched: 0, unverified: samples.length, labelsMatched: 0 },
    };
  }
  const results = assemblePrograms(samples);
  const comparisons: ProgramComparison[] = samples.map((sample, index) => {
    const image = programImage(sample.instructions, encoder);
    const ours = toHex(image.bytes);
    const result = results[index]!;
    const base = { key: sample.key, asText: sample.asText, ours, disp: image.disp, targetAddress: image.targetAddress };
    if (!result.ok) {
      return { ...base, status: 'НЕ ПРОВЕРЕНО' as const, reason: result.error === '' ? 'ассемблер отверг программу' : result.error };
    }
    const diff = firstDifference(image.bytes, result.bytes);
    const problems: string[] = [];
    if (diff !== undefined) problems.push(`байт ${diff.index}: у нас 0x${diff.ours.toString(16)}, у ассемблера 0x${diff.theirs.toString(16)}`);
    if (image.bytes.length !== result.bytes.length) problems.push(`длины: у нас ${image.bytes.length}, у ассемблера ${result.bytes.length}`);
    // Второй свидетель: адрес метки, который ассемблер посчитал сам.
    if (result.label !== undefined && result.label !== image.targetAddress) {
      problems.push(`адрес метки у ассемблера 0x${result.label.toString(16)}, у нашей раскладки 0x${image.targetAddress.toString(16)}`);
    }
    return {
      ...base,
      ...(result.label === undefined ? {} : { labelAddress: result.label }),
      theirs: toHex(result.bytes),
      status: problems.length === 0 ? ('совпал' as const) : ('не совпал' as const),
      reason:
        problems.length === 0
          ? `байт ${result.bytes.length} совпали${result.label === undefined ? ' (адрес метки не прочитан)' : `, цель 0x${result.label.toString(16)}`}`
          : problems.join('; '),
    };
  });
  return {
    format: PROGRAM_REPORT_FORMAT,
    version: 1,
    tool,
    comparisons,
    summary: {
      total: comparisons.length,
      matched: comparisons.filter((item) => item.status === 'совпал').length,
      mismatched: comparisons.filter((item) => item.status === 'не совпал').length,
      unverified: comparisons.filter((item) => item.status === 'НЕ ПРОВЕРЕНО').length,
      labelsMatched: comparisons.filter(
        (item) => item.labelAddress !== undefined && item.labelAddress === item.targetAddress,
      ).length,
    },
  };
}

function main(): void {
  const report = runExternalAs();
  fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  console.log(report.tool === null ? `инструмент не найден: ${report.unavailableReason}` : `инструмент: ${report.tool.version}`);
  for (const item of report.comparisons) {
    const mark = item.status === 'совпал' ? 'OK  ' : item.status === 'не совпал' ? 'РАСХ' : 'НЕТ ';
    console.log(`${mark} ${item.key.padEnd(12)} ${item.asText}`);
    if (item.status !== 'совпал') {
      console.log(`     наши: ${item.ours}`);
      if (item.theirs !== undefined) console.log(`     as:   ${item.theirs}`);
      console.log(`     ${item.reason}`);
    }
  }
  console.log(
    `итого: ${report.summary.total}; совпало ${report.summary.matched}; расхождений ${report.summary.mismatched}; не проверено ${report.summary.unverified}`,
  );
  console.log(`отчёт: ${path.relative(ROOT, REPORT_FILE)}`);

  // Программы с переходом — отдельный отчёт: там сравниваются не инструкции, а адреса целей.
  const programs = runExternalAsPrograms();
  fs.mkdirSync(path.dirname(PROGRAM_REPORT_FILE), { recursive: true });
  fs.writeFileSync(PROGRAM_REPORT_FILE, `${JSON.stringify(programs, null, 2)}\n`, 'utf-8');
  console.log('');
  console.log(`программы с переходом: инструмент ${programs.tool === null ? 'не найден' : programs.tool.version}`);
  for (const item of programs.comparisons) {
    const mark = item.status === 'совпал' ? 'OK  ' : item.status === 'не совпал' ? 'РАСХ' : 'НЕТ ';
    const label = item.labelAddress === undefined ? 'метка не прочитана' : `метка 0x${item.labelAddress.toString(16)}`;
    console.log(`${mark} ${item.key.padEnd(22)} смещение ${String(item.disp).padStart(3)}  цель 0x${item.targetAddress.toString(16)}  ${label}`);
    if (item.status !== 'совпал') {
      console.log(`     наши: ${item.ours}`);
      if (item.theirs !== undefined) console.log(`     as:   ${item.theirs}`);
      console.log(`     ${item.reason}`);
    }
  }
  console.log(
    `итого: ${programs.summary.total}; совпало ${programs.summary.matched}; расхождений ${programs.summary.mismatched}; ` +
      `не проверено ${programs.summary.unverified}; адресов меток совпало ${programs.summary.labelsMatched}`,
  );
  console.log(`отчёт: ${path.relative(ROOT, PROGRAM_REPORT_FILE)}`);
}

if (require.main === module) {
  main();
}
