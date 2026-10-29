import { useEffect, useState } from 'react';

export type UpdatePhase =
  /** 没有更新 (或还没查) — 界面上什么都不显示 */
  | 'idle'
  /** 有新版本, 还没下 */
  | 'available'
  /** 正在下 */
  | 'downloading'
  /** 已下好并校验通过, 点一下就重启装上 */
  | 'ready'
  /** 已经在重启安装了 */
  | 'installing';

export interface UpdateAvailability {
  phase: UpdatePhase;
  version?: string;
  /** downloading 时的百分比 (0-100) */
  percent?: number;
  /** available 时可以直接喂给 updateDownload 的地址 */
  downloadUrl?: string;
}

type Bridge = {
  updateCheck?: () => Promise<{ hasUpdate: boolean; latestVersion?: string; downloadUrl?: string; error?: string }>;
  updateStagedStatus?: () => Promise<{ ready: boolean; version?: string }>;
  updateDownload?: (url?: string) => Promise<{ success: boolean; error?: string; paused?: boolean }>;
  updateInstall?: (filePath?: string) => Promise<{ success: boolean; error?: string }>;
  onUpdateProgress?: (cb: (p: { percent: number; paused?: boolean }) => void) => () => void;
  onUpdateReady?: (cb: (p: { id: number; version?: string }) => void) => () => void;
};

const bridge = (): Bridge | null => {
  try { return ((window as unknown as { neox?: Bridge }).neox) ?? null; } catch { return null; }
};

let state: UpdateAvailability = { phase: 'idle' };
const listeners = new Set<(s: UpdateAvailability) => void>();

function set(next: Partial<UpdateAvailability>): void {
  state = { ...state, ...next };
  for (const fn of listeners) {
    try { fn(state); } catch { /* 一个订阅者抛错不该带塌其他的 */ }
  }
}

/** 已下好的包优先 —— 有它就不用再问 feed 了, 而且 ready 比 available 更进一步。 */
export async function refreshUpdateAvailability(): Promise<void> {
  const api = bridge();
  if (!api) return;
  /* 正在下 / 正在装的时候不要被一次后台轮询打回 available */
  if (state.phase === 'downloading' || state.phase === 'installing') return;

  try {
    const staged = await api.updateStagedStatus?.();
    if (staged?.ready) { set({ phase: 'ready', version: staged.version }); return; }
  } catch { /* 问不到就往下走正常检查 */ }

  try {
    const info = await api.updateCheck?.();
    if (info?.hasUpdate && !info.error) {
      set({ phase: 'available', version: info.latestVersion, downloadUrl: info.downloadUrl });
    } else if (state.phase === 'available') {
      set({ phase: 'idle', version: undefined, downloadUrl: undefined });
    }
  } catch { /* 网络问题不改状态: 保持上一次的结论, 不要把已有的更新提示抹掉 */ }
}

/** 点胶囊: available → 下载; ready → 重启装上。返回错误文案 (null = 一切正常)。 */
export async function startUpdateAction(): Promise<string | null> {
  const api = bridge();
  if (!api) return null;

  if (state.phase === 'ready') {
    set({ phase: 'installing' });
    const r = await api.updateInstall?.().catch((e: unknown) => ({ success: false, error: String(e) }));
    if (r && !r.success) { set({ phase: 'ready' }); return r.error ?? 'install failed'; }
    return null;                                  /* 成功 = 应用马上就退出重启了 */
  }

  if (state.phase === 'available') {
    set({ phase: 'downloading', percent: 0 });
    const r = await api.updateDownload?.(state.downloadUrl).catch((e: unknown) => ({ success: false, error: String(e), paused: false }));
    if (r?.success) { set({ phase: 'ready', percent: undefined }); return null; }
    /* 暂停不是失败 —— 半成品还在盘上, 退回 available, 再点一下就从断点接着下 */
    set({ phase: 'available', percent: undefined });
    return r?.paused ? null : (r?.error ?? 'download failed');
  }

  return null;
}

/* 订阅主进程那两条推送 —— 挂一次就够, 所以放模块级而不是 effect 里。
 * 后台自动下载的进度和完成事件都从这儿进来, 用户不必打开设置页也看得见。 */
let wired = false;
function wireBridgeEvents(): void {
  if (wired) return;
  const api = bridge();
  if (!api) return;
  wired = true;
  try {
    api.onUpdateProgress?.((p) => {
      const percent = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)));
      if (p?.paused) { set({ phase: 'available', percent: undefined }); return; }
      if (state.phase === 'installing') return;
      set({ phase: percent >= 100 ? state.phase : 'downloading', percent });
    });
  } catch { /* 旧 preload 没这个通道 */ }
  try {
    api.onUpdateReady?.((p) => set({ phase: 'ready', version: p?.version, percent: undefined }));
  } catch { /* 同上 */ }
}

/** 一小时一次 —— 主进程那条是 6h, 这条只是为了让刚开机的那一屏尽快正确。 */
const POLL_MS = 60 * 60 * 1000;

export function useUpdateAvailability(): UpdateAvailability {
  const [snapshot, setSnapshot] = useState<UpdateAvailability>(state);

  useEffect(() => {
    listeners.add(setSnapshot);
    wireBridgeEvents();
    void refreshUpdateAvailability();
    const timer = setInterval(() => { void refreshUpdateAvailability(); }, POLL_MS);
    return () => { listeners.delete(setSnapshot); clearInterval(timer); };
  }, []);

  return snapshot;
}
