/**
 * ЧИСЛА СМЫСЛОВОГО СЛОЯ `gate` — ДЛЯ ЛОГА КОНВЕЙЕРА GITFLIC.
 *
 * # Зачем отдельный скрипт
 *
 * Задание `gate` раньше печатало только PASS/FAIL: «все шаги прошли» не говорит, ЧТО именно
 * измерено. Владелец требует в логе числа — `FIR-ядро 268, пять ядер 979, пакеты 220,
 * срез 3/11/2/0` — и требует, чтобы расхождение было КРАСНЫМ с ДВУМЯ числами (эталон и факт),
 * а не молчаливым SUCCESS.
 *
 * Числа НЕ литералы: каждое берётся из реального прогона.
 * - `FIR-ядро`, `пять ядер`, `пакеты` — из понижения пяти DSP-ядер тем же путём, что у компилятора
 *   (`src/e2k/kernelStream.ts`, вынесен из оракула `src/e2k/e2kWideFir.test.ts`);
 * - `срез` — четыре программы владельца проходят `parseV3 → loweredProgram → ELF → QEMU-e2k`
 *   и спрашиваются у МОДЕЛИ (3/11/2/0); без модели число не выдумывается, а отказ НАЗЫВАЕТСЯ.
 *
 * Код возврата: 0 — все числа совпали с эталоном; 1 — расхождение (оба числа в логе);
 * 3 — модели нет, число среза не получено.
 *
 * Запуск: `npm run gate:metrics`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseV3 } from '../compiler-v3/index';
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from '../e2k/elfMinimal';
import { KERNELS, kernelStreamOf } from '../e2k/kernelStream';
import { loweredProgram } from '../e2k/lowered';
import { wideStats } from '../e2k/widePacker';
import { runInQemu } from './e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const WORK = path.join(ROOT, '.tmp', 'gate-metrics');

/** Дистрибутив WSL и модель — те же, что у `src/scripts/e2kQemuExec.ts`. */
const WSL = 'C:\\Program Files\\WSL\\wsl.exe';
const WSL_QEMU = '/root/qemu-build/qemu-e2k';

/**
 * ЭТАЛОН ЧИСЕЛ. Каждое живёт в закреплённой проверке:
 * - 268 и 220 — `src/e2k/e2kWideFir.test.ts`;
 * - 979 — сумма команд пяти ядер, `src/e2k/literalBarriers.test.ts`;
 * - 3/11/2/0 — четыре программы владельца, `src/e2k/stringSliceRuntime.test.ts` (ШАГ 6).
 */
const ЭТАЛОН = {
  firCommands: 268,
  kernelsCommands: 979,
  firPackets: 220,
  slice: [3, 11, 2, 0] as const,
};

/** Программа владельца: края — переменные, известные сборке (СТАТИЧЕСКИЙ путь, арена не нужна). */
function программаВладельца(источник: string, н: string, к: string): string {
  return [
    'действие главная()',
    `  пусть с = "${источник}"`,
    `  пусть н = ${н}`,
    `  пусть к = ${к}`,
    '  вернуть длина подстрока(с, н, к)',
    'конец главная',
  ].join('\n');
}

/** Четыре программы владельца — те же, что в оракуле шага 6, с эталоном 3/11/2/0. */
const СРЕЗ = [
  { имя: 'N3', текст: программаВладельца('абвгде', '1', '4'), эталон: 3 },
  { имя: 'N11', текст: программаВладельца('абвгдеёжзийкл', '1', '12'), эталон: 11 },
  { имя: 'N2', текст: программаВладельца('абвгде', '-2', '6'), эталон: 2 },
  { имя: 'N0', текст: программаВладельца('абвгде', '3', '1'), эталон: 0 },
] as const;

/** Есть ли модель: проверяем ДО прогона, чтобы «нет модели» не выглядело как расхождение. */
function модельЕсть(): boolean {
  try {
    execFileSync(WSL, ['-d', 'e2k', '--', 'test', '-x', WSL_QEMU], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Понизить программу, собрать ELF и спросить код возврата у модели. */
function прогонНаМодели(текст: string, файл: string): number {
  const имяМодуля = 'gate-метрика.osnova';
  const разбор = parseV3(текст, имяМодуля);
  if (разбор.errors.length > 0) throw new Error(`разбор не чист: ${разбор.errors.join(' | ')}`);
  const итог = loweredProgram(текст, {
    filename: имяМодуля,
    parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
  });
  if (!итог.ок) throw new Error(`отказ понижения: ${итог.отказ.отказы.map((запись) => запись.причина).join(' | ')}`);
  const elf = path.join(WORK, файл);
  fs.writeFileSync(
    elf,
    buildElfFromCode(итог.значение.bytes, MINIMAL_BASE, {
      writable: true,
      extraMemory: WRITE_ZONE_EXTRA_MEMORY,
    }).bytes,
  );
  const запуск = runInQemu(elf, { shim: true, timeoutMs: 60_000 });
  if (запуск === undefined || запуск.status === null) throw new Error(`модель не ответила на ${файл}`);
  return запуск.status;
}

async function main(): Promise<number> {
  // Артефакты прошлого прогона НЕ переиспользуются: образ другой ревизии под тем же именем —
  // измеренная ловушка (A4-5г, задача 2), поэтому каталог чистится ДО сборки.
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // ── Числа ПОНИЖЕНИЯ: берутся из настоящего пути, а не из литерала ──────────────────────────────
  const ядра = KERNELS.map(({ name, atom }) => {
    const поток = kernelStreamOf(name, atom);
    const статистика = wideStats(поток.commands);
    return { имя: name, команд: поток.commands.length, пакетов: статистика.packets, отказов: поток.refusedTotal };
  });
  for (const ядро of ядра) {
    console.log(`ядро ${ядро.имя}: команд=${ядро.команд} пакетов=${ядро.пакетов} отказов=${ядро.отказов}`);
  }
  const fir = ядра.find((ядро) => ядро.имя === 'fir');
  if (fir === undefined) throw new Error('в KERNELS нет ядра fir — эталон 268/220 не к чему привязать');
  const командПять = ядра.reduce((сумма, ядро) => сумма + ядро.команд, 0);

  // ── Числа СРЕЗА: спрашиваются у модели ────────────────────────────────────────────────────────
  if (!модельЕсть()) {
    console.log(`МОДЕЛИ НЕТ: ${WSL_QEMU} в WSL e2k недоступна — число среза не спрошено.`);
    console.log(
      `METRICS gate: FIR-ядро=${fir.команд} пять ядер=${командПять} пакеты=${fir.пакетов} ` +
        'срез=refused reason=no-model',
    );
    fs.rmSync(WORK, { recursive: true, force: true });
    return 3;
  }
  const срез = СРЕЗ.map((случай) => {
    const код = прогонНаМодели(случай.текст, `срез-${случай.имя}.elf`);
    console.log(`срез ${случай.имя}: код=${код} эталон=${случай.эталон}`);
    return код;
  });
  fs.rmSync(WORK, { recursive: true, force: true });

  // ── СВЕРКА С ЭТАЛОНОМ: расхождение — красное и с ДВУМЯ числами ────────────────────────────────
  const расхождения: string[] = [];
  if (fir.команд !== ЭТАЛОН.firCommands) расхождения.push(`FIR-ядро=${fir.команд} эталон=${ЭТАЛОН.firCommands}`);
  if (командПять !== ЭТАЛОН.kernelsCommands) расхождения.push(`пять ядер=${командПять} эталон=${ЭТАЛОН.kernelsCommands}`);
  if (fir.пакетов !== ЭТАЛОН.firPackets) расхождения.push(`пакеты=${fir.пакетов} эталон=${ЭТАЛОН.firPackets}`);
  for (let at = 0; at < ЭТАЛОН.slice.length; at++) {
    if (срез[at] !== ЭТАЛОН.slice[at]) {
      расхождения.push(`срез[${at}]=${срез[at] ?? '?'} эталон=${ЭТАЛОН.slice[at]}`);
    }
  }

  if (расхождения.length > 0) {
    console.log(`РАСХОЖДЕНИЕ С ЭТАЛОНОМ: ${расхождения.join('; ')}`);
    console.log(
      `METRICS gate=refused reason=metrics-mismatch FIR-ядро=${fir.команд} пять ядер=${командПять} ` +
        `пакеты=${fir.пакетов} срез=${срез.join('/')} ${расхождения.join(' ')}`,
    );
    return 1;
  }

  console.log(
    `METRICS gate: FIR-ядро=${fir.команд} пять ядер=${командПять} пакеты=${fir.пакетов} ` +
      `срез=${срез.join('/')}`,
  );
  return 0;
}

void main().then(
  (код) => process.exit(код),
  (ошибка: unknown) => {
    console.error('gate:metrics: непредвиденная ошибка:', ошибка);
    console.log('METRICS gate=refused reason=metrics-error');
    process.exit(1);
  },
);
