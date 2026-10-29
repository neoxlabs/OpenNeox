import { describe, expect, it } from 'vitest';
import { resolveResearchModels, isSubscriptionProvider, describeModelPlan } from '../models.js';

const CLOUD = { sessionProviderId: 'neox-cloud', sessionModelName: 'deepseek-v4-pro', provider: { models: [] } };
const BYOK_DS = {
  sessionProviderId: 'deepseek',
  sessionModelName: 'deepseek-v4-pro',
  providerApiKey: 'sk-real-key',
  provider: { models: [{ name: 'deepseek-v4-pro' }, { name: 'deepseek-v4-flash' }] },
};

describe('订阅 vs BYOK 判据', () => {
  it('哨兵 providerId 是订阅', () => {
    expect(isSubscriptionProvider('neox-cloud')).toBe(true);
  });
  it('托管 key 是订阅', () => {
    expect(isSubscriptionProvider('whatever', 'neox-managed')).toBe(true);
  });
  it('模型清单为空是订阅 (云端不枚举模型)', () => {
    expect(isSubscriptionProvider('x', 'sk-abc', { models: [] })).toBe(true);
  });
  it('自己配 key 且有模型清单是 BYOK', () => {
    expect(isSubscriptionProvider('deepseek', 'sk-abc', { models: [{ name: 'deepseek-v4-pro' }] })).toBe(false);
  });
});

describe('订阅: leader 当前模型, worker 同系列 flash', () => {
  it('deepseek-v4-pro → worker deepseek-v4-flash', () => {
    const plan = resolveResearchModels(CLOUD);
    expect(plan.kind).toBe('subscription');
    expect(plan.leader.modelName).toBe('deepseek-v4-pro');
    expect(plan.worker.modelName).toBe('deepseek-v4-flash');
  });

  it('leader 永远是当前会话模型 —— 不许被降级带走', () => {
    const plan = resolveResearchModels(CLOUD);
    expect(plan.leader).toEqual({ providerId: 'neox-cloud', modelName: 'deepseek-v4-pro' });
  });

  it('派生不出 fast 变种就回落主模型, 不编一个不存在的名字', () => {
    const plan = resolveResearchModels({ ...CLOUD, sessionModelName: 'some-unknown-model-v1' });
    expect(plan.worker.modelName).toBe('some-unknown-model-v1');
  });
});

describe('BYOK: 默认全用当前模型', () => {
  it('即使 provider 里有 flash, 默认也不自动降级', () => {
    const plan = resolveResearchModels(BYOK_DS);
    expect(plan.kind).toBe('byok');
    expect(plan.worker.modelName).toBe('deepseek-v4-pro');
    expect(plan.leader.modelName).toBe('deepseek-v4-pro');
  });

  it('用户主动开了自动降级才换', () => {
    const plan = resolveResearchModels({ ...BYOK_DS, byokAutoDowngrade: true });
    expect(plan.worker.modelName).toBe('deepseek-v4-flash');
  });

  it('用户显式指定 worker 模型 → 一切照它, 不看降级开关', () => {
    const plan = resolveResearchModels({
      ...BYOK_DS,
      overrideWorkerProviderId: 'opencode',
      overrideWorkerModelName: 'deepseek-v4-flash',
    });
    expect(plan.worker).toEqual({ providerId: 'opencode', modelName: 'deepseek-v4-flash' });
    expect(plan.source).toBe('configured');
  });

  it('订阅下用户指定也照它', () => {
    const plan = resolveResearchModels({
      ...CLOUD,
      overrideWorkerProviderId: 'neox-cloud',
      overrideWorkerModelName: 'deepseek-v4-pro',
    });
    expect(plan.worker.modelName).toBe('deepseek-v4-pro');
    expect(plan.source).toBe('configured');
  });
});

describe('说明文案', () => {
  it('两边不同时都报出来', () => {
    expect(describeModelPlan(resolveResearchModels(CLOUD)))
      .toBe('订阅 · leader deepseek-v4-pro / worker deepseek-v4-flash (auto-haiku)');
  });
  it('两边相同时说"都用"', () => {
    expect(describeModelPlan(resolveResearchModels(BYOK_DS))).toContain('都用 deepseek-v4-pro');
  });
});
