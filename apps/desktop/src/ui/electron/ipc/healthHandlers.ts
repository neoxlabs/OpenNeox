/* 走桥的 ipcMain 替身 —— 这个文件对 Electron 零依赖, 极简版也要用它:
 * 登录页的"云端是否可达"探活走的就是这里的 cloud:health-probe
 * (renderer 直接 fetch 会撞 CORS, 所以必须由宿主进程发)。 */
import { ipcMain } from './ipcMainBridged.js';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { healthCheckService, type ProviderHealth } from '../../../platform-electron/healthCheckService.js';

export function registerHealthIpcHandlers(): void {
  ipcMain.handle('config:get-health-interval', () => {
    return configService.getProviderHealthIntervalMinutes();
  });

  ipcMain.handle('config:set-health-interval', (_event, minutes: number) => {
    configService.setProviderHealthIntervalMinutes(minutes);
  });

  ipcMain.handle('config:get-auto-health-check', () => {
    return configService.getAutoHealthCheck();
  });

  ipcMain.handle('config:set-auto-health-check', (_event, enabled: boolean) => {
    configService.setAutoHealthCheck(enabled);
  });

  ipcMain.handle('health:get-all', () => {
    return healthCheckService.getHealthData();
  });

  ipcMain.handle('health:update', (_event, providerId: string, status: string, latency?: number, error?: string, httpStatus?: number, model?: string) => {
    return healthCheckService.updateProviderHealth(
      providerId,
      status as ProviderHealth['current'],
      latency,
      error,
      httpStatus,
      model,
    );
  });

  ipcMain.handle('health:set-all', (_event, data: Record<string, ProviderHealth>) => {
    healthCheckService.setHealthData(data);
  });

  ipcMain.handle('health:delete', (_event, providerId: string) => {
    healthCheckService.deleteProviderHealth(providerId);
  });

  ipcMain.handle('health:clear-all', () => {
    healthCheckService.clearAllHealth();
  });

  /* 云端存活探测 — 走主进程发, 不走 renderer fetch.
   *
   *   renderer 的 origin 在打包版是 file:// (服务端 CORS 白名单里放了), 但 dev 下是
   *   http://127.0.0.1:5180。控制面的 CORS 只在非生产环境放行 localhost 回环
   *   (control-plane app.ts 的 !isProd 分支), 所以「dev 构建打生产」时 /api/health
   *   会被判 403, 登录页顶一条"云端暂不可达"的红条 —— 服务端明明是好的。
   *
   *   主进程发请求没有 origin 概念, 也就没有 CORS。这里不接受 renderer 传 URL,
   *   base 由主进程自己从 NEOX_API_BASE 读 —— 否则就是给 renderer 开了一个
   *   任意地址请求的代理 (SSRF), 探活这点便利不值得。
   *
   *   不带 Authorization: 这是粗粒度活性探测, 登录前就要能跑; 带凭据还会在 token
   *   过期时触发刷新, 把一个只读探针变成有副作用的调用。 */
  ipcMain.handle('cloud:health-probe', async (_event, timeoutMs?: number) => {
    const base = String(process.env.NEOX_API_BASE || '').trim().replace(/\/$/, '');
    if (!base) return { ok: false, code: 'NO_ENDPOINT' as const };
    const controller = new AbortController();
    const budget = Math.max(1_000, Math.min(Number(timeoutMs) || 6_000, 30_000));
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      /* 不能用 RequestInit.cache —— Node 的 fetch(undici) 没有 HTTP 缓存层,
       * 这个字段既不在类型里也不起作用。要绕中间层缓存得靠请求头。 */
      const res = await fetch(`${base}/api/health`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'cache-control': 'no-cache' },
      });
      return { ok: true as const, status: res.status };
    } catch (err) {
      const e = err as { name?: string; message?: string } | null;
      const lower = String(e?.message ?? '').toLowerCase();
      let code = 'NETWORK_FAILED';
      if (e?.name === 'AbortError') code = 'NETWORK_TIMEOUT';
      else if (lower.includes('dns') || lower.includes('enotfound') || lower.includes('eai_again')) code = 'NETWORK_DNS';
      else if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) code = 'NETWORK_TLS';
      return { ok: false as const, code };
    } finally {
      clearTimeout(timer);
    }
  });
}
