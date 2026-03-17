/**
 * Тесты Этапа 1 планировщика VLIW: e2kModel, dependencyGraph, scheduler.
 * Запуск: npx tsx --test src/tools/osnova-vliw/scheduler.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { classifyOpcode, VLIW_SLOTS } from "./e2kModel";
import { buildDependencyGraph } from "./dependencyGraph";
import { scheduleLinearBlock, packetsToCodeElements } from "./scheduler";
import type { RawInstruction } from "../osnova-runtime/vm/bytecode";
import type { OsVbcModule } from "../osnova-runtime/vm/bytecode";
import { VM } from "../osnova-runtime/vm/interpreter";

// ─── 1. classifyOpcode ──────────────────────────────────────

describe("e2kModel.classifyOpcode", () => {
  it("VLIW_SLOTS is 4", () => {
    assert.strictEqual(VLIW_SLOTS, 4);
  });

  it("ALU ops → I0", () => {
    assert.strictEqual(classifyOpcode("add"), "I0");
    assert.strictEqual(classifyOpcode("sub"), "I0");
    assert.strictEqual(classifyOpcode("mul"), "I0");
    assert.strictEqual(classifyOpcode("eq"), "I0");
    assert.strictEqual(classifyOpcode("lt"), "I0");
  });

  it("push ops → I1", () => {
    assert.strictEqual(classifyOpcode("const"), "I1");
    assert.strictEqual(classifyOpcode("const.true"), "I1");
    assert.strictEqual(classifyOpcode("local.get"), "I1");
    assert.strictEqual(classifyOpcode("global.get"), "I1");
  });

  it("local.set / global.set → I1", () => {
    assert.strictEqual(classifyOpcode("local.set"), "I1");
    assert.strictEqual(classifyOpcode("global.set"), "I1");
  });

  it("branch/control → B", () => {
    assert.strictEqual(classifyOpcode("jmp"), "B");
    assert.strictEqual(classifyOpcode("jmp_if"), "B");
    assert.strictEqual(classifyOpcode("jmp_if_not"), "B");
    assert.strictEqual(classifyOpcode("call"), "B");
    assert.strictEqual(classifyOpcode("ret"), "B");
    assert.strictEqual(classifyOpcode("invoke"), "B");
  });

  it("memory ops → M", () => {
    assert.strictEqual(classifyOpcode("field.get"), "M");
    assert.strictEqual(classifyOpcode("field.set"), "M");
  });
});

// ─── 2. buildDependencyGraph ─────────────────────────────────

describe("dependencyGraph.buildDependencyGraph", () => {
  it("const, const, add, local.set: edges 0→2, 1→2, 2→3", () => {
    const code: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "local.set", i: 0 },
    ] as RawInstruction[];
    const g = buildDependencyGraph(code);
    assert.strictEqual(g.nodes.length, 4);
    assert.deepStrictEqual(
      g.edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
      [
        [0, 2],
        [1, 2],
        [2, 3],
      ],
    );
  });

  it("const, local.set 0, local.get 0, const, add, local.set 1, local.get 1, ret: stack + store/load edges", () => {
    const code: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "local.set", i: 0 },
      { op: "local.get", i: 0 },
      { op: "const", type: "i32", k: 0 },
      { op: "add" },
      { op: "local.set", i: 1 },
      { op: "local.get", i: 1 },
      { op: "ret" },
    ] as RawInstruction[];
    const g = buildDependencyGraph(code, { argc: 0 });
    assert.strictEqual(g.nodes.length, 8);
    assert.ok(g.edges.some(([a, b]) => a === 0 && b === 1), "const → local.set 0");
    assert.ok(g.edges.some(([a, b]) => a === 1 && b === 2), "local.set 0 → local.get 0");
    assert.ok(g.edges.some(([a, b]) => a === 2 && b === 4), "local.get 0 → add");
    assert.ok(g.edges.some(([a, b]) => a === 3 && b === 4), "const → add");
    assert.ok(g.edges.some(([a, b]) => a === 4 && b === 5), "add → local.set 1");
    assert.ok(g.edges.some(([a, b]) => a === 5 && b === 6), "local.set 1 → local.get 1");
    assert.ok(g.edges.some(([a, b]) => a === 6 && b === 7), "local.get 1 → ret");
  });
});

// ─── 3. scheduleLinearBlock + packetsToCodeElements ──────────

describe("scheduler.scheduleLinearBlock", () => {
  it("all instructions present and deps respected", () => {
    const code: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "local.set", i: 0 },
    ] as RawInstruction[];
    const g = buildDependencyGraph(code);
    const packets = scheduleLinearBlock(code, g);
    const flat = packets.flat();
    assert.strictEqual(flat.length, 4, "all 4 instructions scheduled");
    const ops = flat.map((i) => (i as { op: string }).op);
    assert.ok(ops.includes("const"));
    assert.ok(ops.includes("add"));
    assert.ok(ops.includes("local.set"));
    assert.strictEqual(ops.filter((o) => o === "const").length, 2);
  });

  it("producers always in same or earlier packet than consumer", () => {
    const code: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "local.set", i: 0 },
    ] as RawInstruction[];
    const g = buildDependencyGraph(code);
    const packets = scheduleLinearBlock(code, g);
    const nodeToPacket = new Map<number, number>();
    let idx = 0;
    for (let p = 0; p < packets.length; p++) {
      for (const _ of packets[p]) {
        nodeToPacket.set(idx++, p);
      }
    }
    for (const [a, b] of g.edges) {
      const pa = nodeToPacket.get(a);
      const pb = nodeToPacket.get(b);
      assert.ok(pa !== undefined && pb !== undefined);
      assert.ok(pa! <= pb!, `producer ${a} in packet ${pa} must be <= consumer ${b} in packet ${pb}`);
    }
  });
});

// ─── 4. Integration: scheduled code → VM → same result ───────

describe("scheduler integration: linear procedure → schedule → VM", () => {
  it("const 1, const 1, add, ret → VM returns 2 (pure stack deps)", async () => {
    const linear: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "ret" },
    ] as RawInstruction[];
    const constants = [1, 1];
    const g = buildDependencyGraph(linear);
    const packets = scheduleLinearBlock(linear, g);
    const code = packetsToCodeElements(packets);

    const module: OsVbcModule = {
      version: 2,
      moduleName: "scheduled_test",
      constants,
      procedures: [
        { name: "main", codeOffset: 0, argc: 0, localsCount: 0 },
      ],
      code,
    };

    const vm = new VM(module, { maxSteps: 10_000 });
    const result = await vm.runProcedure(0, []);
    assert.strictEqual(result, 2, "scheduled procedure must return 2 (1+1)");
  });

  it("const 1, local.set 0, local.get 0, const 1, add, local.set 1, local.get 1, ret → VM returns 2 (stack + store/load deps)", async () => {
    const linear: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "local.set", i: 0 },
      { op: "local.get", i: 0 },
      { op: "const", type: "i32", k: 0 },
      { op: "add" },
      { op: "local.set", i: 1 },
      { op: "local.get", i: 1 },
      { op: "ret" },
    ] as RawInstruction[];
    const constants = [1];
    const g = buildDependencyGraph(linear, { argc: 0 });
    assert.ok(g.edges.some(([a, b]) => a === 0 && b === 1), "const → local.set");
    assert.ok(g.edges.some(([a, b]) => a === 1 && b === 2), "local.set 0 → local.get 0");
    assert.ok(g.edges.some(([a, b]) => a === 4 && b === 5), "add → local.set 1");
    assert.ok(g.edges.some(([a, b]) => a === 5 && b === 6), "local.set 1 → local.get 1");
    const packets = scheduleLinearBlock(linear, g);
    const code = packetsToCodeElements(packets);
    const module: OsVbcModule = {
      version: 2,
      moduleName: "scheduled_test",
      constants,
      procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 2 }],
      code: [...code, { op: "ret" } as RawInstruction],
    };
    const vm = new VM(module, { maxSteps: 10_000 });
    const result = await vm.runProcedure(0, []);
    assert.strictEqual(result, 2, "scheduled procedure must return 2 (1+1) with store/load deps");
  });

  it("CLI: linear-sum.osvbc.json → schedule → VM returns 2", async () => {
    const fixtureDir = path.join(__dirname, "fixtures");
    const inputPath = path.join(fixtureDir, "linear-sum.osvbc.json");
    const outputPath = path.join(fixtureDir, "linear-sum.scheduled.osvbc.json");
    const cliPath = path.join(__dirname, "cli.ts");
    execSync(`npx tsx "${cliPath}" "${inputPath}" -o "${outputPath}"`, {
      encoding: "utf-8",
      cwd: path.resolve(__dirname, "../.."),
    });
    const raw = await fs.readFile(outputPath, "utf-8");
    const m = JSON.parse(raw) as OsVbcModule;
    assert.strictEqual(m.version, 2, "output must be .osvbc v2");
    const vm = new VM(m, { maxSteps: 10_000 });
    const result = await vm.runProcedure(0, []);
    assert.strictEqual(result, 2, "scheduled output must return 2 (1+1)");
  });
});
