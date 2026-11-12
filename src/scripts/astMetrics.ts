/**
 * AST=ЭТАЛОН НА МОДЕЛИ — ЧИСЛО ДЛЯ ЛОГА ШЛЮЗА QEMU.
 *
 * # Что это число значит
 *
 * Шаг протокола P4c-fix проверяется оракулом `src/e2k/parserProtocolP4c.test.ts`: эталонная лента
 * из **85** клеток считается независимо (`эталоннаяЛента` = `parseV01` + `лентаИзAst`), затем
 * программа понижается, собирается в ELF и исполняется в `qemu-e2k`, а её stdout сверяется с лентой
 * **клетка в клетку**. Тест говорит PASS/FAIL; задание конвейера должно называть ЧИСЛО —
 * сколько клеток совпало из скольких и сколько прогонов модели было плохих.
 *
 * `AST=etalon 85/85 QEMU=0` читается так: 85 клеток эталона, 85 совпало, 0 плохих прогонов модели.
 * Расхождение печатается с ДВУМЯ числами (эталон и факт) и делает задание красным — молчаливого
 * «тест прошёл» здесь нет.
 *
 * Код возврата: 0 — совпало всё; 1 — расхождение; 3 — модели нет (число не выдумывается).
 *
 * Запуск: `npm run metrics:ast`.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseV3 } from '../compiler-v3/index';
import {
  ИСХОДНИК_P4B_ПУСТЬ,
  ФАЙЛ_P4C,
  программаПротоколаP4cПоОстатку,
  эталоннаяЛента,
} from '../compiler-v3/parser-protocol-probe';
import { buildElfFromCode, MINIMAL_BASE, WRITE_ZONE_EXTRA_MEMORY } from '../e2k/elfMinimal';
import { loweredProgram } from '../e2k/lowered';
import { runInQemu } from './e2kQemuExec';

const ROOT = path.resolve(__dirname, '..', '..');
const WORK = path.join(ROOT, '.tmp', 'ast-metrics');

const WSL = 'C:\\Program Files\\WSL\\wsl.exe';
const WSL_QEMU = '/root/qemu-build/qemu-e2k';

function модельЕсть(): boolean {
  try {
    execFileSync(WSL, ['-d', 'e2k', '--', 'test', '-x', WSL_QEMU], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** Числа из stdout гостя: по строке на клетку, пустые строки пропускаются. */
function лентаИзStdout(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .filter((строка) => строка.trim() !== '')
    .map((строка) => Number(строка.trim()));
}

async function main(): Promise<number> {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  const эталон = эталоннаяЛента(ИСХОДНИК_P4B_ПУСТЬ, ФАЙЛ_P4C);
  console.log(`эталон AST: ${эталон.length} клеток`);

  const источник = программаПротоколаP4cПоОстатку();
  const разбор = parseV3(источник, ФАЙЛ_P4C);
  if (разбор.errors.length > 0) throw new Error(`разбор P4c не чист: ${разбор.errors.join(' | ')}`);
  const итог = loweredProgram(источник, {
    filename: ФАЙЛ_P4C,
    parse: () => ({ ast: разбор.program ?? null, errors: разбор.errors }),
  });
  if (!итог.ок) {
    throw new Error(`отказ понижения P4c: ${итог.отказ.отказы.map((запись) => запись.причина).join(' | ')}`);
  }

  if (!модельЕсть()) {
    console.log(`МОДЕЛИ НЕТ: ${WSL_QEMU} в WSL e2k недоступна — AST=эталон не спрошен.`);
    console.log('METRICS ast=refused reason=no-model');
    fs.rmSync(WORK, { recursive: true, force: true });
    return 3;
  }

  const elf = path.join(WORK, 'p4c-fix-model.elf');
  fs.writeFileSync(
    elf,
    buildElfFromCode(итог.значение.bytes, MINIMAL_BASE, {
      writable: true,
      extraMemory: WRITE_ZONE_EXTRA_MEMORY,
    }).bytes,
  );

  // ДВА прогона — как в оракуле: одно число могло совпасть случайно, повтор ловит это.
  const прогоны: number[] = [];
  let совпалоЛучше = 0;
  let первоеРасхождение: string | undefined;
  let плохихПрогонов = 0;
  for (const номер of [1, 2]) {
    const запуск = runInQemu(elf, { shim: true, timeoutMs: 60_000 });
    if (запуск === undefined || запуск.status !== 0) {
      плохихПрогонов++;
      console.log(`прогон ${номер}: модель не дала код 0 (status=${запуск?.status ?? 'нет ответа'})`);
      continue;
    }
    const получено = лентаИзStdout(запуск.stdout);
    прогоны.push(получено.length);
    let совпало = 0;
    for (let at = 0; at < эталон.length; at++) {
      if (получено[at] === эталон[at]) совпало++;
      else if (первоеРасхождение === undefined) {
        первоеРасхождение = `позиция ${at + 1}: эталон=${эталон[at]} факт=${получено[at] ?? 'нет'}`;
      }
    }
    if (получено.length !== эталон.length && первоеРасхождение === undefined) {
      первоеРасхождение = `длина: эталон=${эталон.length} факт=${получено.length}`;
    }
    совпалоЛучше = Math.max(совпалоЛучше, совпало);
    console.log(`прогон ${номер}: клеток=${получено.length} совпало=${совпало}/${эталон.length}`);
  }
  fs.rmSync(WORK, { recursive: true, force: true });

  if (плохихПрогонов > 0 || совпалоЛучше !== эталон.length) {
    console.log(`РАСХОЖДЕНИЕ С ЭТАЛОНОМ: ${первоеРасхождение ?? 'прогон модели не состоялся'}`);
    console.log(
      `METRICS ast=refused reason=ast-mismatch AST=etalon ${совпалоЛучше}/${эталон.length} QEMU=${плохихПрогонов} ` +
        `первое=${первоеРасхождение ?? 'нет'}`,
    );
    return 1;
  }

  console.log(`METRICS ast: AST=etalon ${совпалоЛучше}/${эталон.length} QEMU=${плохихПрогонов}`);
  return 0;
}

void main().then(
  (код) => process.exit(код),
  (ошибка: unknown) => {
    console.error('metrics:ast: непредвиденная ошибка:', ошибка);
    console.log('METRICS ast=refused reason=metrics-error');
    process.exit(1);
  },
);
