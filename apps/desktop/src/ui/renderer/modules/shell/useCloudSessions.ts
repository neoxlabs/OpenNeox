/**
 * useCloudSessions — desktop renderer 拉 cloud sessions + push/pull 操作 wrap.
 *
 *   职责:
 *     - 进 shell 时 + 30s 轮询拉 /api/v1/cloud-agent/sessions
 *     - 暴露 list (CloudSessionSummary[]) + isLoggedIn
 *     - 暴露 actions: pushToCloud(localSession) / pullToLocal(cloudSessionId) — 走 IPC
 *     - migration progress event 转 useToast (在 NeoxShellHost 注册一次, hook 这里只 expose actions)
 *
 *   设计: 跟 mobile 同款数据源 (control-plane 同 endpoint), desktop 跟 mobile 看到的是同一份 cloud session list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmAsync } from '../../components/confirmEvents';
import { getEditionHook } from './editionHooks';

export interface CloudSessionSummary {
  sessionId: string;
  agentDeviceId: string;
  state: string;
  title: string | null;
  modelId: string | null;
  createdAt: number | null;
  lastActiveAt: number | null;
  totalActiveSecs: number | null;
  /** 真相源 — control-plane 维护. UI 据此显示徽标 + 决定能否操作. */
  migrationState?: 'native' | 'migrating_to_cloud' | 'cloud_active' | 'draining' | 'snapshot_ready' | 'pulled_back';
}

export interface WorkspaceAnalysisRenderer {
  payloadBytes: number;
  fileCount: number;
  recommended: 'upload' | 'git';
  isLarge: boolean;
  git: {
    isRepo: boolean;
    remoteUrl: string | null;
    branch: string | null;
    head: string | null;
    dirty: boolean;
    dirtyFileCount: number;
  };
}

interface CloudMigrationApi {
  push: (input: {
    sessionId: string;
    workspacePath: string;
    modelId: string;
    title?: string;
    messages?: Array<{ role: string; content: string; ts?: number; reasoning_content?: string }>;
    desktopDeviceId?: string;
  }) => Promise<{ sessionId: string; agentDeviceId: string; state: string }>;
  pushViaGit: (input: {
    sessionId: string;
    workspacePath: string;
    modelId: string;
    title?: string;
    messages?: Array<{ role: string; content: string; ts?: number; reasoning_content?: string }>;
    gitUrl: string;
    branch: string;
    headCommit: string | null;
    dirtyMode: 'ignore' | 'auto-commit-temp' | 'patch';
    authMode: 'token' | 'userpass';
    authUser?: string;       /* userpass 模式时填 */
    authToken: string;       /* token 或 password */
  }) => Promise<{ sessionId: string; agentDeviceId: string; state: string }>;
  pull: (input: { sessionId: string; targetWorkspacePath: string; confirmOverwrite?: boolean }) => Promise<{ ok: boolean; error?: string; needsConfirm?: boolean; existingFiles?: number }>;
  status: (sessionId: string) => Promise<{ migration_state: string; last_snapshot_id: string | null }>;
  analyze: (workspacePath: string) => Promise<WorkspaceAnalysisRenderer>;
  onProgress: (handler: (evt: { sessionId: string; stage: string; pct?: number; msg?: string }) => void) => (() => void) | undefined;
}

interface CloudAgentRemoteSession {
  session_id: string;
  agent_device_id: string;
  state: string;
  title: string | null;
  model_id: string | null;
  created_at: number | null;
  last_active_at: number | null;
  total_active_secs: number | null;
  migration_state?: string;
}

type CloudSessionListRemoteResult =
  | { ok: true; sessions: CloudAgentRemoteSession[] }
  | { ok: false; status?: number; error?: string };

interface CloudSessionApi {
  listRemote?: () => Promise<CloudSessionListRemoteResult>;
  terminate?: (sessionId: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
  control?: (sessionId: string, patch: { model_id?: string; approval_mode?: string }) => Promise<{ ok: boolean; status?: number; error?: string }>;
}

interface NeoxWindow {
  cloudSession?: CloudSessionApi;
  cloudMigration?: CloudMigrationApi;
}

function neox(): NeoxWindow {
  return ((window as unknown as { neox?: NeoxWindow }).neox ?? {});
}

const POLL_INTERVAL_MS = 30_000;
const MIGRATION_STATES = new Set<NonNullable<CloudSessionSummary['migrationState']>>([
  'native',
  'migrating_to_cloud',
  'cloud_active',
  'draining',
  'snapshot_ready',
  'pulled_back',
]);

function normalizeMigrationState(value: string | undefined): CloudSessionSummary['migrationState'] | undefined {
  return MIGRATION_STATES.has(value as NonNullable<CloudSessionSummary['migrationState']>)
    ? value as CloudSessionSummary['migrationState']
    : undefined;
}

/** 浅比较两个 cloud session list, 决定 setCloudSessions 是否要更新 ref.
 *   字段顺序固定, 跨 poll 同 sessionId+state+title+lastActiveAt+migrationState 视为相等.
 *   不比较 totalActiveSecs (累计秒数实时变, 不影响列表渲染). */
function isSameCloudList(a: CloudSessionSummary[], b: CloudSessionSummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x.sessionId !== y.sessionId) return false;
    if (x.agentDeviceId !== y.agentDeviceId) return false;
    if (x.state !== y.state) return false;
    if (x.title !== y.title) return false;
    if (x.modelId !== y.modelId) return false;
    if (x.lastActiveAt !== y.lastActiveAt) return false;
    if (x.migrationState !== y.migrationState) return false;
  }
  return true;
}

export interface PushToCloudResult {
  ok: boolean;
  error?: string;
}

export function useCloudSessions(): {
  cloudSessions: CloudSessionSummary[];
  isLoading: boolean;
  refresh: () => Promise<void>;
  pushToCloud: (input: {
    sessionId: string;
    workspacePath: string;
    modelId: string;
    title?: string;
    messages?: Array<{ role: string; content: string; ts?: number; reasoning_content?: string }>;
  }) => Promise<PushToCloudResult>;
  pullToLocal: (sessionId: string, targetWorkspacePath: string, options?: { confirmOverwrite?: boolean }) => Promise<boolean>;
  terminateCloud: (sessionId: string) => Promise<boolean>;
  syncSessionConfig: (sessionId: string, patch: { model_id?: string; approval_mode?: string }) => Promise<boolean>;
} {
  const [cloudSessions, setCloudSessions] = useState<CloudSessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inflightRef = useRef<Promise<void> | null>(null);
  /* 连续失败计数 — 第 3 次失败才提示用户, 不刷屏. 成功一次就归零. */
  const consecutiveFailureRef = useRef(0);
  const lastToastTsRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (inflightRef.current) return inflightRef.current;
    const p = (async () => {
      const api = neox();
      const listRemote = api.cloudSession?.listRemote;
      /* 没有账号体系的发行版 (开源版) 主进程不注册云会话 IPC, 调了只会在日志里刷 "No handler" */
      if (!listRemote || !getEditionHook('hasAccount')) {
        setCloudSessions([]);
        return;
      }
      try {
        setIsLoading(true);
        const result = await listRemote();
        if (!result.ok) {
          if (result.status === 401) {
            setCloudSessions([]);
            consecutiveFailureRef.current = 0;
            return;
          }
          throw new Error(result.error ?? 'cloud sessions fetch failed');
        }
        const list: CloudSessionSummary[] = result.sessions.map((s) => ({
          sessionId: String(s.session_id ?? ''),
          agentDeviceId: String(s.agent_device_id ?? ''),
          state: String(s.state ?? ''),
          title: s.title ?? null,
          modelId: s.model_id ?? null,
          createdAt: typeof s.created_at === 'number' ? s.created_at : null,
          lastActiveAt: typeof s.last_active_at === 'number' ? s.last_active_at : null,
          totalActiveSecs: typeof s.total_active_secs === 'number' ? s.total_active_secs : null,
          migrationState: normalizeMigrationState(s.migration_state),
        }));
        setCloudSessions((prev) => (isSameCloudList(prev, list) ? prev : list));
        consecutiveFailureRef.current = 0;
      } catch (err) {
        /* network error — 连续 3 次 (~90s) 都失败才提示, 且最多 5min 一条 toast, 不刷屏.
         * 不清空 cloudSessions (保留 stale 数据让用户能看到旧列表), 等用户点 sidebar 触发新建/切换时
         * 显式 retry. */
        consecutiveFailureRef.current += 1;
        const now = Date.now();
        if (consecutiveFailureRef.current >= 3 && now - lastToastTsRef.current > 5 * 60_000) {
          lastToastTsRef.current = now;
          try {
            window.dispatchEvent(new CustomEvent('neox:op-failed', {
              detail: { op: '云端会话同步', message: `网络异常 — 已重试 ${consecutiveFailureRef.current} 次, 下次操作时自动恢复` },
            }));
          } catch { /* ignore */ }
        }
        console.warn('[useCloudSessions] refresh failed:', err);
      } finally {
        setIsLoading(false);
      }
    })();
    inflightRef.current = p;
    try { await p; } finally { inflightRef.current = null; }
  }, []);

  /* mount + interval poll */
  useEffect(() => {
    void refresh();
    const handle = window.setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    /* 显式 refresh 事件 — 例如 cloud-session:create 完成后 NeoxShellHost 派发,
     * 避免等到下一个 30s tick 才看到新条. */
    const onRefresh = () => { void refresh(); };
    window.addEventListener('neox:cloud-sessions-refresh', onRefresh);
    return () => {
      window.clearInterval(handle);
      window.removeEventListener('neox:cloud-sessions-refresh', onRefresh);
    };
  }, [refresh]);

  const pushToCloud = useCallback(async (input: {
    sessionId: string;
    workspacePath: string;
    modelId: string;
    title?: string;
    messages?: Array<{ role: string; content: string; ts?: number; reasoning_content?: string }>;
  }): Promise<PushToCloudResult> => {
    const api = neox().cloudMigration;
    if (!api) {
      return { ok: false, error: 'cloudMigration IPC 不可用 (preload 没加载?)' };
    }
    try {
      await api.push(input);
      await refresh();
      setTimeout(() => { void refresh(); }, 5000);
      return { ok: true };
    } catch (err: any) {
      /* err.message 通常是 IPC 抛回来的 main-process 错误, 比如 "migrate-from-desktop 401: ..." */
      const msg = err?.message ?? String(err);
      // eslint-disable-next-line no-console
      console.warn('[useCloudSessions] pushToCloud failed:', err);
      return { ok: false, error: msg };
    }
  }, [refresh]);

  /** 销毁云端 pod (本地副本不动). control-plane token 只在 main IPC 内使用. */
  const terminateCloud = useCallback(async (sessionId: string): Promise<boolean> => {
    const api = neox().cloudSession;
    if (!api?.terminate) return false;
    try {
      const result = await api.terminate(sessionId);
      if (!result.ok) {
        console.warn('[useCloudSessions] terminateCloud failed:', result.error ?? result.status);
        return false;
      }
      await refresh();
      return true;
    } catch (err) {
      console.warn('[useCloudSessions] terminateCloud error:', err);
      return false;
    }
  }, [refresh]);

  /** 把本地 approval mode / model 同步给云端 pod. token 不出 main IPC 边界. */
  const syncSessionConfig = useCallback(async (
    sessionId: string,
    patch: { model_id?: string; approval_mode?: string },
  ): Promise<boolean> => {
    const api = neox().cloudSession;
    if (!api?.control) return false;
    try {
      const result = await api.control(sessionId, patch);
      return !!result.ok;
    } catch (err) {
      console.warn('[useCloudSessions] syncSessionConfig error:', err);
      return false;
    }
  }, []);

  const pullToLocal = useCallback(async (sessionId: string, targetWorkspacePath: string, options?: { confirmOverwrite?: boolean }): Promise<boolean> => {
    const api = neox().cloudMigration;
    if (!api) return false;
    try {
      const r = await api.pull({ sessionId, targetWorkspacePath, confirmOverwrite: options?.confirmOverwrite }) as any;
      /* main 端返 needsConfirm=true 表示目标目录非空, 需要 UI 二次确认. */
      if (r.needsConfirm) {
        const confirmed = await confirmAsync({
          title: '覆盖目标目录?',
          message: `目标目录已有 ${r.existingFiles} 个文件 / 子目录, 拉回操作会覆盖它们. 继续吗?`,
          description: '取消 → 选别的目录, 比如新建一个空文件夹.',
          variant: 'danger',
          confirmLabel: '覆盖并拉回',
        });
        if (!confirmed) return false;
        return pullToLocal(sessionId, targetWorkspacePath, { confirmOverwrite: true });
      }
      if (!r.ok) {
        console.warn('[useCloudSessions] pullToLocal:', r.error);
        return false;
      }
      await refresh();
      setTimeout(() => { void refresh(); }, 5000);
      return true;
    } catch (err) {
      console.warn('[useCloudSessions] pullToLocal failed:', err);
      return false;
    }
  }, [refresh]);

  return { cloudSessions, isLoading, refresh, pushToCloud, pullToLocal, terminateCloud, syncSessionConfig };
}

/**
 * 把 CloudSessionSummary 的 migration_state 翻成 SessionItem.cloudLocation.
 *   - native / cloud_active                → 'cloud'
 *   - migrating_to_cloud                   → 'migrating'
 *   - draining / snapshot_ready            → 'syncing-back'
 *   - pulled_back / terminated / undefined → undefined (不显徽标)
 */
export function migrationStateToCloudLocation(
  state: CloudSessionSummary['migrationState'] | undefined,
): 'cloud' | 'migrating' | 'syncing-back' | undefined {
  if (!state) return undefined;
  if (state === 'native' || state === 'cloud_active') return 'cloud';
  if (state === 'migrating_to_cloud') return 'migrating';
  if (state === 'draining' || state === 'snapshot_ready') return 'syncing-back';
  return undefined;
}
