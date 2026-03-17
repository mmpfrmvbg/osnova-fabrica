/**
 * Тесты планировщика VLIW: e2kModel, dependencyGraph, scheduler.
 * Запуск: npx vitest run
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { classifyOpcode, VLIW_SLOTS } from "./e2kModel";
import { buildDependencyGraph } from "./dependencyGraph";
import { scheduleLinearBlock, packetsToCodeElements } from "./scheduler";
import type { RawInstruction } from "../runtime/vm/bytecode";
import type { OsVbcModule } from "../runtime/vm/bytecode";
import { VM } from "../runtime/vm/interpreter";

describe("e2kModel.classifyOpcode", () => {
  it("VLIW_SLOTS is 4", () => { expect(VLIW_SLOTS).toBe(4); });

  it("ALU ops → I0", () => {
    expect(classifyOpcode("add")).toBe("I0");
    expect(classifyOpcode("sub")).toBe("I0");
    expect(classifyOpcode("mul")).toBe("I0");
    expect(classifyOpcode("eq")).toBe("I0");
    expect(classifyOpcode("lt")).toBe("I0");
  });

  it("push ops → I1", () => {
    expect(classifyOpcode("const")).toBe("I1");
    expect(classifyOpcode("const.true")).toBe("I1");
    expect(classifyOpcode("local.get")).toBe("I1");
    expect(classifyOpcode("global.get")).toBe("I1");
  });

  it("local.set / global.set → I1", () => {
    expect(classifyOpcode("local.set")).toBe("I1");
    expect(classifyOpcode("global.set")).toBe("I1");
  });

  it("branch/control → B", () => {
    expect(classifyOpcode("jmp")).toBe("B");
    expect(classifyOpcode("jmp_if")).toBe("B");
    expect(classifyOpcode("jmp_if_not")).toBe("B");
    expect(classifyOpcode("call")).toBe("B");
    expect(classifyOpcode("ret")).toBe("B");
    expect(classifyOpcode("invoke")).toBe("B");
  });

  it("memory ops → M", () => {
    expect(classifyOpcode("field.get")).toBe("M");
    expect(classifyOpcode("field.set")).toBe("M");
  });
});

describe("dependencyGraph.buildDependencyGraph", () => {
  it("const, const, add, local.set: edges 0→2, 1→2, 2→3", () => {
    const code: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "local.set", i: 0 },
    ] as RawInstruction[];
    const g = buildDependencyGraph(code);
    expect(g.nodes.length).toBe(4);
    expect(g.edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])).toEqual([[0, 2], [1, 2], [2, 3]]);
  });

  it("store/load edges present", () => {
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
    expect(g.nodes.length).toBe(8);
    expect(g.edges.some(([a, b]) => a === 1 && b === 2)).toBe(true);
    expect(g.edges.some(([a, b]) => a === 5 && b === 6)).toBe(true);
  });
});

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
    expect(flat.length).toBe(4);
    const ops = flat.map((i) => (i as { op: string }).op);
    expect(ops).toContain("const");
    expect(ops).toContain("add");
    expect(ops).toContain("local.set");
    expect(ops.filter((o) => o === "const").length).toBe(2);
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
      for (let s = 0; s < packets[p].length; s++) nodeToPacket.set(idx++, p);
    }
    for (const [a, b] of g.edges) {
      expect(nodeToPacket.get(a)!).toBeLessThanOrEqual(nodeToPacket.get(b)!);
    }
  });
});

describe("scheduler integration: linear procedure → schedule → VM", () => {
  it("const 1, const 1, add, ret → VM returns 2", async () => {
    const linear: RawInstruction[] = [
      { op: "const", type: "i32", k: 0 },
      { op: "const", type: "i32", k: 1 },
      { op: "add" },
      { op: "ret" },
    ] as RawInstruction[];
    const g = buildDependencyGraph(linear);
    const packets = scheduleLinearBlock(linear, g);
    const code = packetsToCodeElements(packets);
    const module: OsVbcModule = {
      version: 2,
      moduleName: "scheduled_test",
      constants: [1, 1],
      procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 0 }],
      code,
    };
    expect(await new VM(module, { maxSteps: 10_000 }).runProcedure(0, [])).toBe(2);
  });

  it("store/load deps → VM returns 2", async () => {
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
    const g = buildDependencyGraph(linear, { argc: 0 });
    const packets = scheduleLinearBlock(linear, g);
    const code = packetsToCodeElements(packets);
    const module: OsVbcModule = {
      version: 2,
      moduleName: "scheduled_test",
      constants: [1],
      procedures: [{ name: "main", codeOffset: 0, argc: 0, localsCount: 2 }],
      code: [...code, { op: "ret" } as RawInstruction],
    };
    expect(await new VM(module, { maxSteps: 10_000 }).runProcedure(0, [])).toBe(2);
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
    const m = JSON.parse(await fs.readFile(outputPath, "utf-8")) as OsVbcModule;
    expect(m.version).toBe(2);
    expect(await new VM(m, { maxSteps: 10_000 }).runProcedure(0, [])).toBe(2);
  });
});
