import type { ModelInfo } from '../../shared/ipc';
import { emptyEffortPrefs, parseEffortPrefs, serializeEffortPrefs, type EffortPrefs } from './effortPrefs';
import { isAutoRoutedModelName } from '../modules/agent-timeline/ProviderBrandIcon';

export async function isPiiFilterOn(): Promise<boolean> {
  try {
    const v = await (window.neox as any).getPiiFilterPreference?.();
    return v !== false;   // 读不到时按"开"处理 —— 保护性默认
  } catch {
    return true;
  }
}

/* ---------- lastModelId 持久化 (SQLite app_state via IPC) ----------
 *   每次 setSelectedModel 异步写一次, boot 时优先 honor.
 *   走 IPC 因为 SQLite 操作必须经 main 进程.
 *
 *   readLastModelId 是同步函数 (在 setSelectedModel 后续会被 callback 调用),
 *   走个内存 cache: bootstrap 时异步拉一次填进 _lastModelIdCache, 后续读用 cache.
 *   cache miss 返 null, 走 auto 模型 fallback. */
let _lastModelIdCache: string | null = null;
export async function preloadLastModelId(): Promise<void> {
  try {
    const r = await (window as any).neox?.uiStateGet?.('lastModelId');
    if (r?.value) _lastModelIdCache = r.value;
  } catch { /* ignore */ }
}
export function writeLastModelId(id: string) {
  _lastModelIdCache = id;
  void (window as any).neox?.uiStateSet?.('lastModelId', id);
}
export function readLastModelId(): string | null {
  return _lastModelIdCache;
}

/* 推理强度偏好 —— 与 lastModelId 同一套 uiState 通道 (异步预载进内存 cache, 后续同步读)。
 * 读取路径在启动关键路径上, parseEffortPrefs 对任何脏数据都只退化成空偏好, 不抛。 */
const EFFORT_PREFS_KEY = 'effortPrefs';
let _effortPrefsCache: EffortPrefs = emptyEffortPrefs();
export async function preloadEffortPrefs(): Promise<void> {
  try {
    const r = await (window as any).neox?.uiStateGet?.(EFFORT_PREFS_KEY);
    _effortPrefsCache = parseEffortPrefs(r?.value);
  } catch { /* ignore — 保持空偏好 */ }
}
export function readEffortPrefs(): EffortPrefs {
  return _effortPrefsCache;
}
export function writeEffortPrefs(prefs: EffortPrefs): void {
  _effortPrefsCache = prefs;
  void (window as any).neox?.uiStateSet?.(EFFORT_PREFS_KEY, serializeEffortPrefs(prefs));
}

/** key 失效 / 没额度这类错误 —— 换模型才能好, 重试没用 */
const DEAD_KEY_CODES = new Set(['UNAUTHORIZED', 'FORBIDDEN', 'QUOTA_EXCEEDED', 'INSUFFICIENT_BALANCE', '401', '402', '403']);

export function pickDefaultAfterDeadKey(opts: {
  code: string | undefined;
  failedModelId: string | undefined;
  lastModelId: string | null;
  subscription: ModelInfo[];
}): ModelInfo | null {
  const { code, failedModelId, lastModelId, subscription } = opts;
  if (!code || !DEAD_KEY_CODES.has(String(code))) return null;
  if (!lastModelId || !failedModelId || lastModelId !== failedModelId) return null;
  if (lastModelId.startsWith('neox-cloud:') || subscription.length === 0) return null;
  const bare = lastModelId.slice(lastModelId.indexOf(':') + 1);
  return subscription.find((m) => m.id === `neox-cloud:${bare}` || m.name === bare)
    ?? subscription.find((m) => isAutoRoutedModelName(m.name))
    ?? subscription[0]
    ?? null;
}

/** 按会话 modelId 在可用列表里找模型 — 兼容 bare / provider:model / neox-cloud:model. */
export function findModelInAvailableList(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  const exact = models.find((m) => m.id === modelId);
  if (exact) return exact;
  const bareOf = (id: string) => {
    const idx = id.indexOf(':');
    return idx > 0 && idx < id.length - 1 ? id.slice(idx + 1) : id;
  };
  const want = bareOf(modelId);
  const prefix = modelId.includes(':') ? modelId.slice(0, modelId.indexOf(':')) : null;
  const same = models.filter((m) => {
    if (m.id === want) return true;
    const bare = bareOf(m.id);
    return bare === want || m.id.endsWith(`:${want}`);
  });
  if (prefix) return same.find((m) => (m.providerId ?? (m.id.includes(':') ? m.id.slice(0, m.id.indexOf(':')) : '')) === prefix);
  return same.find((m) => m.providerId === 'neox-cloud') ?? same[0];
}
