import { resolveCloudEndpoints } from './cloudEndpoints.js';
import { ensureFreshDesktopAuthTokens } from '../ipc/authHandlers.js';

export type PhonePushKind = 'call' | 'alert' | 'wake';

const DEVICES_TTL_MS = 10 * 60_000;
let pushable: { value: boolean; at: number } | null = null;
let refreshing: Promise<void> | null = null;

async function authed(path: string, init: RequestInit = {}): Promise<Response | null> {
  const tok = await ensureFreshDesktopAuthTokens().catch(() => null);
  if (!tok?.accessToken) return null;
  const { api } = resolveCloudEndpoints();
  return fetch(`${api}/api/v1/devices${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.accessToken}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
}

/** 后台刷新「账号下有没有能推的手机」 */
export function refreshPhonePushable(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const res = await authed('/push-token');
    if (!res) { pushable = { value: false, at: Date.now() }; return; }
    const j = await res.json().catch(() => ({})) as { devices?: unknown[] };
    pushable = { value: res.ok && Array.isArray(j.devices) && j.devices.length > 0, at: Date.now() };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function phonePushable(): boolean {
  if (!pushable || Date.now() - pushable.at > DEVICES_TTL_MS) void refreshPhonePushable();
  return pushable?.value === true;
}

/** 叫醒手机。不抛, 返回送没送到 (送到 = FCM 收下了, 不代表人看见了)。 */
export async function pushToPhone(kind: PhonePushKind, title: string, body: string, data: Record<string, string> = {}): Promise<boolean> {
  const res = await authed('/push', { method: 'POST', body: JSON.stringify({ kind, title, body, data }) });
  if (!res) return false;
  const j = await res.json().catch(() => ({})) as { ok?: boolean; sent?: number; errors?: string[] };
  if (!j.ok) console.warn(`[PilotPush] ${kind} 没推出去: HTTP ${res.status} ${(j.errors ?? []).join(' | ')}`);
  /* 推送说没有设备了 (令牌失效被删) → 下次别再当能推 */
  if (res.ok && j.sent === 0) pushable = { value: false, at: Date.now() };
  return !!j.ok;
}
