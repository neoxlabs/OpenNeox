/**
 * Welcome 冷启动门禁
 * ---------------------
 * Welcome ≠ Home。
 *
 *   · Welcome (本文件门禁): 仅冷启动 — 没有可用的模型来源 (未登录且未配 BYOK) 时出现。
 *     配好或登过一次后启动不再经过这里。
 *   · Home (工作台内): 清当前会话 → 模式封面 / 空态。不卸载 workspace，不进 Welcome。
 *   · forceWelcome: 仅 UI 调试，见 isForceWelcome()。
 *
 * 登录态从发行版能力钩子读 (editionHooks.isAuthenticated): 没有账号体系的构建里它恒为
 * false, 门禁就只看 BYOK。
 */
import {
  NEOX_CLOUD_PROVIDER_ID,
  NEOX_MANAGED_APIKEY_MARKER,
} from '../../shared/neoxCloud';
import { getEditionHook } from '../modules/shell/editionHooks';

type ProviderLike = {
  id?: string;
  apiKey?: string | null;
};

/**
 * 强制停留 Welcome — 只给 UI 验证 / 调试用，不改产品门禁。
 *
 *   开启: localStorage.setItem('neox.forceWelcome', '1'); location.reload()
 *     或 URL ?forceWelcome=1
 *   关掉: localStorage.removeItem('neox.forceWelcome'); location.reload()
 */
export function isForceWelcome(): boolean {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('neox.forceWelcome') === '1') {
      return true;
    }
  } catch { /* private mode / SSR */ }
  try {
    if (typeof window !== 'undefined') {
      const qs = new URLSearchParams(window.location.search);
      if (qs.get('forceWelcome') === '1' || qs.get('welcome') === '1') return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** 是否已配置非托管云端的真实 BYOK provider（有明文 apiKey）。 */
export async function hasByokConfigured(): Promise<boolean> {
  try {
    const getProviders = window.neox?.getProviders;
    if (typeof getProviders !== 'function') return false;
    const providers = (await getProviders()) as ProviderLike[];
    if (!Array.isArray(providers)) return false;
    return providers.some((p) => {
      if (!p || p.id === NEOX_CLOUD_PROVIDER_ID) return false;
      const key = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
      if (!key) return false;
      if (key === NEOX_MANAGED_APIKEY_MARKER) return false;
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * 启动 / 空 workspace 时是否可跳过 Welcome 直进工作台。
 * forceWelcome 调试开关可覆盖为 false。
 */
export async function canSkipWelcome(): Promise<boolean> {
  if (isForceWelcome()) return false;
  if (getEditionHook('isAuthenticated')()) return true;
  return hasByokConfigured();
}
