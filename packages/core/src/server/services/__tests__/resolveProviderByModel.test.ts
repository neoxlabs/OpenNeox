/** 未指定 provider 时，模型名只在唯一 provider 声明它时参与 provider 解析。 */
import { describe, expect, it } from 'vitest';

/** 复刻 ProviderResolverService.resolve 的选家逻辑 —— 真实实现依赖 store/配置盘,
 *  这里按同一份契约建最小实现验**判据**。真实实现改了这里要一起改。 */
type P = { id: string; models: Array<{ name: string }> };
function pickProvider(
  providers: P[],
  defaultId: string,
  providerId?: string,
  modelName?: string,
): string | null {
  if (providerId) return providers.find((p) => p.id === providerId)?.id ?? null;
  if (modelName) {
    const declaring = providers.filter((p) => p.models.some((m) => m.name === modelName));
    /* 只在**恰好一个**声明时才认 —— 多个说明信息不足, 猜错家比不猜更糟 */
    if (declaring.length === 1) return declaring[0]!.id;
  }
  return providers.find((p) => p.id === defaultId)?.id ?? null;
}

/** ProviderStore 返回的配置形状。 */
const REAL: P[] = [
  { id: 'by-ok', models: [{ name: 'gpt-5.5' }, { name: 'gpt-5.6-sol' }] },
  { id: 'deepseek', models: [{ name: 'deepseek-v4-flash' }, { name: 'deepseek-v4-pro' }] },
  { id: 'grok', models: [{ name: 'grok-4.6' }, { name: 'grok-4.5' }] },
  { id: 'opencode', models: [{ name: 'mimo-v2.5' }, { name: 'deepseek-v4-flash' }, { name: 'glm-5.3' }] },
];
const DEFAULT_ID = 'grok';   /* 默认家 —— bug 期间所有子 agent 都被发到这里 */

describe('按模型名找到唯一声明它的 provider', () => {
  it('mimo-v2.5 只有 opencode 有 → 选 opencode (bug 期间选的是默认家)', () => {
    expect(pickProvider(REAL, DEFAULT_ID, undefined, 'mimo-v2.5')).toBe('opencode');
  });

  it('glm-5.3 同理', () => {
    expect(pickProvider(REAL, DEFAULT_ID, undefined, 'glm-5.3')).toBe('opencode');
  });
});

describe('⚠️ 拿不准就别猜', () => {
  it('多家都声明的模型 → 不猜, 回默认家 (deepseek-v4-flash 在 deepseek 和 opencode 下都有)', () => {
    expect(pickProvider(REAL, DEFAULT_ID, undefined, 'deepseek-v4-flash')).toBe(DEFAULT_ID);
  });

  it('没人声明的模型 → 回默认家, 让上游去报错 (可能是新模型, 本地清单没同步)', () => {
    expect(pickProvider(REAL, DEFAULT_ID, undefined, 'brand-new-model')).toBe(DEFAULT_ID);
  });

  it('没给模型名也没给 provider → 默认家 (老行为不变)', () => {
    expect(pickProvider(REAL, DEFAULT_ID)).toBe(DEFAULT_ID);
  });
});

describe('显式 providerId 永远优先 —— 它比模型名更明确', () => {
  it('给了 providerId 就用它, 哪怕该模型别家也有', () => {
    expect(pickProvider(REAL, DEFAULT_ID, 'opencode', 'deepseek-v4-flash')).toBe('opencode');
    expect(pickProvider(REAL, DEFAULT_ID, 'deepseek', 'deepseek-v4-flash')).toBe('deepseek');
  });
});

/**
 * layer 2: 子 agent 优先留在主 agent 那一家
 *
 *   同名模型好几家都有时, 换模型不该顺带换家 —— 换家 = 换 key、换计费、换限流池,
 *   而用户的意图只是"这一步用轻一点的模型"。
 */
function resolveForSubAgent(providers: P[], defaultId: string, homeId: string, alias: string): string | null {
  const home = providers.find((p) => p.id === homeId);
  if (home?.models.some((m) => m.name === alias)) return homeId;      // 主家有 → 留在主家
  return pickProvider(providers, defaultId, undefined, alias);        // 没有 → 按模型名找
}

describe('子 agent 优先留在主 agent 所在的 provider', () => {
  it('主家有这个模型 → 留在主家 (不被"别家也有"抢走)', () => {
    expect(resolveForSubAgent(REAL, DEFAULT_ID, 'opencode', 'deepseek-v4-flash')).toBe('opencode');
    expect(resolveForSubAgent(REAL, DEFAULT_ID, 'deepseek', 'deepseek-v4-flash')).toBe('deepseek');
  });

  it('主家没有 → 退回按模型名找 (mimo 只在 opencode, 主家是 deepseek)', () => {
    expect(resolveForSubAgent(REAL, DEFAULT_ID, 'deepseek', 'mimo-v2.5')).toBe('opencode');
  });

  it('主家没有且没人有 → 默认家', () => {
    expect(resolveForSubAgent(REAL, DEFAULT_ID, 'deepseek', 'nobody-has-this')).toBe(DEFAULT_ID);
  });
});
