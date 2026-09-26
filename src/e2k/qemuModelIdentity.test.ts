/**
 * ОРАКУЛ ИДЕНТИЧНОСТИ МОДЕЛИ: тот ли это порт, на котором измерены закреплённые числа.
 *
 * Живёт в шлюзе `npm run gate:qemu` (в полный прогон не входит) — он спрашивает у WSL
 * живую сборку, а не читает константу из исходника.
 *
 * Зачем: 2026-09-25 выяснилось, что порт, на котором измерено «окно вызываемой — 8 регистров»
 * (§3.17, §3.18), — это **наша пропатченная сборка без версии**: дерево исходников не
 * git-репозиторий, апстрим неизвестен, а опубликованный порт сообщества задаёт окно иначе
 * (`wd.size = 16; wd.psize = 8` против наших `psize_q = 4`, `size_q = 8` плюс локальная
 * правка). Пока у модели нет паспорта, любое её изменение молча обесценивает все замеры.
 *
 * Оракул намеренно **не** чинит расхождение: он его называет. Пересборка модели — это смена
 * истины, а не правка кода; после неё числа перемеряются, а паспорт обновляется
 * (`src/e2k/qemuModelPassport.ts`, `tools/qemu-e2k/README.md`).
 */
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { QEMU_MODEL, modelIdentityProblems, type ModelIdentity } from './qemuModelPassport';

/** Тот же путь к WSL, что и в остальных оракулах шлюза. */
const WSL = 'C:\\Program Files\\WSL\\wsl.exe';

function inWsl(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(WSL, ['-d', QEMU_MODEL.wslDistro, '--', ...args], {
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: run.status,
    stdout: (run.stdout ?? '').toString(),
    stderr: (run.stderr ?? '').toString(),
  };
}

/** Прочитать у живой сборки версию и sha256. */
function readIdentity(): { identity?: ModelIdentity; problem?: string } {
  const version = inWsl([QEMU_MODEL.binary, '--version']);
  if (version.code !== 0) {
    return {
      problem:
        `модель недоступна: ${QEMU_MODEL.binary} в дистрибутиве ${QEMU_MODEL.wslDistro} ` +
        `не ответила (${version.stderr.trim() || 'без сообщения'})`,
    };
  }
  const digest = inWsl(['sha256sum', QEMU_MODEL.binary]);
  if (digest.code !== 0) {
    return { problem: `sha256 модели не прочитан: ${digest.stderr.trim() || 'без сообщения'}` };
  }
  const sha256 = digest.stdout.trim().split(/\s+/u)[0] ?? '';
  // `--version` печатает две строки: версию и копирайт. Сверяем первую — остальное не про модель.
  const firstLine = version.stdout.trim().split('\n')[0]?.trim() ?? '';
  return { identity: { version: firstLine, sha256 } };
}

describe('идентичность модели e2k: та ли сборка, на которой всё измерено', () => {
  it('версия и sha256 читаются у ЖИВОЙ сборки, а не подставляются из паспорта', () => {
    const { identity, problem } = readIdentity();
    expect(problem, problem ?? 'модель должна быть доступна в шлюзе').toBeUndefined();
    expect(identity, 'живая сборка ответила').toBeDefined();
    expect(identity!.version.length, 'версия непуста').toBeGreaterThan(0);
    expect(identity!.sha256.length, 'sha256 непуст').toBe(64);
  });

  it('паспорт совпадает с живой сборкой — иначе числа требуют перемера', () => {
    const { identity, problem } = readIdentity();
    if (problem !== undefined) {
      expect(problem, problem).toBeUndefined();
      return;
    }
    const problems = modelIdentityProblems(identity!);
    expect(
      problems,
      problems.length === 0
        ? ''
        : `модель изменилась — обнови паспорт (${QEMU_MODEL.localPatch}) и перемерь числа:\n` +
          problems.join('\n'),
    ).toEqual([]);
  });

  it('паспорт честно называет неизвестное происхождение дерева', () => {
    expect(QEMU_MODEL.upstreamProvenance).toContain('НЕ УСТАНОВЛЕНО');
    expect(QEMU_MODEL.localPatchSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});
