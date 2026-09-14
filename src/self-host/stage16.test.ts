import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compileSource } from "../compiler/compiler";
import { VM, createDefaultInvokeHandler } from "../runtime/vm/interpreter";
import type { OsVbcModule } from "../runtime/vm/bytecode";

describe("self-hosting stage16: тип + массивы/объекты в кодогене", () => {
  it("self-check: тип, массив, объект, индекс и поле → сумма 3", async () => {
    const src = fs.readFileSync(path.resolve(__dirname, "stage16.osnova"), "utf-8");
    const compiled = compileSource(src);
    expect(
      compiled.module,
      [...compiled.lexerErrors, ...compiled.parserErrors, ...compiled.compilerErrors]
        .map((e) => e.message)
        .join("; "),
    ).not.toBeNull();

    let emitted = "";
    const base = createDefaultInvokeHandler();
    const vm = new VM(compiled.module!, {
      maxSteps: 1_000_000,
      invoke: async (name, args) => {
        if (name === "система.лог.вывести") {
          emitted = String(args[0]);
          return null;
        }
        return base(name, args);
      },
    });
    await vm.runProcedure(vm.findProcedureIndex("главная"), []);

    const genModule = JSON.parse(emitted) as OsVbcModule;
    const vm2 = new VM(genModule, { maxSteps: 1_000_000 });
    const result = await vm2.runProcedure(vm2.findProcedureIndex("главная"), []);
    expect(result).toBe(3);
  });
});
