import { describe, it, expect } from 'vitest';
import { ARRAY_WINDOW_RSZ } from './arrayRuntime';
import { QEMU_MODEL } from './qemuModelPassport';
import { WINDOW_REGISTERS_CALLEE, WINDOW_REGISTERS_ENTRY } from './regAlloc';
import { calleeWindowRegisters, passportWindow, windowGeometryProblems } from './windowGeometry';

describe('геометрия окна: паспорт, константы раскладки и формула порта — одно число', () => {
  it('формула 2*(size_q − wbs) равна константе вызываемой, а окно входа — прологу образа', () => {
    const passport = passportWindow();
    expect(calleeWindowRegisters(QEMU_MODEL.window.sizeQ, QEMU_MODEL.window.wbs)).toBe(passport.callee);
    expect(WINDOW_REGISTERS_CALLEE, 'окно вызываемой').toBe(passport.callee);
    expect(WINDOW_REGISTERS_ENTRY, 'окно входа').toBe(2 * (ARRAY_WINDOW_RSZ + 1));
    expect(WINDOW_REGISTERS_ENTRY, 'окно входа обязано помещаться в окно вызывающего')
      .toBeLessThanOrEqual(passport.caller);
  });

  it('НЕГАТИВНЫЙ КОНТРОЛЬ: согласие не даёт замечаний, а каждое расхождение — названо', () => {
    const passport = passportWindow();
    const agree = { callee: passport.callee, caller: passport.caller };
    expect(windowGeometryProblems(agree), 'согласие').toEqual([]);
    // (1) константа разошлась с паспортом
    expect(
      windowGeometryProblems(agree, passport, { callee: passport.callee + 8, entry: passport.entry }).join(' '),
      'константа против паспорта',
    ).toMatch(/константа окна вызываемой/);
    // (2) паспорт разошёлся с константой — та же проверка с другой стороны
    expect(
      windowGeometryProblems(agree, { ...passport, callee: passport.callee + 8 }).join(' '),
      'паспорт против константы',
    ).toMatch(/константа окна вызываемой/);
    // (3) ЖИВАЯ модель дала другое число — то, чего до этого модуля не ловило ничто
    expect(
      windowGeometryProblems({ callee: passport.callee + 8, caller: passport.caller }).join(' '),
      'модель против константы',
    ).toMatch(/живая модель даёт вызываемой/);
    // (4) окно входа перестало помещаться в окно вызывающего
    expect(
      windowGeometryProblems({ callee: passport.callee, caller: passport.entry - 1 }).join(' '),
      'вход против вызывающего',
    ).toMatch(/константа входа требует/);
  });
});
