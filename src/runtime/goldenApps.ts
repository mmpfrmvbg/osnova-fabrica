import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { run as runCli } from './run';
import { storageWrite, storageKeys, storageRead, storageDelete } from './storage';
import { VM } from './vm/interpreter';
import type { StackValue } from './vm/interpreter';
import { createGoldenCheckVm } from './vm';
import { isOsVbcModule, isVliwPacket } from './vm/bytecode';
import type { OsVbcModule, VliwPacket } from './vm/bytecode';
import type { GoldenReport } from '../pipeline/types';
import type { OsnovaSpec } from '../pipeline/types';
import { RUNTIME_CODES, runtimeErrorCodeOf, type RuntimeErrorCode } from './runtimeCodes';

const STORAGE_ROOT = path.join(os.tmpdir(), 'osnova-storage');

/**
 * Запись об отказе исполнения для `GoldenReport.vmErrors`.
 *
 * Зачем отдельная функция и почему она экспортирована: сборка записи — это
 * **точка, где канал рвётся молча**. Замер 2026-09-28 (проба T4): код у ошибки
 * уже был (`код=OSN-RT-002`), а в записи лежал только текст — в живом
 * `runs/traces.jsonl` 51 отказ исполнения, и у всех код «не назван». Поэтому
 * сборка вынесена в одно место, покрыта сторожем
 * (`src/runtime/runtimeCodes.test.ts`) и не оставляет выбора «забыть поле».
 *
 * Контракт записи:
 * - `message` — **дословно** прежний текст (`e.message`), его читает человек и
 *   ищут существующие проверки; текст не переписывается;
 * - `code` — код из таблицы `src/runtime/runtimeCodes.ts`. Если у ошибки кода
 *   нет (в том числе когда это не ошибка, а текст отказа), запись получает
 *   **явный** маркер `OSN-RT-000`: «код не назван» обязано быть видно числом,
 *   а не пустым полем — пустое поле не отличить от «поле забыли»;
 * - `op`/`pc` — место отказа в байткоде, когда оно есть: без них запись говорит
 *   «что», но не «где».
 */
export interface VmErrorRecord {
  readonly message: string;
  readonly code: RuntimeErrorCode;
  readonly op?: string;
  readonly pc?: number;
  readonly opcode?: string;
  readonly stack?: unknown[];
}

/** Собрать запись об отказе исполнения (см. {@link VmErrorRecord}). */
export function vmErrorRecordOf(error: unknown): VmErrorRecord {
  const record: {
    message: string;
    code: RuntimeErrorCode;
    op?: string;
    pc?: number;
  } = {
    message: error instanceof Error ? error.message : String(error),
    code: runtimeErrorCodeOf(error) ?? RUNTIME_CODES.unnamedRefusal,
  };
  if (error !== null && typeof error === 'object') {
    const { op, pc } = error as { op?: unknown; pc?: unknown };
    // Пустые `op`/`pc` не пишем: поле с `undefined` в JSON-журнале неотличимо
    // от отсутствующего, а «нет места» — это отсутствие поля, а не пустое значение.
    if (typeof op === 'string' && op !== '') record.op = op;
    if (typeof pc === 'number' && Number.isInteger(pc)) record.pc = pc;
  }
  return record;
}

/**
 * Корень хранилища golden-приложений. Экспортирован для оракула app-runner'а:
 * он обязан читать те же ключи из того же корня, что пишет приложение
 * (`src/runtime/appRunner.test.ts`), иначе проверка смотрела бы в другое место.
 */
export const GOLDEN_STORAGE_ROOT = STORAGE_ROOT;

function makeTmpStorageRoot(): string {
  const dir = path.join(os.tmpdir(), `osnova-golden-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fssync.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─────────────────────────────────────────────────────────────
// runGoldenCheck — вызывается из pipeline/orchestrator
// Запускает bytecode на VM и возвращает GoldenReport
// ─────────────────────────────────────────────────────────────
export async function runGoldenCheck(
  bytecode: unknown,
  spec: OsnovaSpec,
): Promise<GoldenReport> {
  const start = Date.now();
  const pad2 = (n: number): string => String(Math.trunc(n)).padStart(2, '0');

  if (!isOsVbcModule(bytecode)) {
    return {
      executed: false,
      passed: false,
      qualityScore: 0,
      // Предполётный отказ проверки: исполнение не состоялось, кода у него нет —
      // маркер `OSN-RT-000` ставится тем же сборщиком записи, что и для ошибок.
      vmErrors: [vmErrorRecordOf('bytecode is not a valid OsVbcModule')],
      outputDiff: null,
      durationMs: Date.now() - start,
    };
  }

  const module = bytecode as OsVbcModule;
  const vmErrors: VmErrorRecord[] = [];

  // ── 1. Точка входа ──
  const entryName =
    module.procedures.find(p => p.name === spec.mainModule)?.name ??
    module.procedures[0]?.name;

  if (!entryName) {
    return {
      executed: false,
      passed: false,
      qualityScore: 0,
      vmErrors: [vmErrorRecordOf('no procedures in bytecode')],
      outputDiff: null,
      durationMs: Date.now() - start,
    };
  }

  // ── 1.5. Подготовка storage для поведенческих проверок ──
  const storageRoot = makeTmpStorageRoot();
  const appId = `golden-check-${module.moduleName}`;

  // ── 2. Запуск VM ──
  let executed = false;
  let vmResult: unknown = null;
  try {
    const goldenInvoke = async (name: string, args: StackValue[]): Promise<StackValue> => {
        // Хранилище — реальная реализация через tmpdir
        if (name === 'система.хранилище.записать') {
          await storageWrite(storageRoot, appId, String(args[0]), String(args[1]));
          return null;
        }
        if (name === 'система.хранилище.удалить') {
          await storageDelete(storageRoot, appId, String(args[0]));
          return null;
        }
        if (name === 'система.хранилище.прочитать') {
          return await storageRead(storageRoot, appId, String(args[0]));
        }
        if (name === 'система.хранилище.ключи') {
          return await storageKeys(storageRoot, appId);
        }
        if (name === 'система.хранилище.ключи_с_префиксом') {
          const prefix = String(args[0]);
          const allKeys = await storageKeys(storageRoot, appId);
          return allKeys.filter((k: string) => k.startsWith(prefix));
        }
        if (name === 'система.время.метка') {
          return new Date().toISOString();
        }
        if (name === 'система.время.разобрать') {
          const raw = String(args[0] ?? '');
          const d = new Date(raw);
          return {
            год: d.getUTCFullYear(),
            месяц: d.getUTCMonth() + 1,
            день: d.getUTCDate(),
            часы: d.getUTCHours(),
            минуты: d.getUTCMinutes(),
          };
        }
        if (name === 'система.время.форматировать') {
          const dateObj = (args[0] ?? {}) as Record<string, unknown>;
          const format = String(args[1] ?? '');
          const year = Number(dateObj['год'] ?? 0);
          const month = Number(dateObj['месяц'] ?? 1);
          const day = Number(dateObj['день'] ?? 1);
          const hours = Number(dateObj['часы'] ?? 0);
          const minutes = Number(dateObj['минуты'] ?? 0);
          const dd = pad2(day);
          const mm = pad2(month);
          const yyyy = String(Math.trunc(year));
          const hh = pad2(hours);
          const min = pad2(minutes);
          if (format === 'дд.мм.гггг') return `${dd}.${mm}.${yyyy}`;
          if (format === 'дд.мм.гггг чч:мм') return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
          return new Date(Date.UTC(year, month - 1, day, hours, minutes)).toISOString();
        }
        if (name === 'система.время.добавить_дни') {
          const iso = String(args[0] ?? '');
          const n = Number(args[1] ?? 0);
          const d = new Date(iso);
          d.setUTCDate(d.getUTCDate() + n);
          return d.toISOString();
        }
        if (name === 'система.время.разница_дней') {
          const iso1 = String(args[0] ?? '');
          const iso2 = String(args[1] ?? '');
          const d1 = new Date(iso1);
          const d2 = new Date(iso2);
          const diffDays = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24);
          return Math.floor(diffDays);
        }
        if (name === 'система.массив.создать') {
          const size = Number(args[0] ?? 0);
          return new Array(size).fill(null);
        }
        if (name === 'система.массив.длина') {
          return Array.isArray(args[0]) ? (args[0] as unknown[]).length : 0;
        }
        if (name === 'система.массив.получить') {
          const arr = args[0] as unknown[];
          const i = Number(args[1]) | 0;
          return Array.isArray(arr) && i >= 0 && i < arr.length ? (arr[i] as never) : null;
        }
        if (name === 'система.массив.установить') {
          const arr = args[0] as unknown[];
          const i = Number(args[1]) | 0;
          if (Array.isArray(arr) && i >= 0 && i < arr.length) arr[i] = args[2];
          return null;
        }
        if (name === 'система.массив.добавить') {
          if (Array.isArray(args[0])) (args[0] as unknown[]).push(args[1]);
          return null;
        }
        // Остальные syscall — заглушки (лог, UI и т.д.)
        if (name.startsWith('система.лог.')) return null;
        if (name.startsWith('система.окно.')) return null;
        if (name.startsWith('система.интерфейс.')) return null;
        if (name.startsWith('система.массив.')) return null;
        if (name.startsWith('система.время.')) return null;
        if (name.startsWith('система.сеть.')) return null;
        return null;
    };

    const vm = createGoldenCheckVm(spec, module, { invoke: goldenInvoke });
    if (!vm) {
      vmErrors.push(vmErrorRecordOf('bytecode is not a valid OsVbcModule'));
    } else {
      vmResult = await vm.execute({ procedure: entryName });
      executed = true;
    }
  } catch (e) {
    // Отказ VM: текст остаётся дословным, а код (или явный `OSN-RT-000`) едет
    // в запись отдельным полем — см. `vmErrorRecordOf`.
    vmErrors.push(vmErrorRecordOf(e));
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
  const expectedReturnValue =
    spec.expectedReturnValue ?? spec.expectVM?.returnValue;
  const hasExpectedReturnValue = expectedReturnValue !== undefined;

  const checks = await (async () => ({
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
            entry.name === sc
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
    // Если spec.syscalls содержит хранилище — проверяем что запись реально произошла
    storageWriteVerified: await (async () => {
      const hasStorageSyscall = spec.syscalls.some(sc =>
        sc.startsWith('система.хранилище.записать')
      );
      if (!hasStorageSyscall) return true; // не требуется
      const keys = await storageKeys(storageRoot, appId);
      return keys.length > 0;
    })(),
    vmReturnMatches: !hasExpectedReturnValue || vmResult === expectedReturnValue,
  }))();

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
        entry.name === sc
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
          vmReturnDiff:
            checks.vmReturnMatches
              ? null
              : { expected: expectedReturnValue, actual: vmResult },
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

async function runChatAppCompileOnly(): Promise<void> {
  console.error('[osnova-golden] chat: compile check...');
  // Только проверяем компиляцию — без реального HTTP к Jarvis
  const { execSync } = await import('child_process');
  const outPath = path.join(os.tmpdir(), 'chat-golden-check.osvbc.json');
  try {
    execSync(`npx tsx src/cli.ts compile apps/chat/chat.osnova -o ${outPath}`, {
      stdio: 'pipe',
      cwd: path.join(__dirname, '..', '..'),
    });
    console.error('[osnova-golden] chat: compile OK');
  } catch (e) {
    const err = e as { stderr?: Buffer };
    throw new Error(`[osnova-golden] chat compile failed: ${err.stderr?.toString() ?? String(e)}`);
  }
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

  console.error('[osnova-golden] running Chat compile check...');
  await runChatAppCompileOnly();
}

if (require.main === module) {
  main().catch(err => {
    console.error('[osnova-golden] ERROR:', err);
    process.exit(1);
  });
}
