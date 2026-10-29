import { describe, test, expect } from 'vitest';
import { pickDefaultAfterDeadKey } from '../runtimeBridgePrefs';
import type { ModelInfo } from '../../../shared/ipc';

const sub = [
  { id: 'neox-cloud:auto', name: 'auto', providerId: 'neox-cloud' },
  { id: 'neox-cloud:deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', providerId: 'neox-cloud' },
] as ModelInfo[];
const BYOK = 'opencode-zen:deepseek-v4.1-flash';

describe('pickDefaultAfterDeadKey', () => {
  test('默认模型就是报 401 的那个 BYOK → 换订阅同名', () => {
    expect(pickDefaultAfterDeadKey({ code: 'UNAUTHORIZED', failedModelId: BYOK, lastModelId: BYOK, subscription: sub })?.id)
      .toBe('neox-cloud:deepseek-v4.1-flash');
  });
  test('订阅里没同名 → 订阅 auto', () => {
    expect(pickDefaultAfterDeadKey({ code: '402', failedModelId: 'x:foo', lastModelId: 'x:foo', subscription: sub })?.id)
      .toBe('neox-cloud:auto');
  });
  test('网络抖动 / 失败的不是默认模型 / 默认本来就是订阅 / 没登录 → 不动', () => {
    expect(pickDefaultAfterDeadKey({ code: 'STREAM_TIMEOUT', failedModelId: BYOK, lastModelId: BYOK, subscription: sub })).toBeNull();
    expect(pickDefaultAfterDeadKey({ code: 'UNAUTHORIZED', failedModelId: 'x:foo', lastModelId: BYOK, subscription: sub })).toBeNull();
    expect(pickDefaultAfterDeadKey({ code: 'UNAUTHORIZED', failedModelId: 'neox-cloud:auto', lastModelId: 'neox-cloud:auto', subscription: sub })).toBeNull();
    expect(pickDefaultAfterDeadKey({ code: 'UNAUTHORIZED', failedModelId: BYOK, lastModelId: BYOK, subscription: [] })).toBeNull();
  });
});
