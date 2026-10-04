import { describe, it, expect } from 'vitest';
import { resolveTaskAgentRoute } from '../taskAgentRoute.js';

const GLOBAL = { providerId: 'p-global', model: 'm-global' };
const MAP = { 'claude-opus-4-8': { providerId: 'p-anthropic', model: 'haiku-4-5' } };

describe('resolveTaskAgentRoute — 子 Agent 按主模型路由', () => {
  it('当前主模型配过 → 用它, 不看全局值', () => {
    expect(resolveTaskAgentRoute('claude-opus-4-8', MAP, GLOBAL))
      .toEqual({ providerId: 'p-anthropic', modelName: 'haiku-4-5' });
  });

  it('换个主模型 → 不再串用上一个的搭配, 退回全局值', () => {
    /* 未配置当前主模型时使用全局回退路由。 */
    expect(resolveTaskAgentRoute('gpt-5.6', MAP, GLOBAL))
      .toEqual({ providerId: 'p-global', modelName: 'm-global' });
  });

  it('主模型名大小写/空白不影响命中', () => {
    expect(resolveTaskAgentRoute('  Claude-Opus-4-8 ', MAP, GLOBAL)?.modelName).toBe('haiku-4-5');
  });

  it('两者都没配 → null, 交给上层按派系自动挑快变种', () => {
    expect(resolveTaskAgentRoute('gpt-5.6', {}, undefined)).toBeNull();
  });

  it('映射项残缺(只有 providerId 没有 model) → 当作没配, 退回全局', () => {
    expect(resolveTaskAgentRoute('x', { x: { providerId: 'p' } }, GLOBAL))
      .toEqual({ providerId: 'p-global', modelName: 'm-global' });
  });

  it('全局值残缺 → null, 不返回半个路由', () => {
    expect(resolveTaskAgentRoute('x', {}, { providerId: 'p' })).toBeNull();
  });

  it('主模型为空(拿不到会话模型) → 只看全局值', () => {
    expect(resolveTaskAgentRoute(undefined, MAP, GLOBAL)?.modelName).toBe('m-global');
  });
});
