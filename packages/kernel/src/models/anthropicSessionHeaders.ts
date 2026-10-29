import { randomUUID } from 'crypto';
import { headerSafeSessionId } from '../utils/headerSafeSessionId.js';

const sessionOf = new WeakMap<object, string>();

/** 构造 provider 时记下会话 id; 单发调用 (测试 / 标题生成…) 没有会话 id 就给这个实例一个固定的 */
export function rememberAnthropicSession(provider: object, config: { sessionId?: unknown }): void {
  const sid = typeof config.sessionId === 'string' && config.sessionId.trim()
    ? config.sessionId.trim()
    : `neox-${randomUUID()}`;
  sessionOf.set(provider, headerSafeSessionId(sid));
}

export function anthropicSessionHeaders(provider: object): Record<string, string> {
  const sid = sessionOf.get(provider);
  return sid ? { session_id: sid } : {};
}
