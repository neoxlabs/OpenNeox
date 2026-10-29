
import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '../../../shared/ipc';
import {
  isSubscriptionAutoModel, isSubscriptionModel, isLowLatencyModel,
  pickChatFallbackModel, pickFallbackModel, pickReconsideredForMode, pickReconsideredModel,
  pickStartupModel, shouldReconsiderAutoPick,
} from '../modelDefaultPick';

const CLOUD = 'neox-cloud';

const m = (id: string, name: string, providerId: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id, name, provider: providerId, providerId, maxTokens: 8192, contextWindow: 128_000, ...extra,
});

/** 订阅段: 自动路由入口 + 几个真模型 */
const subAuto = m(`${CLOUD}:or-free-auto`, 'or-free-auto', CLOUD);
const subModel = m(`${CLOUD}:deepseek-v4-flash`, 'deepseek-v4-flash', CLOUD);
/** BYOK 段: 用户自己的 provider */
const byokDirect = m('deepseek:deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek');
const byokAuto = m('auto:or-free-auto', 'or-free-auto', 'auto', { isAutoRouted: true });

describe('isSubscriptionModel / isSubscriptionAutoModel', () => {
  it('只认 neox-cloud 这个 providerId', () => {
    expect(isSubscriptionModel(subModel)).toBe(true);
    expect(isSubscriptionModel(byokDirect)).toBe(false);
    expect(isSubscriptionModel(null)).toBe(false);
    expect(isSubscriptionModel(undefined)).toBe(false);
  });

  it("auto 入口 id 带档位前缀 (or-free-auto) 也算自动路由 —— 老的 name==='auto' 永远匹配不上", () => {
    expect(isSubscriptionAutoModel(subAuto)).toBe(true);
    expect(isSubscriptionAutoModel(subModel)).toBe(false);
  });

  it('BYOK 侧名字里有 auto 也不算订阅 auto', () => {
    expect(isSubscriptionAutoModel(byokAuto)).toBe(false);
  });
});

describe('pickFallbackModel · 兜底优先级', () => {
  it('订阅 auto 优先 (登录订阅用户的默认落点)', () => {
    expect(pickFallbackModel([byokDirect, subModel, subAuto])).toBe(subAuto);
  });

  it('没有 auto 入口 → 任意订阅', () => {
    expect(pickFallbackModel([byokDirect, subModel])).toBe(subModel);
  });

  it('订阅段为空 (未登录 / 纯 BYOK) → BYOK 直连, 不拿自动路由虚拟模型顶', () => {
    expect(pickFallbackModel([byokAuto, byokDirect])).toBe(byokDirect);
  });

  it('只剩自动路由虚拟模型 → 用它', () => {
    expect(pickFallbackModel([byokAuto])).toBe(byokAuto);
  });

  it('空列表 → null (启动那段据此跳过默认选中)', () => {
    expect(pickFallbackModel([])).toBeNull();
  });
});

describe('聊天模式默认走低延迟档 (chat:C8-01)', () => {
  const subPro = m(`${CLOUD}:deepseek-v4-pro`, 'deepseek-v4-pro', CLOUD);
  const subFlash = m(`${CLOUD}:deepseek-v4.1-flash`, 'deepseek-v4.1-flash', CLOUD);

  it('低延迟档按型号名识别: flash / mini / lite / haiku / nano', () => {
    for (const name of ['deepseek-v4.1-flash', 'gpt-5-mini', 'gemini-3-flash', 'claude-haiku-4-5', 'qwen3-nano']) {
      expect(isLowLatencyModel(m(`x:${name}`, name, 'x'))).toBe(true);
    }
    expect(isLowLatencyModel(subPro)).toBe(false);
    expect(isLowLatencyModel(subAuto)).toBe(false);
    /* 出图 / 语音模型不算对话模型 */
    expect(isLowLatencyModel(m('x:gpt-image-mini', 'gpt-image-mini', 'x'))).toBe(false);
  });

  it('聊天兑底: 订阅低延迟档 > 其他低延迟档 > 原兑底 (auto)', () => {
    expect(pickChatFallbackModel([subAuto, subPro, subFlash])).toBe(subFlash);
    expect(pickChatFallbackModel([subAuto, subPro,
      m('deepseek:deepseek-v4.1-flash', 'deepseek-v4.1-flash', 'deepseek')])?.name)
      .toBe('deepseek-v4.1-flash');
    /* 一个低延迟档都没有 → 回到原兑底顺序 */
    expect(pickChatFallbackModel([subAuto, subPro])).toBe(subAuto);
    expect(pickChatFallbackModel([subPro])).toBe(subPro);
    expect(pickChatFallbackModel([])).toBeNull();
  });

  it('用户自己选的高质量档不被聊天默认改造', () => {
    /* 启动那条路: lastPick 命中就直接用, 不走 pickChatFallbackModel */
    const models = [subAuto, subFlash, subPro];
    const lastPick = models.find((x) => x.id === subPro.id);
    expect(lastPick).toBe(subPro);
    expect(pickReconsideredModel({
      subscription: [subAuto, subFlash, subPro], savedModelId: subPro.id, preferLowLatency: true,
    })).toBe(subPro);
  });

  it('聊天模式且没保存过选择时, 回头改优先低延迟档', () => {
    expect(pickReconsideredModel({
      subscription: [subAuto, subPro, subFlash], savedModelId: null, preferLowLatency: true,
    })).toBe(subFlash);
    /* preferLowLatency=false 保持原行为 */
    expect(pickReconsideredModel({
      subscription: [subAuto, subPro, subFlash], savedModelId: null,
    })).toBe(subAuto);
  });

  it('启动时: 上次选的模型仍可用就不动 (含高质量档)', () => {
    const models = [subAuto, subFlash, subPro];
    expect(pickStartupModel(models, subPro.id, true)).toEqual({ model: subPro, autoPicked: false });
  });

  it('启动时: 没选过 → 聊天模式低延迟档, 其他模式原兑底', () => {
    const models = [subAuto, subPro, subFlash];
    expect(pickStartupModel(models, null, true)).toEqual({ model: subFlash, autoPicked: true });
    expect(pickStartupModel(models, null, false)).toEqual({ model: subAuto, autoPicked: true });
    expect(pickStartupModel(models, 'gone:somemodel', true)).toEqual({ model: subFlash, autoPicked: true });
  });

  it('pickReconsideredForMode 是 preferLowLatency 的简写', () => {
    const subscription = [subAuto, subPro, subFlash];
    expect(pickReconsideredForMode(subscription, null, true)).toBe(subFlash);
    expect(pickReconsideredForMode(subscription, null, false)).toBe(subAuto);
    expect(pickReconsideredForMode(subscription, subPro.id, true)).toBe(subPro);
  });
});

describe('shouldReconsiderAutoPick · 订阅段迟到后要不要回头改', () => {
  it('兜底挑的 BYOK + 订阅段到了 → 改 (这就是修的那个 bug)', () => {
    expect(shouldReconsiderAutoPick({
      current: byokDirect, autoPicked: true, subscriptionCount: 3,
    })).toBe(true);
  });

  it('用户自己挑的 BYOK → 不改', () => {
    expect(shouldReconsiderAutoPick({
      current: byokDirect, autoPicked: false, subscriptionCount: 3,
    })).toBe(false);
  });

  it('会话还原的模型 (标记已被清掉) → 不改', () => {
    expect(shouldReconsiderAutoPick({
      current: byokDirect, autoPicked: false, subscriptionCount: 3,
    })).toBe(false);
  });

  it('当前已经是订阅模型 → 不改', () => {
    expect(shouldReconsiderAutoPick({
      current: subModel, autoPicked: true, subscriptionCount: 3,
    })).toBe(false);
  });

  it('订阅段还是空的 (未登录 / 套餐没有可用云端模型) → 不改', () => {
    expect(shouldReconsiderAutoPick({
      current: byokDirect, autoPicked: true, subscriptionCount: 0,
    })).toBe(false);
  });

  it('啥都没选中 → 不改 (那条路由"一个都没选中"分支管)', () => {
    expect(shouldReconsiderAutoPick({
      current: null, autoPicked: true, subscriptionCount: 3,
    })).toBe(false);
  });
});

describe('pickReconsideredModel · 回头改的时候选哪个', () => {
  const subscription = [subAuto, subModel];

  it('用户上次那个订阅模型现在看得见了 → 就选它', () => {
    expect(pickReconsideredModel({ subscription, savedModelId: subModel.id })).toBe(subModel);
  });

  it('套餐清单第一个是语音合成 → 跳过它 (2026-10-16 新装进 Code 落在 cosyvoice)', () => {
    const tts = m(`${CLOUD}:cosyvoice-v3-flash`, 'cosyvoice-v3-flash', CLOUD);
    expect(pickReconsideredModel({ subscription: [tts, subModel], savedModelId: null })).toBe(subModel);
  });

  it('上次那个还没回来 → 退到订阅 auto', () => {
    expect(pickReconsideredModel({ subscription, savedModelId: `${CLOUD}:claude-opus-5` })).toBe(subAuto);
  });

  it('没有任何保存过的选择 → 订阅 auto', () => {
    expect(pickReconsideredModel({ subscription, savedModelId: null })).toBe(subAuto);
  });

  it('没有 auto 入口 → 订阅首项', () => {
    expect(pickReconsideredModel({ subscription: [subModel], savedModelId: null })).toBe(subModel);
  });

  it('订阅段为空 → null (什么都不动)', () => {
    expect(pickReconsideredModel({ subscription: [], savedModelId: subModel.id })).toBeNull();
  });
});

describe('完整时序 · 重启后掉到 BYOK (用户实拍)', () => {
  it('冷启动订阅段还没到 → 兜底落 BYOK 且标记为"兜底挑的"; 订阅段到了 → 回到订阅', () => {
    /* 1. 冷启动: membershipStore 是内存缓存, 重启即空 → subscription 段为空 */
    const subscriptionAtBoot: ModelInfo[] = [];
    const savedModelId = subModel.id;
    const bootModels = [byokDirect, byokAuto, ...subscriptionAtBoot];

    const lastPick = savedModelId ? bootModels.find((x) => x.id === savedModelId) : null;
    expect(lastPick).toBeUndefined();

    const chosen = lastPick ?? pickFallbackModel(bootModels);
    const autoPicked = !lastPick;
    expect(chosen).toBe(byokDirect);              /* ← 这就是用户看到的"掉到 BYOK" */
    expect(autoPicked).toBe(true);

    /* 2. 订阅段到了 */
    const subscription = [subAuto, subModel];
    expect(shouldReconsiderAutoPick({
      current: chosen, autoPicked, subscriptionCount: subscription.length,
    })).toBe(true);

    const fixed = pickReconsideredModel({ subscription, savedModelId });
    expect(fixed).toBe(subModel);
  });

  it('用户重启前就是有意选 BYOK 的 → 从头到尾都不动', () => {
    const savedModelId = byokDirect.id;
    const bootModels = [byokDirect, byokAuto];
    const lastPick = bootModels.find((x) => x.id === savedModelId);
    expect(lastPick).toBe(byokDirect);
    const autoPicked = false;                     /* lastPick 命中 = 用户的选择, 不是兜底 */
    expect(shouldReconsiderAutoPick({
      current: lastPick, autoPicked, subscriptionCount: 2,
    })).toBe(false);
  });
});
