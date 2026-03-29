import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(fileURLToPath(import.meta.url));

describe('tsconfig.json', () => {
  const raw = readFileSync(resolve(root, 'tsconfig.json'), 'utf8');
  const cfg = JSON.parse(raw) as { compilerOptions: Record<string, unknown> };

  it('keeps strict mode on', () => {
    expect(cfg.compilerOptions.strict).toBe(true);
  });

  it('uses explicit node10 moduleResolution (not legacy "node")', () => {
    expect(cfg.compilerOptions.moduleResolution).toBe('node10');
  });

  it('includes ES2022 and ES2023 libs for the compiler', () => {
    expect(cfg.compilerOptions.lib).toEqual(['ES2022', 'ES2023']);
  });
});
