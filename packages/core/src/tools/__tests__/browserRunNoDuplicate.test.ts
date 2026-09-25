import { describe, it, expect } from 'vitest';
import { getTools } from '../runtimeTools.js';
import { ToolTreeEngine } from '../toolTreeEngine.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';

function dupsOf(names: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of names) (seen.has(n) ? dup : seen).add(n);
  return [...dup];
}

describe('工具名唯一性 (重名会让上游拒收整个请求)', () => {
  it('装配出来的工具表没有重名', async () => {
    const tools = (await (getTools as unknown as () => Promise<Tool[]>)()) ?? [];
    const names = tools.map((t) => t?.name).filter(Boolean) as string[];
    expect(names.length).toBeGreaterThan(30);
    expect(dupsOf(names), `重名: ${dupsOf(names).join(', ')}`).toEqual([]);
  });

  it('解锁 browser 包之后 liveTools 仍然没有重名 —— 这是实际炸掉的那一步', async () => {
    const tools = (await (getTools as unknown as () => Promise<Tool[]>)()) ?? [];
    const engine = new ToolTreeEngine(tools.filter(Boolean));
    engine.promote(['browser_run']);
    engine.promote(['browser_run']); /* 重复解锁同一个也不该长出第二份 */
    const names = engine.liveTools.map((t) => t.name);
    expect(dupsOf(names), `liveTools 里重名: ${dupsOf(names).join(', ')}`).toEqual([]);
  });

  it('browser_run 必须同时在 pack 归类清单和解锁清单里', async () => {
    const { BROWSER_PACK_TOOL_NAMES, MODEL_FACING_BROWSER_TOOL_NAMES } =
      await import('../../runtime/browser/browserToolDefs.js');
    /* 归类清单缺它 → 未分类安全网把它升成常驻, 再被解锁加一遍 = 重名 */
    expect(BROWSER_PACK_TOOL_NAMES).toContain('browser_run');
    /* 解锁清单缺它 → 模型根本拿不到脚本入口, 只能退回逐步点击 */
    expect(MODEL_FACING_BROWSER_TOOL_NAMES).toContain('browser_run');
    expect(dupsOf(BROWSER_PACK_TOOL_NAMES)).toEqual([]);
    expect(dupsOf(MODEL_FACING_BROWSER_TOOL_NAMES)).toEqual([]);
  });
});
