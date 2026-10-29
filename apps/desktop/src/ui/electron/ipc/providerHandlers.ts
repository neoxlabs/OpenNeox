import { ipcMain } from './ipcMainBridged.js';
import type { HealthCheckRequest, HealthCheckResult } from '../../shared/ipc.js';
import { queryProviderBalance, type BalanceResult } from '../services/providerBalance.js';
import { runProviderChatProbe, type ChatProbeResult } from '@neoxlabs/core';
import { configService } from '@neoxlabs/platform/platform/configService.js';
import { runProviderHealthCheck } from '@neoxlabs/core/platform/providerHealthCheck.js';
import { resolveProviderEntry } from '@neoxlabs/platform/platform/providerResolver.js';
import { NEOX_CLOUD_PROVIDER_ID, NEOX_MANAGED_APIKEY_MARKER } from '../../shared/neoxCloud.js';
import { resolveCloudEndpoints } from '../services/cloudEndpoints.js';

export function registerProviderIpcHandlers(): void {
  /**
   * 健康探测必须按 providerId 从配置补齐 apiKey/baseUrl/protocol。
   * 历史 bug: CDP / 定时器只传 `{ providerId }` 时 apiKey 字面量变 undefined、
   * baseUrl 回落到 api.openai.com → 明明能聊天却报「Incorrect API key: undefined」。
   * 对齐同文件 kimi-balance：先 getProvider 再探测。
   */
  ipcMain.handle('provider:health-check', (_event, request: HealthCheckRequest): Promise<HealthCheckResult> => {
    const providerId = String(request?.providerId || '').trim();
    const stored = providerId ? configService.getProvider(providerId) : null;
    const firstModel = stored?.models?.[0];
    const modelName = typeof firstModel === 'string'
      ? firstModel
      : (firstModel && typeof firstModel === 'object' && 'name' in firstModel
        ? String((firstModel as { name?: string }).name || '')
        : '');

    const pick = (...vals: Array<string | undefined | null>) => {
      for (const v of vals) {
        const t = (v ?? '').trim();
        if (t) return t;
      }
      return '';
    };

    /* protocol 不能走 pick() —— 那个函数返回 string, 会把 ProviderProtocol 联合拓宽掉。
     * 两个来源本身就是 ProviderProtocol, 直接取即可。 */
    const hydrated: HealthCheckRequest = {
      providerId,
      protocol: request?.protocol || stored?.protocol || 'openai',
      baseUrl: pick(request?.baseUrl, stored?.baseUrl),
      urlSuffix: pick(request?.urlSuffix, stored?.urlSuffix) || undefined,
      apiKey: pick(request?.apiKey, stored?.apiKey),
      model: pick(
        request?.model,
        stored?.defaultModel,
        stored?.lastSelectedModel,
        modelName,
      ) || 'gpt-4o',
      disableCaching: request?.disableCaching,
      /* stored.claudeCodeMode 本来就是 'auto'|'on'|'off' (configTypes.ts:380)。
       * 原先断言成 boolean 是错的 —— 断言错了类型, 等于把这条链的检查全关了。 */
      claudeCodeMode: request?.claudeCodeMode ?? stored?.claudeCodeMode,
    };

    const isManaged = hydrated.providerId === NEOX_CLOUD_PROVIDER_ID
      || hydrated.apiKey.trim() === NEOX_MANAGED_APIKEY_MARKER;
    if (isManaged) {
      const resolved = resolveProviderEntry({
        id: hydrated.providerId,
        protocol: hydrated.protocol,
        apiKey: hydrated.apiKey,
        baseUrl: hydrated.baseUrl,
      } as never) as { apiKey?: string } | null;
      return runProviderHealthCheck({
        ...hydrated,
        apiKey: (resolved?.apiKey ?? '').trim(),
        cloudApiBase: resolveCloudEndpoints().api,
      });
    }

    return runProviderHealthCheck(hydrated);
  });

  ipcMain.handle('provider:chat-probe', async (_event, req: {
    providerId?: string; protocol?: string; baseUrl?: string; urlSuffix?: string; apiKey?: string;
    model: string; prompt?: string; claudeCodeMode?: 'auto' | 'on' | 'off';
  }): Promise<ChatProbeResult> => {
    const stored = req?.providerId ? configService.getProvider(req.providerId) : null;
    const pick = (a?: string | null, b?: string | null) => ((a ?? '').trim() || (b ?? '').trim() || undefined);
    const model = String(req?.model || '').trim();
    const apiKey = pick(req?.apiKey, stored?.apiKey);
    if (!model) return { ok: false, latencyMs: 0, error: 'No model selected' };
    if (!apiKey) return { ok: false, latencyMs: 0, error: 'API key is empty' };
    const provider = {
      ...(stored ?? {}),
      id: stored?.id ?? `probe-${Date.now()}`,
      name: stored?.name ?? 'probe',
      protocol: (req?.protocol || stored?.protocol || 'openai') as any,
      baseUrl: pick(req?.baseUrl, stored?.baseUrl),
      urlSuffix: pick(req?.urlSuffix, stored?.urlSuffix),
      apiKey,
      /* 多 Tab 路由按表单这一套走: 测的是"现在填的这些", 不是存盘里另一个 Tab */
      channels: undefined,
      models: [{ name: model }],
      claudeCodeMode: req?.claudeCodeMode ?? stored?.claudeCodeMode,
    };
    return runProviderChatProbe({ provider: provider as any, model, prompt: req?.prompt });
  });

  ipcMain.handle('provider:balance', async (_event, providerId: string): Promise<BalanceResult> => {
    const provider = configService.getProvider(String(providerId || ''));
    if (!provider) return { status: 'error', error: 'Provider not found' };
    return queryProviderBalance({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  });
}
