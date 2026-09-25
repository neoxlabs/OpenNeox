/**
 * 额度类错误必须在时间线上显示可读文案。
 *
 *   两个条件共同约束这条路径:
 *     1. CATALOGUE 的 quota 家族**只有 rate_limit 一条**, 额度真用尽时没有 preset。
 *     2. presentNeoxError 直接 CATALOGUE[code] 查, 不解析任何别名, 而 kernel 的
 *        classifyError 产出的是 'INSUFFICIENT_BALANCE' 这类老 UPPERCASE 码。
 *   结果: 别名解析与 quota preset 必须同时生效，避免把 envelope.message 或裸 code 当标题。
 */
import { describe, it, expect } from 'vitest';
import { presentNeoxError } from '../neoxErrorCatalogue.js';

const AXIOS_NOISE = 'Request failed with status code 402';

describe('额度类错误必须有人话, 不能摊裸码', () => {
  it('INSUFFICIENT_BALANCE (kernel 给 402 打的码) 能解析到人话 + topup', () => {
    const r = presentNeoxError({ code: 'INSUFFICIENT_BALANCE', message: AXIOS_NOISE } as never);
    expect(r.title).toBe('额度已用尽');
    expect(r.title).not.toContain('INSUFFICIENT');
    expect(r.title).not.toBe(AXIOS_NOISE);
    expect(r.action?.kind).toBe('topup');
  });

  it('dot-namespace 的 quota.exhausted 同样命中', () => {
    expect(presentNeoxError({ code: 'quota.exhausted' } as never).title).toBe('额度已用尽');
  });

  it('QUOTA_EXCEEDED / USAGE_LIMIT_REACHED 都不再裸码', () => {
    for (const c of ['QUOTA_EXCEEDED', 'USAGE_LIMIT_REACHED']) {
      const r = presentNeoxError({ code: c, message: AXIOS_NOISE } as never);
      expect(r.title, c).not.toBe(c);
      expect(r.title, c).not.toBe(AXIOS_NOISE);
    }
  });

  it('限流不能被归进"额度用尽" — 它是等一下就好, 弹充值是敲竹杠', () => {
    const r = presentNeoxError({ code: 'HTTP_429' } as never);
    expect(r.action?.kind).toBe('wait');
    expect(r.title).not.toBe('额度已用尽');
  });

  it('短窗口用尽给"等", 不给"充值"', () => {
    expect(presentNeoxError({ code: 'quota.window_exhausted' } as never).action?.kind).toBe('wait');
  });

  it('别名表不得指向不存在的 CATALOGUE key (指了等于没指, 照样裸码)', () => {
    /* 逐条走一遍别名, 命中兜底就说明断链 */
    const legacy = ['INSUFFICIENT_BALANCE','QUOTA_EXCEEDED','USAGE_LIMIT_REACHED','HTTP_429',
                    'UNAUTHORIZED','CONNECT_TIMEOUT','TIMEOUT','STREAM_TIMEOUT',
                    'STREAM_IDLE_TIMEOUT','PROXY_UPSTREAM_FAILED','INVALID_REQUEST'];
    for (const c of legacy) {
      const r = presentNeoxError({ code: c, message: AXIOS_NOISE } as never);
      expect(r.title, `${c} 断链: 落到兜底`).not.toBe(AXIOS_NOISE);
      expect(r.title, `${c} 断链: 标题是裸码`).not.toBe(c);
    }
  });

  it('真未知 code 仍走兜底, 不炸', () => {
    const r = presentNeoxError({ code: 'totally.unknown', message: '某上游原话' } as never);
    expect(r.message).toBe('某上游原话');
  });
});
