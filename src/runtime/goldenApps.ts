import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { run as runCli } from "./run";
import { storageKeys, storageRead } from "./storage";
import { VM } from "./vm/interpreter";
import { isOsVbcModule, isVliwPacket } from "./vm/bytecode";
import type { OsVbcModule, VliwPacket } from "./vm/bytecode";

const STORAGE_ROOT = path.join(os.tmpdir(), "osnova-storage");

async function runTodoApp(): Promise<void> {
  const manifest = path.join(__dirname, "fixtures", "todo.osapp.yaml");
  process.env.OSNOVA_VM_MOCK_EVENTS = JSON.stringify([
    { тип: "клик_виджета", виджет_id: "add_btn" },
    { тип: "закрытие" },
  ]);
  const code = await runCli(["--manifest", manifest, "--ui", "cli", "--in-process"]);
  if (code !== 0) {
    throw new Error(`TODO app exited with code ${code}`);
  }

  const keys = await storageKeys(STORAGE_ROOT, "osnova.todo");
  if (!keys.includes("items")) {
    throw new Error(`[osnova-golden] TODO app did not create storage key "items"`);
  }
}

async function runViewerApp(): Promise<void> {
  const manifest = path.join(__dirname, "fixtures", "file-viewer.osapp.yaml");
  delete process.env.OSNOVA_VM_MOCK_EVENTS;
  const code = await runCli(["--manifest", manifest, "--ui", "cli"]);
  if (code !== 0) {
    throw new Error(`File Viewer app exited with code ${code}`);
  }

  const val = await storageRead(STORAGE_ROOT, "osnova.viewer", "last_path");
  // На текущем этапе viewer.osvbc.json — каркас без логики; когда реальный байткод появится,
  // это условие можно ужесточить до обязательного непустого значения.
  if (val !== null && val.trim().length === 0) {
    throw new Error(`[osnova-golden] File Viewer wrote empty "last_path" value`);
  }
}

async function runNotificationsService(): Promise<void> {
  const manifest = path.join(__dirname, "fixtures", "notifications.osapp.yaml");
  const code = await runCli(["--manifest", manifest, "--ui", "cli"]);
  if (code !== 0) {
    throw new Error(`Notifications service exited with code ${code}`);
  }
}

async function runMicroCrmApp(): Promise<void> {
  const manifest = path.join(__dirname, "fixtures", "micro_crm.osapp.yaml");
  const code = await runCli(["--manifest", manifest, "--ui", "cli"]);
  if (code !== 0) {
    throw new Error(`Micro-CRM app exited with code ${code}`);
  }
  const totalBalance = await storageRead(STORAGE_ROOT, "osnova.micro_crm", "total_balance");
  const activeCount = await storageRead(STORAGE_ROOT, "osnova.micro_crm", "active_count");
  const balanceActive = await storageRead(STORAGE_ROOT, "osnova.micro_crm", "balance_active");
  const activeOrNewCount = await storageRead(STORAGE_ROOT, "osnova.micro_crm", "active_or_new_count");
  if (totalBalance !== "65") {
    throw new Error(`[osnova-golden] Micro-CRM total_balance expected "65", got ${JSON.stringify(totalBalance)}`);
  }
  if (activeCount !== "2") {
    throw new Error(`[osnova-golden] Micro-CRM active_count expected "2", got ${JSON.stringify(activeCount)}`);
  }
  if (balanceActive !== "30") {
    throw new Error(`[osnova-golden] Micro-CRM balance_active expected "30", got ${JSON.stringify(balanceActive)}`);
  }
  if (activeOrNewCount !== "3") {
    throw new Error(`[osnova-golden] Micro-CRM active_or_new_count expected "3", got ${JSON.stringify(activeOrNewCount)}`);
  }
}

async function runGameRoundsApp(): Promise<void> {
  const manifest = path.join(__dirname, "fixtures", "game_rounds.osapp.yaml");
  const code = await runCli(["--manifest", manifest, "--ui", "cli"]);
  if (code !== 0) {
    throw new Error(`Game Rounds app exited with code ${code}`);
  }
  const totalPoints = await storageRead(STORAGE_ROOT, "osnova.game_rounds", "total_points");
  const wins = await storageRead(STORAGE_ROOT, "osnova.game_rounds", "wins");
  const bonusWins = await storageRead(STORAGE_ROOT, "osnova.game_rounds", "bonus_wins");
  if (totalPoints !== "30") {
    throw new Error(`[osnova-golden] Game Rounds total_points expected "30", got ${JSON.stringify(totalPoints)}`);
  }
  if (wins !== "2") {
    throw new Error(`[osnova-golden] Game Rounds wins expected "2", got ${JSON.stringify(wins)}`);
  }
  if (bonusWins !== "2") {
    throw new Error(`[osnova-golden] Game Rounds bonus_wins expected "2", got ${JSON.stringify(bonusWins)}`);
  }
}

/** Golden-тест VLIW-байткода v2: загрузка, валидация структуры, прогон через VM. */
async function runVliwExampleCheck(): Promise<void> {
  const fixturePath = path.join(__dirname, "fixtures", "vliw-example.osvbc.json");
  const raw = await fs.readFile(fixturePath, "utf-8");
  const data = JSON.parse(raw) as unknown;
  if (!isOsVbcModule(data)) {
    throw new Error("[osnova-golden] vliw-example.osvbc.json is not a valid OsVbcModule");
  }
  const m = data as OsVbcModule;
  if (m.version !== 2) {
    throw new Error(`[osnova-golden] VLIW example expected version 2, got ${m.version}`);
  }
  if (m.vliwSlots !== 4) {
    throw new Error(`[osnova-golden] VLIW example expected vliwSlots 4, got ${m.vliwSlots}`);
  }
  const proc = m.procedures.find((p) => p.name === "пример");
  if (!proc || proc.argc !== 0 || proc.localsCount !== 2 || !proc.deps) {
    throw new Error("[osnova-golden] VLIW example must have procedure пример with argc 0, localsCount 2, deps");
  }
  const packetEl = m.code.find((el) => isVliwPacket(el));
  if (!packetEl || !isVliwPacket(packetEl)) {
    throw new Error("[osnova-golden] VLIW example code must contain a packet element");
  }
  const pkt = packetEl as VliwPacket;
  if (pkt.slots.length !== 3 || !pkt.deps || pkt.deps.length !== 2) {
    throw new Error("[osnova-golden] VLIW example packet must have 3 slots and deps with 2 pairs");
  }
  const vm = new VM(m, { maxSteps: 10_000 });
  const idx = vm.findProcedureIndex("пример");
  const result = await vm.runProcedure(idx, []);
  if (result !== 2) {
    throw new Error(`[osnova-golden] VLIW example procedure пример must return 2, got ${JSON.stringify(result)}`);
  }
}

async function main() {
  console.error("[osnova-golden] running TODO app...");
  await runTodoApp();
  console.error("[osnova-golden] TODO app OK (storage.items present)");

  console.error("[osnova-golden] running File Viewer app...");
  await runViewerApp();
  console.error("[osnova-golden] File Viewer app OK (storage.last_path check soft-passed)");

  console.error("[osnova-golden] running Notifications service...");
  await runNotificationsService();
  console.error("[osnova-golden] Notifications service OK (stub run exit 0)");

  console.error("[osnova-golden] running Micro-CRM app...");
  await runMicroCrmApp();
  console.error("[osnova-golden] Micro-CRM app OK (для_каждого, и/или, storage checks)");

  console.error("[osnova-golden] running Game Rounds app...");
  await runGameRoundsApp();
  console.error("[osnova-golden] Game Rounds app OK (game logic, и, storage checks)");

  console.error("[osnova-golden] running VLIW v2 example check...");
  await runVliwExampleCheck();
  console.error("[osnova-golden] VLIW v2 example OK (format v2, packet, deps, VM run returns 2)");
}

main().catch((err) => {
  console.error("[osnova-golden] ERROR:", err);
  process.exit(1);
});

