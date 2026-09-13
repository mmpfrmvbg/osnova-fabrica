import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runOracle } from './oracle';
import type { OsVbcModule } from '../runtime/vm/bytecode';

function loadFixture(name: string): OsVbcModule {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as OsVbcModule;
}

describe('VLIW oracle', () => {
  it('linear-sum: пакетный результат равен линейному', async () => {
    const mod = loadFixture('linear-sum.osvbc.json');
    const report = await runOracle(mod);

    expect(report.equal).toBe(true);
    expect(report.linearResult).toBe(2);
    expect(report.scheduledResult).toBe(2);
    // const(0)→I0, const(1)→I1 в один пакет; add; ret → 3 пакета, 4 слота
    expect(report.packetCount).toBe(3);
    expect(report.avgSlots).toBeCloseTo(4 / 3, 2);
  });

  it('независимые пары операций распараллеливаются (ILP > 1)', async () => {
    // a = 1+2; b = 3+4; вернуть a+b → две независимые пары const/add
    const mod: OsVbcModule = {
      version: 1,
      moduleName: 'par',
      constants: [1, 2, 3, 4],
      procedures: [{ name: 'main', codeOffset: 0, argc: 0, localsCount: 2 }],
      code: [
        { op: 'const', type: 'i32', k: 0 },
        { op: 'const', type: 'i32', k: 1 },
        { op: 'add' },
        { op: 'local.set', i: 0 },
        { op: 'const', type: 'i32', k: 2 },
        { op: 'const', type: 'i32', k: 3 },
        { op: 'add' },
        { op: 'local.set', i: 1 },
        { op: 'local.get', i: 0 },
        { op: 'local.get', i: 1 },
        { op: 'add' },
        { op: 'ret' },
      ],
    };
    const report = await runOracle(mod);

    expect(report.equal).toBe(true);
    expect(report.linearResult).toBe(10);
    expect(report.packetCount).toBeLessThan(12); // 12 инструкций → есть пакеты с 2 слотами
    expect(report.avgSlots).toBeGreaterThan(1);
  });
});
