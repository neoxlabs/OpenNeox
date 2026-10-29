import { describe, it, expect } from 'vitest';
import { snapshotUniverCells, diffUniverCells, normalizeEditValue, isStructuralCommand, colName } from '../sheetSurfaceDiff';

const load = () => ({
  sheets: {
    'sheet-0': { cellData: { 0: { 0: { v: '月份' }, 1: { v: '市场费用' } }, 3: { 0: { v: '3月' }, 1: { v: '16,000.00' }, 3: { v: '47,000.00' } } } },
    'sheet-1': { cellData: { 0: { 1: { v: '796,000.00' } } } },
  },
});
const names = { 'sheet-0': '预算', 'sheet-1': '汇总' };

describe('diffUniverCells — 右栏表格只存改过的格', () => {
  it('没改 = 没有任何写 (打开/失焦不再整本重写)', () => {
    const d = load();
    expect(diffUniverCells(snapshotUniverCells(d), d, names)).toEqual([]);
  });

  it('只改一格: 只出这一格; 显示成缓存值的公式格 (D4) 不碰; 带千分位的输入还原成数', () => {
    const base = snapshotUniverCells(load());
    const d = load();
    (d.sheets['sheet-0'].cellData as any)[3][1] = { v: '20,000.00' };
    expect(diffUniverCells(base, d, names)).toEqual([{ sheet: '预算', edits: [{ cell: 'B4', value: 20000 }] }]);
  });

  it('清空 / 新格 / 公式 / 富文本', () => {
    const base = snapshotUniverCells(load());
    const d: any = load();
    delete d.sheets['sheet-0'].cellData[0][1];
    d.sheets['sheet-0'].cellData[5] = { 2: { f: '=SUM(B2:B4)', v: 0 }, 3: { p: { body: { dataStream: '备注\r\n' } } } };
    expect(diffUniverCells(base, d, names)).toEqual([{ sheet: '预算', edits: [
      { cell: 'B1', value: '' },
      { cell: 'C6', formula: '=SUM(B2:B4)' },
      { cell: 'D6', value: '备注' },
    ] }]);
  });

  it('预览里新建的工作表不能原地存', () => {
    const base = snapshotUniverCells(load());
    const d: any = load();
    d.sheets['sheet-9'] = { cellData: { 0: { 0: { v: 'x' } } } };
    expect(() => diffUniverCells(base, d, names)).toThrow('NEW_SHEET');
  });
});

describe('小工具', () => {
  it('值还原: 千分位 / 百分号 / 普通文本 / 空', () => {
    expect(normalizeEditValue('1,234,567.5')).toBe(1234567.5);
    expect(normalizeEditValue('35%')).toBeCloseTo(0.35);
    expect(normalizeEditValue('1,2')).toBe('1,2');
    expect(normalizeEditValue('')).toBe('');
    expect(normalizeEditValue(42)).toBe(42);
  });
  it('结构改动识别', () => {
    expect(isStructuralCommand('sheet.command.insert-row')).toBe(true);
    expect(isStructuralCommand('sheet.mutation.remove-rows')).toBe(true);
    expect(isStructuralCommand('sheet.command.move-range')).toBe(true);
    expect(isStructuralCommand('sheet.command.set-range-values')).toBe(false);
    expect(isStructuralCommand('sheet.mutation.set-range-values')).toBe(false);
  });
  it('列名', () => {
    expect(colName(0)).toBe('A');
    expect(colName(27)).toBe('AB');
  });
});
