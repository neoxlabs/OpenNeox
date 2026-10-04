import { describe, expect, it } from 'vitest';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

const mk = (name: string, fn?: () => Promise<string>): Tool => ({
  name,
  description: `mock ${name}`,
  parameters: { type: 'object', properties: { x: { type: 'string', description: 'x' } } },
  isReadOnly: true,
  function: fn ?? (async () => 'ok'),
});

const skillResult = (content: string, status = 'success') =>
  JSON.stringify({ type: 'contextual', status, tool: 'use_skill', summary: 'loaded', content });

function build(content: string, status?: string) {
  const SHEET = ['sheet_describe', 'sheet_write_range', 'sheet_export_file'];
  const tools = [mk('readfile'), mk('use_skill', async () => skillResult(content, status)), ...SHEET.map((n) => mk(n))];
  return new ToolTreeEngine(tools, {
    alwaysActive: new Set(['readfile', 'use_skill']),
    categories: [{ id: 'sheet', label: 'Sheet', description: 'sheet', toolNames: SHEET }],
  });
}

const callSkill = async (e: ToolTreeEngine) =>
  JSON.parse(await (e.liveTools.find((t) => t.name === 'use_skill')!.function as any)({ skill: 'excel-data' }));

describe('use_skill → 解锁技能点名的工具', () => {
  it('反引号里写的、存在的、还没解锁的工具被解锁, 用法附在结果后面', async () => {
    const e = build('用 `sheet_describe` 看表, 写回用 `sheet_write_range`; `readfile` 本来就在; `not_a_tool` 不存在');
    const r = await callSkill(e);
    const live = e.liveTools.map((t) => t.name);
    expect(live).toContain('sheet_describe');
    expect(live).toContain('sheet_write_range');
    expect(live).not.toContain('sheet_export_file');
    const appended = r.content.split('already unlocked')[1] ?? '';
    expect(appended).toContain('sheet_describe');
    expect(appended).not.toContain('not_a_tool');
    expect(appended).not.toContain('mock readfile');
  });

  it('技能加载失败 / 没点名工具: 结果原样返回', async () => {
    const failed = build('`sheet_describe`', 'error');
    const r1 = await callSkill(failed);
    expect(r1.content).toBe('`sheet_describe`');
    expect(failed.liveTools.map((t) => t.name)).not.toContain('sheet_describe');

    const plain = build('只是一段说明');
    const r2 = await callSkill(plain);
    expect(r2.content).toBe('只是一段说明');
  });
});
