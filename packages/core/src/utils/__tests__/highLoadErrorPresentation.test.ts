import { describe, it, expect } from 'vitest';
import { extractNeoxEnvelopeFromError, parseNeoxErrorEnvelope, presentNeoxError } from '@neoxlabs/platform/utils/neoxErrorCatalogue.js';

/** 网关 writeNeoxError 写出来的真实形状 */
function gatewayBody(code: string, message: string) {
  return {
    error: { code, severity: 'warning', retryable: true, message, requestId: 'a1b2c3d4e5f60718' },
    type: 'server_busy',
  };
}

describe('高负载 / 熔断的错误呈现', () => {
  it('system.busy 不再落到未知码兜底 —— 有标准文案和「换个模型」按钮', () => {
    const env = parseNeoxErrorEnvelope(gatewayBody('system.busy', '服务繁忙, 请稍候重试'))!;
    const p = presentNeoxError(env);
    expect(p.title).toContain('使用人数');
    expect(p.action?.kind).toBe('switch_model');
    /* 高负载不是用户的错, 不该引导充值 */
    expect(p.action?.kind).not.toBe('topup');
    expect(p.severity).not.toBe('critical');
  });

  it('upstream.circuit_open 同样给「换个模型」而不是"联系管理员"', () => {
    const env = parseNeoxErrorEnvelope(gatewayBody('upstream.circuit_open', '该模型上游暂时不稳定'))!;
    const p = presentNeoxError(env);
    expect(p.action?.kind).toBe('switch_model');
  });

  it('requestId 从网关 body 一路解析出来 (报障能对上 request_logs)', () => {
    const env = parseNeoxErrorEnvelope(gatewayBody('system.busy', 'x'))!;
    expect(env.requestId).toBe('a1b2c3d4e5f60718');
  });

  it('requestId 穿过 SDK 把 body 塞进 message 的那层包装也还在', () => {
    const err = new Error(`503 ${JSON.stringify(gatewayBody('upstream.circuit_open', 'x'))}`);
    const env = extractNeoxEnvelopeFromError(err);
    expect(env?.requestId).toBe('a1b2c3d4e5f60718');
  });

  it('BYOK 直连 (没网关) 时没有 requestId, 不该凭空造一个', () => {
    const env = parseNeoxErrorEnvelope({ error: { code: 'auth.invalid_key', message: 'bad key' } })!;
    expect(env.requestId).toBeUndefined();
  });
});

