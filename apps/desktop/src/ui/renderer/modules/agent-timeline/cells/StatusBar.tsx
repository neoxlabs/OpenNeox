
import React, { useEffect, useState } from 'react';
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import { DotSpinner } from '../../../components/DotSpinner';

interface StatusBarProps {
  /** runtime.streaming — turn 是否运行中. 为 false 时整条 status bar 不渲染. */
  streaming: boolean;
  /** turn 开始 epoch ms; 算 elapsed 用 */
  turnStartedAt?: number | null;
  /** 主 session timelineEvents — 倒序找 active tool / thinking */
  events: TimelineEntry[];
  /** Esc hot-key 字符串; mac 显 'Esc', win 显 'Esc' (本期都一样, 留扩展) */
  interruptKey?: string;
  /** 文案语言 */
  isZh: boolean;
  /** 暂停时显"已暂停", 不显 Esc 提示 */
  paused?: boolean;
}

interface ActiveInsight {
  variant: 'tool' | 'thinking' | 'idle';
  /** 主行文字 — 简短 verb + target */
  primary: string;
  /** 副文字 — 比如 reasoning bold header */
  secondary?: string;
}

const TOOL_VERB_ZH: Record<string, string> = {
  execute_shell: '运行命令',
  execute_bash: '运行命令',
  readfile: '读取文件',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  search: '搜索',
  search_files: '查找文件',
  web_search: '搜索网络',
  web_fetch: '抓取网页',
  list_directory: '列目录',
  show_tree: '查看树',
  run_workflow: '执行工作流',
};

const TOOL_VERB_EN: Record<string, string> = {
  execute_shell: 'Running shell',
  execute_bash: 'Running shell',
  readfile: 'Reading',
  read_file: 'Reading',
  write_file: 'Writing',
  edit_file: 'Editing',
  search: 'Searching',
  search_files: 'Finding files',
  web_search: 'Searching web',
  web_fetch: 'Fetching',
  list_directory: 'Listing',
  show_tree: 'Tree',
  run_workflow: 'Running workflow',
};

const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m === 0) return `${ss}s`;
  if (m < 60) return `${m}m ${ss.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, '0')}m`;
};

/** 倒序找 active tool / thinking, 都没就 idle.
 *   TimelineEntry 用 pending=true 表 "运行中, 还没拿到 tool_result 或 stream 终态".
 *   tool_result / tool_error 出现意味着该 toolCall 已结束, 跳过. */
function deriveActiveInsight(events: TimelineEntry[], isZh: boolean): ActiveInsight {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    const isToolish = e.type === 'tool_call' || e.type === 'file_stream';
    if (isToolish && e.pending === true) {
      const verbMap = isZh ? TOOL_VERB_ZH : TOOL_VERB_EN;
      const toolName = (e.toolName || '').toLowerCase();
      const verb = verbMap[toolName] || (isZh ? '运行工具' : 'Running tool');
      const target = e.targetPath || e.description || '';
      return {
        variant: 'tool',
        primary: target ? `${verb} · ${target}` : verb,
      };
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.type === 'thinking' && e.pending === true) {
      const text = String(e.detail || e.description || '').trim();
      const boldMatch = /\*\*([^*]+)\*\*/.exec(text);
      const secondary = boldMatch?.[1]?.trim();
      return {
        variant: 'thinking',
        primary: isZh ? '思考中' : 'Thinking',
        secondary,
      };
    }
  }
  return { variant: 'idle', primary: isZh ? '处理中' : 'Working' };
}

export const StatusBar: React.FC<StatusBarProps> = ({
  streaming,
  turnStartedAt,
  events,
  interruptKey = 'Esc',
  isZh,
  paused = false,
}) => {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!streaming || !turnStartedAt) return;
    const id = window.setInterval(() => setTick((v) => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [streaming, turnStartedAt]);

  if (!streaming) return null;

  const insight = deriveActiveInsight(events, isZh);
  const elapsed = turnStartedAt ? Date.now() - turnStartedAt : 0;
  void tick;

  return (
    <div className={`atl-status-bar atl-status-bar--${insight.variant}${paused ? ' is-paused' : ''}`} role="status" aria-live="polite">
      <span className="atl-status-bar__icon" aria-hidden="true">
        {insight.variant === 'thinking' ? (
          <span className="atl-status-bar__shimmer" />
        ) : (
          <DotSpinner size={12} />
        )}
      </span>
      <span className="atl-status-bar__primary">{insight.primary}</span>
      {insight.secondary && (
        <span className="atl-status-bar__secondary">— {insight.secondary}</span>
      )}
      <span className="atl-status-bar__spacer" />
      <span className="atl-status-bar__elapsed" title={isZh ? '已用时长' : 'Elapsed'}>
        {formatElapsed(elapsed)}
      </span>
      {!paused && (
        <span className="atl-status-bar__hint" title={isZh ? `按 ${interruptKey} 中断` : `Press ${interruptKey} to interrupt`}>
          {isZh ? `${interruptKey} 中断` : `${interruptKey} to interrupt`}
        </span>
      )}
    </div>
  );
};

export default StatusBar;
