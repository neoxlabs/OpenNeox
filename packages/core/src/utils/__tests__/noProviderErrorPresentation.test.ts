import { describe, it, expect } from 'vitest';
import { NeoxError, ErrorCategory } from '@neoxlabs/kernel/types/errors.js';
import { extractNeoxEnvelopeFromError, presentNeoxError } from '@neoxlabs/platform/utils/neoxErrorCatalogue.js';

/** 与 runtimeOrchestrator 无 provider 分支抛的完全一致 */
function throwLikeOrchestrator(): NeoxError {
  return new NeoxError({
    code: 'auth.login_required',
    category: ErrorCategory.FATAL_AUTH,
    retryable: false,
    message: 'No provider configured. Please add an API provider first.',
  });
}

describe('无 provider 时的错误呈现', () => {
  it('抛出的 NeoxError 能被识别成 envelope (而不是无 code 的裸 Error)', () => {
    const env = extractNeoxEnvelopeFromError(throwLikeOrchestrator());
    expect(env).not.toBeNull();
    expect(env!.code).toBe('auth.login_required');
  });

  it('呈现出来是中文可读文案, 不是那句英文原文', () => {
    const env = extractNeoxEnvelopeFromError(throwLikeOrchestrator())!;
    const p = presentNeoxError(env);

    expect(p.title).toBe('需要配置 BYOK');
    expect(p.message).toContain('API 服务商');
    // 英文原句绝不能出现在用户眼前
    expect(p.title + p.message).not.toContain('No provider configured');
  });

  it('带"打开服务商设置"的 CTA —— 文案让用户去哪, 就得给得去的入口', () => {
    const env = extractNeoxEnvelopeFromError(throwLikeOrchestrator())!;
    const p = presentNeoxError(env);

    expect(p.action).toBeDefined();
    expect(p.action!.kind).toBe('open_providers');
    expect(p.action!.label).toBe('打开服务商设置');
  });

  it('在时间线里显示为失败块 (不能静默吞掉)', () => {
    const env = extractNeoxEnvelopeFromError(throwLikeOrchestrator())!;
    expect(presentNeoxError(env).showInTimeline).toBe(true);
  });

  it('对照组: 裸 Error 拿不到 code —— 正是修复前的坏行为', () => {
    const bare = new Error('No provider configured. Please add an API provider first.');
    expect(extractNeoxEnvelopeFromError(bare)).toBeNull();
  });
});
