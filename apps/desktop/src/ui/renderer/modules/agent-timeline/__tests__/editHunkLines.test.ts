import { describe, it, expect } from 'vitest';
import { editHunkLines } from '../editHunkLines';

describe('editHunkLines', () => {
  it('没动的行是上下文, 计数只算真改的', () => {
    const d = editHunkLines(
      'export function sub(a,b){return a-b}',
      'export function sub(a,b){return a-b}\nexport function mul(a,b){return a*b}',
      2,
    );
    expect(d.add).toBe(1);
    expect(d.del).toBe(0);
    expect(d.lines.map((l) => l.kind)).toEqual(['ctx', 'add']);
    /* 行号按编辑起点偏移 */
    expect(d.lines[0]).toMatchObject({ oldNo: 2, newNo: 2 });
    expect(d.lines[1]).toMatchObject({ newNo: 3 });
  });

  it('真的改了一行: 一删一加', () => {
    const d = editHunkLines('import {add,sub} from "x";\nrun()', 'import {add,sub,mul} from "x";\nrun()', 1);
    expect(d.lines.map((l) => l.kind)).toEqual(['del', 'add', 'ctx']);
    expect([d.add, d.del]).toEqual([1, 1]);
  });

  it('新建 (旧文本为空) 全是加', () => {
    const d = editHunkLines('', 'a\nb', 1);
    expect(d.lines.map((l) => l.kind)).toEqual(['add', 'add']);
  });
});
