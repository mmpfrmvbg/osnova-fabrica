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
    // const(0) и const(1) — оба I1 → разные пакеты; add; ret → 4 пакета по 1 слоту
    expect(report.packetCount).toBe(4);
    expect(report.avgSlots).toBe(1);
  });
});
