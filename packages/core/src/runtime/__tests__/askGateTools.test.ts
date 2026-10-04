import { describe, expect, it, beforeEach } from 'vitest';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { wrapAskGateToolsInPlace, SIDE_EFFECT_TOOL_NAMES } from '../askGateTools.js';
import { isAskSideEffectBlocked, clearAskSideEffectBlock, noteAskAnswered, __blockAskSideEffectsForTest } from '../../tools/askUserTool.js';

const SID = 'sess-ask-gate';
const mk = (name: string): Tool => ({
  name,
  description: `mock ${name}`,
  parameters: { type: 'object', properties: {} },
  async function() { return 'DID_RUN'; },
});

beforeEach(() => clearAskSideEffectBlock(SID));

describe('问完没人答 → 本轮禁副作用', () => {
  it('没闸时照常执行', async () => {
    const tools = [mk('write_file'), mk('readfile')];
    wrapAskGateToolsInPlace(tools, SID);
    expect(await (tools[0].function as any)({}, {})).toBe('DID_RUN');
    expect(await (tools[1].function as any)({}, {})).toBe('DID_RUN');
  });

  it('闸上之后: 写文件/命令行/浏览器被拒, 读文件照旧放行', async () => {
    const tools = [mk('write_file'), mk('execute_shell'), mk('browser_run'), mk('readfile'), mk('search')];
    wrapAskGateToolsInPlace(tools, SID);
    __blockAskSideEffectsForTest(SID);
    expect(isAskSideEffectBlocked(SID)).toBe(true);

    for (const t of tools.slice(0, 3)) {
      const out = String(await (t.function as any)({}, {}));
      expect(out).not.toBe('DID_RUN');
      const parsed = JSON.parse(out);
      expect(parsed.status).toBe('error');
      /* 「环境不具备」而不是「工具坏了」—— 界面按引导渲染, 不报红 */
      expect(parsed.precondition).toBe(true);
      expect(String(parsed.error)).toContain('没等到回答');
    }
    /* 它还要能把"卡在哪"讲清楚: 读和搜不拦 */
    expect(await (tools[3].function as any)({}, {})).toBe('DID_RUN');
    expect(await (tools[4].function as any)({}, {})).toBe('DID_RUN');
  });

  it('用户答了 → 闸解除', async () => {
    const tools = [mk('write_file')];
    wrapAskGateToolsInPlace(tools, SID);
    __blockAskSideEffectsForTest(SID);
    noteAskAnswered(SID);
    expect(isAskSideEffectBlocked(SID)).toBe(false);
    expect(await (tools[0].function as any)({}, {})).toBe('DID_RUN');
  });

  it('闸按会话隔离 —— 别的会话不受影响', async () => {
    const mine = [mk('write_file')];
    const other = [mk('write_file')];
    wrapAskGateToolsInPlace(mine, SID);
    wrapAskGateToolsInPlace(other, 'sess-other');
    __blockAskSideEffectsForTest(SID);
    expect(String(await (mine[0].function as any)({}, {}))).not.toBe('DID_RUN');
    expect(await (other[0].function as any)({}, {})).toBe('DID_RUN');
    clearAskSideEffectBlock('sess-other');
  });

  it('原地包装, 不换数组身份 (liveTools 的活引用契约)', () => {
    const tools = [mk('write_file')];
    expect(wrapAskGateToolsInPlace(tools, SID)).toBe(tools);
  });

  it('副作用名单覆盖写盘/命令/浏览器三类', () => {
    for (const n of ['write_file', 'edit', 'execute_shell', 'browser_run', 'git_commit']) {
      expect(SIDE_EFFECT_TOOL_NAMES.has(n), n).toBe(true);
    }
    for (const n of ['readfile', 'search', 'list_directory', 'ask_user']) {
      expect(SIDE_EFFECT_TOOL_NAMES.has(n), n).toBe(false);
    }
  });
});
