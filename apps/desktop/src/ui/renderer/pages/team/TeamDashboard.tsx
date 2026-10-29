
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { useActiveTeamRuns, openTeamSurface } from '../../state/teamRunStore';
import { useApprovalMode } from '../../modules/agent-timeline/approvalModeStore';
import { ToolPageHeader } from '../../components/ToolPage';
import teamArt from '../../media/clay/tool-team.webp';
import stepPlan from '../../media/clay/sfc-plan.webp';
import stepTodo from '../../media/clay/sfc-todo.webp';
import stepTeam from '../../media/clay/sfc-team.webp';
import stepBoard from '../../media/clay/sfc-services.webp';
import './team-page.css';
import { CustomSelect } from '../../components/CustomSelect';
import { isTeamEnabled, teamUnavailableReason } from './teamAvailability';
import { isChatModelInfo } from '../../utils/modelKind';

const buildKickoffPrompt = (goal: string, isZh: boolean): string => (isZh
  ? `${goal}\n\n<neox-directive>先调 team_run({ goal }) 进入团队规划态: 递归拆需求树 → 定编制 → 每人领取, 三步走完停下来把方案讲给用户, 等他拍板再调 team_execute({confirm:true}) 开工。规划过程留在这个会话里, 别派子 agent。</neox-directive>`
  : `${goal}\n\n<neox-directive>Call team_run({ goal }) to enter team planning: decompose into a requirement tree, staff it, have each member claim their leaves. Stop after those three and walk the user through the plan; only call team_execute({confirm:true}) once they say go. Keep planning in this conversation — no sub-agents.</neox-directive>`);

const STEPS: Array<[string, string, string, string, string]> = [
  [stepPlan, '拆成需求树', 'Break it down', '把大目标一层层拆到能直接动手的小任务', 'Split the goal until each piece is actionable'],
  [stepTodo, '定编制、排批次', 'Staff & order', '谁做哪块、先后顺序、哪些能同时做', 'Who does what, in which order, what runs together'],
  [stepTeam, '并行开工', 'Run in parallel', '几个 Agent 各占一块地盘，互不踩脚', 'Each agent owns its area — no stepping on toes'],
  [stepBoard, '看板验收', 'Review on the board', '每块做完你过一眼，不行打回重做', 'Check each piece; send it back if it is not right'],
];

export const TeamDashboard: React.FC<{
  /** 启动后切回 chat 视图 (由 NeoxShellHost 传入) */
  onLaunched?: () => void;
  /** 左上「返回任务」 */
  onClose?: () => void;
  /** 打开一条团队会话 —— 走宿主的选会话 (跨模式会先切模式、侧栏选中那一行), 不在这里直接 selectSession */
  onOpenSession?: (sessionId: string) => void;
}> = ({ onLaunched, onClose, onOpenSession }) => {
  const { isZh } = useI18n();
  const runtime = useNeoxRuntime();
  const activeTeams = useActiveTeamRuns();
  const [goal, setGoal] = useState('');
  const [launching, setLaunching] = useState(false);
  const [orchestration, setOrchestration] = useState<'on' | 'off' | null>(null);
  const [orchFailed, setOrchFailed] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /* 能力位: 关着时整页只读 —— 输入框/启动按钮都不给, 免得发出一条模型执行不了的开团指令 */
  const teamOpen = isTeamEnabled();
  const { selectedModel, availableModels, setSelectedModel, workspacePath } = runtime;
  const approvalMode = useApprovalMode(null); // 新会话继承全局默认审批模式
  const workspaceName = useMemo(() => {
    const p = (workspacePath || '').replace(/[\\/]+$/, '');
    const base = p.split(/[\\/]/).pop();
    return base || p || (isZh ? '未选择项目' : 'No workspace');
  }, [workspacePath, isZh]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await (window as any).neox?.getAgentRuntimeConfig?.();
        if (cancelled) return;
        if (cfg) setOrchestration(cfg.modelOrchestration === 'on' ? 'on' : 'off');
        else setOrchFailed(true);
      } catch { if (!cancelled) setOrchFailed(true); /* 读不到才不显示开关行 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const launch = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed || launching || !isTeamEnabled()) return;
    setLaunching(true);
    try {
      const session = await runtime.createNewSession({
        name: (isZh ? 'Team · ' : 'Team · ') + trimmed.slice(0, 24),
      });
      if (!session) return;
      const prompt = buildKickoffPrompt(trimmed, isZh);
      /* 切回 chat 视图后, composer 已挂在新会话上; composer-fill send:true 直接发送 */
      onLaunched?.();
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: prompt, send: true } }));
      }, 350);
      setGoal('');
    } finally {
      setLaunching(false);
    }
  }, [goal, launching, runtime, isZh, onLaunched]);

  const toggleOrchestration = useCallback(async () => {
    if (orchestration === null) return;
    const next = orchestration === 'on' ? 'off' : 'on';
    setOrchestration(next);
    try {
      await (window as any).neox?.setAgentRuntimeConfig?.({ modelOrchestration: next });
    } catch (err) {
      console.error('[TeamDashboard] save orchestration failed', err);
      setOrchestration(orchestration);
    }
  }, [orchestration]);

  const openTeam = useCallback((sessionId: string, teamId: string, teamGoal?: string) => {
    if (onOpenSession) onOpenSession(sessionId);
    else { runtime.selectSession(sessionId); onLaunched?.(); }
    window.setTimeout(() => { openTeamSurface(sessionId, { teamId, goal: teamGoal, reveal: true }); }, 200);
  }, [runtime, onLaunched]);

  const modelOptions = useMemo(
    () => availableModels.filter(isChatModelInfo).map((m) => ({ value: m.id, label: m.name })),
    [availableModels],
  );

  const laneStatusColor: Record<string, string> = {
    running: 'var(--neox-primary-600, #666c75)',
    blocked: 'var(--neox-warn, #d97706)',
    done: 'var(--neox-ok, #3ba55d)',
    failed: 'var(--neox-err, #dc2626)',
  };

  /* 最近的团队: 开团时会话名是「Team · 目标」, 按这个找; 在跑的标进行中 */
  const recentTeams = useMemo(
    () => runtime.sessions
      .filter((s) => /^Team · /.test(s.name ?? ''))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 6),
    [runtime.sessions],
  );

  return (
    <div className="team-dash tp-page">
      <div className="team-dash__inner">
        <ToolPageHeader
          icon={teamArt}
          title={isZh ? '团队' : 'Team'}
          desc={isZh
            ? '一个大目标交给几个 Agent 分头做：先拆、再排、你拍板，然后并行开工'
            : 'Hand one big goal to several agents: break it down, plan it, you approve, they run in parallel'}
          onBack={onClose}
          zh={isZh}
        />

        {!teamOpen && (
          <div className="team-dash__gate" role="status">
            <strong>{isZh ? '暂不支持' : 'Not available yet'}</strong>
            <span>{teamUnavailableReason(isZh)}</span>
          </div>
        )}

        <section className="team-dash__launcher">
          <textarea
            ref={inputRef}
            className="team-dash__input"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void launch(); }
            }}
            placeholder={isZh
              ? '描述大目标，例如：把这个仓库按模块做成可交付的方案…'
              : 'Describe a big goal, e.g. add full i18n…'}
            rows={3}
            disabled={launching || !teamOpen}
          />
          {approvalMode === 'manual' && (
            <div className="team-dash__approval-warn">
              {isZh
                ? '当前为「每步都问」，规划过程中的每次工具调用都要你点一次。建议先切到「危险操作才问」。'
                : 'You are on “Every step”, so you approve every tool call during planning. Switch to “Risky actions” first.'}
            </div>
          )}
          <div className="team-dash__toolbar">
            <span className="team-dash__ws-chip" title={workspacePath || undefined}>
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.8H13A1.5 1.5 0 0 1 14.5 6.3v5.2A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7Z" />
              </svg>
              {workspaceName}
            </span>
            <div className="team-dash__model-pick">
              <span className="team-dash__model-label">{isZh ? '指挥官' : 'Conductor'}</span>
              <CustomSelect
                className="team-dash__model-select"
                value={selectedModel?.id ?? ''}
                onChange={(id) => {
                  const m = availableModels.find((x) => x.id === id);
                  if (m) setSelectedModel(m);
                }}
                options={modelOptions}
                placeholder={isZh ? '选择模型' : 'Pick model'}
              />
            </div>
            {/* 编排开关挪进工具条 (设计稿); 读不到配置才不显示, 加载期间占位 (见 orchFailed 注释) */}
            {!orchFailed && (
              <footer className="team-dash__footer">
                <span className="team-dash__footer-title">{isZh ? '按任务自动选模型' : 'Auto-pick models'}</span>
                <button
                  type="button"
                  role="switch"
                  className={`team-dash__switch${orchestration === 'on' ? ' is-on' : ''}${orchestration === null ? ' is-pending' : ''}`}
                  onClick={() => void toggleOrchestration()}
                  disabled={orchestration === null}
                  aria-busy={orchestration === null || undefined}
                  aria-checked={orchestration === 'on'}
                  aria-label={isZh ? '智能模型编排' : 'Smart model orchestration'}
                  title={orchestration === null
                    ? (isZh ? '读取中…' : 'Loading…')
                    : orchestration === 'on'
                      ? (isZh ? '已开启 · 点击关闭' : 'On · click to turn off')
                      : (isZh ? '已关闭 · 点击开启' : 'Off · click to turn on')}
                >
                  <span className="team-dash__switch-knob" aria-hidden="true" />
                </button>
              </footer>
            )}
            <span className="team-dash__toolbar-spacer" aria-hidden="true" />
            <span className="team-dash__hint">
              {isZh ? '⌘Enter' : '⌘Enter'}
            </span>
            <button
              type="button"
              className="team-dash__launch-btn"
              onClick={() => void launch()}
              disabled={!teamOpen || !goal.trim() || launching || !selectedModel}
              title={teamOpen ? undefined : teamUnavailableReason(isZh)}
            >
              {!teamOpen
                ? (isZh ? '暂不支持' : 'Not available yet')
                : launching ? (isZh ? '启动中…' : 'Launching…') : (isZh ? '启动团队' : 'Launch team')}
            </button>
          </div>
        </section>

        {activeTeams.length > 0 && (
          <section className="team-dash__section">
            <div className="team-dash__section-head">{isZh ? '进行中' : 'Active'}</div>
            {activeTeams.map((t) => (
              <button
                key={t.teamId}
                type="button"
                className="team-dash__active-card"
                onClick={() => openTeam(t.sessionId, t.teamId, t.goal)}
              >
                <div className="team-dash__active-goal">{t.goal}</div>
                <div className="team-dash__active-lanes">
                  {t.lanes.map((lane) => (
                    <span key={lane.laneId} className="team-dash__lane-chip">
                      <span
                        className="team-dash__lane-dot"
                        style={{ background: laneStatusColor[lane.status] ?? 'var(--neox-fg-hint)' }}
                        aria-hidden="true"
                      />
                      {lane.role}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </section>
        )}

        {/* 它怎么干: 四步 (跟执行层现在的做法对齐 —— 领地互斥 / 按批次, 不是 07 版的泳道 + worktree) */}
        <section className="tp-steps" role="list" aria-label={isZh ? '团队怎么干活' : 'How a team works'}>
          {STEPS.map(([art, zhT, enT, zhD, enD], i) => (
            <div key={zhT} className="tp-step" role="listitem">
              <div className="tp-step__head"><img src={art} alt="" draggable={false} /><span>{isZh ? `第 ${i + 1} 步` : `Step ${i + 1}`}</span></div>
              <div className="tp-step__title">{isZh ? zhT : enT}</div>
              <div className="tp-step__desc">{isZh ? zhD : enD}</div>
            </div>
          ))}
        </section>

        {recentTeams.length > 0 && (
          <section className="team-dash__section">
            <div className="tp-list-head"><b>{isZh ? '最近的团队' : 'Recent teams'}</b><span>{recentTeams.length}</span></div>
            {recentTeams.map((s) => {
              const running = runtime.runningSessionIds.has(s.id);
              const d = new Date(s.updatedAt ?? s.createdAt ?? Date.now());
              return (
                <button key={s.id} type="button" className="tp-team-row" onClick={() => { if (onOpenSession) onOpenSession(s.id); else { runtime.selectSession(s.id); onLaunched?.(); } }}>
                  <img src={teamArt} alt="" draggable={false} />
                  <span className="tp-team-row__text">
                    <span className="tp-team-row__title">{(s.name ?? '').replace(/^Team · /, '')}</span>
                    <span className="tp-team-row__sub">
                      {running && <span className="tp-dot is-running" aria-hidden="true" />}
                      {running ? (isZh ? '进行中' : 'Running') : (isZh ? '已结束' : 'Finished')}
                    </span>
                  </span>
                  <span className="tp-team-row__time">{`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`}</span>
                </button>
              );
            })}
          </section>
        )}
      </div>
    </div>
  );
};

export default TeamDashboard;
