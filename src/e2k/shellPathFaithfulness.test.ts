/**
 * ОРАКУЛ ВЕРНОСТИ ПУТИ ОБОЛОЧКИ: примеры корпуса, исполняемые на цели, обязаны совпадать
 * с регистровой VM **уже на пути оболочки** — до реальной кодировки и до модели.
 *
 * # Зачем он появился
 *
 * Пример `17-ранжирование-выбором` даёт на VM **23**, а на модели e2k — **4** при полном
 * понижении (отказов 0): программа собирается, исполняется и выдаёт неверное число. Это худший
 * класс — не отказ, а тихая ложь. Первый вопрос при таком расхождении: где именно врёт?
 *
 * Замер (`.tmp/probe-17.ts`, 2026-09-25):
 *
 * | слой | пример 17 | контроль 16 |
 * |---|---|---|
 * | регистровая VM | **23** | 60 |
 * | путь оболочки (эмиттер + симулятор оболочки) | **23** | 60 |
 * | реальная кодировка: носителей / отвергнуто / круговой разбор | 54 / 0 / 54 из 108, расхождений 0 | 46 / 0 / 46 из 135, расхождений 0 |
 *
 * То есть **наши** слои — выбор инструкций, раскладка регистров, планирование, понижение и
 * кодировка с обратным разбором — на этом примере согласованы. Расхождение живёт **ниже**:
 * между тем, что мы закодировали, и тем, как это понимает модель. Поэтому этот оракул держит
 * нижнюю границу («путь оболочки верен»), а поиск причины — в реальной кодировке и модели.
 *
 * Пока оракул зелёный, любую правку раскладки/планировщика, которая сломает эту границу,
 * видно сразу и без QEMU.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { regModuleOf } from '../vliw/regOracle';
import { annotateAtomRegions } from '../compiler/atomRegions';
import { emitShell } from './emitterShell';
import { getEncoder } from './backend';
import { simulateShellImage } from './simulatorShell';
import { RegVM } from '../runtime/vm/reginterpreter';
import { createDefaultInvokeHandler } from '../runtime/vm/interpreter';
import { resolveEntryIndex } from '../oracle/parity';

const ROOT = path.resolve(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');

const shellEncoder = getEncoder('internal-shell');

/** Примеры с результатом-возвратом: у них значение сверяемо и без печати. */
const CASES = [
  '01-свёртка-fir',
  '11-минимум-массива',
  '12-скалярное-произведение',
  '13-сумма-квадратов',
  '15-проверка-отсортированности',
  '16-накопление-по-двум-массивам',
  '17-ранжирование-выбором',
];

async function vmValue(source: string): Promise<unknown> {
  const built = regModuleOf(source);
  if (built === null) throw new Error('пример не компилируется');
  const entry = resolveEntryIndex(built.module.procedures, undefined) ?? 0;
  const host = createDefaultInvokeHandler();
  const vm = new RegVM(built.module, { maxSteps: 200_000, invoke: (n, a) => host(n, a) });
  return vm.runProcedure(entry, []);
}

async function shellValue(source: string): Promise<unknown> {
  const built = regModuleOf(source);
  if (built === null) throw new Error('пример не компилируется');
  const annotated = annotateAtomRegions(built.module, [
    { atom: 'A5', procedures: built.module.procedures.map((p) => p.name) },
  ]);
  const emitted = emitShell(annotated, shellEncoder);
  const simulated = await simulateShellImage(emitted.image, shellEncoder, {});
  return simulated.value;
}

describe('путь оболочки верен для примеров, объявленных исполняемыми', () => {
  it('примеры корпуса найдены', () => {
    for (const dir of CASES) {
      expect(fs.existsSync(path.join(EXAMPLES, dir, 'main.osnova')), `${dir} на месте`).toBe(true);
    }
  });

  for (const dir of CASES) {
    it(`${dir}: путь оболочки совпадает с регистровой VM`, async () => {
      const source = fs.readFileSync(path.join(EXAMPLES, dir, 'main.osnova'), 'utf-8');
      const direct = Number(await vmValue(source));
      const viaShell = Number(await shellValue(source));
      expect(
        viaShell,
        `${dir}: оболочка ${String(viaShell)}, VM ${String(direct)} — расхождение внутри НАШИХ ` +
          'слоёв (выбор инструкций, раскладка, планирование, эмиссия), а не в модели',
      ).toBe(direct);
    });
  }
});
