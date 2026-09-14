/**
 * Граф зависимостей по стеку для линейного кода (Этап 1.2).
 * Симуляция стека: каждый push — узел (индекс инструкции), рёбра producer → consumer.
 */

import type { RawInstruction } from "../runtime/vm/bytecode";

export interface DependencyGraph {
  /** Индексы инструкций в порядке следования. */
  nodes: number[];
  /** Рёбра: [producerIndex, consumerIndex]. */
  edges: [number, number][];
}

/** Опции для построения графа: вызовы и локальные. */
export interface DependencyGraphOptions {
  callArgc?: (fi: number) => number;
  invokeArgc?: (name: string) => number;
  /** Число аргументов процедуры (локали 0..argc-1 считаются «входными», для local.get по ним не добавляется ребро store→load). */
  argc?: number;
  /** Чистая ли процедура по индексу (нет побочных эффектов → call не упорядочивается с эффектами). */
  callPure?: (fi: number) => boolean;
  /**
   * Чистый ли invoke по имени (read-only системный вызов → не упорядочивается с эффектами).
   * По умолчанию любой invoke считается эффектом.
   */
  invokePure?: (name: string) => boolean;
}

function getOp(ins: RawInstruction): string {
  return (ins as { op: string }).op;
}

export function buildDependencyGraph(
  instructions: RawInstruction[],
  options: DependencyGraphOptions = {},
): DependencyGraph {
  const edges: [number, number][] = [];
  const stack: number[] = [];
  const callArgc = options.callArgc ?? (() => 0);
  const invokeArgc = options.invokeArgc ?? (() => 0);
  const callPure = options.callPure ?? (() => false);
  const invokePure = options.invokePure ?? (() => false);
  const argc = options.argc ?? 0;
  const lastStore = new Map<number, number>();
  let lastEffect: number | undefined;

  for (let i = 0; i < instructions.length; i++) {
    const ins = instructions[i];
    const op = getOp(ins);

    switch (op) {
      case "const":
      case "const.true":
      case "const.false":
      case "const.null":
      case "global.get":
        stack.push(i);
        break;

      case "local.get": {
        const localIndex = (ins as { op: "local.get"; i: number }).i;
        if (localIndex >= argc) {
          const prev = lastStore.get(localIndex);
          if (prev !== undefined) edges.push([prev, i]);
        }
        stack.push(i);
        break;
      }

      case "add":
      case "sub":
      case "mul":
      case "div":
      case "rem":
      case "eq":
      case "ne":
      case "lt":
      case "le":
      case "gt":
      case "ge":
      case "and":
      case "or": {
        const b = stack.pop();
        const a = stack.pop();
        if (a !== undefined) edges.push([a, i]);
        if (b !== undefined) edges.push([b, i]);
        stack.push(i);
        break;
      }

      case "not": {
        const v = stack.pop();
        if (v !== undefined) edges.push([v, i]);
        stack.push(i);
        break;
      }

      case "local.set": {
        const v = stack.pop();
        if (v !== undefined) edges.push([v, i]);
        const localIndex = (ins as { op: "local.set"; i: number }).i;
        lastStore.set(localIndex, i);
        break;
      }

      case "global.set": {
        const v = stack.pop();
        if (v !== undefined) edges.push([v, i]);
        break;
      }

      case "ret": {
        const v = stack.pop();
        if (v !== undefined) edges.push([v, i]);
        break;
      }

      case "jmp_if":
      case "jmp_if_not": {
        const v = stack.pop();
        if (v !== undefined) edges.push([v, i]);
        break;
      }

      case "call": {
        const fi = (ins as { op: "call"; fi: number }).fi;
        const argc = callArgc(fi);
        for (let k = 0; k < argc; k++) {
          const a = stack.pop();
          if (a !== undefined) edges.push([a, i]);
        }
        if (!callPure(fi)) {
          if (lastEffect !== undefined) edges.push([lastEffect, i]);
          lastEffect = i;
        }
        stack.push(i);
        break;
      }

      case "invoke": {
        const name = (ins as { op: "invoke"; name: string }).name;
        const argc = invokeArgc(name);
        for (let k = 0; k < argc; k++) {
          const a = stack.pop();
          if (a !== undefined) edges.push([a, i]);
        }
        if (!invokePure(name)) {
          if (lastEffect !== undefined) edges.push([lastEffect, i]);
          lastEffect = i;
        }
        stack.push(i);
        break;
      }

      case "jmp":
        break;

      case "result.unwrap":
      case "result.tag": {
        const v = stack.pop();
        if (v !== undefined) edges.push([v, i]);
        stack.push(i);
        break;
      }

      case "dup": {
        const v = stack[stack.length - 1];
        if (v !== undefined) edges.push([v, i]);
        stack.push(i);
        break;
      }

      case "pop": {
        const v = stack.pop();
        if (v !== undefined) edges.push([v, i]);
        break;
      }

      default:
        stack.push(i);
        break;
    }
  }

  return { nodes: instructions.map((_, idx) => idx), edges };
}
