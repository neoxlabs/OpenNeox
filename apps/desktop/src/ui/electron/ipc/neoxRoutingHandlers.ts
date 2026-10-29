/**
 * neoxRoutingHandlers — IPC 桥, 让 renderer 把 membership 状态推到 main 进程.
 *
 *   neox-routing:set-plan        renderer 拿到 /membership/me 后调; main 只记录当前 plan id.
 *                                   BYOK 已套餐无关, resolver 只改写 neox-cloud 托管 provider
 *   neox-routing:set-enabled     用户设置里"用 Neox 网关"开关变化时调
 *   neox-routing:refresh-token   登录 / 登出 / token 刷新成功时调, 让 main 立即刷缓存
 *   neox-routing:describe        debug — 给定一个 provider, 看 main 会怎么改写
 */
import { ipcMain } from './ipcMainBridged.js';
import { neoxRoutingState } from '../services/neoxRoutingService.js';
import { subscriptionState, type SubscriptionModel } from '../services/subscriptionState.js';
import { writeMembershipCache } from '../services/membershipCacheWriter.js';

type SetPlanPayload = {
  planId?: string;
  /** 完整的 /membership/me .membership —— main 落盘给 agent server 读 (并发上限、订阅出图模型) */
  membership?: unknown;
  /** 当前登录用户 id, 写进缓存的 accountKey */
  accountKey?: string;
  [key: string]: unknown;
} | null;

export function registerNeoxRoutingIpcHandlers(): void {
  ipcMain.handle('neox-routing:set-plan', async (_event, payload: SetPlanPayload) => {
    if (!payload) {
      neoxRoutingState.setPlan(null);
    } else {
      const planId = String(payload.planId || '').trim();
      neoxRoutingState.setPlan(planId ? { planId } : null);
      if (payload.membership) writeMembershipCache(payload.membership, String(payload.accountKey || ''));
    }
    return { ok: true };
  });

  ipcMain.handle('neox-routing:set-enabled', async (_event, enabled: boolean) => {
    neoxRoutingState.setEnabled(!!enabled);
    return { ok: true, enabled: neoxRoutingState.isEnabled() };
  });

  ipcMain.handle('neox-routing:refresh-token', async () => {
    neoxRoutingState.refreshToken();
    return { ok: true };
  });

  ipcMain.handle('neox-routing:describe', async (_event, provider: any) => {
    if (!provider || typeof provider !== 'object') {
      return { error: 'provider object required' };
    }
    return neoxRoutingState.describe(provider);
  });

  ipcMain.handle('neox-routing:status', async () => {
    return {
      enabled: neoxRoutingState.isEnabled(),
      plan: neoxRoutingState.getPlan(),
    };
  });

  /* renderer 拉到 membership.models 后 push 进来 — mobile-bridge 的 model.list RPC 用这份 */
  ipcMain.handle('neox-routing:set-subscription-models', async (_event, models: SubscriptionModel[] | null) => {
    subscriptionState.setModels(models);
    return { ok: true, count: subscriptionState.getModels().length };
  });
}
