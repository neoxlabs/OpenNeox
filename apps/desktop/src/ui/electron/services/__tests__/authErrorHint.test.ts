import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, '../agentBridge.ts'), 'utf8');

/* 把源码里那两个判定原样搬过来跑 —— agentBridge 整个类拉不起来 (electron 依赖链),
 * 但这两段是纯函数, 复刻一遍能真的跑出行为, 比断言正则长什么样有意义。
 * 下面第一条测试会校验复刻件跟源码没跑偏。 */
function looksLikeAuthFailure(message: string): boolean {
  if (/\b401\b/.test(message)) return true;
  if (/\bunauthorized\b/i.test(message)) return true;
  if (/authentication\s+(failed|error|required)/i.test(message)) return true;
  if (/invalid[_\s-]?api[_\s-]?key/i.test(message)) return true;
  return false;
}

describe('复刻件跟源码保持一致', () => {
  it('源码里就是这四条判定', () => {
    const i = SRC.indexOf('private looksLikeAuthFailure');
    expect(i, '找不到 looksLikeAuthFailure').toBeGreaterThan(0);
    const block = SRC.slice(i, i + 500);
    expect(block).toContain('\\b401\\b');
    expect(block).toContain('\\bunauthorized\\b');
    expect(block).toMatch(/authentication\\s\+\(failed\|error\|required\)/);
    expect(block).toMatch(/invalid\[_\\s-\]\?api/);
  });
});

describe('401 要有词边界, 不能在消息里到处命中', () => {
  it('真的鉴权失败仍然认得出来', () => {
    expect(looksLikeAuthFailure('HTTP 401 Unauthorized')).toBe(true);
    expect(looksLikeAuthFailure('status: 401')).toBe(true);
    expect(looksLikeAuthFailure('Authentication failed')).toBe(true);
    expect(looksLikeAuthFailure('invalid_api_key')).toBe(true);
    expect(looksLikeAuthFailure('Invalid API key provided')).toBe(true);
  });

  it('只是**碰巧含 401 的数字**不该算鉴权失败', () => {
    /* 这几条原来全会被判成"登录已过期", 然后让用户去做一件毫不相干的事。 */
    expect(looksLikeAuthFailure('request-id: req_9401ab')).toBe(false);
    expect(looksLikeAuthFailure('context length 1401 tokens exceeded')).toBe(false);
    expect(looksLikeAuthFailure('model gpt-4010 not found')).toBe(false);
    expect(looksLikeAuthFailure('read ECONNRESET after 4012ms')).toBe(false);
  });

  it('光提到 authentication 这个词不算失败', () => {
    expect(looksLikeAuthFailure('Supported authentication methods: bearer, basic')).toBe(false);
    expect(looksLikeAuthFailure('authentication required')).toBe(true);
  });
});

describe('文案按 provider 分流', () => {
  it('订阅走"重新登录", BYOK 走"检查 API Key", 未知走中性', () => {
    const i = SRC.indexOf('private authFailureHint');
    expect(i).toBeGreaterThan(0);
    const block = SRC.slice(i, i + 800);
    /* 订阅判定走 isNeoxCloudProviderId (官方云有不止一个 provider id), 不是写死 'neox-cloud' */
    expect(block).toMatch(/isNeoxCloudProviderId\(pid\).*\n?.*登录已过期/);
    expect(block, 'BYOK 分支必须提到 API Key 和服务商设置').toMatch(/API Key.*服务商设置/);
    /* provider 未知时不许默认指向登录 —— 那正是把 BYOK 用户带偏的那条路。 */
    const unknown = block.slice(0, block.indexOf('isNeoxCloudProviderId(pid)'));
    expect(unknown).toMatch(/若使用自配服务商/);
  });

  it('sendMessage 里确实把 providerId 记下来了 —— 不记就永远走中性分支', () => {
    expect(SRC).toMatch(/if \(providerId\) this\.lastProviderId = providerId;/);
  });

  it('403 也加了词边界', () => {
    expect(SRC).toMatch(/\/\\b403\\b\|forbidden\|denied\/i/);
  });
});
