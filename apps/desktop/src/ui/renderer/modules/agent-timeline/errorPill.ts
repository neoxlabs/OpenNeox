
export type ErrorKind = 'server' | 'network' | 'auth' | 'quota' | 'model' | 'desktop';

export interface ErrorPillSpec {
  kind: ErrorKind;
  label: string;
  /** null = 用户做什么都没用, 别给假按钮 */
  action: string | null;
  /** 此刻根本发不出消息 = 红, 否则黄 */
  blocking: boolean;
}

export function describeKind(kind: ErrorKind, zh: boolean): ErrorPillSpec {
  switch (kind) {
    case 'server':
      return { kind, label: zh ? '服务器出问题了' : 'Server problem', action: null, blocking: false };
    case 'network':
      return { kind, label: zh ? '网络连不上' : 'Network unreachable', action: zh ? '重试' : 'Retry', blocking: false };
    case 'auth':
      return { kind, label: zh ? '登录已失效' : 'Sign-in expired', action: zh ? '重新登录' : 'Sign in', blocking: true };
    case 'quota':
      return { kind, label: zh ? '额度已用尽' : 'Quota exhausted', action: zh ? '看套餐' : 'View plan', blocking: true };
    case 'model':
      return { kind, label: zh ? '这个模型用不了' : 'Model unavailable', action: zh ? '换模型' : 'Switch model', blocking: true };
    case 'desktop':
      return { kind, label: zh ? '电脑没连上' : 'Computer offline', action: zh ? '去连接' : 'Connect', blocking: false };
  }
}

/** 从错误码/状态码判断属于哪一层. 跟手机端 classifyError 一一对应. */
export function classifyError(input: { statusCode?: number | null; code?: string | null; message?: string | null }): ErrorKind {
  const c = (input.code ?? '').toUpperCase();
  const m = input.message ?? '';

  if (c === 'AUTH_REFRESH_UNAVAILABLE') return 'network';
  if (c.startsWith('AUTH_') || c === 'SESSION_EXPIRED' || c === 'NOT_AUTHENTICATED') return 'auth';
  if (c.startsWith('NETWORK_')) return 'network';

  /* membershipStore 上报的是 HTTP_401 这种形状 */
  const httpMatch = /^HTTP_(\d{3})$/.exec(c);
  const status = input.statusCode ?? (httpMatch ? Number(httpMatch[1]) : undefined);

  if (status === 401) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  if (status === 403) return 'model';
  if (typeof status === 'number' && status >= 500) return 'server';

  /* 兜底只认网关的固定文案, 别的一律不猜 */
  if (m.includes('额度') || m.includes('用尽')) return 'quota';
  if (m.includes('模型') && (m.includes('停用') || m.includes('不可用'))) return 'model';
  if (m.includes('登录') && (m.includes('过期') || m.includes('失效'))) return 'auth';
  if (m.includes('电脑') && (m.includes('没连') || m.includes('连不上'))) return 'desktop';

  return 'server';
}
