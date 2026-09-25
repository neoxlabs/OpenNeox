/**
 * skillScope + trustLevel — K2 单测
 *
 * 覆盖:
 *  - deriveDefaultTrustLevel 按 source 推断
 *  - SkillScopeBox 跨 ALS context 共享 (key 设计点)
 *  - runWithSkillScopeBox 内 set/get/clear 正确语义
 *  - 不在 context 里 set 静默 noop, 不抛
 */

import { describe, it, expect } from 'vitest';
import { deriveDefaultTrustLevel } from '@neoxlabs/kernel/skills/types.js';
import {
  createSkillScopeBox,
  runWithSkillScopeBox,
  getSkillScope,
  setSkillScope,
  clearSkillScope,
  resetSkillScopeBox,
} from '@neoxlabs/kernel/skills/skillScope.js';

describe('deriveDefaultTrustLevel', () => {
  it('builtin/user/workspace → trusted (自己写的)', () => {
    expect(deriveDefaultTrustLevel('builtin')).toBe('trusted');
    expect(deriveDefaultTrustLevel('user')).toBe('trusted');
    expect(deriveDefaultTrustLevel('workspace')).toBe('trusted');
  });

  it('marketplace/mcp/plugin/managed → limited (外人写的)', () => {
    expect(deriveDefaultTrustLevel('marketplace')).toBe('limited');
    expect(deriveDefaultTrustLevel('mcp')).toBe('limited');
    expect(deriveDefaultTrustLevel('plugin')).toBe('limited');
    expect(deriveDefaultTrustLevel('managed')).toBe('limited');
  });
});

describe('SkillScopeBox + ALS context', () => {
  it('不在 context 里 set/get/clear 都 noop, 不抛', () => {
    expect(getSkillScope()).toBeNull();
    setSkillScope({ skillId: 'x', allowedTools: [], trustLevel: 'limited' });
    expect(getSkillScope()).toBeNull(); // 没 context, set 无效
    clearSkillScope(); // 不应该抛
  });

  it('runWithSkillScopeBox 内 set, 内 get 能读到', async () => {
    const box = createSkillScopeBox();
    await runWithSkillScopeBox(box, async () => {
      expect(getSkillScope()).toBeNull(); // 初始空
      setSkillScope({ skillId: 'commit', allowedTools: ['execute_shell', 'readfile'], trustLevel: 'trusted' });
      const got = getSkillScope();
      expect(got).not.toBeNull();
      expect(got!.skillId).toBe('commit');
      expect(got!.allowedTools).toEqual(['execute_shell', 'readfile']);
      expect(got!.trustLevel).toBe('trusted');
      expect(typeof got!.setAt).toBe('number');
    });
  });

  it('同一 box 跨多次 runWithSkillScopeBox 持续可见 (Runner pattern)', async () => {
    const box = createSkillScopeBox();

    // 第一次进入 box, 设 scope
    await runWithSkillScopeBox(box, async () => {
      setSkillScope({ skillId: 'review', allowedTools: ['edit'], trustLevel: 'limited' });
    });

    // 直接读 box.current — Runner 持有 box 引用, 跨 context 仍可见
    expect(box.current).not.toBeNull();
    expect(box.current!.skillId).toBe('review');

    // 第二次进入同 box (模拟下一轮 invokeTool), getSkillScope 读到的还是同一个
    await runWithSkillScopeBox(box, async () => {
      const got = getSkillScope();
      expect(got!.skillId).toBe('review');
    });
  });

  it('resetSkillScopeBox 跨 context 清掉, Runner.run() 入口用', async () => {
    const box = createSkillScopeBox();
    await runWithSkillScopeBox(box, async () => {
      setSkillScope({ skillId: 'foo', allowedTools: [], trustLevel: 'limited' });
    });
    expect(box.current).not.toBeNull();
    resetSkillScopeBox(box);
    expect(box.current).toBeNull();
  });

  it('clearSkillScope 在 context 内清当前 box', async () => {
    const box = createSkillScopeBox();
    await runWithSkillScopeBox(box, async () => {
      setSkillScope({ skillId: 'a', allowedTools: [], trustLevel: 'trusted' });
      expect(getSkillScope()).not.toBeNull();
      clearSkillScope();
      expect(getSkillScope()).toBeNull();
    });
    expect(box.current).toBeNull();
  });

  it('多个独立 box 互不污染 (并发 Runner 隔离)', async () => {
    const boxA = createSkillScopeBox();
    const boxB = createSkillScopeBox();

    await Promise.all([
      runWithSkillScopeBox(boxA, async () => {
        setSkillScope({ skillId: 'a-only', allowedTools: [], trustLevel: 'limited' });
        await new Promise(r => setImmediate(r));
        const got = getSkillScope();
        expect(got!.skillId).toBe('a-only');
      }),
      runWithSkillScopeBox(boxB, async () => {
        setSkillScope({ skillId: 'b-only', allowedTools: [], trustLevel: 'trusted' });
        await new Promise(r => setImmediate(r));
        const got = getSkillScope();
        expect(got!.skillId).toBe('b-only');
      }),
    ]);

    expect(boxA.current!.skillId).toBe('a-only');
    expect(boxB.current!.skillId).toBe('b-only');
  });
});
