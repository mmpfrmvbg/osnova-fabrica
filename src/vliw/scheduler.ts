/**
 * List scheduling и упаковка в VLIW-пакеты (Этап 1.3).
 */

import type { RawInstruction } from "../runtime/vm/bytecode";
import type { VliwPacket } from "../runtime/vm/bytecode";
import { VLIW_SLOTS, possibleSlots, type SlotType } from "./e2kModel";
import type { DependencyGraph } from "./dependencyGraph";

const SLOT_ORDER: SlotType[] = ["I0", "I1", "M", "B"];
function slotTypeToIndex(st: SlotType): number {
  const i = SLOT_ORDER.indexOf(st);
  return i >= 0 ? i : 0;
}

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

export function scheduleLinearBlock(
  instructions: RawInstruction[],
  graph: DependencyGraph,
): RawInstruction[][] {
  const n = instructions.length;
  if (n === 0) return [];
  const { preds } = buildPredSucc(graph);
  const packets: RawInstruction[][] = [];
  let cur: (RawInstruction | null)[] = Array(VLIW_SLOTS).fill(null);
  let curNodes = new Set<number>();

  const flush = (): void => {
    const packed: RawInstruction[] = [];
    for (let i = 0; i < VLIW_SLOTS; i++) {
      if (cur[i] != null) packed.push(cur[i]!);
    }
    if (packed.length > 0) packets.push(packed);
    cur = Array(VLIW_SLOTS).fill(null);
    curNodes = new Set<number>();
  };

  // In-order упаковка: инструкции кладутся в пакеты строго в исходном порядке.
  // Это сохраняет порядок стековых операций (producer всегда раньше consumer в
  // потоке исполнения), в отличие от готового list scheduling, который переставляет
  // push/pop и ломает стек. Продюсер и потребитель никогда не попадают в один пакет:
  // если продюсер ещё лежит в текущем (открытом) пакете, пакет закрывается раньше.
  let i = 0;
  while (i < n) {
    const predInCur = preds[i].some((p) => curNodes.has(p));
    if (predInCur) {
      flush();
      continue;
    }

    const ins = instructions[i]!;
    const op = (ins as { op: string }).op;
    let placed = false;
    for (const slotType of possibleSlots(op)) {
      const slotIdx = slotTypeToIndex(slotType);
      if (cur[slotIdx] == null) {
        cur[slotIdx] = ins;
        curNodes.add(i);
        placed = true;
        break;
      }
    }
    if (placed) {
      i++;
    } else {
      flush();
    }
  }
  flush();

  return packets;
}

export function packetsToCodeElements(packets: RawInstruction[][]): Array<RawInstruction | VliwPacket> {
  const out: Array<RawInstruction | VliwPacket> = [];
  for (const pkt of packets) {
    if (pkt.length === 0) continue;
    if (pkt.length === 1) {
      out.push(pkt[0]);
      continue;
    }
    out.push({ packet: true, slots: pkt });
  }
  return out;
}
