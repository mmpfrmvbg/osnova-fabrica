import { describe, it, expect } from 'vitest';
import { buildDependencyGraph } from './dependencyGraph';
import type { RawInstruction } from '../runtime/vm/bytecode';

describe('dependencyGraph: побочные эффекты и pure', () => {
  it('invoke создаёт порядок эффектов', () => {
    const ins: RawInstruction[] = [
      { op: 'invoke', name: 'система.лог.вывести' },
      { op: 'invoke', name: 'система.лог.вывести' },
    ];
    const g = buildDependencyGraph(ins);
    expect(g.edges).toContainEqual([0, 1]);
  });

  it('чистый call не создаёт порядок эффектов', () => {
    const ins: RawInstruction[] = [
      { op: 'invoke', name: 'система.лог.вывести' },
      { op: 'call', fi: 0 },
    ];
    const g = buildDependencyGraph(ins, { callPure: (fi) => fi === 0 });
    expect(g.edges).not.toContainEqual([0, 1]);
  });

  it('не-чистый call создаёт порядок эффектов', () => {
    const ins: RawInstruction[] = [
      { op: 'invoke', name: 'система.лог.вывести' },
      { op: 'call', fi: 0 },
    ];
    const g = buildDependencyGraph(ins, { callPure: () => false });
    expect(g.edges).toContainEqual([0, 1]);
  });
});
