/**
 * ExternalAgentView — 派给本机其它 agent CLI 的任务卡
 *
 *   Codex / Claude Code 干活时, 用户在 timeline 里该看到「一个 Agent 在跑」, 而不是
 *   一坨终端输出 —— 它跟子 agent 是同一类事情, 只是跑在另一个进程里。所以这张卡
 *   照着 DelegationView 的形态长: 运行脉冲、状态、任务一行、实时进度一行、结果摘要。
 *
 *   实时进度复用 terminalChunkBus
 *   ----------------------------
 *   runner 的流式输出本来就按 toolCallId 打进这条总线 (跟 shell 卡同一条)。这里
 *   只订阅、只取**最后一行**当 live 文本 —— 外部 agent 一跑几十行, 全摊在主 timeline
 *   里就是另一个「子 agent 吃掉大半屏」的老问题 (见 DelegationView 的注释)。
 *   完整输出在工具结果里, 不在这张卡上。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { fmtAgentElapsed, parseExternalAgentResult } from './externalAgentResult';
import { subscribeTerminalChunk } from '../terminalChunkBus';
import { DotSpinner } from '../../../components/DotSpinner';
import { PluginBrandLogo } from '../../../pages/plugins/components/PluginBrandLogo';

export type ExternalAgentStatus = 'running' | 'completed' | 'error';

export interface ExternalAgentViewProps {
  /** 外部 agent id, 如 codex / claude_code */
  agentId: string;
  /** 显示名 */
  displayName?: string;
  /** 派下去的任务书 */
  task?: string;
  status?: ExternalAgentStatus;
  /** 结果正文 (工具返回) */
  summary?: string;
  error?: string;
  /** 宿主给的 tool_use_id — 用它订阅实时进度 */
  toolCallId?: string;
  elapsedMs?: number;
  /** true = 已转后台, 主对话不再等它 */
  isBackground?: boolean;
  /** 隔离产物 */
  branch?: string;
  changedFiles?: string[];
}

export const ExternalAgentView: React.FC<ExternalAgentViewProps> = ({
  agentId, displayName, task, status = 'running', summary, error,
  toolCallId, elapsedMs, branch, changedFiles, isBackground,
}) => {
  const { isZh } = useI18n();
  const isRunning = status === 'running';
  const [live, setLive] = useState('');
  const liveRef = useRef('');
  const [open, setOpen] = useState(false);
  const result = useMemo(() => parseExternalAgentResult(status === 'error' ? (error || summary) : summary), [status, error, summary]);

  /* 运行中的用时自己走表 (工具还没返回, 拿不到服务端的用时) */
  const [tick, setTick] = useState(0);
  const startedRef = useRef(Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isRunning]);
  const elapsed = isRunning ? Date.now() - startedRef.current : (elapsedMs ?? result.elapsedMs);
  void tick;

  useEffect(() => {
    if (!toolCallId || !isRunning) return;
    return subscribeTerminalChunk(toolCallId, (delta: string) => {
      /* 只留最后一行非空 —— 主 timeline 要的是「它现在在干嘛」, 不是滚动日志 */
      liveRef.current = (liveRef.current + delta);
      const lines = liveRef.current.split('\n').filter(l => l.trim());
      setLive(lines[lines.length - 1]?.slice(0, 160) ?? '');
      /* 只保留尾部, 别让这个 ref 跟着一个跑二十分钟的任务无限长大 */
      if (liveRef.current.length > 4000) liveRef.current = liveRef.current.slice(-2000);
    });
  }, [toolCallId, isRunning]);

  const cls = status === 'completed' ? 'is-done' : status === 'error' ? 'is-fail' : 'is-running';
  const statusLabel = status === 'completed' ? (isZh ? '完成' : 'Done')
    : status === 'error' ? (isZh ? '失败' : 'Failed')
      : isBackground ? (isZh ? '后台运行' : 'In background') : (isZh ? '运行中' : 'Running');
  const branchName = branch ?? result.branch;
  const fileCount = result.files.length || changedFiles?.length || 0;
  const output = result.output;
  const longOutput = output.split('\n').length > 3 || output.length > 220;

  return (
    <div className={`atl-acard ${cls}`}>
      <div className="atl-acard__head">
        <span className="atl-acard__logo"><PluginBrandLogo name={agentId.replace(/_/g, '-')} size={20} /></span>
        <span className="atl-acard__name">{displayName || agentId}</span>
        <span className="atl-acard__badge" title={isZh ? '跑在你本机的另一个 agent CLI 里' : 'Runs in another agent CLI on your machine'}>
          {isZh ? '本机' : 'Local'}
        </span>
        <span className="atl-acard__status">
          <i aria-hidden />
          {statusLabel}
          {elapsed ? <em>{fmtAgentElapsed(elapsed)}</em> : null}
        </span>
      </div>

      <div className="atl-acard__body">
        {task && <div className="atl-acard__task" title={task}>{task}</div>}

        {isRunning && (
          <div className="atl-acard__live">
            <DotSpinner size={12} />
            <span>{live || (isBackground
              ? (isZh ? '在后台继续跑，完成后会通知你' : 'Running in the background — you’ll be notified')
              : (isZh ? '已派出，等它开始产出…' : 'Delegated — waiting for output…'))}</span>
          </div>
        )}

        {!isRunning && (result.tools.length > 0 || branchName || result.noChanges) && (
          <div className="atl-acard__chips">
            {result.tools.map((t) => (
              <span key={t.name} className="atl-acard__chip">{t.name}<b>×{t.count}</b></span>
            ))}
            {branchName ? (
              <span className="atl-acard__chip is-branch" title={isZh ? '改动在这个分支上，不在当前工作区' : 'Changes are on this branch, not in your workspace'}>
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="5.5" r="1.6" /><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-3.5 2.2-6.2 3.9" /></svg>
                <code>{branchName}</code>
                <span>{isZh ? `${fileCount} 个文件` : `${fileCount} file${fileCount === 1 ? '' : 's'}`}</span>
              </span>
            ) : result.noChanges ? (
              <span className="atl-acard__chip is-muted">{isZh ? '没有改动文件' : 'No file changes'}</span>
            ) : null}
          </div>
        )}

        {status === 'completed' && output && (
          <>
            <div className={`atl-acard__output${open ? ' is-open' : ''}`}>{output}</div>
            {longOutput && (
              <button type="button" className="atl-acard__more" onClick={() => setOpen((v) => !v)}>
                {open ? (isZh ? '收起' : 'Show less') : (isZh ? '展开全部' : 'Show all')}
              </button>
            )}
          </>
        )}

        {status === 'error' && (
          <div className="atl-acard__error">
            <b>{result.reason || (error || summary || '').split('\n')[0]}</b>
            {result.hint && <span>{result.hint}</span>}
          </div>
        )}
      </div>
    </div>
  );
};
