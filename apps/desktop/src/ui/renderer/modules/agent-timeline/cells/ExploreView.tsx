import React, { useEffect, useState } from 'react';
import { ToolMoreButton } from '../components/ToolMoreButton';
import { useI18n } from '../../../hooks/useI18n';
import { formatCompactToolArgs } from '../formatCompactToolArgs';
import './subAgentsCard.css';

/* ---------- explore (TaskAgent) ----------
 *
 * 单 agent 模式: 平铺工具列表
 * 并行模式 (×N): 每个 agent 一行 head + 嵌套该 agent 的 tool 列表
 *   ×3 时实际渲染:
 *     ├ ✓ explorer-1   分析认证模块   3 工具 · 12s
 *     │   ├ readfile   path: README.md  read_all: true
 *     │   └ smart_tree  directory: .  mode: structure
 *     ├ ✓ explorer-2 ...
 *     └ ● explorer-3 ...
 */

export 
const AGENT_STATUS_CLS: Record<string, string> = {
  pending: 'is-pending',
  running: 'is-running',
  completed: 'is-done',
  failed: 'is-fail',
  error: 'is-fail',
  aborted: 'is-aborted',
};

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}

type ExploreToolRec = {
  name: string;
  agentId?: string;
  args?: string;
  status: 'running' | 'done' | 'error';
  duration?: number;
  resultHint?: string;
};

export type ExploreGroupMem = {
  agentId: string;
  task: string;
  model?: string;
  status: 'running' | 'completed' | 'error';
  toolCount: number;
  tokens: number;
  iterations?: number;
  tokensEstimated?: boolean;
  startedAt?: number;
  elapsed: number;
};

const formatExploreArgs = (raw: string): string => formatCompactToolArgs(raw);

const ExploreToolItem: React.FC<{
  rec: ExploreToolRec;
  /** 嵌套层级缩进; agent group 下的工具传 1 */
  indent?: number;
  isLast?: boolean;
}> = ({ rec, indent = 0, isLast = false }) => (
  <li
    className={`atl-explore__rec is-${rec.status}${indent > 0 ? ' is-nested' : ''}`}
    style={indent > 0 ? { paddingLeft: `${indent * 14}px` } : undefined}
  >
    <span className="atl-explore__rec-connector">{isLast ? '└' : '├'}</span>
    <span className="atl-explore__rec-name">{rec.name}</span>
    {rec.args && (
      <span className="atl-explore__rec-args" title={rec.args}>
        {formatExploreArgs(rec.args)}
      </span>
    )}
    {rec.resultHint && <span className="atl-explore__rec-hint">{rec.resultHint}</span>}
    {typeof rec.duration === 'number' && rec.duration > 0 && (
      <span className="atl-explore__rec-dur">{formatMs(rec.duration)}</span>
    )}
  </li>
);

/** 单 agent 模式 — 平铺,前 8 条,超出 +N 更多 */
const ExploreFlatList: React.FC<{ records: ExploreToolRec[] }> = ({ records }) => {
  const [expanded, setExpanded] = useState(false);
  const cap = 8;
  const visible = expanded ? records : records.slice(0, cap);
  const hidden = Math.max(0, records.length - visible.length);
  return (
    <ul className="atl-explore__records">
      {visible.map((r, i) => (
        <ExploreToolItem
          key={i}
          rec={r}
          isLast={i === visible.length - 1 && hidden <= 0}
        />
      ))}
      {records.length > cap && (
        <li className="atl-explore__rec is-more">
          <ToolMoreButton
            expanded={expanded}
            hiddenCount={records.length - cap}
            onToggle={() => setExpanded((v) => !v)}
          />
        </li>
      )}
    </ul>
  );
};

/** 跑动中的子 Agent 只露最近这几条工具, 新的一条从底下滑进来, 旧的往上顶出去。 */
const TICKER_ROWS = 3;

const SubAgentToolRow: React.FC<{ rec: ExploreToolRec; isZh: boolean }> = ({ rec, isZh }) => (
  <li className={`atl-agentgroup__tool is-${rec.status}`}>
    <span className="atl-agentgroup__tool-name">{rec.name}</span>
    {rec.args && (
      <span className="atl-agentgroup__tool-args" title={rec.args}>{formatExploreArgs(rec.args)}</span>
    )}
    <span className="atl-agentgroup__tool-dur">
      {rec.status === 'running'
        ? (isZh ? '进行中' : 'running')
        : typeof rec.duration === 'number' && rec.duration > 0 ? formatMs(rec.duration) : ''}
    </span>
  </li>
);

/**
 * 一个子 Agent 一段: 名字 + 模型 + 进度数字, 下面是它的工具。
 * 跑动中是滚动窗口 (最近 TICKER_ROWS 条, key 用绝对序号, 新挂载的那条带入场动画);
 * 跑完收成一行, 需要时再展开全部。
 */
const SubAgentBlock: React.FC<{ member: ExploreGroupMem; records: ExploreToolRec[] }> = ({ member, records }) => {
  const { isZh } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const running = member.status === 'running';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsed = running && member.startedAt
    ? Math.max(member.elapsed, now - member.startedAt) : member.elapsed;
  const count = Math.max(records.length, member.toolCount || 0);
  const meta: string[] = [];
  if (member.iterations !== undefined) meta.push(isZh ? `${member.iterations} 轮` : `${member.iterations} rounds`);
  if (count > 0) meta.push(isZh ? `${count} 个工具` : `${count} tool${count === 1 ? '' : 's'}`);
  if (member.iterations !== undefined || member.tokens > 0) meta.push(`${member.tokensEstimated ? '~' : ''}${formatNumber(member.tokens)} tok`);
  if (running || elapsed > 0) meta.push(formatMs(elapsed));

  const start = running ? Math.max(0, records.length - TICKER_ROWS) : 0;
  const shown = running ? records.slice(start) : expanded ? records : [];

  return (
    <section className={`atl-agentgroup__agent is-${member.status}`}>
      <div className="atl-agentgroup__agent-head">
        <span className={`atl-agentgroup__dot is-${member.status}`} aria-hidden />
        <span className="atl-agentgroup__agent-name">{member.agentId}</span>
        {member.model && <span className="atl-agentgroup__model" title={member.model}>{member.model}</span>}
        {meta.length > 0 && <span className="atl-agentgroup__agent-meta">{meta.join(' · ')}</span>}
      </div>
      {member.task && <div className="atl-agentgroup__task" title={member.task}>{member.task}</div>}
      {running && records.length === 0 && (
        <div className="atl-agentgroup__waiting">{(member.iterations ?? 0) > 0
          ? (isZh ? '思考中…' : 'Thinking…')
          : (isZh ? '正在启动…' : 'Starting…')}</div>
      )}
      {shown.length > 0 && (
        <ul className={`atl-agentgroup__tools${running ? ' is-ticker' : ''}`}>
          {shown.map((r, i) => <SubAgentToolRow key={start + i} rec={r} isZh={isZh} />)}
        </ul>
      )}
      {!running && records.length > 0 && (
        <button type="button" className="atl-agentgroup__toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded
            ? (isZh ? '收起工具' : 'Hide tools')
            : (isZh ? `查看 ${records.length} 个工具` : `Show ${records.length} tools`)}
        </button>
      )}
    </section>
  );
};

const SubAgentsCard: React.FC<{
  role?: string;
  status?: string;
  statusLabel?: string;
  elapsed?: number;
  error?: string;
  members: ExploreGroupMem[];
  recordsByAgent: Map<string, ExploreToolRec[]>;
}> = ({ role, status, statusLabel, elapsed, error, members, recordsByAgent }) => {
  const { isZh } = useI18n();
  const done = members.filter((m) => m.status !== 'running').length;
  const summary: string[] = [];
  const totalTools = members.reduce((sum, m) => sum + Math.max(m.toolCount, recordsByAgent.get(m.agentId)?.length ?? 0), 0);
  const totalTokens = members.reduce((sum, m) => sum + m.tokens, 0);
  summary.push(members.length > 1
    ? (isZh ? `${members.length} 个子 Agent` : `${members.length} sub-agents`)
    : (isZh ? '子 Agent' : 'Sub-agent'));
  if (status === 'running' && members.length > 1) summary.push(isZh ? `${done}/${members.length} 完成` : `${done}/${members.length} done`);
  else if (statusLabel) summary.push(statusLabel);
  if (totalTools > 0) summary.push(isZh ? `${totalTools} 个工具` : `${totalTools} tools`);
  if (members.some(m => m.iterations !== undefined) || totalTokens > 0) {
    summary.push(`${members.some(m => m.tokensEstimated) ? '~' : ''}${formatNumber(totalTokens)} tok`);
  }
  if (typeof elapsed === 'number' && elapsed > 0) summary.push(formatMs(elapsed));

  return (
    <div className={`atl-agentgroup is-${status ?? 'running'}`}>
      <div className="atl-agentgroup__head">
        <span className="atl-agentgroup__role">{role || 'Explore'}</span>
        <span className="atl-agentgroup__summary">{summary.join(' · ')}</span>
      </div>
      {status === 'error' && error && <div className="atl-agentgroup__error">{error}</div>}
      {members.map((m) => (
        <SubAgentBlock key={m.agentId} member={m} records={recordsByAgent.get(m.agentId) ?? []} />
      ))}
    </div>
  );
};

export const ExploreView: React.FC<{
  role?: string;
  task?: string;
  status?: string;
  summary?: string;
  error?: string;
  toolCount?: number;
  tokens?: number;
  elapsed?: number;
  currentStatus?: string;
  toolRecords?: ExploreToolRec[];
  groupMembers?: ExploreGroupMem[];
}> = ({ role, task, status, summary, error, toolCount, tokens, elapsed, currentStatus, toolRecords, groupMembers }) => {
  const { isZh } = useI18n();
  const cls = AGENT_STATUS_CLS[status ?? 'running'] ?? 'is-running';
  const statusLabel = status === 'running' ? (isZh ? '运行中' : 'Running')
    : status === 'completed' ? (isZh ? '完成' : 'Done')
    : status === 'failed' ? (isZh ? '失败' : 'Failed')
    : status === 'aborted' ? (isZh ? '已终止' : 'Aborted')
    : status === 'pending' ? (isZh ? '等待' : 'Pending')
    : status;

  if (groupMembers && groupMembers.length > 0) {
    /* 按 agentId 分桶, 同一个子 Agent 的工具串在一起; 没标 agentId 的记录归第一个成员 */
    const recordsByAgent = new Map<string, ExploreToolRec[]>();
    for (const r of toolRecords ?? []) {
      const aid = r.agentId || groupMembers[0].agentId;
      const arr = recordsByAgent.get(aid) ?? [];
      arr.push(r);
      recordsByAgent.set(aid, arr);
    }
    return (
      <SubAgentsCard
        role={role}
        status={status}
        statusLabel={statusLabel}
        elapsed={elapsed}
        error={error || (status === 'error' ? summary : undefined)}
        members={groupMembers}
        recordsByAgent={recordsByAgent}
      />
    );
  }

  /* 没有成员信息的是旧会话里存下的单 Agent 记录, 保留原来的平铺画法 */
  const totalTools = toolCount ?? toolRecords?.length ?? 0;
  const totalTokens = tokens ?? 0;
  return (
    <div className={`atl-explore ${cls}`}>
      <div className="atl-explore__head">
        <span className="atl-explore__role">{role || 'Explore'}</span>
        {statusLabel && <span className="atl-explore__chip">{statusLabel}</span>}
        {totalTools > 0 && <span className="atl-explore__chip">{isZh ? `${totalTools} 工具` : `${totalTools} tool${totalTools === 1 ? '' : 's'}`}</span>}
        {totalTokens > 0 && (
          <span className="atl-explore__chip">{formatNumber(totalTokens)} tok</span>
        )}
        {typeof elapsed === 'number' && elapsed > 0 && (
          <span className="atl-explore__chip">{formatMs(elapsed)}</span>
        )}
      </div>
      {task && <div className="atl-explore__task">{task}</div>}
      {status === 'error' && (error || summary) && (
        <div className="atl-explore__error">{error || summary}</div>
      )}
      {status === 'completed' && summary && (
        <div className="atl-explore__summary">{summary}</div>
      )}
      {currentStatus && status === 'running' && (
        <div className="atl-explore__live">{currentStatus}</div>
      )}

      {toolRecords && toolRecords.length > 0 && (
        <ExploreFlatList records={toolRecords} />
      )}
    </div>
  );
};
