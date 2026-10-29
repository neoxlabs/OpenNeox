/**
 * todo 契约回归
 *
 * The contract keeps update_todos as an upsert and restricts open_surface todo
 * sources to inline payloads, so every accepted result produces a renderable checklist.
 */
import { describe, it, expect } from 'vitest';
import { updateTodosTool } from '../updateTodosTool.js';
import { openSurfaceTool } from '../openSurfaceTool.js';
import { SURFACE_MARKER } from '../surfaceTypes.js';

const call = async (tool: any, args: any): Promise<any> => JSON.parse(await tool.function(args));

describe('update_todos', () => {
  it('不传 surface_id 也能用, 并带 ensureSurface 让 renderer 现场建', async () => {
    const r = await call(updateTodosTool, {
      items: [
        { id: 't1', text: '读 spec', status: 'done' },
        { id: 't2', text: '加运费', status: 'in_progress' },
      ],
    });
    expect(r[SURFACE_MARKER]).toBe(true);
    expect(r.action).toBe('todo_replace');
    expect(r.surfaceId).toBe('todo:current');
    expect(r.ensureSurface).toEqual({ kind: 'todo', title: '待办清单' });
    expect(r.todoItems).toHaveLength(2);
  });

  it('传了 surface_id 就用它, 同样带 ensureSurface (upsert 语义)', async () => {
    const r = await call(updateTodosTool, {
      surface_id: 'my-list',
      items: [{ id: 'a', text: 'x', status: 'pending' }],
    });
    expect(r.surfaceId).toBe('my-list');
    expect(r.ensureSurface.kind).toBe('todo');
  });

  it('items 非法仍然报错, 不会伪装成功', async () => {
    const r = await call(updateTodosTool, { items: [{ id: '', text: 'x', status: 'pending' }] });
    expect(r.error).toContain('items[0].id');
    expect(r[SURFACE_MARKER]).toBeUndefined();
  });
});

describe('open_surface kind=todo', () => {
  it('file 源在工具层就被拒, 不落 tab, 并指向 update_todos', async () => {
    const r = await call(openSurfaceTool, { kind: 'todo', source: { type: 'file', path: '/tmp/x.json' } });
    expect(r.error).toContain('only accepts source:{type:"inline"}');
    expect(r.next).toContain('update_todos');
    expect(r[SURFACE_MARKER]).toBeUndefined();
  });

  it('inline 源仍然放行', async () => {
    const r = await call(openSurfaceTool, { kind: 'todo', source: { type: 'inline', content: '{"items":[]}' } });
    expect(r[SURFACE_MARKER]).toBe(true);
    expect(r.surface.kind).toBe('todo');
  });
});
