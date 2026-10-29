import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISTRIBUTION } from '@neoxlabs/kernel/platform/distribution.js';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'neox-auth-bcast-'));
const TOKEN_DIR = process.platform === 'darwin'
  ? join(SANDBOX_HOME, 'Library', 'Application Support', DISTRIBUTION.appName)
  : join(SANDBOX_HOME, DISTRIBUTION.homeDirname);
const TOKEN_FILE = join(TOKEN_DIR, 'auth.enc');

const markSpy = vi.fn();

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
vi.mock('../services/authFileWatcher.js', () => ({ markAuthSelfBroadcast: markSpy }));
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

describe('auth.enc 自我广播风暴', () => {
  beforeEach(() => {
    vi.resetModules();
    markSpy.mockClear();
    let refreshCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).includes('/auth/refresh')) {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          tokens: { accessToken: `access-${refreshCalls}`, refreshToken: `refresh-${refreshCalls}`, expiresIn: 900 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(() => { rmSync(SANDBOX_HOME, { recursive: true, force: true }); });

  it('token 轮换写 auth.enc 时必须自我标记 —— 漏了就是无限广播风暴', async () => {
    seedTokens('access-0', 'refresh-0', 1_000);
    const mod = await import('../ipc/authHandlers.js');
    const r = await mod.ensureFreshDesktopAuthTokensEx({ force: true, staleAccessToken: 'access-0' });

    expect(r.fatal).toBe(false);
    expect(r.tokens?.accessToken).toBe('access-1');

    /* 核心: 写盘路径必须打了自我标记, 否则 fs.watch 会把它当外部登录广播出去 */
    expect(markSpy).toHaveBeenCalled();
  });

  it('轮换一直成功但业务一直 401 → 必须收敛, 不能永远回"稍后重试"', async () => {
    /* 实机日志里 "401 但刚轮换成功过 — 判为轮换竞态" 刷了几百屏: 轮换在成功,
     * 业务却一直 401 —— 那就不是竞态, 再重试多少次也不会好。这条分支必须有上限,
     * 超限后给出可定位的告警 + 明确退避, 且**仍然不清账**。 */
    seedTokens('access-0', 'refresh-0', 30 * 60_000);
    let refreshCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).includes('/auth/refresh')) {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          tokens: { accessToken: `access-${refreshCalls}`, refreshToken: `refresh-${refreshCalls}`, expiresIn: 900 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      /* 业务接口永远 401 —— 模拟服务端换了签名密钥这类"重试也没用"的故障 */
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    }));

    const mod = await import('../ipc/authHandlers.js');
    mod.registerAuthIpcHandlers();
    /* 从**通用 IPC 桥的路由表**取 handler, 不再从 mock 的 electron.ipcMain 上抓。
     * authHandlers 现在 import 的是 ipcMainBridged (顶层 import electron 会让整个
     * bundle 在纯 Node 后端里加载失败, 见 lazyElectron.ts), 注册动作已经不经过
     * electron.ipcMain 了 —— 路由表才是现在的真相源。 */
    const { getBridgeRoute } = await import('@neoxlabs/platform/shared/ipc.js');
    const fetchFn = getBridgeRoute('auth:fetch');
    expect(fetchFn, 'auth:fetch handler 应该被注册').toBeTruthy();
    const callProxy = () => fetchFn!({ sender: { id: 1 } }, {
      url: 'https://api.test/api/v1/membership/me', method: 'GET', headers: [],
    });

    const results: any[] = [];
    for (let i = 0; i < 8; i++) results.push(await callProxy());

    /* 全程不许清账 —— 铁律: 只有 /auth/refresh 明确拒绝 refresh token 才允许登出 */
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.code).toBe('AUTH_REFRESH_UNAVAILABLE');
    }
    /* 前几次当竞态 (短退避), 超阈值后升级成长退避 —— 也就是"会收敛" */
    expect(results[0].retryAfterMs).toBe(1_000);
    const escalated = results.filter(r => r.retryAfterMs && r.retryAfterMs >= 30_000);
    expect(escalated.length, '连续命中超阈值后必须升级为长退避').toBeGreaterThan(0);
  });

  it('登出删 auth.enc 同样要自我标记 (否则自己的登出被当成"外部登出"再广播一轮)', async () => {
    seedTokens('access-0', 'refresh-0', 30 * 60_000);
    const mod = await import('../ipc/authHandlers.js');
    markSpy.mockClear();
    /* restoreAuthIdentity → readTokens; 这里直接走公开的清理入口 */
    await mod.ensureFreshDesktopAuthTokensEx({ force: false });
    markSpy.mockClear();

    /* clearTokens 没有直接导出, 走 registerAuthIpcHandlers 注册的 clear-tokens IPC */
    mod.registerAuthIpcHandlers();
    /* 同上: 注册已经走桥, 从路由表取。 */
    const { getBridgeRoute } = await import('@neoxlabs/platform/shared/ipc.js');
    const clearFn = getBridgeRoute('auth:clear-tokens');
    expect(clearFn, 'auth:clear-tokens handler 应该被注册').toBeTruthy();
    await clearFn!({ sender: { id: 1 } });
    expect(markSpy).toHaveBeenCalled();
  });
});
