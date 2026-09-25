/**
 * resolveModelProfile 的用户覆盖层
 *
 * 设置页「模型适配」右栏改的每一格都落到 config.modelProfileOverrides[modelKey],
 * 由 resolver 作为**最后一层**合并。放在 resolver 而不是各调用点, 是因为解析入口有四个
 * (runtimeBuilder / systemPrompt / CLI / 桌面 IPC) —— 分散实现迟早漏一个, 表现为
 * "设置里改了, 某条路径上不生效"。这组用例钉住这个口径。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveBuiltinModelProfile } from '../resolver.js';
import { setKernelConfigProvider } from '../../core/kernelConfigBridge.js';

const INPUT = { protocol: 'anthropic', model: 'claude-opus-4-8', baseUrl: '' };

afterEach(() => setKernelConfigProvider(null));

describe('resolveModelProfile — 用户覆盖层', () => {
  it('没有覆盖时结果与内置解析一致', () => {
    setKernelConfigProvider(() => ({}));
    const base = resolveBuiltinModelProfile(INPUT);
    setKernelConfigProvider(() => ({ modelProfileOverrides: {} }));
    expect(resolveBuiltinModelProfile(INPUT)).toEqual(base);
  });

  it('覆盖压过内置值, 且只影响被覆盖的那一格', () => {
    const base = resolveBuiltinModelProfile(INPUT);
    setKernelConfigProvider(() => ({
      modelProfileOverrides: { 'claude-opus-4-8': { reasoning: { effort: 'minimal' } } },
    }));
    const merged = resolveBuiltinModelProfile(INPUT);
    expect(merged.reasoning?.effort).toBe('minimal');
    /* 同一节里没被覆盖的字段必须保留内置值 —— 否则就是整节被替换掉了 */
    expect(merged.reasoning?.summary).toBe(base.reasoning?.summary);
    expect(merged.completion).toEqual(base.completion);
  });

  it('modelKey 大小写不敏感前提: 存的是小写 key, 大写模型名同样命中', () => {
    setKernelConfigProvider(() => ({
      modelProfileOverrides: { 'claude-opus-4-8': { loop: { strategy: 'fast_converge' } } },
    }));
    const merged = resolveBuiltinModelProfile({ ...INPUT, model: 'Claude-Opus-4-8' });
    expect(merged.loop?.strategy).toBe('fast_converge');
  });

  it('别的模型的覆盖不会串到这个模型上', () => {
    const base = resolveBuiltinModelProfile(INPUT);
    setKernelConfigProvider(() => ({
      modelProfileOverrides: { 'gpt-5.6': { reasoning: { effort: 'minimal' } } },
    }));
    expect(resolveBuiltinModelProfile(INPUT).reasoning?.effort).toBe(base.reasoning?.effort);
  });

  it('id / match / priority 不接受覆盖 —— 那是"这个包是谁", 不是"它怎么配"', () => {
    const base = resolveBuiltinModelProfile(INPUT);
    setKernelConfigProvider(() => ({
      modelProfileOverrides: {
        'claude-opus-4-8': { id: 'hacked', priority: 999, match: { protocols: ['nope'] } },
      },
    }));
    const merged = resolveBuiltinModelProfile(INPUT);
    expect(merged.id).toBe(base.id);
    expect(merged.match).toEqual(base.match);
  });

  it('有覆盖时 sourceProfileIds 末尾标出 user-override (界面据此显示"已改")', () => {
    setKernelConfigProvider(() => ({
      modelProfileOverrides: { 'claude-opus-4-8': { reasoning: { effort: 'low' } } },
    }));
    expect(resolveBuiltinModelProfile(INPUT).sourceProfileIds?.at(-1)).toBe('user-override');
  });

  it('provider 没接上 (纯 kernel) 时不报错, 退回内置解析', () => {
    setKernelConfigProvider(null);
    expect(() => resolveBuiltinModelProfile(INPUT)).not.toThrow();
  });
});
