import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { run as runCli } from './run';
import { storageKeys, storageRead } from './storage';
import { VM } from './vm/interpreter';
import { isOsVbcModule, isVliwPacket } from './vm/bytecode';
import type { OsVbcModule, VliwPacket } from './vm/bytecode';
import type { GoldenReport } from '../pipeline/types';
import type { OsnovaSpec } from '../pipeline/types';

const STORAGE_ROOT = path.join(os.tmpdir(), 'osnova-storage');

// ─────────────────────────────────────────────────────────────
// runGoldenCheck — вызывается из pipeline/orchestrator
// Запускает bytecode на VM и возвращает GoldenReport
// ─────────────────────────────────────────────────────────────
export async function runGoldenCheck(
  bytecode: unknown,
  spec: OsnovaSpec,
): Promise<GoldenReport> {
  const start = Date.now();

  if (!isOsVbcModule(bytecode)) {
    return {
      executed: false,
      passed: false,
      qualityScore: 0,
      vmErrors: [{ message: 'bytecode is not a valid OsVbcModule' }],
      outputDiff: null,
      durationMs: Date.now() - start,
    };
  }

  const module = bytecode as OsVbcModule;
  const vmErrors: { message: string; opcode?: string; stack?: unknown[] }[] = [];

  // ── 1. Точка входа ──
  const entryName =
    module.procedures.find(p => p.name === spec.mainModule)?.name ??
    module.procedures[0]?.name;

  if (!entryName) {
    return {
      executed: false,
      passed: false,
      qualityScore: 0,
      vmErrors: [{ message: 'no procedures in bytecode' }],
      outputDiff: null,
      durationMs: Date.now() - start,
    };
  }

  // ── 2. Запуск VM ──
  let executed = false;
  try {
    const vm = new VM(module, { maxSteps: 50_000 });
    const idx = vm.findProcedureIndex(entryName);
    await vm.runProcedure(idx, []);
    executed = true;
  } catch (e) {
    vmErrors.push({ message: e instanceof Error ? e.message : String(e) });
  }

  if (!executed) {
    return {
      executed: false,
      passed: false,
      qualityScore: 0,
      vmErrors,
      outputDiff: null,
      durationMs: Date.now() - start,
    };
  }

  // ── 3. Структурные проверки ──
  const checks = {
    hasEntryProcedure: true,

    // Проверяем только что процедура "главная" существует в bytecode,
    // или если spec.procedures пуст — всегда true
    procedureNamesMatch:
      spec.procedures.length === 0 ||
      module.procedures.some(mp =>
        mp.name === 'главная' ||
        mp.name === spec.mainModule ||
        spec.procedures.some(p => p.name === mp.name)
      ),

    // Проверяем что хотя бы половина требуемых syscalls присутствует
    syscallsPresent:
      spec.syscalls.length === 0 ||
      spec.syscalls.filter(sc =>
        module.code.some((el: unknown) => {
          if (typeof el !== 'object' || el === null) return false;
          const entry = el as { op?: unknown; name?: unknown };
          return (
            entry.op === 'invoke' &&
            typeof entry.name === 'string' &&
            entry.name.startsWith(sc.split('.').slice(0, 2).join('.'))
          );
        })
      ).length >= Math.ceil(spec.syscalls.length / 2),

    entryProcedureCallable:
      module.procedures.some(p =>
        p.name === 'главная' ||
        p.name === 'main' ||
        p.name === spec.mainModule ||
        (spec.procedures.length > 0 && spec.procedures.some(sp => sp.name === p.name))
      ) &&
      module.code.length > 0,
  };

  const passedChecks = Object.values(checks).filter(Boolean).length;
  const totalChecks = Object.values(checks).length;
  const qualityScore = passedChecks / totalChecks;

  const failedNames = (Object.entries(checks) as [string, boolean][])
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const missingSyscalls = spec.syscalls.filter(sc =>
    !module.code.some((el: unknown) => {
      if (typeof el !== 'object' || el === null) return false;
      const entry = el as { op?: unknown; name?: unknown };
      return (
        entry.op === 'invoke' &&
        typeof entry.name === 'string' &&
        entry.name.startsWith(sc.split('.').slice(0, 2).join('.'))
      );
    })
  );

  const outputDiff =
    failedNames.length > 0 || missingSyscalls.length > 0
      ? JSON.stringify({
          failedChecks: failedNames,
          missingSyscalls,
          procedureCount: module.procedures.length,
          codeLength: module.code.length,
        })
      : null;

  return {
    executed: true,
    passed: qualityScore >= 0.7,
    qualityScore,
    vmErrors: [],
    outputDiff,
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────
// Ниже — fixture golden-тесты (legacy main())
// ─────────────────────────────────────────────────────────────

async function runTodoApp(): Promise<void> {
  const manifest = path.join(__dirname, 'fixtures', 'todo.osapp.yaml');
  process.env.OSNOVA_VM_MOCK_EVENTS = JSON.stringify([
    { тип: 'клик_виджета', виджет_id: 'add_btn' },
    { тип: 'закрытие' },
  ]);
  const code = await runCli(['--manifest', manifest, '--ui', 'cli', '--in-process']);
  if (code !== 0) throw new Error(`TODO app exited with code ${code}`);
  const keys = await storageKeys(STORAGE_ROOT, 'osnova.todo');
  if (!keys.includes('items'))
    throw new Error('[osnova-golden] TODO app did not create storage key "items"');
}

async function runViewerApp(): Promise<void> {
  const manifest = path.join(__dirname, 'fixtures', 'file-viewer.osapp.yaml');
  delete process.env.OSNOVA_VM_MOCK_EVENTS;
  const code = await runCli(['--manifest', manifest, '--ui', 'cli']);
  if (code !== 0) throw new Error(`File Viewer app exited with code ${code}`);
  const val = await storageRead(STORAGE_ROOT, 'osnova.viewer', 'last_path');
  if (val !== null && val.trim().length === 0)
    throw new Error('[osnova-golden] File Viewer wrote empty "last_path" value');
}

async function runNotificationsService(): Promise<void> {
  const manifest = path.join(__dirname, 'fixtures', 'notifications.osapp.yaml');
  const code = await runCli(['--manifest', manifest, '--ui', 'cli']);
  if (code !== 0) throw new Error(`Notifications service exited with code ${code}`);
}

async function runMicroCrmApp(): Promise<void> {
  const manifest = path.join(__dirname, 'fixtures', 'micro_crm.osapp.yaml');
  const code = await runCli(['--manifest', manifest, '--ui', 'cli']);
  if (code !== 0) throw new Error(`Micro-CRM app exited with code ${code}`);
  const checks: [string, string][] = [
    ['total_balance', '65'],
    ['active_count', '2'],
    ['balance_active', '30'],
    ['active_or_new_count', '3'],
  ];
  for (const [key, expected] of checks) {
    const val = await storageRead(STORAGE_ROOT, 'osnova.micro_crm', key);
    if (val !== expected)
      throw new Error(`[osnova-golden] Micro-CRM ${key} expected "${expected}", got ${JSON.stringify(val)}`);
  }
}

async function runGameRoundsApp(): Promise<void> {
  const manifest = path.join(__dirname, 'fixtures', 'game_rounds.osapp.yaml');
  const code = await runCli(['--manifest', manifest, '--ui', 'cli']);
  if (code !== 0) throw new Error(`Game Rounds app exited with code ${code}`);
  const checks: [string, string][] = [
    ['total_points', '30'],
    ['wins', '2'],
    ['bonus_wins', '2'],
  ];
  for (const [key, expected] of checks) {
    const val = await storageRead(STORAGE_ROOT, 'osnova.game_rounds', key);
    if (val !== expected)
      throw new Error(`[osnova-golden] Game Rounds ${key} expected "${expected}", got ${JSON.stringify(val)}`);
  }
}

async function runVliwExampleCheck(): Promise<void> {
  const fixturePath = path.join(__dirname, 'fixtures', 'vliw-example.osvbc.json');
  const raw = await fs.readFile(fixturePath, 'utf-8');
  const data = JSON.parse(raw) as unknown;
  if (!isOsVbcModule(data))
    throw new Error('[osnova-golden] vliw-example.osvbc.json is not a valid OsVbcModule');
  const m = data as OsVbcModule;
  if (m.version !== 2) throw new Error(`[osnova-golden] VLIW example expected version 2, got ${m.version}`);
  if (m.vliwSlots !== 4) throw new Error(`[osnova-golden] VLIW expected vliwSlots 4, got ${m.vliwSlots}`);
  const proc = m.procedures.find(p => p.name === 'пример');
  if (!proc || proc.argc !== 0 || proc.localsCount !== 2 || !proc.deps)
    throw new Error('[osnova-golden] VLIW example must have procedure пример with argc 0, localsCount 2, deps');
  const packetEl = m.code.find(el => isVliwPacket(el));
  if (!packetEl || !isVliwPacket(packetEl))
    throw new Error('[osnova-golden] VLIW example code must contain a packet element');
  const pkt = packetEl as VliwPacket;
  if (pkt.slots.length !== 3 || !pkt.deps || pkt.deps.length !== 2)
    throw new Error('[osnova-golden] VLIW example packet must have 3 slots and deps with 2 pairs');
  const vm = new VM(m, { maxSteps: 10_000 });
  const idx = vm.findProcedureIndex('пример');
  const result = await vm.runProcedure(idx, []);
  if (result !== 2)
    throw new Error(`[osnova-golden] VLIW пример must return 2, got ${JSON.stringify(result)}`);
}

async function main() {
  console.error('[osnova-golden] running TODO app...');
  await runTodoApp();
  console.error('[osnova-golden] TODO app OK');

  console.error('[osnova-golden] running File Viewer app...');
  await runViewerApp();
  console.error('[osnova-golden] File Viewer app OK');

  console.error('[osnova-golden] running Notifications service...');
  await runNotificationsService();
  console.error('[osnova-golden] Notifications service OK');

  console.error('[osnova-golden] running Micro-CRM app...');
  await runMicroCrmApp();
  console.error('[osnova-golden] Micro-CRM app OK');

  console.error('[osnova-golden] running Game Rounds app...');
  await runGameRoundsApp();
  console.error('[osnova-golden] Game Rounds app OK');

  console.error('[osnova-golden] running VLIW v2 example check...');
  await runVliwExampleCheck();
  console.error('[osnova-golden] VLIW v2 example OK');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[osnova-golden] ERROR:', err);
    process.exit(1);
  });
}
