import React, { useEffect, useMemo, useState } from 'react';
import { IconStop, IconRefresh } from '../shell/shellIcons';
import ServiceManagerBadge from './ServiceManagerBadge';
import { CloudSyncCapsule } from './CloudSyncCapsule';
import type { CloudLocation } from '../shell/cloudLocation';
import GitBranchChip from '../../components/GitBranchChip';
import type { AgentModeValue } from '../../hooks/useAgentModeVariant';
import { useI18n } from '../../hooks/useI18n';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';

interface TimelineHeaderProps {
  title: string;
  turnStartedAt?: number | null;
  running: boolean;
  paused?: boolean;
  onStop?: () => void;
  /** 当前会话所属工作目录 (绝对路径). 显示 basename + tooltip 完整路径. */
  workspacePath?: string;
  /** 当前 session 的 cloud location — 决定是否显 sync 胶囊. */
  cloudLocation?: CloudLocation;
  sessionId?: string;
  agentMode?: AgentModeValue | null;
}

const pad = (n: number) => n.toString().padStart(2, '0');
const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  return `${pad(h)}:${pad(m)}:${pad(rs)}`;
};

/** 叶子计时 — 仅自身 1Hz 重渲, 不牵动 header 外兄弟树 */
const ElapsedClock: React.FC<{ startedAt: number; active: boolean }> = React.memo(({ startedAt, active }) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  const text = useMemo(() => {
    void tick;
    return formatElapsed(Date.now() - startedAt);
  }, [startedAt, tick]);
  return <span className="atl-running__time">{text}</span>;
});
ElapsedClock.displayName = 'ElapsedClock';

/** 取路径最后一段 — basename 用 unicode 安全的 split, 支持 / \ 混用. */
function basenameOf(p: string): string {
  if (!p) return '';
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] || p;
}

/* ============================================================
 * TimelineHeader — 极薄会话条 (仅一行)
 *   左: 会话标题
 *   右: 运行胶囊 · 暂停/继续 · 停止
 *   · running=false 时 pause/stop 不渲染 (空操作没意义)
 * ============================================================ */
export const TimelineHeader: React.FC<TimelineHeaderProps> = ({
  title,
  turnStartedAt,
  running,
  paused = false,
  onStop,
  workspacePath,
  cloudLocation,
  sessionId,
  /* agentMode 保留在 props 里 (调用方不用改), 本行已不渲染模式切换 —— 见下方注释 */
}) => {
  const { isZh } = useI18n();
  const modeVariant = useAgentModeVariant();
  const showControls = running || paused;
  const showElapsed = Boolean(turnStartedAt) && (running || paused);
  const wsName = modeVariant.isWork ? '' : basenameOf(workspacePath || '');
  const showCloudCapsule = cloudLocation && cloudLocation !== 'local';
  return (
    <header className={`atl-header${running ? ' is-running' : ''}${paused ? ' is-paused' : ''}`}>
      <h1 className="atl-header__title" title={title}>
        {running && <span className="atl-header__livedot" aria-hidden="true" />}
        {title}
      </h1>
      <div className="atl-header__right">
        {/* Git branch chip — 在 cwd 标签左侧, 跟 cwd 是工作上下文双胞胎.
         *   非 git 仓库自动隐藏; agent 运行中禁用切换 (避免跟 agent 写文件 race). */}
        <GitBranchChip cwd={workspacePath} variant="header" disabled={running} />
        {wsName && (
          <span className="atl-header__workspace" title={workspacePath}>
            {wsName}
          </span>
        )}
        {/* Cloud sync 胶囊 — session 在 cloud (或正在迁移) 时显, 让用户一眼看到 location. */}
        {showCloudCapsule && (
          <CloudSyncCapsule state={cloudLocation as Exclude<CloudLocation, 'local'>} />
        )}
        {/* 服务管理 badge — 有 background 进程在跑时才显示, 提供 pid/暂停/恢复/停止控制.
          * 放在 running 胶囊左边, 跟暂停/停止按钮一起组成右侧"运行态"控制簇 */}
        <ServiceManagerBadge />
        {/* 任务详情 (i) — 从 composer 工具栏迁来; 跟会话标题同一行更易触达,
         * 点击 dispatch 'neox:toggle-task-detail' 由 TaskDetailPopover 接管显隐. */}
        <button
          type="button"
          className="atl-header__taskdetail"
          data-task-detail-trigger="1"
          onClick={(e) => {
            /* 把按钮自身 boundingRect 塞进事件 detail, 让 TaskDetailPopover 跟随定位.
             *   旧实现 popover position:fixed top:84 right:16 写死, 跟 i 按钮真实位置无关
             *   (大屏 button 在 main 区中间, popover 还固定在屏幕右上角, 视觉脱节). */
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            window.dispatchEvent(new CustomEvent('neox:toggle-task-detail', {
              detail: { anchor: { top: rect.bottom, right: window.innerWidth - rect.right } },
            }));
          }}
          title={isZh ? "任务详情 — token / checkpoints / 最近工具" : "Task details — tokens / checkpoints / recent tools"}
          aria-label={isZh ? "任务详情" : "Task details"}
        >
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 6.2 V10" />
            <circle cx="7" cy="4.2" r=".7" fill="currentColor" stroke="none" />
          </svg>
        </button>
        {running && !paused && (
          <span className="atl-running" aria-live="polite">
            <IconRefresh size={10} />
            <span>{isZh ? "运行中" : "Running"}</span>
            {showElapsed && turnStartedAt ? (
              <ElapsedClock startedAt={turnStartedAt} active />
            ) : null}
          </span>
        )}
        {paused && (
          <span className="atl-running is-paused" aria-live="polite">
            <span>{isZh ? "已暂停" : "Paused"}</span>
            {showElapsed && turnStartedAt ? (
              <ElapsedClock startedAt={turnStartedAt} active={false} />
            ) : null}
          </span>
        )}
        {/* aria-hidden 同步 —— 按钮虽然 disabled 不可聚焦, 但仍会被读屏念出来;
            空会话里念一句"暂停按钮, 已禁用"跟视觉上的幽灵按钮是同一个问题。 */}
        <span
          className={`atl-controls${showControls ? '' : ' atl-controls--off'}`}
          aria-hidden={!showControls}
        >
          <button type="button" className="atl-btn is-danger" onClick={onStop} aria-label={isZh ? "停止" : "Stop"} disabled={!showControls}>
            <IconStop size={10} />
            <span>{isZh ? "停止" : "Stop"}</span>
          </button>
        </span>
      </div>
    </header>
  );
};

export default TimelineHeader;
