/**
 * CloudAgentTab — Settings → 云端 Agent.
 *
 *   功能:
 *     - 拉用户全部 cloud_agent_sessions, 显 active / suspended 列表
 *     - 每条 session: 标题 / migration_state / 最近活跃 / [拉回] [销毁]
 *     - 累计 cloud 使用时长 (后端补 endpoint 后接入)
 *     - 默认 cloud 模型 (local 设置, 给 RunDestinationPicker "云端" 用)
 *     - 没登录 NeoxCloud → 显登录指引 (跳 远程访问 tab)
 *
 *   不在 cloud 这里做: pod 实时日志 / pod metrics (Phase B 加 admin tools)
 */
import React, { useCallback, useEffect, useState } from 'react';
import './CloudAgentTab.css';
import { useI18n, defaultIsZh } from '../../../hooks/useI18n';
import { confirmAsync } from '../../../components/confirmEvents';
import { PageTitle, NeoxButton } from '../../../components/settings-base';
import { friendlyOpError } from '../../../components/notifyEvents';

interface CloudSession {
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
  | { ok: true; sessions: CloudSession[] }
  | { ok: false; status?: number; error?: string };

interface CloudSessionBridge {
  listRemote?: () => Promise<CloudSessionListRemoteResult>;
  terminate?: (sessionId: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
}

function cloudSessionBridge(): CloudSessionBridge | undefined {
  return (window as any).neox?.cloudSession as CloudSessionBridge | undefined;
}

const STATE_LABEL_ZH: Record<string, string> = {
  starting: '启动中', ready: '就绪', active: '运行中', idle: '空闲',
  snapshotting: '正在 snapshot', suspended: '已挂起', terminated: '已结束',
};
const STATE_LABEL_EN: Record<string, string> = {
  starting: 'Starting', ready: 'Ready', active: 'Active', idle: 'Idle',
  snapshotting: 'Snapshotting', suspended: 'Suspended', terminated: 'Terminated',
};

type MigToneRec = { text: string; tone: 'ok' | 'warn' | 'mute' };
const MIG_LABEL_ZH: Record<string, MigToneRec> = {
  native: { text: '云端原生', tone: 'mute' },
  cloud_active: { text: '运行中', tone: 'ok' },
  migrating_to_cloud: { text: '推送中', tone: 'warn' },
  draining: { text: '拉回中', tone: 'warn' },
  snapshot_ready: { text: '快照就绪', tone: 'warn' },
  pulled_back: { text: '已拉回', tone: 'mute' },
};
const MIG_LABEL_EN: Record<string, MigToneRec> = {
  native: { text: 'Cloud-native', tone: 'mute' },
  cloud_active: { text: 'Running', tone: 'ok' },
  migrating_to_cloud: { text: 'Pushing', tone: 'warn' },
  draining: { text: 'Pulling back', tone: 'warn' },
  snapshot_ready: { text: 'Snapshot ready', tone: 'warn' },
  pulled_back: { text: 'Pulled back', tone: 'mute' },
};

function fmtRel(ts: number | null, zh = defaultIsZh()): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (zh) {
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtDuration(secs: number | null, zh = defaultIsZh()): string {
  if (!secs || secs <= 0) return zh ? '0 秒' : '0s';
  if (zh) {
    if (secs < 60) return `${Math.floor(secs)} 秒`;
    if (secs < 3600) return `${Math.floor(secs / 60)} 分钟`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  }
  if (secs < 60) return `${Math.floor(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const CloudAgentTab: React.FC = () => {
  const { language } = useI18n();
  const zh = language === 'zh';
  const STATE_LABEL = zh ? STATE_LABEL_ZH : STATE_LABEL_EN;
  const MIG_LABEL = zh ? MIG_LABEL_ZH : MIG_LABEL_EN;
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const bridge = cloudSessionBridge();
    if (!bridge?.listRemote) {
      setLoggedIn(false);
      setSessions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await bridge.listRemote();
      if (!result.ok) {
        if (result.status === 401) {
          setLoggedIn(false);
          setSessions([]);
          setError(null);
          return;
        }
        throw new Error(result.error ?? 'cloud sessions fetch failed');
      }
      setLoggedIn(true);
      setSessions(result.sessions ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const terminateSession = useCallback(async (sid: string) => {
    const ok = await confirmAsync({
      title: zh ? '销毁云端 session' : 'Terminate Cloud Session',
      message: zh ? '销毁这个云端 session? 云端 pod 会立即停止. 本地副本不动.' : 'Terminate this cloud session? The pod stops immediately; local copy is preserved.',
      confirmLabel: zh ? '销毁' : 'Terminate',
      variant: 'danger',
    });
    if (!ok) return;
    const bridge = cloudSessionBridge();
    if (!bridge?.terminate) {
      setError(zh ? '销毁失败: cloudSession IPC 不可用' : 'Terminate failed: cloudSession IPC unavailable');
      return;
    }
    setBusy((s) => new Set(s).add(sid));
    try {
      const result = await bridge.terminate(sid);
      if (!result.ok) throw new Error(result.error ?? `status=${result.status ?? 'unknown'}`);
      await refresh();
    } catch (e: any) {
      setError(zh ? `销毁失败: ${friendlyOpError(e)}` : `Terminate failed: ${friendlyOpError(e)}`);
    } finally {
      setBusy((s) => { const n = new Set(s); n.delete(sid); return n; });
    }
  }, [refresh, zh]);

  const pullBack = useCallback((sid: string) => {
    /* 走全局 cloud migration dialog — sidebar / banner 都是同一套. */
    window.dispatchEvent(new CustomEvent('neox:request-pull-cloud-session', { detail: { sessionId: sid } }));
  }, []);

  /* 计算总活跃秒数 */
  const totalActiveSecs = sessions.reduce((sum, s) => sum + (s.total_active_secs ?? 0), 0);
  const activeCount = sessions.filter(
    (s) => s.migration_state === 'cloud_active' || s.state === 'active' || s.state === 'ready',
  ).length;

  if (loggedIn === false) {
    return (
      <div className="cloud-agent-tab">
        <div className="cloud-agent-tab__empty">
          <h3>{zh ? '云端 Agent · 需要登录' : 'Cloud Agent · Sign in required'}</h3>
          <p>
            {zh
              ? '关机后继续运行, 跨设备接力, 适合长任务'
              : 'Keep tasks running after you close Neox, hand off across devices'}
          </p>
          <button
            type="button"
            className="cloud-agent-tab__signin"
            onClick={() => window.dispatchEvent(new CustomEvent('neox:login-required'))}
            style={{
              marginTop: 14,
              padding: '8px 18px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--neox-primary-600)',
              color: 'var(--neox-fg-invert, #fff)',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {zh ? '登录 / 注册 →' : 'Sign in / Sign up →'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cloud-agent-tab">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 }}>
        <PageTitle
          title={zh ? '云端 Agent' : 'Cloud Agent'}
        />
        <NeoxButton variant="secondary" size="sm" onClick={() => void refresh()}>
          {zh ? '刷新' : 'Refresh'}
        </NeoxButton>
      </div>

      <div className="cloud-agent-tab__stats">
        <div className="cloud-agent-tab__stat">
          <div className="cloud-agent-tab__stat-num">{activeCount}</div>
          <div className="cloud-agent-tab__stat-label">{zh ? '运行中 session' : 'Active sessions'}</div>
        </div>
        <div className="cloud-agent-tab__stat">
          <div className="cloud-agent-tab__stat-num">{sessions.length}</div>
          <div className="cloud-agent-tab__stat-label">{zh ? '总 session 数' : 'Total sessions'}</div>
        </div>
        <div className="cloud-agent-tab__stat">
          <div className="cloud-agent-tab__stat-num">{fmtDuration(totalActiveSecs, zh)}</div>
          <div className="cloud-agent-tab__stat-label">{zh ? '累计活跃时长' : 'Total active time'}</div>
        </div>
      </div>

      <h3 className="cloud-agent-tab__section">Sessions</h3>
      {error && <div className="cloud-agent-tab__error">{error}</div>}
      {loading && !sessions.length && (
        <div className="cloud-agent-tab__empty neox-text-shimmer">{zh ? '加载中…' : 'Loading…'}</div>
      )}
      {!loading && sessions.length === 0 && !error && (
        <div className="cloud-agent-tab__empty">
          <p>{zh ? '你还没有云端 session.' : 'No cloud sessions yet.'}</p>
          <p className="cloud-agent-tab__hint">
            {zh
              ? <>在 timeline 底部点 <strong>"云端"</strong>, 或右键侧栏 session → <strong>"推到云端继续"</strong></>
              : <>Click <strong>Cloud</strong> at the bottom of the timeline, or right-click a sidebar session → <strong>Continue in cloud</strong></>}
          </p>
        </div>
      )}
      {sessions.length > 0 && (
        <ul className="cloud-agent-tab__list">
          {sessions.map((s) => {
            const mig = MIG_LABEL[s.migration_state ?? 'native'] ?? MIG_LABEL.native;
            const isCloudActive = s.migration_state === 'cloud_active' || s.migration_state === 'native';
            return (
              <li key={s.session_id} className="cloud-agent-tab__item">
                <div className="cloud-agent-tab__item-main">
                  <div className="cloud-agent-tab__item-title">{s.title || (zh ? '云端会话' : 'Cloud session')}</div>
                  <div className="cloud-agent-tab__item-meta">
                    <span className={`cloud-agent-tab__pill cloud-agent-tab__pill--${mig.tone}`}>
                      {mig.text}
                    </span>
                    <span>{STATE_LABEL[s.state] ?? s.state}</span>
                    {s.model_id && <span><code>{s.model_id}</code></span>}
                    <span>{zh ? `活跃于 ${fmtRel(s.last_active_at, zh)}` : `Active ${fmtRel(s.last_active_at, zh)}`}</span>
                  </div>
                </div>
                <div className="cloud-agent-tab__item-actions">
                  {isCloudActive && (
                    <button
                      type="button"
                      className="cloud-agent-tab__btn"
                      onClick={() => pullBack(s.session_id)}
                      disabled={busy.has(s.session_id)}
                    >
                      {zh ? '拉回本机' : 'Pull back'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="cloud-agent-tab__btn cloud-agent-tab__btn--danger"
                    onClick={() => void terminateSession(s.session_id)}
                    disabled={busy.has(s.session_id)}
                  >
                    {zh ? '销毁' : 'Terminate'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default CloudAgentTab;
