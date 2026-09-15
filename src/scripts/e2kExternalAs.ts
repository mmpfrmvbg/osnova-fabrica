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
import { getEncoder, toHex, type AsmInstruction, type Operand } from '../e2k/backend';
import { REAL_OPCODES, type RealOpcodeEntry } from '../e2k/e2k-real';

const ROOT = path.resolve(__dirname, '..', '..');
const REPORT_FILE = path.join(ROOT, '.tmp', 'e2k-external-as.json');
const WSL = 'C:\\Program Files\\WSL\\wsl.exe';
const WSL_AS = '/root/build-gas/gas/as-new';
const WSL_OBJCOPY = '/root/build/binutils/objcopy';

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

/** Префикс регистра по формату операнда: `S` → `%b`, `D` → `%db` (см. `opcodes/e2k-dis.c:417,454`). */
export function registerText(format: string, index: number): string {
  if (format === 'S') return `%b[${index}]`;
  if (format === 'D') return `%db[${index}]`;
  throw new Error(`неизвестный формат регистра «${format}» — в таблице только S и D`);
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
    operands: entry.operands.map((_, index) => reg(index + 1)),
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
    lines.push(`    && { echo "== ${index}"; od -An -tx1 "$D/s${index}.bin"; } \\`);
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
  let buffer: number[] = [];
  const flush = (): void => {
    if (current < 0) return;
    if (failed) {
      // Отказ ассемблера сохраняется как отказ: пустой поток байтов — это не «совпало».
      const previous = results[current]!;
      const error = previous.ok ? 'ассемблер не выдал байтов' : previous.error;
      results[current] = { ok: false, error: error === '' ? 'ассемблер не выдал байтов' : error };
    } else if (buffer.length === 0) {
      results[current] = { ok: false, error: 'ассемблер выдал пустой .text' };
    } else {
      results[current] = { ok: true, bytes: Uint8Array.from(buffer) };
    }
    buffer = [];
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
      results[current] = { ok: false, error: '' };
      continue;
    }
    if (current < 0) continue;
    if (/^[0-9a-f]{2}(\s+[0-9a-f]{2})*$/.test(line)) {
      buffer.push(...line.split(/\s+/).map((byte) => Number.parseInt(byte, 16)));
      continue;
    }
    if (failed && (line.startsWith('Error') || line.includes('Error:'))) {
      const previous = results[current]!;
      if (!previous.ok && previous.error === '') results[current] = { ok: false, error: line };
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
}

if (require.main === module) {
  main();
}
