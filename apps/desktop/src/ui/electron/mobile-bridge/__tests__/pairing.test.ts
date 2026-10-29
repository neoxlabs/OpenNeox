import { beforeEach, describe, expect, it, vi } from 'vitest';

const added = vi.hoisted(() => [] as any[]);
const account = vi.hoisted(() => ({ verdict: { ok: true, desktopUserId: 'user-a' } as any }));

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
vi.mock('../pairingAccount.js', () => ({ verifyPhoneAccount: async () => account.verdict }));

import { generateX25519Keypair } from '../crypto.js';
import {
  _clearPendingPairings,
  consumePairingByCode,
  consumePairingByQR,
  createPairingSession,
  listPendingPairings,
} from '../pairing.js';

const phone = generateX25519Keypair();

function qrRequest(pairingToken: string) {
  return {
    pairing_token: pairingToken,
    phone_pubkey: phone.publicKey.toString('base64url'),
    phone_device_id: 'phone-1',
    phone_device_name: 'Phone',
  };
}

function codeRequest(backupCode: string) {
  return {
    backup_code: backupCode,
    phone_pubkey: phone.publicKey.toString('base64url'),
    phone_device_id: 'phone-1',
    phone_device_name: 'Phone',
  };
}

describe('pairing (code:REMOTE-04)', () => {
  beforeEach(() => {
    _clearPendingPairings();
    added.length = 0;
    account.verdict = { ok: true, desktopUserId: 'user-a' };
    vi.useRealTimers();
  });

  it('扫码配对成功: 落库记 owner_user_id, 配对码一次性', async () => {
    const session = createPairingSession();

    const first = await consumePairingByQR(qrRequest(session.pairing_token));

    expect(first.ok).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0].device_id).toBe('phone-1');
    expect(added[0].owner_user_id).toBe('user-a');

    const second = await consumePairingByQR(qrRequest(session.pairing_token));
    expect(second.ok).toBe(false);
    expect(added).toHaveLength(1);
  });

  it('备份码配对成功: 同一个码不能用第二次', async () => {
    const session = createPairingSession();

    const first = await consumePairingByCode(codeRequest(session.backup_code));
    expect(first.ok).toBe(true);
    expect(added).toHaveLength(1);
    expect(added[0].owner_user_id).toBe('user-a');

    const second = await consumePairingByCode(codeRequest(session.backup_code));
    expect(second.ok).toBe(false);
    expect(added).toHaveLength(1);
  });

  it('账号不一致时拒绝, 且不消耗配对码 (换对账号还能用)', async () => {
    const session = createPairingSession();
    account.verdict = { ok: false, code: 'account_mismatch', message: '这台手机登录的账号与电脑不一致' };

    const rejected = await consumePairingByQR(qrRequest(session.pairing_token));
    expect(rejected.ok).toBe(false);
    expect(added).toHaveLength(0);
    expect(listPendingPairings()).toHaveLength(1);

    account.verdict = { ok: true, desktopUserId: 'user-a' };
    const retried = await consumePairingByQR(qrRequest(session.pairing_token));
    expect(retried.ok).toBe(true);
    expect(added).toHaveLength(1);
  });

  it('云端无法校验时拒绝, 备份码同样保留', async () => {
    const session = createPairingSession();
    account.verdict = { ok: false, code: 'account_unverifiable', message: '无法校验手机账号' };

    const rejected = await consumePairingByCode(codeRequest(session.backup_code));
    expect(rejected.ok).toBe(false);
    expect(added).toHaveLength(0);
    expect(listPendingPairings()).toHaveLength(1);
  });

  it('过期后不能用', async () => {
    vi.useFakeTimers();
    const session = createPairingSession();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const result = await consumePairingByQR(qrRequest(session.pairing_token));

    expect(result.ok).toBe(false);
    expect(added).toHaveLength(0);
  });

  it('手机公钥不合法时拒绝, 配对码保留', async () => {
    const session = createPairingSession();

    const result = await consumePairingByQR({ ...qrRequest(session.pairing_token), phone_pubkey: 'abc' });

    expect(result.ok).toBe(false);
    expect(added).toHaveLength(0);
    expect(listPendingPairings()).toHaveLength(1);
  });

  it('电脑未登录时配对仍可用, owner_user_id 为 null (老行为)', async () => {
    const session = createPairingSession();
    account.verdict = { ok: true, desktopUserId: null };

    const result = await consumePairingByQR(qrRequest(session.pairing_token));

    expect(result.ok).toBe(true);
    expect(added[0].owner_user_id).toBeNull();
  });
});
