/**
 * ЗОНД ШИРИНЫ ОКНА ВЫЗЫВАЕМОЙ (вопрос §3.18, вопрос №2 в `docs/e2k-hardware-access.md`).
 *
 * # Зачем
 *
 * «Восемь регистров у вызываемой» измерено на **нашей** сборке порта (QEMU 11.0.1 + локальная
 * правка, `src/e2k/qemuModelPassport.ts`). Машина отвечает одной командой, поэтому зонд собран
 * заранее. Наблюдаемое — **факт возврата**: вызываемая пишет метку в свой `%rK` и возвращается
 * парой; вызывающий после возврата выходит кодом 42.
 *
 * ```
 *   вызывающий: setbn → disp → call 1 → exit 42
 *   вызываемая: movts 42 → %rK → return %ctpr3 → ct %ctpr3
 * ```
 *
 * Смысл ответа: код **42** — запись в `%rK` прошла, окно вызываемой не уже K+1; **9** (гостевое
 * исключение) — регистра нет, то есть окно уже́.
 *
 * # Почему НЕ через память (первая и вторая редакции — обе отклонены замером)
 *
 * 1. **Первая редакция** (`e2kWindowProbe.ts`, автор — владелец) заставляла вызываемую саму делать
 *    `exit`. Контроль дал статус 9: номер ABI лежит в `%r8`, которого у вызываемой нет, — вопроса
 *    не задать, потому что наблюдаемого выхода из вызываемой не существует.
 * 2. **Вторая редакция** писала метку в память. Замер (`.tmp/debug-window-probe.ts`): внутри
 *    вызываемой **`movtd` и `std`/`ldd` с базовыми регистрами `%b[]` — ловушка**, а `movts` в
 *    регистр окна работает. То есть адрес в вызываемой не построить: `%b[]` живёт только внутри
 *    своего окна, и у вызываемой его нет.
 * 3. **Эта редакция** обходится без памяти вовсе: наблюдаемое — возврат.
 *
 * # Самопроверка (замер `.tmp/debug-window-probe.ts`, свип)
 *
 * ```
 *   %r4, %r5, %r6, %r7 → 42   (регистр есть, запись проходит, управление возвращается)
 *   %r8, %r9           → 9    (ловушка: регистра у вызываемой нет)
 * ```
 *
 * Значит контроль `%r7` обязан дать 42, вопрос `%r8` — НЕ 42. Не сойдётся — зонд в кит не пойдёт:
 * зонд, который ничего не проверяет, отправлять на машину нельзя.
 */
import { getEncoder, type AsmInstruction, type Operand } from "../e2k/backend";
import { MINIMAL_BASE, SYSCALL_WBS } from "../e2k/elfMinimal";
import { SYS_EXIT, HELLO_SETBN_RSZ, WINDOW_NUMBER_REGISTER } from "../e2k/syscallRuntime";
import { CT_COND_ALWAYS } from "../e2k/e2k-real";

/** Метка, которую вызываемая кладёт в свой регистр; ею же выходит вызывающий. */
export const WINDOW_PROBE_MARK = 42;
const encoder = getEncoder("e2k");
const imm = (value: number): Operand => ({ kind: "imm", value });
const w = (index: number): Operand => ({ kind: "reg", index, file: "window" });

/** Программа зонда: вызываемая пишет метку в свой `%rK` и возвращается парой. */
export function windowProbeProgram(register: number): Uint8Array {
  const caller = (target: number): AsmInstruction[] => [
    { mnemonic: "setbn", channel: 0, operands: [imm(HELLO_SETBN_RSZ), imm(0), imm(0)] },
    { mnemonic: "disp", channel: 0, operands: [imm(1), imm(target)] },
    { mnemonic: "call", channel: 0, operands: [imm(1), imm(SYSCALL_WBS)] },
    // Управление вернулось — значит запись в %rK прошла. Выходим меткой.
    { mnemonic: "movts", channel: 0, operands: [imm(WINDOW_PROBE_MARK), w(WINDOW_NUMBER_REGISTER + 1)] },
    { mnemonic: "movts", channel: 0, operands: [imm(SYS_EXIT), w(WINDOW_NUMBER_REGISTER)] },
    { mnemonic: "sdisp", channel: 0, operands: [imm(2), imm(0)] },
    { mnemonic: "call", channel: 0, operands: [imm(2), imm(SYSCALL_WBS)] },
  ];
  const callee: AsmInstruction[] = [
    { mnemonic: "movts", channel: 0, operands: [imm(WINDOW_PROBE_MARK), w(register)] },
    { mnemonic: "return", channel: 0, operands: [imm(3)] },
    { mnemonic: "ct", channel: 0, operands: [imm(3), imm(CT_COND_ALWAYS)] },
  ];
  const addressesOf = (list: readonly AsmInstruction[]): number[] => {
    const out: number[] = [];
    let offset = 0;
    for (const i of list) {
      out.push(offset);
      offset += encoder.encode(i).length;
    }
    return out;
  };
  const draft = caller(0).concat(callee);
  const calleeIndex = draft.length - callee.length;
  const target = (addressesOf(draft)[calleeIndex]! - addressesOf(draft)[1]!) / 8;
  if (!Number.isInteger(target)) throw new Error("цель перехода не кратна 8 байтам");
  const list = caller(target).concat(callee);
  const chunks = list.map((i) => encoder.encode(i));
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Область загрузки образа — та же, что у всех зондов и примеров. */
export const WINDOW_PROBE_BASE = MINIMAL_BASE;
