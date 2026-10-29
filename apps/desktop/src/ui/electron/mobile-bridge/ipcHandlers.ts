/**
 * mobile-bridge/ipcHandlers.ts — Renderer ↔ Main IPC handlers
 *
 * 暴露给 renderer 的能力 (Settings UI / Composer 用):
 *   - mobileBridge:status         → 当前 server 状态 (port / device_id / device_name / lan_ip / paired_count)
 *   - mobileBridge:start-pairing  → 启一次配对会话 (返 pairing_token + backup_code + qr_payload + expires_at)
 *   - mobileBridge:cancel-pairing → 取消 pending 配对 (用户关 QR 弹窗时)
 *   - mobileBridge:list-paired    → 列已配对 Mobile 设备
 *   - mobileBridge:remove-paired  → 撤销某 Mobile 配对
 *   - mobileBridge:set-device-name → 改 Desktop 显示名
 *
 * 注: 这些都是 main 进程对外暴露的, preload 转发, renderer 调.
 */

/* 走桥的 ipcMain 替身 —— 设置里的「Remote Access」页要用这一族。 */
import { ipcMain } from '../ipc/ipcMainBridged.js';
import {
  getMobileBridgePort,
  getMobileBridgeLanIp,
  getAllLanIps,
  getMobileBridgeServer,
  enableMobileBridgeLan,
  disableMobileBridgeLanIfIdle,
  startCloudRelayClient,
  stopCloudRelayClient,
  isCloudRelayConnected,
} from './index.js';
import {
  getDeviceId,
  getDeviceName,
  setDeviceName,
  listPairedMobiles,
  removePairedMobile,
  setPairedMobileName,
} from './deviceStore.js';
import {
  createPairingSession,
  getQRPayload,
  cancelPairing,
  listPendingPairings,
} from './pairing.js';
import { bridgeLog } from './log.js';
import { readDesktopAuthTokens, ensureFreshDesktopAuthTokens } from '../ipc/authHandlers.js';
import { resolveCloudEndpoints } from '../services/cloudEndpoints.js';
import { loadCloudPrefs, saveCloudPrefs } from './cloudPrefs.js';

/* NeoxCloud control-plane 公网入口 — 走 cloudEndpoints 系统,
 * 切 profile (cloud-endpoints.json) 即可统一改; mobile 端 kNeoxCloudBaseUrl 要对齐. */
function getCloudBaseUrl(): string {
  return resolveCloudEndpoints().api;
}

/** 安全读取当前 desktop 登录用户 id — 失败返 null (按未登录处理). */
async function readCurrentUserIdSafe(): Promise<string | null> {
  try {
    const tok = await readDesktopAuthTokens();
    return tok?.user?.id ?? null;
  } catch {
    return null;
  }
}

export function registerMobileBridgeIpcHandlers(): void {
  /**
   * 状态查询 — Settings 主页面 / Composer cloud icon 显示用.
   */
  ipcMain.handle('mobileBridge:status', async () => {
    const server = getMobileBridgeServer();
    const currentUserId = await readCurrentUserIdSafe();
    return {
      running: server !== null,
      port: getMobileBridgePort(),
      lan_ip: getMobileBridgeLanIp(),
      device_id: getDeviceId(),
      device_name: getDeviceName(),
      paired_count: listPairedMobiles({ currentUserId }).length,
      active_connections: server?.listConns().length ?? 0,
      pending_pairings: listPendingPairings().length,
    };
  });

  /**
   * 启一次配对 — Renderer 弹"添加 Mobile 设备"对话框时调.
   * 返 pairing_token + backup_code + 完整 QR payload (renderer 用 qrcode 库渲 QR).
   */
  ipcMain.handle('mobileBridge:start-pairing', async () => {
    /* server 默认只绑 127.0.0.1 — 这里是用户显式发起配对的路径, 升级到 LAN 可达
     * (0.0.0.0 + mDNS), phone 才能扫码连上. 幂等, 已升级时立即返回. */
    try {
      await enableMobileBridgeLan();
    } catch (e: any) {
      return { ok: false, error: `无法开启局域网监听: ${e?.message ?? String(e)}` };
    }
    const session = createPairingSession();
    const port = getMobileBridgePort();
    const host = getMobileBridgeLanIp() ?? 'localhost';
    /* 多网卡时 Phone 端逐个 try, 防 Desktop 默认 IP 选错 (有线+WiFi+Hotspot 等) */
    const hosts = getAllLanIps();
    const qr = getQRPayload(session.pairing_token, host, port, hosts);
    if (!qr) {
      return { ok: false, error: 'failed to get QR payload (pairing 已立即过期? 不应该)' };
    }
    /* QR 实际内容编 base64url JSON, renderer 把它当 QR 二维码内容 */
    const qrEncoded = Buffer.from(JSON.stringify(qr), 'utf-8').toString('base64url');
    return {
      ok: true,
      pairing_token: session.pairing_token,
      backup_code: session.backup_code,
      expires_at: session.expires_at,
      qr_payload: qr,
      qr_encoded: qrEncoded,
    };
  });

  /** 取消 pending 配对 (用户关 QR 弹窗) */
  ipcMain.handle('mobileBridge:cancel-pairing', async (_event, pairing_token: string) => {
    const ok = cancelPairing(pairing_token);
    await disableMobileBridgeLanIfIdle();
    return { ok };
  });

  /** 已配对 Mobile 列表 — Settings 显示. 附带每条的当前 transport (lan/cloud/null) 给 UI 打 tag.
   *   P0 — 按当前 desktop 登录 user 过滤, 防 B 登录看到 A 名下的配对手机. */
  ipcMain.handle('mobileBridge:list-paired', async () => {
    const server = getMobileBridgeServer();
    const activeByDeviceId = new Map<string, 'lan' | 'cloud'>();
    if (server) {
      for (const conn of server.listConns()) {
        if (!conn.isOpen()) continue;
        activeByDeviceId.set(
          conn.mobile.device_id,
          conn.transport === 'cloud' ? 'cloud' : 'lan',
        );
      }
    }
    const currentUserId = await readCurrentUserIdSafe();
    /* 不返 relay_session_key / device_token 给 renderer (减少暴露面) */
    return listPairedMobiles({ currentUserId }).map((m) => ({
      id: m.id,
      device_id: m.device_id,
      device_name: m.device_name,
      paired_at: m.paired_at,
      last_seen_at: m.last_seen_at,
      active_transport: activeByDeviceId.get(m.device_id) ?? null,
    }));
  });

  /** 撤销某 Mobile — 立即 kick 所有它的 WS 连接 */
  ipcMain.handle('mobileBridge:remove-paired', async (_event, device_id: string) => {
    const currentUserId = await readCurrentUserIdSafe();
    const ok = removePairedMobile(device_id, { currentUserId });
    /* 同时 kick active conn */
    const server = getMobileBridgeServer();
    if (ok && server) {
      for (const conn of server.listConns()) {
        if (conn.mobile.device_id === device_id && conn.transport === 'lan' && conn.ws) {
          try { conn.ws.close(1008, 'device unpaired'); } catch { /* ignore */ }
        }
      }
    }
    /* 解绑掉最后一台手机之后, LAN listener 就没有存在理由了 —— 跟启动时
     * "配过手机才绑 LAN" 是同一条规矩, 这里补上运行期的那一半。
     * 还有别的设备时 disableMobileBridgeLanIfIdle() 自己会判定不动。 */
    await disableMobileBridgeLanIfIdle();
    return { ok };
  });

  /** 改 Desktop 显示名 */
  ipcMain.handle('mobileBridge:set-device-name', (_event, name: string) => {
    setDeviceName(name);
    return { ok: true, device_name: getDeviceName() };
  });

  /** 改某已配对 Mobile 的显示名 — UI 行内编辑入口. name='' 清空回默认. */
  ipcMain.handle(
    'mobileBridge:rename-paired',
    async (_event, device_id: string, name: string) => {
      const currentUserId = await readCurrentUserIdSafe();
      const ok = setPairedMobileName(device_id, name, { currentUserId });
      return { ok };
    },
  );

  /* ────── M4 Mode B Cloud Relay 控制 — 复用 Desktop 主账户 SSO ────── */

  /** 兼容旧 renderer: cloud-login 现在直接返回主账户态. UI 应改走 cloud-status. */
  ipcMain.handle('mobileBridge:cloud-login', async () => {
    const tok = await readDesktopAuthTokens();
    if (!tok?.accessToken) {
      return { ok: false, error: '请先在右上账户菜单登录 Neox' };
    }
    return { ok: true, email: tok.user?.email ?? '' };
  });

  /** 退出登录 — 仅停 cloud client. 真退出账号走主 app 登出 (清 safeStorage). */
  ipcMain.handle('mobileBridge:cloud-logout', async () => {
    await stopCloudRelayClient();
    return { ok: true };
  });

  /** 起 cloud client — 直接用 Desktop 主账户 token, 临期自动 refresh, 不要求二次登录. */
  ipcMain.handle('mobileBridge:cloud-start', async () => {
    const tok = await ensureFreshDesktopAuthTokens();
    if (!tok?.accessToken) {
      return { ok: false, error: '请先登录 Neox 账户' };
    }
    try {
      await startCloudRelayClient({
        serverBaseUrl: getCloudBaseUrl(),
        bearerJwt: tok.accessToken,
      });
      /* 手动点了「启用」= 撤销之前的显式停用, 否则下次启动又回到停用状态 */
      saveCloudPrefs({ disabled: false });
      bridgeLog('cloud-start', `ok email=${tok.user?.email ?? '-'}`);
      return { ok: true, connected: isCloudRelayConnected() };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /** 停 cloud client — 显式停用会被记住, 否则下次启动又自己连上, 等于开关点了没用 */
  ipcMain.handle('mobileBridge:cloud-stop', async () => {
    saveCloudPrefs({ disabled: true });
    await stopCloudRelayClient();
    return { ok: true };
  });

  /** 状态查询 — 复用 Desktop 主账户登录态 (SSO) */
  ipcMain.handle('mobileBridge:cloud-status', async () => {
    const tok = await readDesktopAuthTokens();
    const prefs = loadCloudPrefs();
    return {
      logged_in: !!tok?.accessToken,
      email: tok?.user?.email ?? null,
      display_name: tok?.user?.displayName ?? null,
      server_base_url: getCloudBaseUrl(),
      connected: isCloudRelayConnected(),
      /* 语义已反转: 现在默认就是自动连, auto_start 只在用户显式停用时为 false.
       * 字段名保留是为了不动 preload/renderer 的既有契约。 */
      auto_start: !prefs.disabled,
    };
  });

  /** 切开关. 现在 enabled=false 表示「显式停用远程」, 默认(没记录)是启用. */
  ipcMain.handle('mobileBridge:cloud-set-auto-start', async (_event, enabled: boolean) => {
    const tok = await readDesktopAuthTokens();
    if (!tok?.accessToken) return { ok: false, error: '请先登录 Neox' };
    saveCloudPrefs({ disabled: !enabled });
    return { ok: true, auto_start: !!enabled };
  });

  /* ────── 自托管中继 (cloud/relay) — 不要账号, 部署令牌鉴权 ────── */

  /** 令牌不回给界面明文, 只说有没有、尾 4 位 */
  ipcMain.handle('mobileBridge:self-relay-get', async () => {
    const { loadSelfHostedRelay } = await import('./selfHostedRelay.js');
    const cfg = loadSelfHostedRelay();
    return {
      configured: !!cfg,
      url: cfg?.url ?? '',
      token_tail: cfg ? cfg.token.slice(-4) : '',
      connected: !!cfg && isCloudRelayConnected(),
    };
  });

  /** 保存并立刻按新配置重连; token 留空 = 沿用已存的那个 (只改地址) */
  ipcMain.handle('mobileBridge:self-relay-set', async (_event, input: { url?: string; token?: string }) => {
    const { loadSelfHostedRelay, normalizeSelfHostedRelay, saveSelfHostedRelay } = await import('./selfHostedRelay.js');
    const prev = loadSelfHostedRelay();
    const r = normalizeSelfHostedRelay({ url: input?.url, token: input?.token || prev?.token });
    if (!r.ok) return { ok: false, error: r.error };
    const probe = await probeSelfHostedRelay(r.config.url);
    if (!probe.ok) return { ok: false, error: probe.error };
    saveSelfHostedRelay(r.config);
    saveCloudPrefs({ disabled: false });
    await stopCloudRelayClient();
    const { ensureCloudRelayClientRunning } = await import('./index.js');
    const state = await ensureCloudRelayClientRunning().catch((e: any) => `error: ${e?.message ?? e}`);
    bridgeLog('self-relay', `saved ${r.config.url}, relay: ${state}`);
    return { ok: true, state };
  });

  ipcMain.handle('mobileBridge:self-relay-clear', async () => {
    const { saveSelfHostedRelay } = await import('./selfHostedRelay.js');
    saveSelfHostedRelay(null);
    await stopCloudRelayClient();
    return { ok: true };
  });
}

/** 存之前先探一下 /healthz —— 地址填错时当场说, 而不是存下来以后静默连不上 */
async function probeSelfHostedRelay(baseUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, error: `unreachable: HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    return body?.ok === true ? { ok: true } : { ok: false, error: 'not_a_relay' };
  } catch (e: any) {
    return { ok: false, error: `unreachable: ${e?.message ?? e}` };
  }
}

/* 云中转偏好搬去 ./cloudPrefs.ts —— main.ts 启动那条路径也要读同一份判断,
 * 留在这个只在 registerIpcHandlers 里可见的文件里两边就会各写一套。 */

/* refresh/jwt-exp 校验现在由 Desktop 主 AuthClient (renderer) 统一负责. */
