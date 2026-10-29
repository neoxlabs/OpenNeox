import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'neox-auth-storm-'));
const TOKEN_DIR = process.platform === 'darwin'
  ? join(SANDBOX_HOME, 'Library', 'Application Support', DISTRIBUTION.appName)
  : join(SANDBOX_HOME, DISTRIBUTION.homeDirname);
const TOKEN_FILE = join(TOKEN_DIR, 'auth.enc');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: { ...actual, homedir: () => SANDBOX_HOME }, homedir: () => SANDBOX_HOME };
});
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => SANDBOX_HOME, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
}));
/* 加密层换成恒等映射 — 不依赖 machine-id, 也让测试能直接写明文 token 文件 */
vi.mock('../services/localSecretCipher.js', () => ({
  encryptLocalSecret: (s: string) => Buffer.from(s, 'utf-8'),
  decryptLocalSecret: (b: Buffer) => b.toString('utf-8'),
  isLocalSecretBlob: () => false,
}));
vi.mock('../services/oauthFlow.js', () => ({ oauthFlow: {} }));
vi.mock('../services/deviceFingerprint.js', () => ({ getDeviceFingerprint: async () => null }));
vi.mock('../services/cloudEndpoints.js', () => ({
  resolveCloudEndpoints: () => ({ api: 'https://api.test', gateway: 'https://gw.test' }),
}));
vi.mock('../mobile-bridge/deviceStore.js', () => ({
  getDeviceId: () => 'dev', getDeviceName: () => 'dev', getDesktopKeypair: () => null,
}));
vi.mock('../services/logoutBus.js', () => ({ runLogout: async () => {} }));
vi.mock('@neoxlabs/platform/utils/config.js', () => ({ setCurrentUserId: () => {} }));
vi.mock('../services/neoxRoutingService.js', () => ({ neoxRoutingState: { setUserId: () => {} } }));
vi.mock('../services/authFileWatcher.js', () => ({ markAuthSelfBroadcast: () => {} }));
vi.mock('@neoxlabs/platform/platform/routingState.js', () => ({
  setRoutingState: () => {}, clearRoutingState: () => {},
}));

function seedTokens(accessToken: string, refreshToken: string, expiresInMs: number): void {
  mkdirSync(TOKEN_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify({
    accessToken, refreshToken,
    accessExpiresAt: Date.now() + expiresInMs,
    user: { id: 'u1', email: 'qa@test' },
    scopes: ['profile'],
  }), { mode: 0o600 });
}

describe('refresh 轮换风暴', () => {
  let refreshCalls = 0;
  /* 刷新响应的闸门 —— 默认敞开; "并发只打一次"那条会先关上, 等五个调用都进来再放行。
   * 见那条用例里的说明: 不这么做的话重叠与否取决于机器忙不忙。 */
  let refreshGate: Promise<void> = Promise.resolve();

  beforeEach(() => {
    vi.resetModules();
    refreshCalls = 0;
    refreshGate = Promise.resolve();
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).includes('/auth/refresh')) {
        refreshCalls += 1;
        await refreshGate;
        return new Response(JSON.stringify({
          tokens: { accessToken: `access-${refreshCalls}`, refreshToken: `refresh-${refreshCalls}`, expiresIn: 900 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(() => { rmSync(SANDBOX_HOME, { recursive: true, force: true }); });

  it('并发 force refresh 只打一次 /auth/refresh', async () => {
    seedTokens('access-0', 'refresh-0', 60_000);
    const mod = await import('../ipc/authHandlers.js');
    let openGate!: () => void;
    refreshGate = new Promise<void>((resolve) => { openGate = resolve; });
    const inflight = Array.from({ length: 5 }, () =>
      mod.ensureFreshDesktopAuthTokensEx({ force: true, staleAccessToken: 'access-0' }));
    const deadline = Date.now() + 5_000;
    while (refreshCalls === 0) {
      if (Date.now() > deadline) throw new Error('5s 内没有任何 refresh 到达闸门 —— 刷新链路本身没跑起来');
      await new Promise((r) => setTimeout(r, 5));
    }
    /* 第一个已就位; 再让出几轮宏任务, 给其余四个汇合的机会 (它们此刻应挂在单飞 promise 上) */
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    openGate();
    const results = await Promise.all(inflight);
    expect(refreshCalls).toBe(1);
    for (const r of results) {
      expect(r.fatal).toBe(false);
      expect(r.tokens?.accessToken).toBe('access-1');
    }
  });

  it('手上那张已经过时 (别人刚转过) → 一次都不转', async () => {
    seedTokens('access-9', 'refresh-9', 30 * 60_000);
    const mod = await import('../ipc/authHandlers.js');
    const r = await mod.ensureFreshDesktopAuthTokensEx({ force: true, staleAccessToken: 'access-OLD' });
    expect(refreshCalls).toBe(0);
    expect(r.tokens?.accessToken).toBe('access-9');
    expect(r.fatal).toBe(false);
  });
});
