/**
 * List scheduling и упаковка в VLIW-пакеты (Этап 1.3).
 * Вход: линейная последовательность инструкций и граф зависимостей.
 * Выход: массив пакетов (каждый пакет — до VLIW_SLOTS операций по слотам).
 */

import type { RawInstruction } from "../osnova-runtime/vm/bytecode";
import type { VliwPacket } from "../osnova-runtime/vm/bytecode";
import { VLIW_SLOTS, classifyOpcode, type SlotType } from "./e2kModel";
import type { DependencyGraph } from "./dependencyGraph";

const SLOT_ORDER: SlotType[] = ["I0", "I1", "M", "B"];
function slotTypeToIndex(st: SlotType): number {
  const i = SLOT_ORDER.indexOf(st);
  return i >= 0 ? i : 0;
}

/**
 * Строит списки предшественников и преемников по графу.
 */
function buildPredSucc(graph: DependencyGraph): { preds: number[][]; succs: number[][] } {
  const n = graph.nodes.length;
  const preds: number[][] = Array.from({ length: n }, () => []);
  const succs: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of graph.edges) {
    preds[b].push(a);
    succs[a].push(b);
  }
  return { preds, succs };
}

/**
 * List scheduling: на каждом цикле набирает пакет из готовых узлов по типам слотов,
 * закрывает пакет и обновляет множество готовых. Задержка пока 1 такт для всех операций.
 */
export function scheduleLinearBlock(
  instructions: RawInstruction[],
  graph: DependencyGraph,
): RawInstruction[][] {
  const n = instructions.length;
  if (n === 0) return [];
  const { preds, succs } = buildPredSucc(graph);
  const scheduled = new Set<number>();
  let ready = new Set<number>(graph.nodes.filter((i) => preds[i].length === 0));
  const packets: RawInstruction[][] = [];

  while (scheduled.size < n) {
    const packet: (RawInstruction | null)[] = Array(VLIW_SLOTS).fill(null);
    const used = new Set<number>();

    for (const node of ready) {
      if (scheduled.has(node)) continue;
      const ins = instructions[node];
      const op = (ins as { op: string }).op;
      const slotType = classifyOpcode(op);
      const slotIdx = slotTypeToIndex(slotType);
      if (packet[slotIdx] == null) {
        packet[slotIdx] = ins;
        used.add(node);
      }
    }
    for (const u of used) {
      scheduled.add(u);
      ready.delete(u);
      for (const s of succs[u]) {
        if (preds[s].every((p) => scheduled.has(p))) ready.add(s);
      }
    }
    const packed: RawInstruction[] = [];
    for (let i = 0; i < VLIW_SLOTS; i++) {
      if (packet[i] != null) packed.push(packet[i]!);
    }
    if (packed.length > 0) packets.push(packed);
    if (used.size === 0) {
      const stuck = graph.nodes.find((i) => !scheduled.has(i));
      if (stuck != null) {
        throw new Error(
          `Scheduler stuck: node ${stuck} has unscheduled predecessors ${preds[stuck].join(",")}`,
        );
      }
      break;
    }
  }

  return packets;
}

/**
 * Преобразует массив пакетов (массив инструкций на пакет) в массив CodeElement:
 * каждый пакет — элемент с packet: true и slots (и опционально deps).
 */
export function packetsToCodeElements(packets: RawInstruction[][]): Array<RawInstruction | VliwPacket> {
  const out: Array<RawInstruction | VliwPacket> = [];
  for (const pkt of packets) {
    if (pkt.length === 0) continue;
    if (pkt.length === 1) {
      out.push(pkt[0]);
      continue;
    }
    out.push({
      packet: true,
      slots: pkt,
    });
  }
  return out;
}
