
import React from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useTargetIndicator } from '../../agent-timeline/targetIndicatorStore';
import { useTeamPlan, hydrateTeamPlan } from '../../../state/teamPlanStore';
import TeamPlanBoard from './TeamPlanBoard';
import {
  useTeamRun,
  type TeamBlackboardEntry,
  type TeamLaneSnapshot,
  type TeamLaneStatus,
  type TeamRunSnapshot,
  type TeamRunStatus,
} from '../../../state/teamRunStore';
import { abortSubAgent } from '../../../state/subAgentsStore';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { useI18n } from '../../../hooks/useI18n';
import { NeoxIllus } from '../../../media/illus';

/* ---------- helpers ---------- */

/** role → 配色 modifier — 对齐 AgentDelegationViews 的 role 色系
 *  (plan=蓝 / verify|review=橙 / research|explore=灰 / implement|code=紫默认) */
function roleModifier(role: string): 'plan' | 'verify' | 'explore' | 'code' {
  const key = (role || '').toLowerCase();
  if (key.includes('plan')) return 'plan';
  if (key.includes('review') || key.includes('verify')) return 'verify';
  if (key.includes('research') || key.includes('explore')) return 'explore';
  return 'code';
}

function laneStatusLabel(status: TeamLaneStatus, isZh: boolean): string {
  switch (status) {
    case 'pending': return isZh ? '待派' : 'Not dispatched';
    case 'running': return isZh ? '运行中' : 'Running';
    case 'blocked': return isZh ? '阻塞' : 'Blocked';
    case 'done':    return isZh ? '完成' : 'Done';
    case 'failed':  return isZh ? '失败' : 'Failed';
  }
}

function teamStatusLabel(status: TeamRunStatus, isZh: boolean): string {
  switch (status) {
    case 'planning': return isZh ? '规划中' : 'Planning';
    case 'plan_ready': return isZh ? '方案就绪' : 'Plan ready';
    case 'running': return isZh ? '进行中' : 'Running';
    case 'success': return isZh ? '成功' : 'Success';
    case 'partial': return isZh ? '部分完成' : 'Partial';
    case 'aborted': return isZh ? '已中止' : 'Aborted';
  }
}

function formatClock(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------- icons (monoline 14px, 跟 timeline / surface 同风格) ---------- */

const icon = (path: React.ReactNode) => (
  <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);
const ICON_RESULT = icon(<><circle cx="7" cy="7" r="5.2" /><path d="M4.6 7.2 L6.3 8.9 L9.5 5.4" /></>);
const ICON_NOTE = icon(<><path d="M3 2.5 H9.5 L11 4 V11.5 H3 Z" /><path d="M5 6 H9" /><path d="M5 8.5 H8" /></>);
const ICON_BLOCKER = icon(<><path d="M7 1.8 L12.4 11.3 H1.6 Z" /><path d="M7 5.4 V7.9" /><circle cx="7" cy="9.8" r=".6" fill="currentColor" stroke="none" /></>);
const ICON_STOP = (
  <svg viewBox="0 0 14 14" width="11" height="11" fill="currentColor" aria-hidden="true">
    <rect x="3.6" y="3.6" width="6.8" height="6.8" rx=".8" />
  </svg>
);

const BLACKBOARD_ICON: Record<TeamBlackboardEntry['kind'], React.ReactNode> = {
  result: ICON_RESULT,
  note: ICON_NOTE,
  blocker: ICON_BLOCKER,
};

/* ---------- 泳道卡 ---------- */

const LaneCard: React.FC<{ lane: TeamLaneSnapshot; isZh: boolean }> = ({ lane, isZh }) => {
  const mod = roleModifier(lane.role);
  const running = lane.status === 'running';

  const jumpToSubSession = () => {
    /* laneId 即子会话 id — 与 reminder 通知跳会话同一通路 (NeoxRuntimeBridge 监听) */
    window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: lane.laneId } }));
  };

  const onStop = async (e: React.MouseEvent) => {
    e.stopPropagation();
    /* 与 SubAgentsBar 同款 abort 通路 (window.neox.abortSubAgent) */
    await abortSubAgent(lane.laneId);
  };

  const progressParts: string[] = [];
  if (lane.toolCount > 0) progressParts.push(isZh ? `${lane.toolCount} 工具` : `${lane.toolCount} tool${lane.toolCount === 1 ? '' : 's'}`);
  if (lane.changedFiles > 0) progressParts.push(isZh ? `${lane.changedFiles} 文件改动` : `${lane.changedFiles} file${lane.changedFiles === 1 ? '' : 's'} changed`);

  return (
    <div
      className={`sfc-team__lane is-${lane.status} sfc-team__lane--${mod}`}
      role="button"
      tabIndex={0}
      onClick={jumpToSubSession}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToSubSession(); } }}
      title={isZh ? '点击查看该成员的子会话' : "Click to open this member's sub-session"}
    >
      <div className="sfc-team__lane-head">
        <span className="sfc-team__lane-role">{lane.role}</span>
        <span className="sfc-team__lane-name">{lane.agentName}</span>
        {lane.model && <span className="sfc-team__lane-model">{lane.model}</span>}
        <span className={`sfc-team__lane-status is-${lane.status}`}>
          {running && <span className="sfc-team__lane-status-dot" aria-hidden="true" />}
          {laneStatusLabel(lane.status, isZh)}
        </span>
        {running && (
          <button
            type="button"
            className="sfc-team__lane-stop"
            onClick={onStop}
            title={isZh ? '停止该成员' : 'Stop this member'}
            aria-label={isZh ? '停止该成员' : 'Stop this member'}
          >
            {ICON_STOP}
          </button>
        )}
      </div>
      {lane.currentAction && (
        <div className={`sfc-team__lane-action${running ? ' is-live' : ''}`} title={lane.currentAction}>
          {lane.currentAction}
        </div>
      )}
      {(progressParts.length > 0 || lane.scope.length > 0) && (
        <div className="sfc-team__lane-meta">
          {lane.scope.length > 0 && (
            <span className="sfc-team__lane-scope" title={lane.scope.join('\n')}>
              {lane.scope.slice(0, 2).join(' · ')}{lane.scope.length > 2 ? ` +${lane.scope.length - 2}` : ''}
            </span>
          )}
          {progressParts.length > 0 && <span className="sfc-team__lane-progress">{progressParts.join(' · ')}</span>}
        </div>
      )}
      {lane.milestones.length > 0 && (
        <div className="sfc-team__milestones" aria-label={isZh ? '里程碑' : 'Milestones'}>
          {lane.milestones.map((m) => (
            <span
              key={m.id}
              className={`sfc-team__ms${m.reached ? ' is-reached' : ''}`}
              title={`${m.title} — ${m.reached ? (isZh ? '已达' : 'reached') : (isZh ? '未达' : 'pending')}`}
            >
              <span className="sfc-team__ms-dot" aria-hidden="true" />
              <span className="sfc-team__ms-title">{m.title}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

/* ---------- 完成态报告 ---------- */

const ReportBlock: React.FC<{ team: TeamRunSnapshot; isZh: boolean }> = ({ team, isZh }) => (
  <section className={`sfc-team__report is-${team.status}`}>
    <div className="sfc-team__report-head">
      <span className={`sfc-team__report-badge is-${team.status}`}>{teamStatusLabel(team.status, isZh)}</span>
      <span className="sfc-team__report-title">{isZh ? 'Team 报告' : 'Team report'}</span>
      {team.completedAt != null && <span className="sfc-team__report-time">{formatClock(team.completedAt)}</span>}
    </div>
    {team.report && <div className="sfc-team__report-text">{team.report}</div>}
    {team.laneSummaries && team.laneSummaries.length > 0 && (
      <table className="sfc-team__report-table">
        <thead>
          <tr>
            <th>{isZh ? '角色' : 'Role'}</th>
            <th>{isZh ? '状态' : 'Status'}</th>
            <th>{isZh ? '分支' : 'Branch'}</th>
            <th>{isZh ? '改动文件' : 'Changed files'}</th>
          </tr>
        </thead>
        <tbody>
          {team.laneSummaries.map((s) => (
            <tr key={s.laneId}>
              <td>
                <span className={`sfc-team__report-role sfc-team__lane-role sfc-team__lane-role--${roleModifier(s.role)}`}>{s.role || s.laneId}</span>
              </td>
              <td>{s.status}</td>
              <td>{s.branch ? <code>{s.branch}</code> : '—'}</td>
              <td>{typeof s.changedFiles === 'number' ? s.changedFiles : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
);

/* ---------- 黑板流 ---------- */

const BlackboardFeed: React.FC<{ entries: TeamBlackboardEntry[]; isZh: boolean }> = ({ entries, isZh }) => {
  /* 最新在上 — 面板视角"刚发生了什么"优先 */
  const ordered = [...entries].sort((a, b) => b.ts - a.ts);
  return (
    <section className="sfc-team__board">
      <div className="sfc-team__board-head">
        {isZh ? '黑板' : 'Blackboard'}
        {entries.length > 0 && <span className="sfc-team__board-count">{entries.length}</span>}
      </div>
      {ordered.length === 0 ? (
        <div className="sfc-team__board-empty">{isZh ? '还没有黑板条目 — 成员产出会以引用 + 摘要落板' : 'No entries yet — members post refs + summaries here'}</div>
      ) : (
        <ul className="sfc-team__board-list">
          {ordered.map((e) => (
            <li key={`${e.key}-${e.ts}`} className={`sfc-team__bb is-${e.kind}`}>
              <span className="sfc-team__bb-icon" aria-hidden="true">{BLACKBOARD_ICON[e.kind]}</span>
              <div className="sfc-team__bb-main">
                <div className="sfc-team__bb-summary">{e.summary}</div>
                <div className="sfc-team__bb-meta">
                  <span className="sfc-team__bb-author">{e.author}</span>
                  <span className="sfc-team__bb-time">{formatClock(e.ts)}</span>
                  {e.ref && <span className="sfc-team__bb-ref" title={e.ref}>{e.ref}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/* ---------- 规划态面板 ---------- */

const TeamPlanningView: React.FC<{ team: TeamRunSnapshot; isZh: boolean }> = ({ team, isZh }) => {
  const target = useTargetIndicator();
  const blocks = target.subMissions ?? [];
  const done = blocks.filter((b) => b.status === 'completed').length;
  return (
    <div className="sfc-team is-planning">
      <header className="sfc-team__hdr">
        <div className="sfc-team__goal" title={team.goal}>{team.goal || (isZh ? '(未命名目标)' : '(untitled goal)')}</div>
        <div className="sfc-team__hdr-meta">
          <span className="sfc-team__status is-planning">
            <span className="sfc-team__status-dot" aria-hidden="true" />
            {isZh ? '规划中' : 'Planning'}
          </span>
          <span className="sfc-team__hdr-summary">
            {blocks.length > 0
              ? (isZh ? `${blocks.length} 个战略块 · 完成 ${done}` : `${blocks.length} blocks · ${done} done`)
              : (isZh ? '同一个 Agent 在盘现状 / 写需求 / 拆块' : 'same agent: surveying, writing requirements, carving blocks')}
          </span>
          <span className="sfc-team__hdr-id" title={team.teamId}>#{team.teamId.slice(-8)}</span>
        </div>
      </header>
      <div className="sfc-team__scroll">
        {team.lanes.length > 0 && (
          /* 编队草案 —— 谁干哪些块。一个 agent 都没派 (status=pending), 所以不画运行态。 */
          <section className="sfc-team__formation">
            <div className="sfc-team__formation-head">
              {isZh ? `编队 · ${team.lanes.length} 条泳道 (未派兵)` : `Formation · ${team.lanes.length} lanes (not dispatched)`}
            </div>
            {team.lanes.map((lane) => (
              <div key={lane.laneId} className={`sfc-team__crew sfc-team__crew--${roleModifier(lane.role)}`}>
                <div className="sfc-team__crew-head">
                  <span className="sfc-team__crew-role">{lane.role}</span>
                  {(lane.blockIds?.length ?? 0) > 0 && (
                    <span className="sfc-team__crew-blocks">{lane.blockIds!.join(' · ')}</span>
                  )}
                </div>
                {lane.scope.length > 0 && (
                  <div className="sfc-team__crew-scope">{lane.scope.join('  ')}</div>
                )}
              </div>
            ))}
          </section>
        )}
        {blocks.length === 0 ? (
          <div className="sfc-team__board-empty">
            {isZh
              ? '还没有块清单 —— 规划过程 (explore / 读代码 / 写 REQUIREMENTS.md) 在左侧时间线上实时可见, 拆出块后这里会列出来。'
              : 'No blocks yet — the planning itself (explore / reads / REQUIREMENTS.md) is live in the timeline on the left; blocks show up here once carved.'}
          </div>
        ) : (
          <ol className="sfc-team__blocks">
            {blocks.map((b) => (
              <li key={b.id} className={`sfc-team__block is-${b.status ?? 'pending'}`}>
                <span className="sfc-team__block-id">{b.id}</span>
                <span className="sfc-team__block-desc">{b.description}</span>
                {b.success_criteria && <span className="sfc-team__block-ac">{b.success_criteria}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
};

/* ---------- 主组件 ---------- */

export const TeamSurfaceViewer: React.FC<{ surface: Surface }> = ({ surface }) => {
  const { isZh } = useI18n();
  const { activeSession } = useNeoxRuntime();
  const sessionId = activeSession?.id ?? '';
  const team = useTeamRun(sessionId);

  /* surface.metadata.teamId 只是壳上的标记 — 数据源始终是 teamRunStore 当前 session 的 Team.
   * (一个 session 一个活跃 Team; 旧 teamId 的 surface 壳被新一轮复用, 见 surfaceStore 单实例分支) */
  void surface;

  const plan = useTeamPlan(sessionId);
  React.useEffect(() => { void hydrateTeamPlan(sessionId); }, [sessionId]);
  /* 有团队规划就整个交给看板 (自带 概览/需求/人员/文档 四个页签)。
   * 没有规划但 surface 被手动打开时也进看板 —— 它自己有空态引导, 比"暂无 Team 运行"有用。 */
  if (plan || !team) return <TeamPlanBoard sessionId={sessionId} />;

  if (!team) {
    return (
      <div className="sfc-empty">
        {/* 只有"还没开始"才配插画 —— 同一个 .sfc-empty 也用于加载中和渲染失败,
            那两种是**过程/故障**, 配画会让人以为是稳态。 */}
        <img className="sfc-empty__art" src={NeoxIllus.team} alt="" aria-hidden draggable={false} />
        <div className="sfc-empty__title">{isZh ? '暂无 Team 运行' : 'No team run yet'}</div>
        <div className="sfc-empty__msg">
          {isZh
            ? '发起 team_run 后, 泳道 / 里程碑 / 黑板会实时出现在这里'
            : 'Once a team_run starts, lanes, milestones and the blackboard appear here live'}
        </div>
      </div>
    );
  }

  if (team.status === 'planning' || team.status === 'plan_ready') {
    return <TeamPlanningView team={team} isZh={isZh} />;
  }

  const runningCount = team.lanes.filter((l) => l.status === 'running').length;
  const doneCount = team.lanes.filter((l) => l.status === 'done').length;
  const blockedCount = team.lanes.filter((l) => l.status === 'blocked').length;
  const failedCount = team.lanes.filter((l) => l.status === 'failed').length;

  const summaryParts: string[] = [];
  summaryParts.push(isZh ? `${team.lanes.length} 泳道` : `${team.lanes.length} lane${team.lanes.length === 1 ? '' : 's'}`);
  if (runningCount > 0) summaryParts.push(isZh ? `${runningCount} 运行中` : `${runningCount} running`);
  if (blockedCount > 0) summaryParts.push(isZh ? `${blockedCount} 阻塞` : `${blockedCount} blocked`);
  if (doneCount > 0) summaryParts.push(isZh ? `${doneCount} 完成` : `${doneCount} done`);
  if (failedCount > 0) summaryParts.push(isZh ? `${failedCount} 失败` : `${failedCount} failed`);

  return (
    <div className="sfc-team">
      <header className="sfc-team__hdr">
        <div className="sfc-team__goal" title={team.goal}>{team.goal || (isZh ? '(未命名目标)' : '(untitled goal)')}</div>
        <div className="sfc-team__hdr-meta">
          <span className={`sfc-team__status is-${team.status}`}>
            {team.status === 'running' && <span className="sfc-team__status-dot" aria-hidden="true" />}
            {teamStatusLabel(team.status, isZh)}
          </span>
          <span className="sfc-team__hdr-summary">{summaryParts.join(' · ')}</span>
          <span className="sfc-team__hdr-id" title={team.teamId}>#{team.teamId.slice(-8)}</span>
        </div>
      </header>
      <div className="sfc-team__scroll">
        {team.status !== 'running' && <ReportBlock team={team} isZh={isZh} />}
        <div className="sfc-team__lanes">
          {team.lanes.map((lane) => (
            <LaneCard key={lane.laneId} lane={lane} isZh={isZh} />
          ))}
          {team.lanes.length === 0 && (
            <div className="sfc-team__board-empty">{isZh ? '泳道划分中…' : 'Planning lanes…'}</div>
          )}
        </div>
        <BlackboardFeed entries={team.blackboard} isZh={isZh} />
      </div>
    </div>
  );
};

export default TeamSurfaceViewer;
