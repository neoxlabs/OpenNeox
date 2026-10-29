import React from 'react';
import { IconCloud } from '../shell/shellIcons';
import { useI18n } from '../../hooks/useI18n';

interface Props {
  /** 'cloud' 才显完整 banner; 'migrating'/'syncing-back' 显轻量进度提示 */
  state: 'cloud' | 'migrating' | 'syncing-back';
  /** pod id (如已知) — 用于人话描述 */
  podId?: string | null;
  /** 文件数 (从 snapshot manifest, 可选) */
  fileCount?: number | null;
  /** 最近活跃时间 (ms) */
  lastActiveAt?: number | null;
  /** Server session 状态 — 'suspended'/'idle' 时 banner 显特别提示 */
  sessionState?: string | null;
  onPullBack?: () => void;
  onTerminate?: () => void;
}

function fmtRelative(ts: number | null | undefined, isZh: boolean): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return isZh ? '刚刚' : 'just now';
  if (diff < 3_600_000) return isZh ? `${Math.floor(diff / 60_000)} 分钟前` : `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return isZh ? `${Math.floor(diff / 3_600_000)} 小时前` : `${Math.floor(diff / 3_600_000)}h ago`;
  return isZh ? `${Math.floor(diff / 86_400_000)} 天前` : `${Math.floor(diff / 86_400_000)}d ago`;
}

export const CloudSessionBanner: React.FC<Props> = ({
  state, podId, fileCount, lastActiveAt, sessionState, onPullBack, onTerminate,
}) => {
  const { isZh } = useI18n();
  const isMigrating = state === 'migrating' || state === 'syncing-back';
  /* pod 已挂起 (idle 5min snapshot 后销毁) — 用户点 input 会重启 pod (resume) */
  const isSuspended = state === 'cloud' && sessionState === 'suspended';

  return (
    <div className={`atl-cloud-banner${isMigrating ? ' is-migrating' : ''}${isSuspended ? ' is-suspended' : ''}`}>
      <span className="atl-cloud-banner__icon"><IconCloud size={14} /></span>
      <div className="atl-cloud-banner__main">
        <div className="atl-cloud-banner__title">
          {state === 'migrating' ? (isZh ? '正在推到云端…' : 'Pushing to cloud…')
            : state === 'syncing-back' ? (isZh ? '正在从云端拉回…' : 'Pulling back from cloud…')
            : isSuspended ? (isZh ? '云端会话已挂起' : 'Cloud session suspended')
            : (isZh ? '会话在云端运行' : 'Session running in cloud')}
        </div>
        {state === 'cloud' && (
          <div className="atl-cloud-banner__meta">
            {podId && <span>{podId}</span>}
            {fileCount != null && <span>{isZh ? `${fileCount} 个文件` : `${fileCount} files`}</span>}
            <span>{isZh ? '活跃于' : 'Active'} {fmtRelative(lastActiveAt, isZh)}</span>
            <span className="atl-cloud-banner__hint">
              {isSuspended
                ? (isZh ? '· pod 已 idle 销毁, 发消息会自动 resume' : '· pod was idled; sending a message will resume it')
                : (isZh ? '· 在这里发消息会直达云端会话, 也可随时拉回本机' : '· messages here go to the cloud session; you can pull it back anytime')}
            </span>
          </div>
        )}
      </div>
      {state === 'cloud' && (
        <div className="atl-cloud-banner__actions">
          {onPullBack && (
            <button type="button" className="atl-cloud-banner__btn" onClick={onPullBack}>
              {isZh ? '拉回本机' : 'Pull back locally'}
            </button>
          )}
          {onTerminate && (
            <button
              type="button"
              className="atl-cloud-banner__btn atl-cloud-banner__btn--danger"
              onClick={onTerminate}
              title={isZh ? '销毁云端 pod, 本地副本保留' : 'Destroy cloud pod; keep local copy'}
            >
              {isZh ? '销毁云端' : 'Destroy cloud'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
