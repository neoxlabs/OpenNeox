/**
 * 错误文案的兜底归网关，客户端只负责渲染。
 *
 *   网关消息是服务端错误文案的首选来源；本地目录只提供无法解析网关错误时的兜底，
 *   保持新增错误码和用户语言文案无需等待客户端发布。
 */
import { describe, it, expect } from 'vitest';
import { parseNeoxErrorEnvelope, presentNeoxError } from '../neoxErrorCatalogue.js';

describe('网关出文案, 客户端只渲染', () => {
  it('envelope 里的 hint 要被解出来 (老网关不发, 解成 undefined)', () => {
    const withHint = parseNeoxErrorEnvelope({
      error: { code: 'quota.exhausted', message: '本月额度已用完。', hint: '可升级套餐或等下个周期。' },
    });
    expect(withHint?.hint).toBe('可升级套餐或等下个周期。');

    const legacy = parseNeoxErrorEnvelope({
      error: { code: 'quota.exhausted', message: '本月额度已用完。' },
    });
    expect(legacy?.hint).toBeUndefined();
  });

  /* 必须**走 parseNeoxErrorEnvelope 造**。
   *   "网关的话优先"的判据从 起看的是**来源** (envelope.fromGateway) 而不是
   *   code 长什么样 —— 手搓一个 envelope 字面量等于绕过了来源标记, 测的就不是真实路径了。
   *   为什么要改判据: 我们自己也用带点的 code 抛错 (runtimeOrchestrator 的
   *   auth.login_required), 里面是硬编码英文, 按"形状"判会把那句英文摊给中文界面。 */
  it('命中本地表时, 网关的 message 仍然优先 (不被本地表盖掉)', () => {
    const env = parseNeoxErrorEnvelope({
      error: { code: 'quota.exhausted', message: '网关写的这句话必须原样出现' },
    })!;
    expect(env.fromGateway).toBe(true);
    expect(presentNeoxError(env).message).toBe('网关写的这句话必须原样出现');
  });

  it('⚠️ 本地抛的同名码走本地表 —— 我们自己写的 message 只有英文, 不许摊给中文界面', () => {
    /* runtimeOrchestrator 没配 provider 时抛的就是这个形状: 带点的 code + 硬编码英文 */
    const local = parseNeoxErrorEnvelope({
      code: 'auth.login_required',
      message: 'No provider configured. Please add an API provider first.',
    })!;
    expect(local.fromGateway).toBeUndefined();
    const p = presentNeoxError(local);
    expect(p.message).toContain('API 服务商');
    expect(p.title + p.message).not.toContain('No provider configured');
  });

  it('渲染出来的文案永远不许残留 {占位符} —— 带模板的本地句子仍走 details 填充', () => {
    const p = presentNeoxError(parseNeoxErrorEnvelope({
      error: { code: 'quota.window_exhausted', message: 'gateway text', details: { window: '60s' } },
    })!);
    expect(/\{[\w.]+\}/.test(p.message)).toBe(false);
  });

  it('网关的 hint 透传到渲染层; 网关没给就没有 hint', () => {
    const withHint = presentNeoxError({
      code: 'quota.exhausted',
      message: 'x',
      hint: '去设置里换个模型试试。',
    } as any);
    expect(withHint.hint).toBe('去设置里换个模型试试。');

    const legacy = presentNeoxError({ code: 'quota.exhausted', message: 'x' } as any);
    expect(legacy.hint).toBeUndefined();
  });

  it('未知 code (网关新增, 客户端还没这条) 也要能出网关的话, 不能只剩裸 code', () => {
    const p = presentNeoxError({
      code: 'model.capability_unsupported_brand_new',
      message: '这个模型不支持图片输入。',
    } as any);
    expect(p.message).toBe('这个模型不支持图片输入。');
    expect(p.showInTimeline).toBe(true);
  });
});
