import { beforeEach, describe, expect, it, vi } from 'vitest';

const added = vi.hoisted(() => [] as any[]);

vi.mock('electron', () => ({ app: { getLocale: () => 'en' }, BrowserWindow: { getAllWindows: () => [] }, dialog: {} }));
vi.mock('../deviceStore.js', async () => {
  const { generateX25519Keypair } = await import('../crypto.js');
  const kp = generateX25519Keypair();
  return {
    getDeviceId: () => 'desktop-1',
    getDeviceName: () => 'Test Mac',
    getDesktopKeypair: () => kp,
    getDesktopPubkeyFingerprint: () => 'aa:bb:cc:dd',
    addPairedMobile: (m: any) => { added.push(m); },
  };
});
vi.mock('../log.js', () => ({ bridgeLog: () => {} }));
vi.mock('../index.js', () => ({ ensureCloudRelayClientRunning: async () => 'test' }));
vi.mock('../pairingAccount.js', () => ({ verifyPhoneAccount: async () => ({ ok: true, desktopUserId: null }) }));
vi.mock('../selfHostedRelay.js', () => ({ loadSelfHostedRelay: () => ({ url: 'https://relay.example.com', token: 't' }) }));

import { generateX25519Keypair } from '../crypto.js';
import { _clearPendingPairings, listPendingPairings } from '../pairing.js';
import { _resetPairRequest, handlePairRequest, pairCheckCode } from '../pairRequest.js';

const phone = generateX25519Keypair();
const body = (id = 'phone-1') => ({
  phone_pubkey: phone.publicKey.toString('base64url'),
  phone_device_id: id,
  phone_device_name: 'Pixel',
});

describe('pairRequest (同一 WiFi 点一下, 电脑确认)', () => {
  beforeEach(() => {
    _clearPendingPairings();
    _resetPairRequest();
    added.length = 0;
  });

  it('电脑点允许: 配对落库, 回包带自托管中继, 弹窗看到的核对码跟手机算的一致', async () => {
    let seen = '';
    const r = await handlePairRequest(body(), async ({ code, deviceName }) => {
      seen = code;
      expect(deviceName).toBe('Pixel');
      return true;
    });
    expect(r.status).toBe(200);
    expect((r.body as any).device_token).toBeTruthy();
    expect((r.body as any).relay.url).toBe('https://relay.example.com');
    expect(added).toHaveLength(1);
    expect(seen).toMatch(/^\d{6}$/);
    expect(seen).toBe(pairCheckCode(phone.publicKey.toString('base64')));
    expect(listPendingPairings()).toHaveLength(0);
  });

  it('电脑点拒绝: 不落库, 60 秒内同一台再来直接拒, 不再弹窗', async () => {
    const decide = vi.fn(async () => false);
    expect((await handlePairRequest(body(), decide)).status).toBe(403);
    expect((await handlePairRequest(body(), decide)).status).toBe(403);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(added).toHaveLength(0);
  });

  it('一个请求还在等确认时, 别的请求直接 busy (不能刷屏弹窗)', async () => {
    let release!: (v: boolean) => void;
    const first = handlePairRequest(body('a'), () => new Promise<boolean>((r) => { release = r; }));
    await Promise.resolve();
    expect((await handlePairRequest(body('b'), async () => true)).status).toBe(429);
    release(false);
    expect((await first).status).toBe(403);
  });

  it('手机断开 (取消) / 60 秒没人理: 弹窗被收掉, 不算拒绝, 不落库', async () => {
    const { EventEmitter } = await import('node:events');
    const res = Object.assign(new EventEmitter(), { writableFinished: false });
    let signal!: AbortSignal;
    const pending = handlePairRequest(body('c'), ({ signal: s }) => { signal = s; return new Promise<boolean>(() => {}); }, res);
    await Promise.resolve();
    res.emit('close');
    expect((await pending).status).toBe(408);
    expect(signal.aborted).toBe(true);

    vi.useFakeTimers();
    const slow = handlePairRequest(body('c'), () => new Promise<boolean>(() => {}));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await slow).status).toBe(408);
    vi.useRealTimers();
    expect(added).toHaveLength(0);
  });

  it('公钥不是 32 字节 / 缺字段: 400, 不弹窗', async () => {
    const decide = vi.fn(async () => true);
    expect((await handlePairRequest({ ...body(), phone_pubkey: 'abc' }, decide)).status).toBe(400);
    expect((await handlePairRequest({ ...body(), phone_device_name: '' }, decide)).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });
});
