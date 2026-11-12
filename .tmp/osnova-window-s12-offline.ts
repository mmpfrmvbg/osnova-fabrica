/**
 * ЦЕНА И ВЫИГРЫШ ОКНА `size_q = 12` — БЕЗ МОДЕЛИ (task-11, шаг 2).
 *
 * Здесь НЕ пересобирается порт и НЕ трогается `src/**`: проба берёт то же, что берёт конвейер
 * (`runKernelThroughRealEncoding`), и отвечает на два вопроса числом:
 *
 * 1. **Выигрыш.** Сколько регистров окна нужно каждой вызываемой процедуре пяти ядер и влезает ли
 *    она в окно 8 (паспорт) против 16 (`size_q = 12`, формула `2*(S − wbs)` из §3.36).
 *    Вопрос «влезает ли» решает ОДНА константа — `WINDOW_REGISTERS_CALLEE` (`regAlloc.ts:98`),
 *    её читает `fitsCalleeWindow` (`regAlloc.ts:492`); пул раскладки (`ALLOCATABLE_REGISTERS`)
 *    ею не ограничен вовсе, поэтому здесь же видно, что расширение окна не даёт раскладке
 *    ни одного нового регистра — только снимает отказ «вызвать нельзя».
 * 2. **Цена на числах.** Все закреплённые числа раскладки и эмиттера печатаются КАК ЕСТЬ:
 *    если константа в них входит, они сдвинутся здесь, до всякой модели.
 *
 * Третий блок — негативный контроль ОРАКУЛА КЛАССА (шаг 4) в чистом виде: три расхождения
 * (константа, паспорт, живая модель) обязаны быть НАЗВАНЫ, а согласие — дать пустой список.
 *
 * Запуск: `npx tsx .tmp/osnova-window-s12-offline.ts`
 */
import * as fs from 'fs';
import * as path from 'path';
import { getEncoder } from '../src/e2k/backend';
import { emitShell } from '../src/e2k/emitterShell';
import { annotateAtomRegions, verifyAtomRegions } from '../src/compiler/atomRegions';
import { regModuleOf } from '../src/vliw/regOracle';
import { runKernelThroughRealEncoding, type KernelRealReport } from '../src/e2k/e2kRealRun';
import { ALLOCATABLE_REGISTERS, WINDOW_REGISTERS_CALLEE, WINDOW_REGISTERS_ENTRY } from '../src/e2k/regAlloc';
import { ARRAY_WINDOW_RSZ } from '../src/e2k/arrayRuntime';
import { SYSCALL_WBS } from '../src/e2k/elfMinimal';
import { QEMU_MODEL } from '../src/e2k/qemuModelPassport';

const ROOT = path.resolve(__dirname, '..');
const KERNELS = [
  { name: 'fir', atom: 'A5', algorithm: 'FIR-фильтр' },
  { name: 'iir', atom: 'A5', algorithm: 'IIR-фильтр' },
  { name: 'fft', atom: 'A5', algorithm: 'БПФ radix-2' },
  { name: 'convolution', atom: 'A6', algorithm: 'свёртка' },
  { name: 'correlation', atom: 'A6', algorithm: 'корреляция' },
];
const shellEncoder = getEncoder('internal-shell');
const realEncoder = getEncoder('e2k');

function kernelImage(name: string, atom: string) {
  const source = fs.readFileSync(path.join(ROOT, 'tests', 'dsp', 'kernels', `${name}.osnova`), 'utf-8');
  const built = regModuleOf(source);
  if (!built) throw new Error(`ядро не компилируется: ${name}`);
  const annotated = annotateAtomRegions(built.module, [
    { atom, procedures: built.module.procedures.map((procedure) => procedure.name) },
  ]);
  const problems = verifyAtomRegions(annotated);
  if (problems.length > 0) throw new Error(`${name}: ${problems.join('; ')}`);
  return emitShell(annotated, shellEncoder);
}

const reports = new Map<string, KernelRealReport>(
  KERNELS.map(({ name, atom }) => [
    name,
    runKernelThroughRealEncoding(kernelImage(name, atom), realEncoder, { kernel: name, atom }),
  ]),
);

/** Геометрия из паспорта: вызываемая — `2*(S − wbs)`, вызывающий — `2*S` (§3.36). */
const S = 8; // паспортная геометрия: qemu/linux-user/e2k/cpu_loop.c, `size_q`
const calleeFormula = 2 * (S - SYSCALL_WBS);
const callerFormula = 2 * S;
const entryFromPrologue = 2 * (ARRAY_WINDOW_RSZ + 1);

console.log('=== ГЕОМЕТРИЯ (паспортная, S = 8) ===');
console.log(`size_q=${S} psize_q=${SYSCALL_WBS} wbs=${SYSCALL_WBS}`);
console.log(`вызываемая по формуле 2*(S-wbs) = ${calleeFormula}; константа WINDOW_REGISTERS_CALLEE = ${WINDOW_REGISTERS_CALLEE}`);
console.log(`вызывающий по формуле 2*S = ${callerFormula}; константа WINDOW_REGISTERS_ENTRY = ${WINDOW_REGISTERS_ENTRY}`);
console.log(`окно входа по прологу 2*(ARRAY_WINDOW_RSZ+1) = ${entryFromPrologue} (rsz=${ARRAY_WINDOW_RSZ})`);
console.log(`пул раскладки ALLOCATABLE_REGISTERS = ${ALLOCATABLE_REGISTERS.length} регистров (%b[0..9]); окном НЕ ограничен`);
console.log(`паспорт: version=${QEMU_MODEL.version} sha256=${QEMU_MODEL.sha256.slice(0, 12)}…`);

console.log('\n=== ВЫИГРЫШ: окно вызываемой, 8 против 16 ===');
console.log('ядро/процедура          нужно  влезает@8  влезает@16');
let fitsNew = 0;
let fitsNow = 0;
const called = new Set<string>();
for (const { name } of KERNELS) {
  for (const item of reports.get(name)!.calleeWindow) {
    called.add(`${name}/${item.procedure}`);
    const at8 = item.needed <= 8;
    const at16 = item.needed <= 16;
    if (at8) fitsNow += 1;
    if (at16) fitsNew += 1;
    console.log(
      `${`${name}/${item.procedure}`.padEnd(24)}${String(item.needed).padStart(4)}  ${(at8 ? 'да' : 'НЕТ').padStart(8)}  ${(at16 ? 'да' : 'НЕТ').padStart(9)}`,
    );
  }
}
console.log(`ИТОГ: вызываемых процедур ${called.size}; влезает при 8 — ${fitsNow}; при 16 — ${fitsNew}`);

console.log('\n=== ЦЕНА НА ЧИСЛАХ: закреплённое как есть ===');
let tInstructions = 0;
let tEliminated = 0;
for (const { name } of KERNELS) {
  const report = reports.get(name)!;
  tInstructions += report.instructions;
  tEliminated += report.eliminated;
  const alloc = report.allocation.map((item) => `${item.procedure}:ok=${item.ok},used=${item.used},pins=${item.incoming.length}`).join(' ');
  console.log(
    `${name.padEnd(12)} носителей=${String(report.instructions).padStart(3)} снято=${String(report.removedCopies).padStart(2)} ` +
      `понижено=${String(report.encoded).padStart(3)} отказов=${report.refused} байт=${report.bytes} ` +
      `пакетов=${report.layout.placed} totalBytes=${report.layout.totalBytes}`,
  );
  console.log(`             раскладка: ${alloc}`);
}
console.log(`СУММА: носителей=${tInstructions} снято=${tEliminated} сумма=${tInstructions + tEliminated} (закреплено 458/53/511)`);

const fir = reports.get('fir')!;
const filter = fir.calleeWindow.find((item) => item.procedure === 'фильтр')!;
console.log(`fir: носителей=${fir.instructions} снято=${fir.removedCopies} понижено=${fir.encoded} отказов=${fir.refused} байт=${fir.bytes}`);
console.log(`fir/фильтр: нужно=${filter.needed} доступно сейчас=${filter.available} влезает сейчас=${filter.ok}`);

console.log('\n=== НЕГАТИВНЫЙ КОНТРОЛЬ ОРАКУЛА КЛАССА (чистая часть, без модели) ===');
/**
 * Ровно та функция, чей готовый текст идёт в `src/e2k/windowGeometry.ts` (§3.44.4):
 * три числа обязаны сойтись — паспорт, константы раскладки и ИЗМЕРЕНИЕ на живой модели.
 */
function windowGeometryProblems(
  passport: { sizeQ: number; wbs: number; entry: number },
  constants: { callee: number; entry: number },
  measured: { callee: number; caller: number },
): string[] {
  const problems: string[] = [];
  const callee = 2 * (passport.sizeQ - passport.wbs);
  if (constants.callee !== callee) {
    problems.push(`константа окна вызываемой ${constants.callee}, а паспортная геометрия (size_q=${passport.sizeQ}, wbs=${passport.wbs}) даёт ${callee}`);
  }
  if (constants.entry !== passport.entry) {
    problems.push(`константа окна входа ${constants.entry}, а пролог образа (` + `rsz) даёт ${passport.entry}`);
  }
  if (measured.callee !== constants.callee) {
    problems.push(`живая модель даёт вызываемой ${measured.callee}, а константа раскладки говорит ${constants.callee}`);
  }
  if (measured.caller < constants.entry) {
    problems.push(`живая модель даёт вызывающему ${measured.caller}, а константа входа требует ${constants.entry}`);
  }
  return problems;
}

const passportNow = { sizeQ: S, wbs: SYSCALL_WBS, entry: entryFromPrologue };
const constantsNow = { callee: WINDOW_REGISTERS_CALLEE, entry: WINDOW_REGISTERS_ENTRY };
console.log(`1 согласие (паспорт 8):      ${JSON.stringify(windowGeometryProblems(passportNow, constantsNow, { callee: 8, caller: 16 }))}`);
console.log(`2 константа ушла (8→16):     ${JSON.stringify(windowGeometryProblems(passportNow, { callee: 16, entry: 16 }, { callee: 8, caller: 16 }))}`);
console.log(`3 модель ушла (S=12, к. 8):  ${JSON.stringify(windowGeometryProblems(passportNow, constantsNow, { callee: 16, caller: 24 }))}`);
console.log(`4 паспорт ушёл (S=12, к. 8): ${JSON.stringify(windowGeometryProblems({ sizeQ: 12, wbs: 4, entry: 16 }, constantsNow, { callee: 16, caller: 24 }))}`);
console.log(`5 согласие на новой модели:  ${JSON.stringify(windowGeometryProblems({ sizeQ: 12, wbs: 4, entry: 16 }, { callee: 16, entry: 16 }, { callee: 16, caller: 24 }))}`);
