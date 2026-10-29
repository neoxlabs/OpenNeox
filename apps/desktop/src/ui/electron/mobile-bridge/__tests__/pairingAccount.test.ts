import { describe, expect, it, vi } from 'vitest';

import { verifyPhoneAccount } from '../pairingAccount.js';

const phonePub = Buffer.alloc(32, 7);
const phonePubB64url = phonePub.toString('base64url');
const phonePubB64 = phonePub.toString('base64');

function loggedIn(userId: string | null = 'user-a') {
  return async () => ({ accessToken: 'tok-1', userId });
}

function devicesResponse(devices: unknown[]): Response {
  return new Response(JSON.stringify({ devices }), { status: 200 });
}

function deps(fetchImpl: any, extra: Record<string, unknown> = {}) {
  return {
    getDesktopAuth: loggedIn(),
    apiBase: 'https://api.test/',
    fetchImpl,
    ...extra,
  } as any;
}

const validInput = { phoneDeviceId: 'phone-1', phonePubkeyB64: phonePubB64url };

describe('verifyPhoneAccount (code:REMOTE-04)', () => {
  it('接受出现在本账号设备列表里的手机 (公钥 base64 两种写法都认)', async () => {
    const fetchImpl = vi.fn(async () => devicesResponse([
      { device_id: 'phone-1', pubkey_b64: phonePubB64 },
      { device_id: 'phone-2', pubkey_b64: Buffer.alloc(32, 9).toString('base64') },
    ]));

    const verdict = await verifyPhoneAccount(validInput, deps(fetchImpl));

    expect(verdict).toEqual({ ok: true, desktopUserId: 'user-a' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('https://api.test/api/v1/devices/my?kinds=mobile');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
  });

  it('拒绝不在本账号列表里的手机 (别人拿到码也配不上)', async () => {
    const fetchImpl = vi.fn(async () => devicesResponse([
      { device_id: 'someone-else', pubkey_b64: phonePubB64 },
    ]));

    const verdict = await verifyPhoneAccount(validInput, deps(fetchImpl));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('account_mismatch');
  });

  it('device_id 相同但公钥不同也算不匹配 (防冒名顶替)', async () => {
    const fetchImpl = vi.fn(async () => devicesResponse([
      { device_id: 'phone-1', pubkey_b64: Buffer.alloc(32, 3).toString('base64') },
    ]));

    const verdict = await verifyPhoneAccount(validInput, deps(fetchImpl));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('account_mismatch');
  });

  it('电脑未登录时没有账号可绑 — 保持旧行为, 不请求云端', async () => {
    const fetchImpl = vi.fn();

    const verdict = await verifyPhoneAccount(validInput, deps(fetchImpl, { getDesktopAuth: async () => null }));

    expect(verdict).toEqual({ ok: true, desktopUserId: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('登录了但云端不可达 — 拒绝 (不放行, 否则这道校验可被绕过)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });

    const verdict = await verifyPhoneAccount(validInput, deps(fetchImpl));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('account_unverifiable');
  });

  it('云端 401 / 响应不是设备列表 — 拒绝', async () => {
    const unauthorized = vi.fn(async () => new Response('{}', { status: 401 }));
    const badShape = vi.fn(async () => new Response(JSON.stringify({ devices: 'nope' }), { status: 200 }));

    for (const fetchImpl of [unauthorized, badShape]) {
      const verdict = await verifyPhoneAccount(validInput, deps(fetchImpl));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('account_unverifiable');
    }
  });

  it('读不到登录态 — 拒绝', async () => {
    const fetchImpl = vi.fn();
    const verdict = await verifyPhoneAccount(validInput, deps(fetchImpl, {
      getDesktopAuth: async () => { throw new Error('auth broken'); },
    }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('account_unverifiable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('输入不合法时直接拒 — 不发网络请求', async () => {
    const fetchImpl = vi.fn();

    const shortKey = await verifyPhoneAccount({ phoneDeviceId: 'phone-1', phonePubkeyB64: 'abc' }, deps(fetchImpl));
    const noId = await verifyPhoneAccount({ phoneDeviceId: '  ', phonePubkeyB64: phonePubB64url }, deps(fetchImpl));

    expect(shortKey.ok).toBe(false);
    expect(noId.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
