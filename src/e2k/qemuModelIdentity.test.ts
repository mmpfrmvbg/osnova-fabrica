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
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { QEMU_MODEL, modelIdentityProblems, type ModelIdentity } from './qemuModelPassport';
import { WINDOW_REGISTERS_CALLEE, WINDOW_REGISTERS_ENTRY } from './regAlloc';
import { calleeWindowRegisters, passportWindow } from './windowGeometry';

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
        : `модель изменилась — обнови паспорт (${QEMU_MODEL.localPatches.map((p) => p.path).join(' + ')}) и перемерь числа:\n` +
          problems.join('\n'),
    ).toEqual([]);
  });

  it('паспорт честно называет неизвестное происхождение дерева', () => {
    expect(QEMU_MODEL.upstreamProvenance).toContain('НЕ УСТАНОВЛЕНО');
    expect(QEMU_MODEL.localPatchSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  /**
   * СВЯЗЬ ПАТЧЕЙ С МОДЕЛЬЮ — а не только форма их хешей.
   *
   * Повод (измерено 2026-09-28): поле `localPatchSha256` обещало «чтобы патч в репозитории не
   * разошёлся с описанным», но сторож проверял у него **только форму** (`/^[0-9a-f]{64}$/`) —
   * то есть запись о происхождении модели не держалась ничем. За это время патч в репозитории
   * сменился (на обе правки сразу, `81ccc715…`), а паспорт продолжал называть прежний
   * (`cc722379…`), и заметить это было нечем.
   *
   * Второй повод (2026-11-09, D4): аудит нашёл, что правок не две, а четыре: `WD` пересобирается
   * ещё и в `target/e2k/tcg/translate-ct.c` (возврат/вызов), а в репозитории этого патча не было —
   * пересборка «по репозиторию» давала другой бинарь. Проверка, что первый патч воспроизводит
   * живой файл, тоже провалилась: в нём был лишний комментарий, которого в источнике уже нет.
   * Поэтому теперь сверяется СОДЕРЖАНИЕ КАЖДОГО патча из `localPatches`.
   *
   * Связь «бинарь ↔ источник ↔ патчи» держится так: паспортный бинарь проверен против живого
   * источника, живой источник побайтово равен тому, что дают эти патчи на чистом дереве
   * (`docs/hardware-debt.md` §3.44.3/§3.44.5). Проверить последнее звено автоматикой нельзя —
   * чистого дерева под рукой нет, — но расхождение записи с файлом теперь ловится.
   */
  it('sha256 патчей в паспорте — это sha256 патчей В РЕПОЗИТОРИИ', () => {
    expect(QEMU_MODEL.localPatches.length, 'правок больше одной: окно задаётся и в cpu_loop.c, и в translate-ct.c').toBeGreaterThan(1);
    for (const patch of QEMU_MODEL.localPatches) {
      const patchPath = path.resolve(__dirname, '..', '..', patch.path);
      expect(fs.existsSync(patchPath), `${patch.path} должен лежать в репозитории`).toBe(true);
      const actual = createHash('sha256').update(fs.readFileSync(patchPath)).digest('hex');
      expect(
        patch.sha256,
        `паспорт называет ${patch.path} ${patch.sha256.slice(0, 8)}…, а в репозитории ` +
          `файл даёт ${actual.slice(0, 8)}… — запись о происхождении модели разошлась с файлом. ` +
          'Обнови поле и дату в паспорте вместе с правкой патча, иначе сторож снова станет формальностью',
      ).toBe(actual);
    }
    // Историческое поле не должно разойтись с первым элементом списка.
    expect(QEMU_MODEL.localPatchSha256).toBe(QEMU_MODEL.localPatches[0].sha256);
    expect(QEMU_MODEL.localPatch).toBe(QEMU_MODEL.localPatches[0].path);
  });

  /**
   * КОНСТАНТА ОКНА — ЭТО СЛЕДСТВИЕ ФОРМУЛЫ, А НЕ ЛИТЕРАЛ.
   *
   * Повод (измерено 2026-09-28): `WINDOW_REGISTERS_CALLEE = 8` и `WINDOW_REGISTERS_ENTRY = 16`
   * ничем друг с другом не связаны и ни на какую формулу не ссылаются — только литералы и
   * отдельные `expect(...).toBe(8)`. Между тем оба выведены из одного: порт задаёт геометрию
   * окна числом `size_q` (ступени лестницы §3.36), а вызываемая получает `2 * (size_q − 4)`.
   *
   * Формула проверена ДВУМЯ независимыми замерами на живой модели: `size_q = 8` → вызываемая
   * видит ровно 8 (`%r7` есть, `%r8` нет), `size_q = 12` → ровно 16 (`%r15` есть, `%r16` нет);
   * оба — `docs/hardware-debt.md` §3.36, §3.44.5. Здесь связь закрепляется арифметикой: сегодня
   * `size_q = 8`, то есть `2*(8−4) = 8`. Когда размер окна в порте изменится, эта проверка
   * назовёт расхождение ЧИСЛОМ, а не «где-то стало тесно».
   */
  it('окно вызываемой — следствие геометрии порта, а не литерал', () => {
    // Геометрия читается ИЗ ПАСПОРТА — единственного источника, который меняется вместе с портом.
    // Прежняя редакция вписывала `SIZE_Q_TODAY = 8` литералом: при правке порта она краснела, но
    // требовала правки СЕБЯ, а не называла расхождение паспорта с константой (§3.44.4, §3.49).
    const window = QEMU_MODEL.window;
    const derived = calleeWindowRegisters(window.sizeQ, window.wbs);
    expect(
      WINDOW_REGISTERS_CALLEE,
      `окно вызываемой ${String(WINDOW_REGISTERS_CALLEE)} не сходится с геометрией порта из паспорта: ` +
        `2*(size_q=${String(window.sizeQ)} − wbs=${String(window.wbs)}) = ${String(derived)}. ` +
        'Правка окна входит одним пакетом: порт → патч → паспорт → константа → оракул класса ' +
        '(`src/e2k/windowGeometry.ts`) → перемер (`docs/hardware-debt.md` §3.44.6)',
    ).toBe(derived);
    expect(
      passportWindow().caller,
      'вызывающий видит 2*size_q — второе следствие той же геометрии',
    ).toBe(2 * window.sizeQ);
    expect(
      WINDOW_REGISTERS_ENTRY,
      'окно входа (пролог образа, setbn rsz) обязано помещаться в окно вызывающего',
    ).toBeLessThanOrEqual(2 * window.sizeQ);
  });
});
