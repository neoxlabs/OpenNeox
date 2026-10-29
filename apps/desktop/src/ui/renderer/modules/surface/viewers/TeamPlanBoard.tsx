import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import Markdown from '../../../components/Markdown';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { promptAsync } from '../../../components/confirmEvents';
import {
  useTeamPlan, useTeamExec, hydrateTeamPlan, teamStageMeta, assignRequirement, execCommand,
  type TeamPlanSnapshot, type TeamRequirement, type TeamMeeting,
  type TeamExecSnapshot, type ExecTask, type TaskState, type ExecMessage,
} from '../../../state/teamPlanStore';
import { NeoxIllus } from '../../../media/illus';

type BoardTab = 'overview' | 'exec' | 'requirements' | 'people' | 'meetings' | 'levels' | 'doc';

const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

function useEscClose(active: boolean, onClose: () => void): void {
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}


const STATUS_META: Record<string, { zh: string; en: string; cls: string }> = {
  todo:    { zh: '待开始', en: 'To do',    cls: 'todo' },
  doing:   { zh: '进行中', en: 'Doing',    cls: 'doing' },
  blocked: { zh: '阻塞',   en: 'Blocked',  cls: 'blocked' },
  done:    { zh: '已完成', en: 'Done',     cls: 'done' },
  failed:  { zh: '失败',   en: 'Failed',   cls: 'failed' },
};

function reqStatus(exec: TeamExecSnapshot | null, req: { id: string; status?: string }): string {
  const t = exec?.tasks.find((x) => x.id === req.id);
  if (t) {
    return t.state === 'running' ? 'doing'
      : t.state === 'done' ? 'done'
        : t.state === 'failed' ? 'failed'
          : t.state === 'blocked' ? 'blocked' : 'todo';
  }
  return req.status ?? 'todo';
}

/** 一条需求的人天 (老数据只有 estimateHours) —— 概览/定级/树聚合共用一份口径 */
const daysOf = (r: TeamRequirement): number => r.estimateDays ?? (r.estimateHours ? r.estimateHours / 8 : 0);

const fmtDays = (r: TeamRequirement): string => {
  const d = r.estimateDays ?? (r.estimateHours ? Math.round((r.estimateHours / 8) * 10) / 10 : undefined);
  return d ? `${d}` : '—';
};

/** 会议类型的人话标签 + 配色键 —— 跟 core 的 MEETING_LABEL 同一套口径 */
const MEETING_META: Record<string, { zh: string; en: string }> = {
  requirements: { zh: '需求评审', en: 'Requirements' },
  design: { zh: '开发研讨', en: 'Design' },
  test: { zh: '测试研讨', en: 'Test' },
  estimate: { zh: '工期复核', en: 'Estimates' },
  review: { zh: '复盘', en: 'Retro' },
  standup: { zh: '站会', en: 'Standup' },
};

const fmtClock = (ts?: number): string => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};


const AVATAR_HUES = [212, 262, 152, 32, 342, 188, 92, 12];
const rosterHue = new Map<string, number>();
const registerRosterHues = (roster: Array<{ id: string }>): void => {
  roster.forEach((m, i) => rosterHue.set(m.id, AVATAR_HUES[i % AVATAR_HUES.length]));
};
/** 成员的稳定色相 —— 头像和概览里"谁负责这条"的色条用同一个, 一眼对上人 */
const avatarHue = (id: string): number => {
  const byRoster = rosterHue.get(id);
  if (byRoster !== undefined) return byRoster;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
};
const Avatar: React.FC<{ id: string; name: string; size?: number }> = ({ id, name, size = 26 }) => {
  const hue = avatarHue(id);
  const ch = (name || id).replace(/[\s（(].*$/, '').slice(0, 1) || '?';
  return (
    <span
      className="tpb-av"
      style={{ width: size, height: size, fontSize: size * 0.44, ['--tpb-av-h' as any]: String(hue) }}
      aria-hidden="true"
    >{ch}</span>
  );
};

const MeetingCard: React.FC<{
  m: TeamMeeting; roster: TeamPlanSnapshot['roster']; isZh: boolean; onOpen: () => void;
}> = ({ m, roster, isZh, onOpen }) => {
  const nameOf = (id: string) => (id === 'facilitator'
    ? (isZh ? '主持' : 'Host')
    : (roster.find((x) => x.id === id)?.title || id));
  const decN = m.decisions?.length ?? 0;
  const openN = m.openQuestions?.length ?? 0;
  const who = m.participants?.length ? m.participants : [...new Set(m.notes.map((n) => n.memberId))];
  /* 折叠态那一行: 优先给第一条决议 (会议的产出), 没决议才退回第一条发言 */
  const gist = decN > 0 ? m.decisions![0] : (m.notes[0]?.say ?? '').replace(/\n/g, ' ');
  return (
    <button type="button" className={`tpb-mtg is-${m.kind}`} onClick={onOpen}>
      <div className="tpb-mtg__h">
        <span className={`tpb-mtg__badge is-${m.kind}`}>
          {isZh ? MEETING_META[m.kind]?.zh ?? m.kind : MEETING_META[m.kind]?.en ?? m.kind}
        </span>
        <span className="tpb-mtg__title" title={m.title}>{m.title}</span>
        <span className="tpb-mtg__at">{fmtClock(m.at)}</span>
      </div>
      <div className="tpb-mtg__row2">
        <span className="tpb-mtg__avs">
          {who.slice(0, 6).map((pid) => <Avatar key={pid} id={pid} name={nameOf(pid)} size={20} />)}
          {who.length > 6 && <span className="tpb-mtg__more">+{who.length - 6}</span>}
        </span>
        <span className="tpb-mtg__n">
          {isZh ? `${who.length} 人 · ${m.notes.length} 发言` : `${who.length} · ${m.notes.length}`}
          {decN > 0 && <i>{isZh ? `${decN} 决议` : `${decN} dec`}</i>}
          {openN > 0 && <u>{isZh ? `${openN} 待定` : `${openN} open`}</u>}
        </span>
      </div>
      {gist && <div className="tpb-mtg__gist-t">{decN > 0 && <b>{isZh ? '结论 ' : 'Decision '}</b>}{gist}</div>}
    </button>
  );
};

const MeetingModal: React.FC<{
  m: TeamMeeting; roster: TeamPlanSnapshot['roster']; isZh: boolean; onClose: () => void;
}> = ({ m, roster, isZh, onClose }) => {
  const memberOf = (id: string) => roster.find((x) => x.id === id);
  const nameOf = (id: string) => (id === 'facilitator' ? (isZh ? '主持' : 'Host') : (memberOf(id)?.title || id));
  /* 按人归并 —— 一个人在会上说了三次, 展示成他名下三段, 而不是散在时间线里 */
  const byPerson = React.useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, string[]>();
    for (const n of m.notes) {
      if (!map.has(n.memberId)) { map.set(n.memberId, []); order.push(n.memberId); }
      map.get(n.memberId)!.push(n.say);
    }
    return order.map((id) => ({ id, says: map.get(id)! }));
  }, [m.notes]);

  useEscClose(true, onClose);

  return (
    /* 复用需求详情弹窗那套壳: .tpb-modal 是遮罩, .tpb-modal__card 是卡片 (别自造第二套) */
    <div className="tpb-modal" onClick={onClose} role="presentation">
      <div className="tpb-modal__card tpb-mtgm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="tpb-mtgm__h">
          <span className={`tpb-mtg__badge is-${m.kind}`}>
            {isZh ? MEETING_META[m.kind]?.zh ?? m.kind : MEETING_META[m.kind]?.en ?? m.kind}
          </span>
          <h3 className="tpb-mtgm__title">{m.title}</h3>
          <span className="tpb-mtgm__at">{fmtClock(m.at)}</span>
          <button type="button" className="tpb-modal__close" onClick={onClose} aria-label="close">✕</button>
        </header>

        {/* 参会人 —— 一共几个人, 每个人是谁 */}
        <div className="tpb-mtgm__crew">
          <span className="tpb-mtgm__crew-n">
            {isZh ? `${byPerson.length} 人参会` : `${byPerson.length} attendees`}
          </span>
          {byPerson.map(({ id }) => (
            <span key={id} className="tpb-mtgm__crew-one" title={memberOf(id)?.why}>
              <Avatar id={id} name={nameOf(id)} size={22} />
              <span className="tpb-mtgm__crew-name">{nameOf(id)}</span>
            </span>
          ))}
        </div>

        <div className="tpb-mtgm__body">
          {/* 结论先行 —— 会议的产出比过程更重要 */}
          {(m.decisions?.length ?? 0) > 0 && (
            <section className="tpb-mtgm__dec">
              <div className="tpb-mtgm__sec-h">{isZh ? '会议结论' : 'Decisions'}</div>
              <ol className="tpb-mtgm__dec-list">
                {m.decisions!.map((d, i) => <li key={i}>{d}</li>)}
              </ol>
            </section>
          )}
          {(m.openQuestions?.length ?? 0) > 0 && (
            <section className="tpb-mtgm__open">
              <div className="tpb-mtgm__sec-h">{isZh ? '还没定 · 需要跟进' : 'Open questions'}</div>
              <ul>{m.openQuestions!.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </section>
          )}

          {/* 每个人说了哪些话 —— 一人一块 */}
          <section>
            <div className="tpb-mtgm__sec-h">{isZh ? '每个人说了什么' : 'Who said what'}</div>
            <div className="tpb-mtgm__says">
              {byPerson.map(({ id, says }) => {
                const mem = memberOf(id);
                return (
                  <article key={id} className="tpb-mtgm__person">
                    <div className="tpb-mtgm__person-h">
                      <Avatar id={id} name={nameOf(id)} size={30} />
                      <span className="tpb-mtgm__person-name">{nameOf(id)}</span>
                      {mem?.level && <span className="tpb-mtgm__person-lv">{mem.level}</span>}
                      {mem?.role && <span className="tpb-mtgm__person-role">{mem.role}</span>}
                    </div>
                    {says.map((sy, i) => <p key={i} className="tpb-mtgm__say">{sy}</p>)}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};


type MemberLive = 'idle' | 'waiting' | 'running' | 'done' | 'failed';
const LIVE_META: Record<MemberLive, { zh: string; en: string }> = {
  idle: { zh: '待激活', en: 'Idle' },
  waiting: { zh: '等待', en: 'Waiting' },
  running: { zh: '执行中', en: 'Running' },
  done: { zh: '已完成', en: 'Done' },
  failed: { zh: '有失败', en: 'Failed' },
};
function memberLive(exec: TeamExecSnapshot | null, memberId: string): { state: MemberLive; done: number; total: number; cur?: string } {
  const mine = exec?.tasks.filter((t) => t.memberId === memberId) ?? [];
  if (!exec || mine.length === 0) return { state: 'idle', done: 0, total: mine.length };
  const done = mine.filter((t) => t.state === 'done').length;
  const running = mine.find((t) => t.state === 'running');
  const failed = mine.some((t) => t.state === 'failed');
  const state: MemberLive = running ? 'running'
    : failed ? 'failed'
      : done === mine.length ? 'done' : 'waiting';
  return { state, done, total: mine.length, cur: running?.title };
}

export function deriveProgress(tasks: ExecTask[]): { done: number; failed: number; running: number; total: number; pct: number } {
  let done = 0, failed = 0, running = 0;
  for (const t of tasks) {
    if (t.state === 'done') done++;
    else if (t.state === 'failed') failed++;
    else if (t.state === 'running') running++;
  }
  const total = tasks.length;
  return { done, failed, running, total, pct: total ? Math.round((done / total) * 100) : 0 };
}


/** 交流流 —— 一条一行 + 搜索 + 按类型筛 + 分页; 点开才看全文 */
const MSG_PAGE = 12;
const MsgFeed: React.FC<{
  messages: ExecMessage[];
  nameOf: (id: string) => string;
  isZh: boolean;
}> = ({ messages, nameOf, isZh }) => {
  const [q, setQ] = React.useState('');
  const [kind, setKind] = React.useState<string | null>(null);
  const [who, setWho] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<ExecMessage | null>(null);
  useEscClose(open != null, () => setOpen(null));

  const people = React.useMemo(
    () => [...new Set(messages.flatMap((m) => [m.from, m.to]))].filter((x) => x !== 'all'),
    [messages],
  );
  const kw = q.trim().toLowerCase();
  const filtered = React.useMemo(() => [...messages].reverse().filter((m) => {
    if (kind && m.kind !== kind) return false;
    if (who && m.from !== who && m.to !== who) return false;
    if (!kw) return true;
    return [m.text, m.taskId, nameOf(m.from), nameOf(m.to)].filter(Boolean)
      .some((t) => String(t).toLowerCase().includes(kw));
  }), [messages, kind, who, kw, nameOf]);
  const { slice, nav } = usePager(filtered, MSG_PAGE);

  return (
    <section className="tpb-card">
      <div className="tpb-card__h">
        {isZh ? '成员之间的交流' : 'Cross-agent messages'}
        <span className="tpb-card__meta">
          {filtered.length === messages.length ? messages.length : `${filtered.length}/${messages.length}`}
        </span>
        {nav}
      </div>

      {messages.length > 0 && (
        <div className="tpb-msgs__bar">
          <span className="tpb-msgs__search">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={isZh ? '搜内容 / 任务号 / 人名…' : 'Search…'} />
            {q && <button type="button" onClick={() => setQ('')} aria-label="clear">✕</button>}
          </span>
          <span className="tpb-msgs__chips">
            {(['contract_ready', 'question', 'answer', 'blocker'] as const)
              .filter((k) => messages.some((m) => m.kind === k))
              .map((k) => (
                <button key={k} type="button"
                  className={`tpb-msgs__chip is-${MSG_META[k]?.cls}${kind === k ? ' is-on' : ''}`}
                  onClick={() => setKind(kind === k ? null : k)}>
                  {isZh ? MSG_META[k]?.zh : MSG_META[k]?.en}
                  <b>{messages.filter((m) => m.kind === k).length}</b>
                </button>
              ))}
            {people.length > 1 && (
              <select className="tpb-msgs__who" value={who ?? ''} onChange={(e) => setWho(e.target.value || null)}>
                <option value="">{isZh ? '全部成员' : 'Everyone'}</option>
                {people.map((pid) => <option key={pid} value={pid}>{nameOf(pid)}</option>)}
              </select>
            )}
          </span>
        </div>
      )}

      {filtered.length === 0
        ? (
          <div className="tpb__empty">
            {messages.length === 0
              ? (isZh ? '还没有交流 —— 契约交付/提问/受阻都会记在这里' : 'No messages yet')
              : (isZh ? '没有符合条件的消息' : 'No matching messages')}
          </div>
        )
        : (
          <div className="tpb-msgs">
            {slice.map((m) => (
              <button key={m.id} type="button" className={`tpb-msg is-${MSG_META[m.kind]?.cls ?? 'note'}`}
                onClick={() => setOpen(m)}>
                <span className="tpb-msg__h">
                  <Avatar id={m.from} name={nameOf(m.from)} size={16} />
                  <span className="tpb-msg__from">{nameOf(m.from)}</span>
                  <span className="tpb-msg__arrow">→</span>
                  <Avatar id={m.to} name={nameOf(m.to)} size={16} />
                  <span className="tpb-msg__to">{nameOf(m.to)}</span>
                  <span className={`tpb-msg__kind is-${MSG_META[m.kind]?.cls ?? 'note'}`}>
                    {isZh ? MSG_META[m.kind]?.zh ?? m.kind : MSG_META[m.kind]?.en ?? m.kind}
                  </span>
                  {m.taskId && <span className="tpb-msg__task">{m.taskId}</span>}
                  <span className="tpb-msg__at">{fmtClock(m.at)}</span>
                </span>
                {/* 摘要一行 —— 第一句 (通常是"X 已交付, 你的 Y 可以开工了") */}
                <span className="tpb-msg__gist">{m.text.split('\n')[0]}</span>
              </button>
            ))}
          </div>
        )}

      {open && (
        <div className="tpb-modal" onClick={() => setOpen(null)} role="presentation">
          <div className="tpb-modal__card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <header className="tpb-modal__hdr">
              <Avatar id={open.from} name={nameOf(open.from)} size={22} />
              <span className="tpb-msg__from">{nameOf(open.from)}</span>
              <span className="tpb-msg__arrow">→</span>
              <Avatar id={open.to} name={nameOf(open.to)} size={22} />
              <span className="tpb-msg__to">{nameOf(open.to)}</span>
              <span className={`tpb-msg__kind is-${MSG_META[open.kind]?.cls ?? 'note'}`}>
                {isZh ? MSG_META[open.kind]?.zh ?? open.kind : MSG_META[open.kind]?.en ?? open.kind}
              </span>
              <button type="button" className="tpb-modal__close" onClick={() => setOpen(null)} aria-label="close">✕</button>
            </header>
            <div className="tpb-modal__props">
              {open.taskId && (
                <div className="tpb-modal__field">
                  <span className="tpb-modal__prop-k">{isZh ? '关联任务' : 'Task'}</span>
                  <span className="tpb-modal__prop-v">{open.taskId}</span>
                </div>
              )}
              <div className="tpb-modal__field">
                <span className="tpb-modal__prop-k">{isZh ? '时间' : 'At'}</span>
                <span className="tpb-modal__prop-v">{fmtClock(open.at)}</span>
              </div>
            </div>
            <div className="tpb-modal__sec">
              <div className="tpb-modal__sec-h">{isZh ? '全文' : 'Full text'}</div>
              <p className="tpb-modal__sec-t tpb-msg__full">{open.text}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};


const AgentWall: React.FC<{
  tasks: ExecTask[];
  nameOf: (id: string) => string;
  isZh: boolean;
  onOpenAgent: (agentId: string) => void;
}> = ({ tasks, nameOf, isZh, onOpenAgent }) => {
  /** 只看有子会话的活: 在跑的排前面, 然后是刚结束的 (最近完成的更值得回看) */
  const cols = React.useMemo(() => tasks
    .filter((t) => t.agentId && t.state !== 'pending' && t.state !== 'blocked')
    .sort((a, b) => {
      const rank = (s: string) => (s === 'running' ? 0 : s === 'failed' ? 1 : 2);
      return rank(a.state) - rank(b.state) || (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0);
    }), [tasks]);
  /* 默认在跑的; 没有在跑的 (执行完了) 就显示全部 —— 收工后用户回看的正是全部 */
  const [only, setOnly] = React.useState<'running' | 'all'>('running');
  const hasRunning = cols.some((t) => t.state === 'running');
  const shown = only === 'running' && hasRunning ? cols.filter((t) => t.state === 'running') : cols;

  if (cols.length === 0) return null;
  return (
    <section className="tpb-card">
      <div className="tpb-card__h">
        {isZh ? '并行现场' : 'Live agents'}
        <span className="tpb-card__meta">
          {isZh ? `${cols.filter((t) => t.state === 'running').length} 在跑 / ${cols.length} 个` : `${cols.filter((t) => t.state === 'running').length} running`}
        </span>
        <span className="tpb-wall__toggle">
          {(['running', 'all'] as const).map((k) => (
            <button key={k} type="button" className={only === k ? 'is-on' : ''} onClick={() => setOnly(k)}>
              {isZh ? (k === 'running' ? '在跑的' : '全部') : k}
            </button>
          ))}
        </span>
      </div>
      <div className="tpb-wall">
        {shown.map((t) => (
          <div key={t.id} className={`tpb-wall__col is-${TASK_STATE_META[t.state]?.cls}`}>
            <div className="tpb-wall__h">
              <Avatar id={t.memberId} name={nameOf(t.memberId)} size={18} />
              <span className="tpb-wall__who">{nameOf(t.memberId)}</span>
              <span
                className={`tpb-tk__state is-${TASK_STATE_META[t.state]?.cls}`}
                title={isZh ? TASK_STATE_META[t.state]?.zh : TASK_STATE_META[t.state]?.en}
              >
                <i className="tpb-tk__state-dot" aria-hidden="true" />
                <span className="tpb-tk__state-txt">
                  {isZh ? TASK_STATE_META[t.state]?.zh : TASK_STATE_META[t.state]?.en}
                </span>
              </span>
              <button
                type="button"
                className="tpb-atl__jump"
                onClick={() => onOpenAgent(t.agentId!)}
                title={isZh ? '在主视图打开完整过程' : 'Open full trace'}
              >
                <span className="tpb-atl__jump-txt">{isZh ? '完整过程' : 'full'}</span>
                <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 8L8 4M8 4H5M8 4v3" />
                </svg>
              </button>
            </div>
            <div className="tpb-wall__task" title={t.title}>{t.id} · {t.title}</div>
            <AgentTimeline agentId={t.agentId!} isZh={isZh} live={t.state === 'running'} compact />
          </div>
        ))}
      </div>
    </section>
  );
};

const TASK_STATE_META: Record<TaskState, { zh: string; en: string; cls: string }> = {
  pending: { zh: '待派', en: 'Queued', cls: 'pending' },
  blocked: { zh: '等前置', en: 'Blocked', cls: 'blocked' },
  running: { zh: '进行中', en: 'Running', cls: 'running' },
  done: { zh: '完成', en: 'Done', cls: 'done' },
  failed: { zh: '失败', en: 'Failed', cls: 'failed' },
  skipped: { zh: '跳过', en: 'Skipped', cls: 'skipped' },
};

const MSG_META: Record<string, { zh: string; en: string; cls: string }> = {
  contract_ready: { zh: '契约交付', en: 'Contract', cls: 'contract' },
  question: { zh: '提问', en: 'Question', cls: 'question' },
  answer: { zh: '回复', en: 'Answer', cls: 'answer' },
  blocker: { zh: '受阻', en: 'Blocker', cls: 'blocker' },
  note: { zh: '备注', en: 'Note', cls: 'note' },
};

const ExecBoard: React.FC<{
  exec: TeamExecSnapshot;
  plan: TeamPlanSnapshot;
  sessionId: string;
  isZh: boolean;
  onOpenAgent: (agentId: string) => void;
}> = ({ exec, plan, sessionId, isZh, onOpenAgent }) => {
  const [openTask, setOpenTask] = React.useState<ExecTask | null>(null);
  useEscClose(openTask != null, () => setOpenTask(null));
  /** 批次排期 (甘特) —— 收在顶部一颗 icon 后面, 点开是悬浮层 (不再占一整行) */
  const [ganttOpen, setGanttOpen] = React.useState(false);
  useEscClose(ganttOpen, () => setGanttOpen(false));
  const p = exec.progress ?? deriveProgress(exec.tasks);
  const nameOf = (id: string) => (id === 'conductor' ? (isZh ? '主脑' : 'Conductor')
    : id === 'system' ? (isZh ? '系统' : 'System')
      : id === 'all' ? (isZh ? '全员' : 'All')
        : (plan.roster.find((m) => m.id === id)?.title || id));
  /* 一行一个成员 —— 成员顺序跟人员页一致 (按认领量降序), 免得两边对不上 */
  const members = React.useMemo(() => {
    const ids = [...new Set(exec.tasks.map((t) => t.memberId))];
    return ids.sort((a, b) =>
      exec.tasks.filter((t) => t.memberId === b).length - exec.tasks.filter((t) => t.memberId === a).length);
  }, [exec.tasks]);
  const waves = Array.from({ length: exec.totalWaves }, (_, i) => i + 1);

  return (
    <div className="tpb-exec">
      <div className="tpb-exec__hd">
        <span className={`tpb-exec__badge is-${exec.status}`}>
          {isZh
            ? ({ running: '执行中', paused: '已暂停', done: '已完成', failed: '有失败', aborted: '已中止', idle: '待开工' } as any)[exec.status]
            : exec.status}
        </span>
        <span className="tpb-exec__wave">
          {isZh ? `第 ${exec.currentWave}/${exec.totalWaves} 批` : `wave ${exec.currentWave}/${exec.totalWaves}`}
        </span>
        <button
          type="button"
          className={`tpb-exec__gantt${ganttOpen ? ' is-on' : ''}`}
          onClick={() => setGanttOpen((v) => !v)}
          title={isZh ? `批次排期 · ${exec.totalWaves} 批 (点开看甘特)` : `Waves · ${exec.totalWaves}`}
          aria-label={isZh ? '批次排期' : 'Waves'}
        >
          {/* 甘特 icon: 三条错位的横杠 —— 一眼是"排期"而不是"列表" */}
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2.5 4h6M5.5 8h8M2.5 12h5" />
          </svg>
          <b>{exec.totalWaves}</b>
        </button>
        <span className="tpb-exec__prog">
          <span className="tpb-exec__prog-bar">
            <i style={{ width: `${p.total ? (p.done / p.total) * 100 : 0}%` }} />
            {p.failed > 0 && <u style={{ width: `${(p.failed / Math.max(1, p.total)) * 100}%` }} />}
          </span>
          <b>{p.done}/{p.total}</b>
          {p.failed > 0 && <em>{isZh ? `${p.failed} 失败` : `${p.failed} failed`}</em>}
        </span>
      </div>

      {ganttOpen && (
        <>
          <div className="tpb-gantt__mask" onClick={() => setGanttOpen(false)} role="presentation" />
          <div className="tpb-gantt__pop" role="dialog" aria-label={isZh ? '批次排期' : 'Waves'}>
            <div className="tpb-gantt__h">
              {isZh ? `批次排期 · ${exec.totalWaves} 批` : `Waves · ${exec.totalWaves}`}
              <span className="tpb-lanes__sum-m">
                {isZh ? `${members.length} 人 · ${exec.tasks.length} 条活` : `${members.length} · ${exec.tasks.length}`}
              </span>
              <button type="button" className="tpb-modal__close" onClick={() => setGanttOpen(false)} aria-label="close">✕</button>
            </div>
      <div className="tpb-lanes">
        <div className="tpb-lanes__head">
          <span className="tpb-lanes__who" />
          {waves.map((w) => (
            <span key={w} className={`tpb-lanes__wv${w === exec.currentWave ? ' is-cur' : ''}`}>
              {isZh ? `第${w}批` : `W${w}`}
            </span>
          ))}
        </div>
        {members.map((mid) => (
          <div key={mid} className="tpb-lanes__row">
            <span className="tpb-lanes__who" title={plan.roster.find((m) => m.id === mid)?.why}>
              <Avatar id={mid} name={nameOf(mid)} size={20} />
              <span className="tpb-lanes__name">{nameOf(mid)}</span>
            </span>
            {waves.map((w) => (
              <span key={w} className="tpb-lanes__cell">
                {exec.tasks.filter((t) => t.memberId === mid && t.wave === w).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`tpb-tk is-${TASK_STATE_META[t.state]?.cls ?? 'pending'}`}
                    onClick={() => setOpenTask(t)}
                    title={`${t.id} · ${t.title} · ${isZh ? TASK_STATE_META[t.state]?.zh : TASK_STATE_META[t.state]?.en}`}
                  >
                    <span className="tpb-tk__id">{t.id}</span>
                    {t.state === 'running' && <i className="tpb-tk__spin" aria-hidden="true" />}
                  </button>
                ))}
              </span>
            ))}
          </div>
        ))}
      </div>
          </div>
        </>
      )}

      {/* 并行现场 —— 多个 agent 的 timeline 同屏刷 (执行台的主体) */}
      <AgentWall tasks={exec.tasks} nameOf={nameOf} isZh={isZh} onOpenAgent={onOpenAgent} />

      <MsgFeed messages={exec.messages} nameOf={nameOf} isZh={isZh} />

      {/* 任务详情 —— 跳进那个 agent 自己的 timeline 的入口 */}
      {openTask && (
        <div className="tpb-modal" onClick={() => setOpenTask(null)} role="presentation">
          <div className="tpb-modal__card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <header className="tpb-modal__hdr">
              <span className="tpb-modal__id">{openTask.id}</span>
              <span className={`tpb-tk__state is-${TASK_STATE_META[openTask.state]?.cls}`}>
                {isZh ? TASK_STATE_META[openTask.state]?.zh : TASK_STATE_META[openTask.state]?.en}
              </span>
              <span className="tpb-lanes__wv">{isZh ? `第 ${openTask.wave} 批` : `W${openTask.wave}`}</span>
              <button type="button" className="tpb-modal__close" onClick={() => setOpenTask(null)} aria-label="close">✕</button>
            </header>
            <h3 className="tpb-modal__title">{openTask.title}</h3>
            <div className="tpb-modal__props">
              <div className="tpb-modal__field">
                <span className="tpb-modal__prop-k">{isZh ? '负责人' : 'Owner'}</span>
                <span className="tpb-modal__prop-v">{nameOf(openTask.memberId)}</span>
              </div>
              {openTask.startedAt && (
                <div className="tpb-modal__field">
                  <span className="tpb-modal__prop-k">{isZh ? '耗时' : 'Elapsed'}</span>
                  <span className="tpb-modal__prop-v">
                    {Math.max(1, Math.round(((openTask.finishedAt ?? Date.now()) - openTask.startedAt) / 1000))}s
                  </span>
                </div>
              )}
            </div>
            {openTask.note && (
              <div className="tpb-modal__sec">
                <div className="tpb-modal__sec-h">{isZh ? '状态说明' : 'Note'}</div>
                <p className="tpb-modal__sec-t">{openTask.note}</p>
              </div>
            )}
            {openTask.result && (
              <div className="tpb-modal__sec">
                <div className="tpb-modal__sec-h">{isZh ? '交付摘要' : 'Result'}</div>
                <p className="tpb-modal__sec-t">{openTask.result}</p>
              </div>
            )}
            {openTask.state !== 'running' && (
              <div className="tpb-fix">
                <button type="button" className="tpb-fix__b is-retry"
                  onClick={async () => { await execCommand(sessionId, 'retry', openTask.id); setOpenTask(null); }}>
                  {isZh ? (openTask.state === 'failed' ? '重派这条' : '重跑这条') : 'Retry'}
                </button>
                <button type="button" className="tpb-fix__b"
                  onClick={async () => {
                    const why = await promptAsync({
                      title: isZh ? '跳过这条活' : 'Skip this task',
                      message: isZh
                        ? '写一句为什么跳过 —— 它会记在执行台上, 下游看得到。'
                        : 'Say why — it is recorded on the board and visible downstream.',
                      placeholder: isZh ? '例: 这条并到 M2 一起做了' : 'e.g. folded into M2',
                    }) ?? '';
                    if (!why.trim()) return;
                    await execCommand(sessionId, 'skip', openTask.id, why.trim());
                    setOpenTask(null);
                  }}>
                  {isZh ? '跳过' : 'Skip'}
                </button>
                <select className="tpb-fix__sel" value=""
                  onChange={async (e) => {
                    if (!e.target.value) return;
                    await execCommand(sessionId, 'reassign', openTask.id, e.target.value);
                    setOpenTask(null);
                  }}>
                  <option value="">{isZh ? '改派给…' : 'Reassign to…'}</option>
                  {plan.roster.filter((m) => m.id !== openTask.memberId).map((m) => (
                    <option key={m.id} value={m.id}>{m.title || m.id}</option>
                  ))}
                </select>
              </div>
            )}

            {openTask.agentId && (
              <div className="tpb-modal__sec">
                <div className="tpb-modal__sec-h">
                  {isZh ? `${nameOf(openTask.memberId)} 干了什么` : 'What this agent did'}
                  <button type="button" className="tpb-atl__jump"
                    onClick={() => { onOpenAgent(openTask.agentId!); setOpenTask(null); }}>
                    {isZh ? '在主视图打开完整过程 →' : 'Open full trace →'}
                  </button>
                </div>
                <AgentTimeline agentId={openTask.agentId} isZh={isZh} live={openTask.state === 'running'} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};


const ATL_ICON: Record<string, React.ReactNode> = {
  think: (
    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M7 2.2a3.4 3.4 0 0 0-3.1 4.8c.3.7.4 1.2.4 1.8h5.4c0-.6.1-1.1.4-1.8A3.4 3.4 0 0 0 7 2.2Z" />
      <path d="M5.6 10.7h2.8M6.2 12.2h1.6" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.4 3.8a1.4 1.4 0 0 1 1.4-1.4h6.4a1.4 1.4 0 0 1 1.4 1.4v4a1.4 1.4 0 0 1-1.4 1.4H6L3.6 11.4V9.2a1.4 1.4 0 0 1-1.2-1.4v-4Z" />
    </svg>
  ),
  tool: (
    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.9 2.5a2.5 2.5 0 0 0 2.7 4l-5.2 5.2a1.35 1.35 0 0 1-1.9-1.9l5.2-5.2a2.5 2.5 0 0 1-.8-2.1Z" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.8 7h7.4M7.4 4.2 10.2 7l-2.8 2.8" />
    </svg>
  ),
};
const ATL_LABEL: Record<string, [string, string]> = {
  think: ['思考', 'thinking'], text: ['发言', 'says'], tool: ['工具', 'tool'], user: ['指令', 'prompt'],
};

const AgentTimeline: React.FC<{ agentId: string; isZh: boolean; live?: boolean; compact?: boolean }> = ({ agentId, isZh, live, compact }) => {
  const [rows, setRows] = React.useState<any[] | null>(null);
  const load = React.useCallback(async () => {
    try {
      const res = await (window as any).neox?.timelinePage?.(agentId, { limit: 200 });
      const list = res?.entries || res?.rows || res || [];
      setRows(Array.isArray(list) ? list : []);
    } catch { setRows([]); }
  }, [agentId]);
  React.useEffect(() => { void load(); }, [load]);
  /* 还在跑的 agent —— 轮询刷新 (子会话落盘是 3 秒一次, 2 秒轮询够跟得上) */
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [live, load]);

  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const stickRef = React.useRef(true);
  React.useEffect(() => {
    const el = boxRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows]);

  if (rows == null) return <div className="tpb__empty neox-text-shimmer">{isZh ? '读取中…' : 'Loading…'}</div>;
  if (rows.length === 0) {
    return (
      <div className="tpb__empty">
        {isZh ? '这个 agent 还没有落盘的记录 —— 刚起步或刚在思考' : 'No entries yet'}
      </div>
    );
  }
  return (
    <div
      className={`tpb-atl${compact ? ' is-compact' : ''}`}
      ref={boxRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {(compact ? rows.slice(-60) : rows).map((e: any, i: number) => {
        const type = String(e.type ?? '');
        const title = String(e.title ?? '').trim();
        const detail = String(e.detail ?? '').trim();
        const isTool = type === 'tool_call' || type === 'tool_result';
        const kind = isTool ? 'tool'
          : type === 'thinking' ? 'think'
            : type === 'user_message' ? 'user' : 'text';
        const toolName = isTool ? String(e.toolName || title || 'tool') : '';
        const body = (isTool ? detail : (detail || title)).slice(0, 600);
        return (
          <div key={e.id ?? i} className={`tpb-atl__row is-${kind}`}>
            <span className="tpb-atl__ico" aria-hidden="true" title={ATL_LABEL[kind]?.[isZh ? 0 : 1]}>
              {ATL_ICON[kind]}
            </span>
            <span className="tpb-atl__t">
              {toolName && <b className="tpb-atl__tool">{toolName}</b>}
              {body || (toolName ? '' : '—')}
            </span>
          </div>
        );
      })}
    </div>
  );
};

const PAGE_ROWS = 8;

/** 分页壳 —— 行数超过一页时给 ‹ 3/13 › 翻页条; 没超就什么都不加。 */
function usePager<T>(items: T[], rows = PAGE_ROWS) {
  const [page, setPage] = React.useState(0);
  const pages = Math.max(1, Math.ceil(items.length / rows));
  const p = Math.min(page, pages - 1);
  return {
    slice: items.slice(p * rows, p * rows + rows),
    pages, page: p, setPage,
    nav: pages > 1 ? (
      <div className="tpb-pager">
        <button className="tpb-pager__b" disabled={p === 0} onClick={() => setPage(p - 1)} aria-label="prev">‹</button>
        <span className="tpb-pager__n">{p + 1}/{pages}</span>
        <button className="tpb-pager__b" disabled={p >= pages - 1} onClick={() => setPage(p + 1)} aria-label="next">›</button>
      </div>
    ) : null,
  };
}

const TeamOverview: React.FC<{
  plan: TeamPlanSnapshot;
  exec: TeamExecSnapshot | null;
  isZh: boolean;
  waves: string[][];
  meetings: TeamMeeting[];
  onOpenReq: (id: string) => void;
  onOpenMember: (id: string) => void;
  onOpenMeeting: (id: string) => void;
  onGoTab: (t: BoardTab) => void;
}> = ({ plan, exec, isZh, waves, meetings, onOpenReq, onOpenMember, onOpenMeeting, onGoTab }) => {
  const reqById = new Map(plan.requirements.map((r) => [r.id, r]));
  const hasKid = new Set(plan.requirements.map((r) => r.parentId).filter(Boolean) as string[]);
  const isLeaf = (r: TeamRequirement) => (r.kind ? r.kind === 'leaf' : !hasKid.has(r.id));
  const leaves = plan.requirements.filter(isLeaf);
  const leafIds = new Set(leaves.map((r) => r.id));
  const ownerByReq = new Map<string, string>();
  for (const c of plan.claims) for (const rid of c.requirementIds) ownerByReq.set(rid, c.memberId);
  /* 意向: 发言里说"想接"的 —— 同一条多人想接时记第一个 (认领时模型会裁决) */
  const intentByReq = new Map<string, string>();
  for (const rv of plan.reviews ?? []) for (const id of rv.picks ?? []) if (!intentByReq.has(id)) intentByReq.set(id, rv.memberId);
  const memberById = new Map(plan.roster.map((m) => [m.id, m]));
  const nameOf = (id: string) => memberById.get(id)?.title || id;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  const assigned = leaves.filter((r) => ownerByReq.has(r.id)).length;
  const done = leaves.filter((r) => reqStatus(exec, r) === 'done').length;
  const totalDays = r1(leaves.reduce((n, r) => n + daysOf(r), 0));
  const maxDepth = plan.requirements.reduce((m, r) => Math.max(m, r.depth ?? 0), 0);
  const openBranches = plan.requirements.filter((r) => r.kind === 'branch' && !hasKid.has(r.id));
  const seniors = plan.roster.filter((m) => /资深|专家|senior|staff|principal|lead/i.test(m.level ?? '')).length;

  /* 关键路径: 依赖展开到叶子, 按批次顺序 (已是拓扑序) 推最早完成日 */
  const expand = (id: string): string[] => (leafIds.has(id)
    ? [id]
    : plan.requirements.filter((c) => c.parentId === id).flatMap((c) => expand(c.id)));
  const finish = new Map<string, number>();
  for (const w of waves) for (const id of w) {
    const r = reqById.get(id);
    if (!r) continue;
    const deps = (r.dependsOn ?? []).flatMap(expand).filter((d) => d !== id);
    finish.set(id, daysOf(r) + Math.max(0, ...deps.map((d) => finish.get(d) ?? 0)));
  }
  const critical = r1(Math.max(0, ...finish.values()));
  const widest = Math.max(0, ...waves.map((w) => w.length));

  const STAGES = ['requirements', 'roster', 'assignment', 'ready'] as const;
  const cur = STAGES.indexOf(plan.stage as typeof STAGES[number]);
  const stageLabel = isZh ? ['需求分析', '定编制', '成员认领', '方案就绪'] : ['Requirements', 'Roster', 'Claiming', 'Ready'];
  const stageSub = [
    isZh ? `${plan.requirements.length} 节点` : `${plan.requirements.length} nodes`,
    isZh ? `${plan.roster.length} 人` : `${plan.roster.length} people`,
    `${assigned}/${leaves.length}`,
    exec ? (isZh ? `${done}/${leaves.length} 完成` : `${done}/${leaves.length} done`) : '',
  ];
  /* 下一步 —— 控制台第一句话: 现在在等什么 */
  const next = openBranches.length > 0
    ? (isZh ? `还有 ${openBranches.length} 个分支没拆完` : `${openBranches.length} branches still to break down`)
    : plan.stage === 'requirements' ? (isZh ? '需求拆完了, 下一步定编制' : 'Breakdown done — staffing next')
      : plan.stage === 'roster' ? (isZh ? `编制已定, 等 ${plan.roster.length - (plan.reviews?.length ?? 0)} 人发言` : `Roster set — ${plan.roster.length - (plan.reviews?.length ?? 0)} still to speak`)
        : plan.stage === 'assignment' ? (isZh ? `等成员认领 · 还有 ${leaves.length - assigned} 条没人接` : `Waiting on claims · ${leaves.length - assigned} unclaimed`)
          : exec ? (isZh ? `执行中 · 第 ${exec.currentWave}/${exec.totalWaves} 批` : `Running · wave ${exec.currentWave}/${exec.totalWaves}`)
            : (isZh ? '方案就绪, 等你拍板开工' : 'Plan ready — waiting for your go');

  const kpis: Array<{ k: string; n: string | number; sub: string; tone?: 'warn' | 'ok' }> = [
    { k: isZh ? '需求' : 'Scope', n: leaves.length, sub: isZh ? `${plan.requirements.length} 节点 · ${maxDepth + 1} 层` : `${plan.requirements.length} nodes · ${maxDepth + 1} lv` },
    { k: isZh ? '成员' : 'People', n: plan.roster.length, sub: plan.roster.length ? (isZh ? `资深 ${seniors}` : `${seniors} senior`) : (isZh ? '未定编制' : 'not staffed') },
    { k: isZh ? '工作量' : 'Effort', n: totalDays, sub: isZh ? '人天' : 'person-days' },
    { k: isZh ? '关键路径' : 'Critical path', n: critical, sub: isZh ? `天 · 最多 ${widest} 条并行` : `days · ≤${widest} in parallel` },
    openBranches.length > 0
      ? { k: isZh ? '待拆' : 'To break down', n: openBranches.length, sub: isZh ? '个分支' : 'branches', tone: 'warn' }
      : { k: isZh ? '待认领' : 'Unclaimed', n: leaves.length - assigned, sub: isZh ? `已认领 ${assigned}` : `${assigned} claimed`, tone: leaves.length - assigned > 0 ? 'warn' : 'ok' },
  ];

  /* 成员行: 认领 (实) + 意向 (虚) 的人天 */
  const people = plan.roster.map((m) => {
    const claimed = leaves.filter((r) => ownerByReq.get(r.id) === m.id);
    const intent = leaves.filter((r) => !ownerByReq.has(r.id) && intentByReq.get(r.id) === m.id);
    return {
      m,
      claimed: claimed.length, claimedDays: r1(claimed.reduce((n, r) => n + daysOf(r), 0)),
      intent: intent.length, intentDays: r1(intent.reduce((n, r) => n + daysOf(r), 0)),
      doneN: claimed.filter((r) => reqStatus(exec, r) === 'done').length,
      concern: plan.reviews?.find((rv) => rv.memberId === m.id)?.concerns,
    };
  });
  const peopleMax = Math.max(0.5, ...people.map((p) => p.claimedDays + p.intentDays));

  /* 需求结构: 顶层域 (树) —— 平铺老数据按模块分组 */
  const tops = plan.requirements.filter((r) => !r.parentId && hasKid.has(r.id) || (!r.parentId && r.kind === 'branch'));
  const domains = (tops.length > 0
    ? tops.map((t) => ({ id: t.id, title: t.title, open: !hasKid.has(t.id), items: expand(t.id).map((id) => reqById.get(id)!).filter(Boolean) }))
    : [...new Set(leaves.map((r) => r.module || (isZh ? '未分组' : 'Ungrouped')))].map((mod) => ({
      id: mod, title: mod, open: false, items: leaves.filter((r) => (r.module || (isZh ? '未分组' : 'Ungrouped')) === mod),
    })));

  const cellState = (r: TeamRequirement): 'done' | 'doing' | 'failed' | 'claimed' | 'free' => {
    const s = reqStatus(exec, r);
    if (s === 'done' || s === 'doing' || s === 'failed') return s;
    return ownerByReq.has(r.id) ? 'claimed' : 'free';
  };
  const whoOf = (id: string): { mid?: string; firm: boolean } => (ownerByReq.has(id)
    ? { mid: ownerByReq.get(id), firm: true }
    : { mid: intentByReq.get(id), firm: false });

  const decisions = meetings
    .filter((m) => (m.decisions?.length ?? 0) > 0)
    .flatMap((m) => (m.decisions ?? []).map((d) => ({ d, m })));
  const openQs = meetings.flatMap((m) => (m.openQuestions ?? []).map((q) => ({ q, m })));
  const risks = people.filter((p) => p.concern);

  return (
    <div className="tpb-ov">
      <div className="tpb-ov__kpis">
        {kpis.map((k) => (
          <div key={k.k} className={`tpb-ov__kpi${k.tone ? ` is-${k.tone}` : ''}`}>
            <span className="tpb-ov__kpi-k">{k.k}</span>
            <span className="tpb-ov__kpi-n">{k.n}</span>
            <span className="tpb-ov__kpi-sub">{k.sub}</span>
          </div>
        ))}
      </div>

      <div className="tpb-ov__stage">
        <ol className="tpb-ov__steps">
          {STAGES.map((st, i) => (
            <li key={st} className={`tpb-ov__step is-${i < cur ? 'done' : i === cur ? 'current' : 'todo'}`}>
              <span className="tpb-ov__step-dot" aria-hidden="true">
                {i < cur
                  ? <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m3.8 8.4 2.7 2.7 5.7-6" /></svg>
                  : i + 1}
              </span>
              <span className="tpb-ov__step-l">{stageLabel[i]}</span>
              {stageSub[i] && <span className="tpb-ov__step-sub">{stageSub[i]}</span>}
            </li>
          ))}
        </ol>
        {/* 方案就绪 = 等你一句「开工」: 直接给颗按钮, 点了等于在输入框发「开工」(Surface 稿 · 团队看板) */}
        {plan.stage === 'ready'
          ? (
            <button
              type="button"
              className="tpb-ov__go"
              onClick={() => window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: isZh ? '开工' : 'Go', send: true } }))}
              title={next}
            >
              {isZh ? '拍板开工' : 'Approve & start'}
            </button>
          )
          : <span className="tpb-ov__next">{next}</span>}
      </div>

      <div className="tpb-ov__grid">
        <section className="tpb-ov__panel">
          <header className="tpb-ov__ph">
            <span>{isZh ? '团队' : 'Team'}</span>
            <span className="tpb-ov__pm">
              {people.some((p) => p.intent > 0) && <><i className="tpb-ov__key is-intent" />{isZh ? '想接' : 'wants'}</>}
              <i className="tpb-ov__key is-firm" />{isZh ? '已认领' : 'claimed'}
            </span>
          </header>
          {people.length === 0 ? (
            <div className="tpb-ov__empty">{isZh ? '还没定编制 —— 需求拆完后由模型按规模定人' : 'Not staffed yet — the model sizes the team after breakdown'}</div>
          ) : people.map((p) => (
            <button key={p.m.id} type="button" className="tpb-ov__person" onClick={() => onOpenMember(p.m.id)}>
              <Avatar id={p.m.id} name={p.m.title || p.m.id} size={28} />
              <span className="tpb-ov__person-main">
                <span className="tpb-ov__person-top">
                  <span className="tpb-ov__person-name">{p.m.title || p.m.id}</span>
                  {p.m.level && <span className="tpb-ov__chip">{p.m.level}</span>}
                  <span className="tpb-ov__person-num">
                    {p.claimed > 0
                      ? (isZh ? `${p.claimed} 条 · ${p.claimedDays}d` : `${p.claimed} · ${p.claimedDays}d`)
                      : p.intent > 0 ? (isZh ? `想接 ${p.intent} 条 · ${p.intentDays}d` : `wants ${p.intent} · ${p.intentDays}d`) : '—'}
                  </span>
                </span>
                <span className="tpb-ov__bar" style={{ ['--tpb-h' as any]: String(avatarHue(p.m.id)) }}>
                  <i className="is-firm" style={{ width: `${(p.claimedDays / peopleMax) * 100}%` }} />
                  <i className="is-intent" style={{ width: `${(p.intentDays / peopleMax) * 100}%` }} />
                </span>
                {p.concern && <span className="tpb-ov__person-risk">{p.concern}</span>}
              </span>
            </button>
          ))}
        </section>

        <section className="tpb-ov__panel">
          <header className="tpb-ov__ph">
            <span>{isZh ? '需求结构' : 'Breakdown'}</span>
            <button type="button" className="tpb-ov__plink" onClick={() => onGoTab('requirements')}>
              {isZh ? `全部 ${plan.requirements.length} 条 →` : `All ${plan.requirements.length} →`}
            </button>
          </header>
          {domains.map((d) => {
            const days = r1(d.items.reduce((n, r) => n + daysOf(r), 0));
            const p0 = d.items.filter((r) => r.priority === 'P0').length;
            const owners = [...new Set(d.items.map((r) => whoOf(r.id).mid).filter(Boolean) as string[])];
            return (
              <div key={d.id} className="tpb-ov__dom">
                <div className="tpb-ov__dom-top">
                  <span className="tpb-ov__dom-name" title={d.title}>{d.title}</span>
                  {d.open && <span className="tpb-ov__chip is-warn">{isZh ? '待展开' : 'open'}</span>}
                  <span className="tpb-ov__dom-avs">
                    {owners.slice(0, 3).map((mid) => <Avatar key={mid} id={mid} name={nameOf(mid)} size={16} />)}
                  </span>
                  <span className="tpb-ov__dom-num">
                    {d.items.length}{isZh ? ' 条' : ''} · {days}d{p0 > 0 && <b> · P0×{p0}</b>}
                  </span>
                </div>
                <span className="tpb-ov__cells">
                  {d.items.map((r) => (
                    <i key={r.id} className={`is-${cellState(r)}`} title={`${r.id} · ${r.title}`} onClick={() => onOpenReq(r.id)} />
                  ))}
                </span>
              </div>
            );
          })}
        </section>
      </div>

      {waves.length > 0 && (
        <section className="tpb-ov__panel tpb-ov__panel--wide">
          <header className="tpb-ov__ph">
            <span>{isZh ? '施工排期' : 'Schedule'}</span>
            <span className="tpb-ov__pm">
              {isZh ? `${waves.length} 批 · 批内并行, 跨批串行 · 关键路径 ${critical} 天` : `${waves.length} waves · parallel within, serial across · ${critical}d critical path`}
            </span>
          </header>
          <div className="tpb-ov__sched">
            {waves.map((w, i) => {
              const span = r1(Math.max(0, ...w.map((id) => daysOf(reqById.get(id)!))));
              return (
                <div key={i} className="tpb-ov__wave">
                  <div className="tpb-ov__wave-h">
                    <b>{isZh ? `第 ${i + 1} 批` : `W${i + 1}`}</b>
                    <span>{w.length}{isZh ? ' 条' : ''} · {span}d</span>
                  </div>
                  {w.map((id) => {
                    const r = reqById.get(id);
                    if (!r) return null;
                    const who = whoOf(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`tpb-ov__task${who.mid ? ' has-owner' : ''}${who.firm ? ' is-firm' : ''} is-${cellState(r)}`}
                        style={who.mid ? { ['--tpb-h' as any]: String(avatarHue(who.mid)) } : undefined}
                        title={`${r.id} · ${r.title}${who.mid ? ` · ${nameOf(who.mid)}${who.firm ? '' : (isZh ? ' (想接)' : ' (wants)')}` : ''}`}
                        onClick={() => onOpenReq(id)}
                      >
                        <span className="tpb-ov__task-t">{r.title}</span>
                        <span className="tpb-ov__task-d">{daysOf(r) || ''}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(decisions.length > 0 || risks.length > 0 || openQs.length > 0) && (
        <div className="tpb-ov__grid">
          {decisions.length > 0 && (
            <section className="tpb-ov__panel">
              <header className="tpb-ov__ph">
                <span>{isZh ? '已定的事' : 'Decided'}</span>
                <button type="button" className="tpb-ov__plink" onClick={() => onGoTab('meetings')}>
                  {isZh ? `${meetings.length} 场会 · ${decisions.length} 条决议 →` : `${meetings.length} meetings · ${decisions.length} →`}
                </button>
              </header>
              <ul className="tpb-ov__list">
                {decisions.slice(0, 6).map(({ d, m }, i) => (
                  <li key={i} onClick={() => onOpenMeeting(m.id)} title={m.title}>
                    <span className="tpb-ov__tag">{isZh ? MEETING_META[m.kind]?.zh : MEETING_META[m.kind]?.en}</span>
                    <span className="tpb-ov__li-t">{d}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(risks.length > 0 || openQs.length > 0) && (
            <section className="tpb-ov__panel">
              <header className="tpb-ov__ph">
                <span>{isZh ? '风险与待定' : 'Risks & open questions'}</span>
                <span className="tpb-ov__pm">{risks.length + openQs.length}</span>
              </header>
              <ul className="tpb-ov__list">
                {openQs.map(({ q, m }, i) => (
                  <li key={`q${i}`} className="is-open" onClick={() => onOpenMeeting(m.id)}>
                    <span className="tpb-ov__tag is-warn">{isZh ? '待定' : 'Open'}</span>
                    <span className="tpb-ov__li-t">{q}</span>
                  </li>
                ))}
                {risks.map((p) => (
                  <li key={p.m.id} onClick={() => onOpenMember(p.m.id)}>
                    <Avatar id={p.m.id} name={p.m.title || p.m.id} size={16} />
                    <span className="tpb-ov__li-t">{p.concern}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {plan.documentPath && (
        <button type="button" className="tpb__doclink" onClick={() => onGoTab('doc')}>
          <span className="tpb__doclink-icon" aria-hidden="true">
            <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
              <path d="M3 1.5 H8.5 L11 4 V12.5 H3 Z" /><path d="M8.5 1.5 V4 H11" /><path d="M5 7 H9" /><path d="M5 9.5 H8" />
            </svg>
          </span>
          <span className="tpb__doclink-main">
            <span className="tpb__doclink-title">{isZh ? '需求分析文档' : 'Requirements doc'}</span>
            <span className="tpb__doclink-path">{plan.documentPath}</span>
          </span>
          <span className="tpb__doclink-go" aria-hidden="true">→</span>
        </button>
      )}
    </div>
  );
};

const Desk: React.FC<{ role: string }> = ({ role }) => {
  const r = role.toLowerCase();
  const kind = /review|qa|test/.test(r) ? 'review'
    : /arch|plan|design/.test(r) ? 'arch'
      : /integr|deliver|ops/.test(r) ? 'ops' : 'impl';
  return (
    <svg className={`tpb-desk is-${kind}`} viewBox="0 0 120 76" role="img" aria-hidden="true">
      {/* 人 */}
      <circle className="tpb-desk__head" cx="60" cy="22" r="10" />
      <path className="tpb-desk__body" d="M42 50c0-9.4 8-15 18-15s18 5.6 18 15" />
      {/* 桌面 + 桌腿 */}
      <rect className="tpb-desk__top" x="18" y="50" width="84" height="5" rx="2.5" />
      <path className="tpb-desk__leg" d="M28 55v14M92 55v14" />
      {/* 桌上的东西 —— 按角色换 */}
      {kind === 'impl' && (<><rect className="tpb-desk__item" x="46" y="41" width="28" height="9" rx="1.6" /><path className="tpb-desk__line" d="M50 45.5h20" /></>)}
      {kind === 'review' && (<><circle className="tpb-desk__item is-stroke" cx="58" cy="45" r="5.4" /><path className="tpb-desk__line" d="M62 49l5 4.5" /></>)}
      {kind === 'arch' && (<><rect className="tpb-desk__item is-stroke" x="45" y="39" width="30" height="11" rx="1.6" /><path className="tpb-desk__line" d="M52 39v11M45 44.5h30" /></>)}
      {kind === 'ops' && (<><path className="tpb-desk__line" d="M44 48l6-6 5 4 6-8 5 6 6-4" /><circle className="tpb-desk__item" cx="44" cy="48" r="1.8" /></>)}
    </svg>
  );
};

const SpecText: React.FC<{ text: string }> = ({ text }) => {
  const items = text.split(/[；;]\s*/).map((t) => t.trim()).filter(Boolean);
  if (items.length <= 1) return <div className="tpb-modal__text">{text}</div>;
  return (
    <ul className="tpb-spec">
      {items.map((it, i) => {
        const codey = /[{}()$]|≥|→|\bN=|\br=|\bp=/.test(it);
        return <li key={i} className={codey ? 'is-code' : undefined}>{it}</li>;
      })}
    </ul>
  );
};

/** 表格一行 —— 整行可点开详情 */
const RequirementRow: React.FC<{
  req: TeamRequirement;
  ownerId?: string;
  roster: TeamPlanSnapshot['roster'];
  isZh: boolean;
  exec?: TeamExecSnapshot | null;
  onOpen: () => void;
}> = ({ req, ownerId, roster, isZh, exec, onOpen }) => {
  const owner = roster.find((m) => m.id === ownerId);
  const st = STATUS_META[reqStatus(exec ?? null, req)] ?? STATUS_META.todo;
  return (
    <div className="tpb-row" role="button" tabIndex={0} onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
      <span className="tpb-row__id">{req.id}</span>
      <span className="tpb-row__title" title={req.title}>
        {req.priority && <span className={`tpb-row__pri is-${req.priority}`}>{req.priority}</span>}
        {req.title}
      </span>
      <span className="tpb-row__days">{fmtDays(req)}</span>
      <span className={`tpb-row__owner${owner ? '' : ' is-none'}`} title={owner?.title}>
        {owner ? (owner.title || owner.id) : (isZh ? '未分配' : 'Unassigned')}
      </span>
      <span className={`tpb-row__status is-${st.cls}`}>{isZh ? st.zh : st.en}</span>
    </div>
  );
};


interface TreeNode { req: TeamRequirement; kids: TreeNode[] }

function buildForest(reqs: TeamRequirement[]): TreeNode[] {
  const byId = new Map<string, TreeNode>(reqs.map((r) => [r.id, { req: r, kids: [] }]));
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    const p = n.req.parentId ? byId.get(n.req.parentId) : undefined;
    if (p) p.kids.push(n); else roots.push(n);
  }
  return roots;
}

/** 子树聚合: 叶子数 + 人天 + 完成数 —— 分支行显示这个 */
function rollup(n: TreeNode): { leaves: number; days: number; done: number } {
  if (n.kids.length === 0) {
    const d = n.req.estimateDays ?? (n.req.estimateHours ? n.req.estimateHours / 8 : 0);
    return { leaves: 1, days: d, done: n.req.status === 'done' ? 1 : 0 };
  }
  return n.kids.reduce((acc, k) => {
    const r = rollup(k);
    return { leaves: acc.leaves + r.leaves, days: acc.days + r.days, done: acc.done + r.done };
  }, { leaves: 0, days: 0, done: 0 });
}

const TreeRows: React.FC<{
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  ownerByReq: Map<string, string>;
  roster: TeamPlanSnapshot['roster'];
  isZh: boolean;
  /** 执行态 —— 状态列以它为准 (单一真相源) */
  exec?: TeamExecSnapshot | null;
  onOpen: (id: string) => void;
}> = ({ nodes, depth, collapsed, toggle, ownerByReq, roster, isZh, exec, onOpen }) => (
  <>
    {nodes.map((n) => {
      const isLeaf = n.kids.length === 0 && n.req.kind !== 'branch';
      const open = !collapsed.has(n.req.id);
      const agg = rollup(n);
      if (isLeaf) {
        return (
          <div key={n.req.id} className="tpb-tree__leaf" style={{ paddingLeft: `${depth * 15}px` }}>
            <RequirementRow req={n.req} ownerId={ownerByReq.get(n.req.id)} roster={roster} isZh={isZh}
              exec={exec} onOpen={() => onOpen(n.req.id)} />
          </div>
        );
      }
      /* 分支 —— 声明了 branch 却没孩子 = 还没展开, 得显眼 */
      const unexpanded = n.kids.length === 0;
      return (
        <React.Fragment key={n.req.id}>
          <div className={`tpb-tree__branch${unexpanded ? ' is-open-branch' : ''}`} style={{ paddingLeft: `${depth * 15}px` }}>
            <button type="button" className="tpb-tree__caret" aria-expanded={open}
              onClick={() => toggle(n.req.id)} disabled={unexpanded}>
              {unexpanded ? '·' : open ? '▾' : '▸'}
            </button>
            <button type="button" className="tpb-tree__label" onClick={() => onOpen(n.req.id)} title={n.req.detail}>
              {n.req.priority && <span className={`tpb-row__pri is-${n.req.priority}`}>{n.req.priority}</span>}
              {n.req.title}
            </button>
            {unexpanded
              ? <span className="tpb-tree__todo">{isZh ? '待展开' : 'unexpanded'}</span>
              : (
                <span className="tpb-tree__agg">
                  {isZh ? `${agg.leaves} 条` : `${agg.leaves}`}
                  {agg.days > 0 && <b>{Math.round(agg.days * 10) / 10}d</b>}
                  {agg.done > 0 && <i>{isZh ? `完成 ${agg.done}` : `${agg.done} done`}</i>}
                </span>
              )}
          </div>
          {open && n.kids.length > 0 && (
            <TreeRows nodes={n.kids} depth={depth + 1} collapsed={collapsed} toggle={toggle}
              ownerByReq={ownerByReq} roster={roster} isZh={isZh} exec={exec} onOpen={onOpen} />
          )}
        </React.Fragment>
      );
    })}
  </>
);

/** 详情弹窗 —— teambition 式任务卡: 左边正文, 右边属性 */
const RequirementDetail: React.FC<{
  req: TeamRequirement;
  plan: TeamPlanSnapshot;
  isZh: boolean;
  onClose: () => void;
  onAssign: (memberId: string | null) => void;
}> = ({ req, plan, isZh, onClose, onAssign }) => {
  const ownerId = plan.claims.find((c) => c.requirementIds.includes(req.id))?.memberId;
  const owner = plan.roster.find((m) => m.id === ownerId);
  const st = STATUS_META[req.status ?? 'todo'] ?? STATUS_META.todo;
  const [pickOpen, setPickOpen] = React.useState(false);
  const deps = (req.dependsOn ?? []).map((id) => plan.requirements.find((r) => r.id === id)).filter(Boolean) as TeamRequirement[];
  /* 领这条的人说过什么 —— 成员发言里跟这条相关的判断, 是这条需求最有价值的上下文 */
  const review = plan.reviews?.find((r) => r.memberId === ownerId);

  useEscClose(true, onClose);

  return (
    <div className="tpb-modal" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="tpb-modal__card" onClick={(e) => e.stopPropagation()}>
        <header className="tpb-modal__hdr">
          <span className="tpb-modal__id">{req.id}</span>
          {req.priority && <span className={`tpb-row__pri is-${req.priority}`}>{req.priority}</span>}
          <span className={`tpb-row__status is-${st.cls}`}>{isZh ? st.zh : st.en}</span>
          <button type="button" className="tpb-modal__close" onClick={onClose} aria-label={isZh ? '关闭' : 'Close'}>✕</button>
        </header>

        <h3 className="tpb-modal__title">{req.title}</h3>

        <div className="tpb-modal__props">
          <div className="tpb-modal__field">
            <span className="tpb-modal__prop-k">{isZh ? '负责人' : 'Owner'}</span>
            <div className="tpb-modal__assign">
              <button type="button" className={`tpb-modal__pick${owner ? '' : ' is-none'}`} onClick={() => setPickOpen((v) => !v)}>
                <span>{owner ? (owner.title || owner.id) : (isZh ? '未分配' : 'Unassigned')}</span>
                <svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4 L5 6.5 L7.5 4" /></svg>
              </button>
              {pickOpen && (
                <div className="tpb-req__menu" role="menu">
                  {plan.roster.map((m) => (
                    <button key={m.id} type="button"
                      className={`tpb-req__menu-item${m.id === ownerId ? ' is-current' : ''}`}
                      onClick={() => { onAssign(m.id); setPickOpen(false); }}>
                      <span className="tpb-req__menu-title">{m.title || m.id}</span>
                      <span className="tpb-req__menu-role">{m.role}</span>
                    </button>
                  ))}
                  {ownerId && (
                    <button type="button" className="tpb-req__menu-item is-clear"
                      onClick={() => { onAssign(null); setPickOpen(false); }}>
                      {isZh ? '收回分配' : 'Unassign'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="tpb-modal__field">
            <span className="tpb-modal__prop-k">{isZh ? '工作量' : 'Estimate'}</span>
            <span className="tpb-modal__prop-v">{fmtDays(req)}{fmtDays(req) !== '—' ? (isZh ? ' 人天' : ' d') : ''}</span>
          </div>
          <div className="tpb-modal__field">
            <span className="tpb-modal__prop-k">{isZh ? '模块' : 'Module'}</span>
            <span className="tpb-modal__prop-v">{req.module || '—'}</span>
          </div>
          <div className="tpb-modal__field">
            <span className="tpb-modal__prop-k">{isZh ? '状态' : 'Status'}</span>
            <span className={`tpb-row__status is-${st.cls}`}>{isZh ? st.zh : st.en}</span>
          </div>
        </div>

        <div className="tpb-modal__main">
          {req.detail && (
            <section className="tpb-modal__sec">
              <div className="tpb-modal__sec-h">{isZh ? '需求说明' : 'Description'}</div>
              <SpecText text={req.detail} />
            </section>
          )}
          {req.acceptance && (
            <section className="tpb-modal__sec">
              <div className="tpb-modal__sec-h">{isZh ? '验收判据' : 'Acceptance'}</div>
              <SpecText text={req.acceptance} />
            </section>
          )}
          {deps.length > 0 && (
            <section className="tpb-modal__sec">
              <div className="tpb-modal__sec-h">{isZh ? '依赖' : 'Depends on'}</div>
              <ul className="tpb-modal__deps">
                {deps.map((d) => (
                  <li key={d.id}><span className="tpb-row__id">{d.id}</span>{d.title}</li>
                ))}
              </ul>
            </section>
          )}
          {review?.analysis && (
            <section className="tpb-modal__sec">
              <div className="tpb-modal__sec-h">{isZh ? `${owner?.title || ownerId} 的判断` : `${owner?.title || ownerId}'s take`}</div>
              <div className="tpb-modal__text is-say">{review.analysis}</div>
              {review.concerns && <div className="tpb-modal__risk">⚠ {review.concerns}</div>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

/** hoist 上去的 memo 要一个引用稳定的空数组 —— 每次现造 [] 会让 memo 白重算 */
const EMPTY_REQS: TeamRequirement[] = [];

/* ---------- 主体 ---------- */

export const TeamPlanBoard: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { isZh } = useI18n();
  const plan = useTeamPlan(sessionId);
  /** 执行现场 —— 开工后才有 (团队方案是"计划", 这个是"现场") */
  const exec = useTeamExec(sessionId);
  /* 用 Optional: 看板也可能被挂在没有 runtime provider 的壳里 (预览/截图) */
  const runtime = useNeoxRuntimeOptional();
  const [tab, setTab] = React.useState<BoardTab>('overview');
  const [doc, setDoc] = React.useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; text?: string; err?: string }>({ state: 'idle' });
  const [q, setQ] = React.useState('');
  const [filterModule, setFilterModule] = React.useState<string | null>(null);
  const [filterOwner, setFilterOwner] = React.useState<string | null>(null);
  const [onlyUnassigned, setOnlyUnassigned] = React.useState(false);
  const [filterOpen, setFilterOpen] = React.useState(false);
  const [filterStatus, setFilterStatus] = React.useState<string | null>(null);
  const [filterPriority, setFilterPriority] = React.useState<string | null>(null);
  /* 点开的需求详情 */
  const [openReqId, setOpenReqId] = React.useState<string | null>(null);
  /** 打开的会议 id —— 详情走弹窗, 不在列表里就地展开 (就地展开会把整页占满) */
  const [openMtgId, setOpenMtgId] = React.useState<string | null>(null);
  /** 折叠起来的分支 id (默认全展开 —— 第一眼要看到整棵树的形状) */
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [openMemberId, setOpenMemberId] = React.useState<string | null>(null);
  /* 人员弹窗是内联 JSX (不是独立组件), Esc 挂在这里 —— 三个弹窗现在同一套行为 */
  const closeMember = React.useCallback(() => setOpenMemberId(null), []);
  useEscClose(openMemberId != null, closeMember);

  React.useEffect(() => { void hydrateTeamPlan(sessionId); }, [sessionId]);

  /* 文档页: 按需读一次那份长文 —— 它可能几百行, 不该跟着每次快照更新重读 */
  React.useEffect(() => {
    if (tab !== 'doc' || !plan?.documentPath) return;
    let cancelled = false;
    setDoc({ state: 'loading' });
    void (async () => {
      try {
        const res = await (window as any).neox?.readFile?.(plan.documentPath);
        const text = typeof res === 'string' ? res : (res?.content ?? null);
        if (cancelled) return;
        if (typeof text === 'string' && text.trim()) setDoc({ state: 'ok', text });
        else setDoc({ state: 'error', err: String(res?.error ?? '') });
      } catch (e: any) { if (!cancelled) setDoc({ state: 'error', err: String(e?.message ?? e) }); }
    })();
    return () => { cancelled = true; };
  }, [tab, plan?.documentPath]);

  const reqs = plan?.requirements ?? EMPTY_REQS;
  /* 递归拆解的树 —— 有 parentId 就按树渲染 (老数据没有, 仍走模块分组平铺) */
  const forest = React.useMemo(() => buildForest(reqs), [reqs]);
  /* 施工批次 (拓扑分层) —— 跟 core 的 scheduleWaves 同一套算法: 批内并行, 跨批串行。
   * 看板自己算一遍是刻意的: 用户在这里改派/调依赖后能立刻看到批次变化, 不用等模型重跑。 */
  const waves = React.useMemo<string[][]>(() => {
    const kids = new Set(reqs.map((r) => r.parentId).filter(Boolean) as string[]);
    const leaves = reqs.filter((r) => (r.kind ? r.kind === 'leaf' : !kids.has(r.id)));
    const leafIds = new Set(leaves.map((r) => r.id));
    const expand = (id: string): string[] => {
      if (leafIds.has(id)) return [id];
      const out: string[] = [];
      const walk = (pid: string) => {
        for (const c of reqs.filter((r) => r.parentId === pid)) {
          if (leafIds.has(c.id)) out.push(c.id); else walk(c.id);
        }
      };
      walk(id);
      return out;
    };
    const done = new Set<string>();
    const out: string[][] = [];
    let guard = 0;
    while (done.size < leaves.length && guard++ < leaves.length + 2) {
      const wave = leaves.filter((l) => !done.has(l.id))
        .filter((l) => (l.dependsOn ?? []).flatMap(expand).filter((d) => d !== l.id)
          .every((d) => done.has(d) || !leafIds.has(d)))
        .map((l) => l.id);
      if (!wave.length) break;
      out.push(wave);
      for (const id of wave) done.add(id);
    }
    return out;
  }, [reqs]);
  const toggleNode = React.useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  /* 会议台 —— 模型记的会 (team_meeting) + 成员发言自动汇成的那场需求评审会。
     用户要的是「看到他们讨论的过程」, 而领活前的逐人发言本身就是一场评审会, 不该只躺在人员页里。 */
  const allMeetings = React.useMemo<TeamMeeting[]>(() => {
    const real = [...(plan?.meetings ?? [])];
    const rv = plan?.reviews ?? [];
    if (rv.length > 0 && !real.some((m) => m.id === 'derived-claim-review')) {
      real.push({
        id: 'derived-claim-review',
        kind: 'requirements',
        title: isZh ? '领取评审: 每个人自己说要接哪些、为什么是我' : 'Claim review: who takes what and why',
        participants: rv.map((r) => r.memberId),
        notes: rv.map((r) => ({
          memberId: r.memberId,
          say: r.analysis + (r.concerns ? `\n⚠ ${r.concerns}` : '')
            + (r.picks?.length ? `\n→ ${isZh ? '想接' : 'picks'}: ${r.picks.join('、')}` : ''),
        })),
        at: Math.max(...rv.map((r) => r.at || 0)),
      });
    }
    return real.sort((a, b) => (b.at || 0) - (a.at || 0));
  }, [plan?.meetings, plan?.reviews, isZh]);

  if (!plan) {
    return (
      <div className="sfc-empty">
        {/* 只有"还没开始"才配插画 —— 同一个 .sfc-empty 也用于加载中和渲染失败,
            那两种是**过程/故障**, 配画会让人以为是稳态。 */}
        <img className="sfc-empty__art" src={NeoxIllus.team} alt="" aria-hidden draggable={false} />
        <div className="sfc-empty__title">{isZh ? '还没有团队' : 'No team yet'}</div>
        <div className="sfc-empty__msg">
          {isZh
            ? '在对话里说「我要调用团队做 …」——需求分析 / 人员配置 / 分配都会出现在这里'
            : 'Say "run this as a team …" in the chat — requirements, people and assignment show up here'}
        </div>
      </div>
    );
  }

  registerRosterHues(plan.roster);
  const meta = teamStageMeta(plan, isZh);
  const ownerByReq = new Map<string, string>();
  for (const c of plan.claims) for (const rid of c.requirementIds) ownerByReq.set(rid, c.memberId);
  const assigned = plan.requirements.filter((r) => ownerByReq.has(r.id)).length;

  /* 需求按模块分组 + 搜索/筛选 —— 几十上百条不分组不筛就是一堵墙 */
  const allModules = [...new Set(plan.requirements.map((r) => r.module).filter(Boolean))] as string[];
  const kw = q.trim().toLowerCase();
  const visible = plan.requirements.filter((r) => {
    if (filterModule && r.module !== filterModule) return false;
    if (filterOwner && ownerByReq.get(r.id) !== filterOwner) return false;
    if (onlyUnassigned && ownerByReq.has(r.id)) return false;
    if (filterStatus && (r.status ?? 'todo') !== filterStatus) return false;
    if (filterPriority && r.priority !== filterPriority) return false;
    if (!kw) return true;
    return [r.id, r.title, r.detail, r.acceptance, r.module].filter(Boolean)
      .some((t) => String(t).toLowerCase().includes(kw));
  });
  const groups = new Map<string, TeamRequirement[]>();
  for (const r of [...visible].sort((a, b) =>
    (PRIORITY_ORDER[a.priority ?? 'P1'] ?? 1) - (PRIORITY_ORDER[b.priority ?? 'P1'] ?? 1))) {
    const key = r.module || (isZh ? '未分组' : 'Ungrouped');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const activeFilterCount = [filterModule, filterOwner, filterStatus, filterPriority].filter(Boolean).length
    + (onlyUnassigned ? 1 : 0);
  /* 递归拆解的树 —— 有 parentId 就按树渲染 (老数据没有, 仍走模块分组平铺); forest 已在上面算好 */
  const hasTree = plan.requirements.some((r) => r.parentId);
  const hasKid = new Set(plan.requirements.map((r) => r.parentId).filter(Boolean) as string[]);
  const leafCount = plan.requirements.filter((r) => (r.kind ? r.kind === 'leaf' : !hasKid.has(r.id))).length;
  const openBranchCount = plan.requirements.filter((r) => r.kind === 'branch' && !hasKid.has(r.id)).length;
  const maxDepth = plan.requirements.reduce((m, r) => Math.max(m, r.depth ?? 0), 0);
  const filterActive = activeFilterCount > 0 || kw.length > 0;
  const openReq = openReqId ? plan.requirements.find((r) => r.id === openReqId) ?? null : null;

  const TABS: Array<{ id: BoardTab; label: string; count?: number }> = [
    { id: 'overview', label: isZh ? '概览' : 'Overview' },
    /* 执行台只在真的开工过之后才出现 —— 没开工时它是个空壳, 白占一个页签 */
    ...(exec ? [{ id: 'exec' as BoardTab, label: isZh ? '执行台' : 'Execution', count: exec.tasks.length }] : []),
    { id: 'requirements', label: isZh ? '需求' : 'Requirements', count: plan.requirements.length },
    { id: 'people', label: isZh ? '人员' : 'People', count: plan.roster.length },
    { id: 'meetings', label: isZh ? '会议台' : 'Meetings', count: allMeetings.length },
    { id: 'levels', label: isZh ? '定级' : 'Levels', count: plan.roster.length },
    { id: 'doc', label: isZh ? '文档' : 'Doc' },
  ];

  return (
    <div className="tpb">
      <header className="tpb__hdr">
        <div className="tpb__goal" title={plan.goal}>{plan.goal}</div>
        <div className="tpb__stage">
          <span className={`tpb__stage-badge is-${plan.stage}`}>{meta.step} {meta.label}</span>
          <span className="tpb__stage-detail">{meta.detail}</span>
        </div>
      </header>

      <nav className="tpb__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tpb__tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && <span className="tpb__tab-count">{t.count}</span>}
          </button>
        ))}
      </nav>

      <div className="tpb__body">
        {tab === 'overview' && (
          <TeamOverview
            plan={plan}
            exec={exec}
            isZh={isZh}
            waves={waves}
            meetings={allMeetings}
            onOpenReq={setOpenReqId}
            onOpenMember={setOpenMemberId}
            onOpenMeeting={setOpenMtgId}
            onGoTab={setTab}
          />
        )}

        {tab === 'requirements' && plan.requirements.length > 0 && (
          /* 一行工具条: 搜索 + 一颗筛选按钮 (条件全在弹出面板里) */
          <div className="tpb-bar">
            <div className="tpb-bar__search">
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                <circle cx="6.2" cy="6.2" r="4.2" /><path d="M9.4 9.4 L12.4 12.4" />
              </svg>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={isZh ? `搜索 ${plan.requirements.length} 条需求…` : `Search ${plan.requirements.length}…`}
              />
              {q && <button type="button" className="tpb-bar__clear" onClick={() => setQ('')} aria-label="clear">✕</button>}
            </div>
            <div className="tpb-bar__filter-wrap">
              <button
                type="button"
                className={`tpb-bar__filter${activeFilterCount > 0 ? ' is-on' : ''}`}
                onClick={() => setFilterOpen((v) => !v)}
                aria-expanded={filterOpen}
              >
                <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M1.5 3h11M3.5 7h7M5.5 11h3" />
                </svg>
                {isZh ? '筛选' : 'Filter'}
                {activeFilterCount > 0 && <span className="tpb-bar__badge">{activeFilterCount}</span>}
              </button>
              {filterOpen && (
                <div className="tpb-filter-pop" role="menu">
                  <div className="tpb-filter-pop__grp">
                    <div className="tpb-filter-pop__h">{isZh ? '模块' : 'Module'}</div>
                    <div className="tpb-filter-pop__chips">
                      <button type="button" className={`tpb__filter${!filterModule ? ' is-on' : ''}`} onClick={() => setFilterModule(null)}>{isZh ? '全部' : 'All'}</button>
                      {allModules.map((m) => (
                        <button key={m} type="button" className={`tpb__filter${filterModule === m ? ' is-on' : ''}`}
                          onClick={() => setFilterModule(filterModule === m ? null : m)}>{m}</button>
                      ))}
                    </div>
                  </div>
                  <div className="tpb-filter-pop__grp">
                    <div className="tpb-filter-pop__h">{isZh ? '负责人' : 'Owner'}</div>
                    <div className="tpb-filter-pop__chips">
                      {plan.roster.map((m) => (
                        <button key={m.id} type="button" className={`tpb__filter${filterOwner === m.id ? ' is-on' : ''}`}
                          onClick={() => setFilterOwner(filterOwner === m.id ? null : m.id)}>{m.title || m.id}</button>
                      ))}
                      <button type="button" className={`tpb__filter${onlyUnassigned ? ' is-on' : ''}`}
                        onClick={() => setOnlyUnassigned((v) => !v)}>{isZh ? '未分配' : 'Unassigned'}</button>
                    </div>
                  </div>
                  <div className="tpb-filter-pop__grp">
                    <div className="tpb-filter-pop__h">{isZh ? '状态' : 'Status'}</div>
                    <div className="tpb-filter-pop__chips">
                      {(['todo', 'doing', 'blocked', 'done'] as const).map((st) => (
                        <button key={st} type="button" className={`tpb__filter${filterStatus === st ? ' is-on' : ''}`}
                          onClick={() => setFilterStatus(filterStatus === st ? null : st)}>
                          {isZh ? STATUS_META[st].zh : STATUS_META[st].en}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="tpb-filter-pop__grp">
                    <div className="tpb-filter-pop__h">{isZh ? '优先级' : 'Priority'}</div>
                    <div className="tpb-filter-pop__chips">
                      {(['P0', 'P1', 'P2'] as const).map((p) => (
                        <button key={p} type="button" className={`tpb__filter${filterPriority === p ? ' is-on' : ''}`}
                          onClick={() => setFilterPriority(filterPriority === p ? null : p)}>{p}</button>
                      ))}
                    </div>
                  </div>
                  <div className="tpb-filter-pop__foot">
                    <span>{isZh ? `${visible.length} / ${plan.requirements.length} 条` : `${visible.length} / ${plan.requirements.length}`}</span>
                    <button type="button" className="tpb-filter-pop__reset" onClick={() => {
                      setFilterModule(null); setFilterOwner(null); setOnlyUnassigned(false);
                      setFilterStatus(null); setFilterPriority(null);
                    }}>{isZh ? '清空条件' : 'Reset'}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {tab === 'exec' && exec && (
          <ExecBoard
            exec={exec}
            plan={plan}
            sessionId={sessionId}
            isZh={isZh}
            /* 跳进那个 agent 自己的子会话 —— agentId 就是子会话 id (派兵时定的),
               子会话的 timeline 才是"他到底干了什么"的完整记录 (工具调用/思考/改动都在那里)。 */
            onOpenAgent={(agentId) => { runtime?.selectSession?.(agentId); }}
          />
        )}

        {tab === 'requirements' && (
          plan.requirements.length === 0
            ? <div className="tpb__empty">{isZh ? '正在盘现状、做需求分析…' : 'Surveying and analysing…'}</div>
            : (
              <div className="tpb-table">
                <div className="tpb-table__head">
                  <span>{isZh ? '编号' : 'ID'}</span>
                  <span>{isZh ? '需求' : 'Requirement'}</span>
                  <span className="tpb-table__num">{isZh ? '人天' : 'Days'}</span>
                  <span>{isZh ? '负责人' : 'Owner'}</span>
                  <span>{isZh ? '状态' : 'Status'}</span>
                </div>
                {/* 有层级就按树渲染 (递归拆解的产物); 没有 parentId 的老数据仍按模块分组平铺。
                    筛选生效时也退回平铺 —— 筛完只剩零散叶子, 硬撑成树反而看不出所以然。 */}
                {hasTree && !filterActive
                  ? (
                    <div className="tpb-tree">
                      <TreeRows nodes={forest} depth={0} collapsed={collapsed} toggle={toggleNode}
                        ownerByReq={ownerByReq} roster={plan.roster} isZh={isZh} exec={exec} onOpen={setOpenReqId} />
                    </div>
                  )
                  : [...groups.entries()].map(([mod, reqs]) => (
                  <section key={mod} className="tpb-table__grp">
                    <div className="tpb-table__grp-h">
                      {mod}<span className="tpb__group-n">{reqs.length}</span>
                      <span className="tpb-table__grp-days">
                        {(() => {
                          const sum = reqs.reduce((n, r) => n + (r.estimateDays ?? (r.estimateHours ? r.estimateHours / 8 : 0)), 0);
                          return sum > 0 ? (isZh ? `${Math.round(sum * 10) / 10} 人天` : `${Math.round(sum * 10) / 10}d`) : '';
                        })()}
                      </span>
                    </div>
                    {reqs.map((r) => (
                      <RequirementRow key={r.id} req={r} ownerId={ownerByReq.get(r.id)}
                        roster={plan.roster} isZh={isZh} exec={exec} onOpen={() => setOpenReqId(r.id)} />
                    ))}
                  </section>
                ))}
                {visible.length === 0 && (
                  <div className="tpb__empty">{isZh ? '没有符合条件的需求' : 'No matching requirements'}</div>
                )}
              </div>
            )
        )}

        {tab === 'people' && (() => {
          if (plan.roster.length === 0) {
            return <div className="tpb__empty">{isZh ? '编制还没定 —— 需求分析完成后才推导人员' : 'Roster not decided yet'}</div>;
          }
          const deptOf = (role: string) => {
            const r = role.toLowerCase();
            if (/review|qa|test/.test(r)) return isZh ? '质量与审查' : 'Quality';
            if (/arch|plan|design/.test(r)) return isZh ? '架构与设计' : 'Architecture';
            if (/integr|deliver|ops/.test(r)) return isZh ? '集成与交付' : 'Delivery';
            return isZh ? '研发实现' : 'Engineering';
          };
          const depts = new Map<string, typeof plan.roster>();
          for (const m of plan.roster) {
            const d = deptOf(m.role);
            if (!depts.has(d)) depts.set(d, []);
            depts.get(d)!.push(m);
          }
          const daysOf2 = (r: TeamRequirement) => r.estimateDays ?? (r.estimateHours ? r.estimateHours / 8 : 0);
          return (
            <div className="tpb-crew">
              {[...depts.entries()].map(([dept, members]) => (
                <section key={dept} className="tpb-crew__dept">
                  <div className="tpb-crew__dept-h">
                    <span>{dept}</span>
                    <span className="tpb-crew__dept-n">{members.length}</span>
                  </div>
                  <div className="tpb-crew__grid">
                    {members.map((m) => {
                      const ids = plan.claims.find((c) => c.memberId === m.id)?.requirementIds ?? [];
                      const reqs = ids.map((id) => plan.requirements.find((r) => r.id === id)).filter(Boolean) as TeamRequirement[];
                      const days = Math.round(reqs.reduce((n, r) => n + daysOf2(r), 0) * 10) / 10;
                      const done = reqs.filter((r) => r.status === 'done').length;
                      const rv = plan.reviews?.find((x) => x.memberId === m.id);
                      const joined = rv?.at ?? plan.updatedAt;
                      const live = memberLive(exec, m.id);
                      return (
                        <button key={m.id} type="button" className={`tpb-seat is-live-${live.state}`} onClick={() => setOpenMemberId(m.id)}>
                          {/* 在线状态灯 —— 执行中会呼吸, 一眼看出谁在动 */}
                          <span className={`tpb-seat__live is-${live.state}`} title={live.cur}>
                            <i aria-hidden="true" />
                            {isZh ? LIVE_META[live.state].zh : LIVE_META[live.state].en}
                            {live.total > 0 && live.state !== 'idle' && <b>{live.done}/{live.total}</b>}
                          </span>
                          <Desk role={m.role} />
                          <div className="tpb-seat__name" title={m.title}>{m.title || m.id}</div>
                          <div className="tpb-seat__role">{m.role}</div>
                          {live.state === 'running' && live.cur && (
                            <div className="tpb-seat__cur" title={live.cur}>{live.cur}</div>
                          )}
                          <div className="tpb-seat__meta">
                            <span>{isZh ? `${reqs.length} 条` : `${reqs.length}`}</span>
                            {days > 0 && <span>{days}d</span>}
                            {done > 0 && <span className="is-done">{isZh ? `完成 ${done}` : `${done} done`}</span>}
                          </div>
                          <div className="tpb-seat__joined">
                            {new Date(joined).toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          );
        })()}


        {tab === 'meetings' && (
          allMeetings.length === 0
            ? (
              <div className="tpb__empty">
                {isZh ? '还没有会议记录 —— 需求评审 / 开发研讨 / 测试研讨会在这里逐场留痕' : 'No meetings yet'}
              </div>
            )
            : (
              <div className="tpb-mtgs">
                {/* 会议类型总览 —— 哪种会开过、开了几场, 一眼看出流程走到哪 */}
                <div className="tpb-mtgs__kinds">
                  {(['requirements', 'design', 'test', 'estimate', 'review', 'standup'] as const).map((k) => {
                    const n = allMeetings.filter((m) => m.kind === k).length;
                    return (
                      <span key={k} className={`tpb-mtgs__kind is-${k}${n ? ' is-on' : ''}`}>
                        {isZh ? MEETING_META[k].zh : MEETING_META[k].en}
                        <b>{n}</b>
                      </span>
                    );
                  })}
                </div>
                {allMeetings.map((m) => (
                  <MeetingCard key={m.id} m={m} roster={plan.roster} isZh={isZh}
                    onOpen={() => setOpenMtgId(m.id)} />
                ))}
              </div>
            )
        )}

        {tab === 'levels' && (
          plan.roster.length === 0
            ? <div className="tpb__empty">{isZh ? '编制还没定' : 'No roster yet'}</div>
            : (
              <div className="tpb-lv">
                {(() => {
                  const rows = plan.roster.map((m) => {
                    const ids = plan.claims.find((c) => c.memberId === m.id)?.requirementIds ?? [];
                    const reqs = plan.requirements.filter((r) => ids.includes(r.id));
                    return {
                      m,
                      count: reqs.length,
                      days: Math.round(reqs.reduce((n, r) => n + daysOf(r), 0) * 10) / 10,
                      p0: reqs.filter((r) => r.priority === 'P0').length,
                    };
                  });
                  const maxDays = Math.max(1, ...rows.map((r) => r.days));
                  const graded = rows.filter((r) => r.m.level).length;
                  return (
                    <>
                      <div className="tpb-lv__meta">
                        {isZh
                          ? `${graded}/${plan.roster.length} 人已定级 · 等级与实际负载并排看`
                          : `${graded}/${plan.roster.length} graded · level vs actual load`}
                      </div>
                      {rows.map(({ m, count, days, p0 }) => (
                        <section key={m.id} className="tpb-lv__row">
                          <div className="tpb-lv__left">
                            <span className={`tpb-seat__live is-${memberLive(exec, m.id).state}`}>
                              <i aria-hidden="true" />
                              {isZh ? LIVE_META[memberLive(exec, m.id).state].zh : LIVE_META[memberLive(exec, m.id).state].en}
                            </span>
                            <span className={`tpb-lv__badge${m.level ? '' : ' is-none'}`}>
                              {m.level || (isZh ? '未定级' : 'ungraded')}
                            </span>
                            <span className="tpb-lv__name" title={m.why}>{m.title || m.id}</span>
                            <span className="tpb-lv__role">{m.role}</span>
                          </div>
                          <div className="tpb-lv__load">
                            <span className="tpb-bars__track">
                              <span className="tpb-bars__fill" style={{ width: `${(days / maxDays) * 100}%` }} />
                            </span>
                            <span className="tpb-lv__nums">
                              {count} {isZh ? '条' : ''} · {days}d{p0 > 0 ? ` · P0 ${p0}` : ''}
                            </span>
                          </div>
                          {m.levelReason && <div className="tpb-lv__why">{m.levelReason}</div>}
                        </section>
                      ))}
                    </>
                  );
                })()}
              </div>
            )
        )}

        {tab === 'doc' && (
          !plan.documentPath
            ? <div className="tpb__empty">{isZh ? '还没有需求文档' : 'No requirements doc yet'}</div>
            : doc.state === 'loading' || doc.state === 'idle'
              ? <div className="tpb__empty neox-text-shimmer">{isZh ? '读取中…' : 'Loading…'}</div>
              : doc.state === 'error'
                ? (
                  <div className="tpb__empty is-err">
                    {isZh ? '读不到这份文档' : 'Cannot read the doc'}
                    <code>{plan.documentPath}</code>
                    <span>{isZh
                      ? '文件可能压根没写出来 (登记了路径 ≠ 落了盘), 或者已经被移走。'
                      : 'The file may never have been written, or was moved.'}</span>
                    {doc.err && <span className="tpb__empty-err">{doc.err}</span>}
                  </div>
                )
              : (
                <div className="tpb__doc markdown-content">
                  <Markdown content={doc.text!} />
                </div>
              )
        )}
      </div>

      {openMemberId && (() => {
        const m = plan.roster.find((x) => x.id === openMemberId);
        if (!m) return null;
        const rv = plan.reviews?.find((x) => x.memberId === m.id);
        const claim = plan.claims.find((c) => c.memberId === m.id);
        const reqs = (claim?.requirementIds ?? []).map((id) => plan.requirements.find((r) => r.id === id)).filter(Boolean) as TeamRequirement[];
        const days = Math.round(reqs.reduce((n, r) => n + (r.estimateDays ?? (r.estimateHours ? r.estimateHours / 8 : 0)), 0) * 10) / 10;
        return (
          <div className="tpb-modal" role="dialog" aria-modal="true" onClick={() => setOpenMemberId(null)}>
            <div className="tpb-modal__card" onClick={(e) => e.stopPropagation()}>
              <header className="tpb-modal__hdr">
                <span className="tpb-modal__id">{m.id}</span>
                <span className="tpb-row__status is-doing">{m.role}</span>
                <button type="button" className="tpb-modal__close" onClick={() => setOpenMemberId(null)} aria-label={isZh ? '关闭' : 'Close'}>✕</button>
              </header>
              <h3 className="tpb-modal__title">{m.title || m.id}</h3>
              <div className="tpb-modal__props">
                <div className="tpb-modal__field">
                  <span className="tpb-modal__prop-k">{isZh ? '负责需求' : 'Requirements'}</span>
                  <span className="tpb-modal__prop-v">{reqs.length}</span>
                </div>
                <div className="tpb-modal__field">
                  <span className="tpb-modal__prop-k">{isZh ? '工作量' : 'Estimate'}</span>
                  <span className="tpb-modal__prop-v">{days > 0 ? `${days}${isZh ? ' 人天' : 'd'}` : '—'}</span>
                </div>
                <div className="tpb-modal__field">
                  <span className="tpb-modal__prop-k">{isZh ? '领地' : 'Scope'}</span>
                  <span className="tpb-modal__prop-v">{(claim?.ownedScope ?? []).length || '—'}</span>
                </div>
              </div>
              <div className="tpb-modal__main">
                {m.why && (
                  <section className="tpb-modal__sec">
                    <div className="tpb-modal__sec-h">{isZh ? '为什么需要他' : 'Why this role'}</div>
                    <div className="tpb-modal__text">{m.why}</div>
                  </section>
                )}
                {rv?.analysis && (
                  <section className="tpb-modal__sec">
                    <div className="tpb-modal__sec-h">{isZh ? '他的判断' : 'Their take'}</div>
                    <div className="tpb-modal__text is-say">{rv.analysis}</div>
                    {rv.concerns && <div className="tpb-modal__risk">⚠ {rv.concerns}</div>}
                  </section>
                )}
                {reqs.length > 0 && (
                  <section className="tpb-modal__sec">
                    <div className="tpb-modal__sec-h">{isZh ? '认领的需求' : 'Claimed'}</div>
                    <div className="tpb-modal__reqlist">
                      {reqs.map((r) => (
                        <button key={r.id} type="button" className="tpb-modal__reqrow"
                          onClick={() => { setOpenMemberId(null); setOpenReqId(r.id); }}>
                          <span className="tpb-row__id">{r.id}</span>
                          <span className="tpb-modal__reqrow-t">{r.title}</span>
                          <span className={`tpb-row__status is-${(STATUS_META[r.status ?? 'todo'] ?? STATUS_META.todo).cls}`}>
                            {isZh ? (STATUS_META[r.status ?? 'todo'] ?? STATUS_META.todo).zh : (STATUS_META[r.status ?? 'todo'] ?? STATUS_META.todo).en}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {claim?.ownedScope && claim.ownedScope.length > 0 && (
                  <section className="tpb-modal__sec">
                    <div className="tpb-modal__sec-h">{isZh ? '领地' : 'Owned scope'}</div>
                    <ul className="tpb-spec">{claim.ownedScope.map((sc, i) => <li key={i} className="is-code">{sc}</li>)}</ul>
                  </section>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {openReq && (
        <RequirementDetail
          req={openReq}
          plan={plan}
          isZh={isZh}
          onClose={() => setOpenReqId(null)}
          onAssign={(memberId) => { void assignRequirement(sessionId, openReq.id, memberId); }}
        />
      )}

      {openMtgId && (() => {
        const m = allMeetings.find((x) => x.id === openMtgId);
        return m ? <MeetingModal m={m} roster={plan.roster} isZh={isZh} onClose={() => setOpenMtgId(null)} /> : null;
      })()}
    </div>
  );
};

export default TeamPlanBoard;
