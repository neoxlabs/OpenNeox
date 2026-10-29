
import React, { useMemo, useState } from 'react';
import TimelineTextRenderer from '../TimelineTextRenderer';
import { getBackgroundTasks } from '../../../state/backgroundTasksStore';
import { openServicesSurface } from '../BackgroundTasksBar';
import { IconTerminal } from '../../shell/shellIcons';
import { useI18n } from '../../../hooks/useI18n';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { SubAgentMark } from './SubAgentMark';
import type { BackgroundShellNotification, AgentCompletion } from './systemMessageParsers';

interface BackgroundShellProps {
  notification: BackgroundShellNotification;
  timestamp?: string;
}

/* 输出默认露出的行数: 够看出「起来没 / 报了什么错」, 再多就点「展开全部」 */
const OUT_PREVIEW_LINES = 4;

export const BackgroundShellCell: React.FC<BackgroundShellProps> = ({ notification, timestamp }) => {
  const { isZh } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const statusLabel = notification.status === 'completed' ? (isZh ? '已完成' : 'Completed')
    : notification.status === 'failed' ? (isZh ? '失败' : 'Failed')
    : notification.status === 'killed' ? (isZh ? '已终止' : 'Killed')
    : notification.status;
  const tone = notification.status === 'completed' ? 'ok' : notification.status === 'failed' ? 'bad' : 'idle';
  /* 被停掉的: 说清楚是谁停的 (summary 里那段英文是写给模型的, 意思翻成一句人话放在状态上) */
  const stoppedBy = notification.status === 'killed'
    ? notification.terminatedBy === 'user' ? (isZh ? '你停止了它' : 'Stopped by you')
      : notification.terminatedBy === 'agent' ? (isZh ? 'Agent 停止了它' : 'Stopped by agent')
      : notification.terminatedBy === 'system' ? (isZh ? '系统停止' : 'Stopped by system')
      : undefined
    : undefined;
  const lastLine = useMemo(
    () => getBackgroundTasks().find((t) => t.pid === notification.pid)?.lastOutputLine?.trim() || '',
    [notification.pid],
  );
  const lines = lastLine ? lastLine.split('\n') : [];
  const hasOut = lines.length > 0;
  const clipped = !expanded && lines.length > OUT_PREVIEW_LINES;
  const shown = clipped ? lines.slice(-OUT_PREVIEW_LINES) : lines;
  /* 正常结束收着; 失败 / 被终止时默认摊开最后的输出 */
  const [showOut, setShowOut] = useState(notification.status !== 'completed');

  return (
    /* 外层留着 atl-tool: 时间线的行盒契约 (缩进 / 宽度) 认这个类; 但它的底色和阴影被主题层
     * !important 清空了, 所以卡的外观画在里面这一层 .atl-bgcard 上 */
    <div
      className={`atl-tool atl-bgtask is-${notification.status === 'completed' ? 'done' : notification.status}`}
      data-content-type="background-task"
    >
      <div className="atl-bgcard">
      <div className="atl-bgcard__head">
        <span className="atl-bgcard__ic" aria-hidden="true"><IconTerminal size={14} /></span>
        <span className="atl-bgcard__title">{isZh ? '后台任务' : 'Background task'}</span>
        {notification.command && <span className="atl-bgcard__cmd" title={notification.command}>{notification.command}</span>}
        <span className="atl-bgcard__right">
          <span className={`atl-bgcard__state is-${tone}`}>
            {stoppedBy ?? statusLabel}
            {typeof notification.exitCode === 'number' && <em>exit {notification.exitCode}</em>}
          </span>
          {notification.pid > 0 && <span className="atl-bgcard__pid">pid {notification.pid}</span>}
          {timestamp && <span className="atl-bgcard__time">{timestamp}</span>}
          {hasOut && (
            <button type="button" className="atl-changes__btn" aria-expanded={showOut} onClick={() => setShowOut((v) => !v)}>
              {showOut ? (isZh ? '收起' : 'Hide') : (isZh ? '输出' : 'Output')}
            </button>
          )}
          {notification.pid > 0 && (
            <button type="button" className="atl-changes__btn" onClick={() => openServicesSurface(isZh, notification.pid)}>
              {isZh ? '日志' : 'Log'}
            </button>
          )}
        </span>
      </div>
      {hasOut && showOut && (
        <div className="atl-bgcard__out">
          <pre>{shown.join('\n')}</pre>
          {lines.length > OUT_PREVIEW_LINES && (
            <button type="button" className="atl-bgcard__more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? (isZh ? '收起' : 'Show less') : (isZh ? `展开全部 ${lines.length} 行` : `Show all ${lines.length} lines`)}
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
};

interface AgentCompletionProps {
  completion: AgentCompletion;
}


export const AgentCompletionCell: React.FC<AgentCompletionProps> = ({ completion }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntime() as any;
  const label = completion.name || completion.agentId.slice(0, 12);
  const chips: string[] = [];
  if (completion.elapsedSeconds > 0) chips.push(`${completion.elapsedSeconds}s`);
  if (completion.toolUseCount > 0) chips.push(isZh ? `${completion.toolUseCount} 工具` : `${completion.toolUseCount} tool${completion.toolUseCount === 1 ? '' : 's'}`);
  const statusName = completion.status === 'failed' ? (isZh ? '失败' : 'Failed')
    : completion.status === 'aborted' ? (isZh ? '已中止' : 'Aborted')
    : (isZh ? '已完成' : 'Completed');
  const openSubAgent = (e: React.MouseEvent) => {
    e.preventDefault();   /* 别让 <summary> 顺手把 details 折叠了 */
    e.stopPropagation();
    runtime?.selectSession?.(completion.agentId);
  };
  const canOpen = typeof runtime?.selectSession === 'function';
  return (
    <details className="atl-agent-done">
      <summary className="atl-agent-done__head">
        <span
          className={`atl-agent-done__icon atl-agent-done__icon--${completion.status}`}
          aria-label={statusName}
        >
          {/* logo 换成子 agent 的 mark —— 状态由这枚 icon 的颜色 + 右侧状态字表达 */}
          <SubAgentMark size={13} aria-hidden />
        </span>
        <span className="atl-agent-done__label">{label}</span>
        {chips.map((c, i) => <span key={i} className="atl-agent-done__chip">{c}</span>)}
        <span className="atl-agent-done__desc">{completion.description}</span>
        <span className={`atl-agent-done__status is-${completion.status}`}>{statusName}</span>
        {canOpen && (
          <button
            type="button"
            className="atl-agent-done__open"
            onClick={openSubAgent}
            title={isZh ? '进入这个子 agent 的对话, 看它每一步做了什么' : "Open this sub-agent's own timeline"}
          >
            {isZh ? '查看过程' : 'Open'}
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor"
              strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m4.5 2.5 3 3.5-3 3.5" />
            </svg>
          </button>
        )}
      </summary>
      {completion.summary && (
        <div className="atl-agent-done__body">
          <TimelineTextRenderer content={completion.summary} />
        </div>
      )}
    </details>
  );
};
