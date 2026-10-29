import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNeoxRuntimeOptional } from '../../app/NeoxRuntimeContext';
import { useI18n } from '../../hooks/useI18n';
import { useExclusivePopover } from '../../hooks/useExclusivePopover';
import { useTimelineFeed } from '../../state/timelineFeedStore';
import { zhRuntimeTitle } from './runtimeTitleZh';
import { DotSpinner } from '../../components/DotSpinner';
import { derivePhase, phaseLabel, type AgentPhase } from './agentPhase';
import './clay-island.css';

type StepKind = 'read' | 'edit' | 'run' | 'search' | 'other';
interface IslandStep { id: string; title: string; kind: StepKind; state: 'done' | 'running' | 'failed'; ms?: number }

/* 工具卡跑完会原地从 tool_call 改成 tool_result (useStreamHandler updateTimelineEntryById), 两种都算一步 */
const STEP_TYPES = new Set(['tool_call', 'tool_result', 'tool_error', 'edit_file', 'file_stream']);

function kindOf(toolName = ''): StepKind {
  const t = toolName.toLowerCase();
  if (/(read|view|cat|open_file|list|glob|ls)/.test(t)) return 'read';
  if (/(edit|write|patch|replace|create_file)/.test(t)) return 'edit';
  if (/(shell|exec|bash|command|run|terminal)/.test(t)) return 'run';
  if (/(search|grep|find|web_fetch|browse)/.test(t)) return 'search';
  return 'other';
}

const VERB: Record<StepKind, [string, string]> = {
  read: ['读取', 'Read'], edit: ['修改', 'Edit'], run: ['运行', 'Run'], search: ['搜索', 'Search'], other: ['', ''],
};

/* 工具卡标题常是整条路径 —— 岛里只留「动词 + 文件名」 */
function shortTitle(rawTitle: string, kind: StepKind, zh: boolean): string {
  const title = zh ? zhRuntimeTitle(rawTitle.trim()) : rawTitle;
  const trimmed = title.trim();
  /* 参数还没到时标题只有裸工具名 ("Readfile" / "read_file"): 中文下写动词, 别把英文工具名摆上岛 */
  if (zh && /^[A-Za-z_]+$/.test(trimmed)) return VERB[kind][0] ? `${VERB[kind][0]}中` : '执行中';
  /* 标题里任何一段路径都缩成文件名 ("a/b/c.ts (1-1000)" → "c.ts (1-1000)") */
  const shortened = trimmed.replace(/(?:[\w.@~-]+)?(?:[\\/][\w.@~ -]*?[\w.@~-])+(?=$|[\s(:,])/g, (p) => p.split(/[\\/]/).filter(Boolean).pop() || p);
  if (shortened === trimmed) return trimmed;
  const verb = VERB[kind][zh ? 0 : 1];
  return verb && !/^[一-龥]/.test(shortened) ? `${verb} ${shortened}` : shortened;
}

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* 1.5px 线条小字形 —— 状态靠字形区分, 不靠一排圆点 */
const Glyph: React.FC<{ name: string }> = ({ name }) => {
  const p = { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'idle': return <svg {...p}><circle cx="8" cy="8" r="4.5" /></svg>;
    case 'spin': return <DotSpinner size={12} />;
    case 'run': return <svg {...p}><path d="m3.5 5 3 3-3 3M8.5 11.5h4" /></svg>;
    case 'read': return <svg {...p}><path d="M4.5 2.5h4.5l2.5 2.5v8.5h-7z M7 8h3M7 10.5h3" /></svg>;
    case 'edit': return <svg {...p}><path d="m10.5 3 2.5 2.5L6 12.5H3.5V10z" /></svg>;
    case 'search': return <svg {...p}><circle cx="7" cy="7" r="3.5" /><path d="m10 10 3 3" /></svg>;
    case 'hand': return <svg {...p}><path d="M5.5 8.5V4.25a1 1 0 0 1 2 0V7.5m0-3.75v-.5a1 1 0 0 1 2 0V7.5m0-3a1 1 0 0 1 2 0v4.25a4.5 4.5 0 0 1-8.2 2.55L2.2 8.9a1 1 0 0 1 1.6-1.2l1.7 1.8" /></svg>;
    case 'check': return <svg {...p}><path d="m3.5 8.5 3 3 6-7" /></svg>;
    case 'warn': return <svg {...p}><path d="M8 3 2.5 13h11zM8 7v2.5M8 11.2v.1" /></svg>;
    case 'plan': return <svg {...p}><path d="M3 4.5l1 1 1.75-2M3 10.5l1 1 1.75-2M8.5 4.5h4.5M8.5 10.5h4.5" /></svg>;
    case 'write': return <svg {...p}><path d="M3 4.5h10M3 8h10M3 11.5h5.5" /></svg>;
    case 'agent': return <svg {...p}><circle cx="8" cy="5.5" r="2.25" /><path d="M3.5 13.5a4.5 4.5 0 0 1 9 0" /></svg>;
    case 'compact': return <svg {...p}><path d="M5 2.5 8 5.5l3-3M5 13.5l3-3 3 3M3 8h10" /></svg>;
    case 'clock': return <svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.25l2 1.25" /></svg>;
    case 'retry': return <svg {...p}><path d="M12.5 6.5A4.75 4.75 0 1 0 12.75 9.5M12.75 3v3.5h-3.5" /></svg>;
    case 'ask': return <svg {...p}><path d="M3 3.5h10v7H7.5L4.5 13v-2.5H3z M6.5 6.25a1.5 1.5 0 1 1 1.5 1.5V8.5" /></svg>;
    default: return <svg {...p}><circle cx="8" cy="8" r="1.5" /></svg>;
  }
};

export const ClayIsland: React.FC = () => {
  const rt = useNeoxRuntimeOptional();
  const { isZh } = useI18n();
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [justDone, setJustDone] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  /* 浮层 portal 到 body: 顶栏 z-index 低于主区, 挂在顶栏里会被泥板盖住 */
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const streaming = !!rt?.streaming;
  const approval = rt?.pendingApproval ?? null;
  const error = rt?.lastError ?? null;
  const startedAt = rt?.turnStartedAt ?? null;
  /* 时间轴走外部 store (timelineFeedStore), Context 上的 timelineEvents 不随流式更新 */
  const events = useTimelineFeed();

  /* 运行中每秒走一下表; 不跑就不挂计时器 */
  useEffect(() => {
    if (!streaming) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [streaming]);

  /* 跑完亮 3 秒「完成」再回空闲 */
  const prevStreaming = useRef(streaming);
  useEffect(() => {
    if (prevStreaming.current && !streaming && !error) {
      setJustDone(true);
      const id = window.setTimeout(() => setJustDone(false), 3000);
      prevStreaming.current = streaming;
      return () => window.clearTimeout(id);
    }
    prevStreaming.current = streaming;
    return undefined;
  }, [streaming, error]);

  /* 这一轮的步骤: 从尾部往回扫到最后一条用户消息 (长会话不全量遍历) */
  const { steps, turnStart } = useMemo<{ steps: IslandStep[]; turnStart: number | null }>(() => {
    if (!events?.length) return { steps: [], turnStart: null };
    const out: IslandStep[] = [];
    let start: number | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      /* 用时从这一轮的用户消息算起 (turnStartedAt 每次续跑都会重置, 不是整轮的起点) */
      if (e.type === 'user_message') { start = e.timestamp || null; break; }
      if (!STEP_TYPES.has(e.type)) continue;
      if (e.id.startsWith('timeline-tool-result')) continue;
      const failed = e.success === false;
      const kind = kindOf(e.toolName);
      if (out.length < 40) {
        /* 有文件路径字段就用它取文件名 —— 标题常被上游截成 "a/b/useStrea… — 675 lines read" */
        const path = (e as { targetPath?: string }).targetPath || e.filePath || (e as { editFilePath?: string }).editFilePath;
        const base = path ? path.split(/[\\/]/).filter(Boolean).pop() : '';
        const tail = (e.title || '').includes(' — ') ? (e.title || '').split(' — ').pop() : '';
        const verb = VERB[kind][isZh ? 0 : 1];
        out.push({
          id: e.id,
          title: base
            ? [verb, base].filter(Boolean).join(' ') + (tail ? ` · ${tail}` : '')
            : shortTitle(e.title || e.toolName || '', kind, isZh),
          kind,
          state: failed ? 'failed' : e.pending ? 'running' : 'done',
        });
      }
    }
    return { steps: out.reverse(), turnStart: start };
  }, [events, isZh]);

  const close = useCallback(() => setOpen(false), []);
  useExclusivePopover('clay-island', open, close);
  useEffect(() => {
    if (!open) return;
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.left + r.width / 2, y: r.bottom + 8 });
    const onDown = (e: MouseEvent) => {
      const el = e.target as Node;
      if (!wrapRef.current?.contains(el) && !panelRef.current?.contains(el)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!rt) return null;

  const since = turnStart ?? startedAt;
  const elapsed = since && streaming ? fmtClock(now - since) : '';
  const running = steps.find((s) => s.state === 'running');
  const doneCount = steps.filter((s) => s.state === 'done').length;
  /* 还在跑就永远留一格没走完 —— 步骤是边跑边出现的, 总数不知道 */
  const pct = steps.length ? Math.round((doneCount / (steps.length + (streaming ? 1 : 0))) * 100) : 0;

  /* 阶段拆细 (agentPhase.ts): 连接中 / 规划中 / 思考中 / 执行某步 / 回复中 / 整理上下文 / 重试 / 子任务 / 等你 */
  const { phase, detail } = derivePhase({
    streaming, approval: !!approval, error: !!error, justDone, status: rt.status, events,
  });
  const TONE: Partial<Record<AgentPhase, 'idle' | 'busy' | 'wait' | 'error' | 'done'>> = {
    idle: 'idle', approval: 'wait', asking: 'wait', slow: 'wait', retrying: 'wait', failover: 'wait', error: 'error', done: 'done',
  };
  const GLYPH: Partial<Record<AgentPhase, string>> = {
    idle: 'idle', approval: 'hand', asking: 'ask', error: 'warn', done: 'check',
    planning: 'plan', writing: 'write', delegating: 'agent', compacting: 'compact', slow: 'clock', retrying: 'retry', failover: 'retry',
  };
  const tone = TONE[phase] ?? 'busy';
  let glyph = GLYPH[phase] ?? 'spin';
  let label = phaseLabel(phase, isZh, detail);
  /* 普通工具: 岛上直接写这一步 (「读取 a.ts」), 比「执行中」有用 */
  if (phase === 'tool' && running) { glyph = running.kind === 'other' ? 'spin' : running.kind; label = running.title; }

  const meta = tone === 'busy'
    ? [steps.length ? `${doneCount + (running ? 1 : 0)}/${steps.length}` : '', elapsed].filter(Boolean).join(' · ')
    : '';

  const onCapsule = () => {
    if (approval) {
      document.querySelector('.atl-approval, [data-approval-card]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (steps.length || streaming) setOpen((v) => !v);
  };
  const focusComposer = () => {
    setOpen(false);
    (document.querySelector('.atl-composer__input') as HTMLTextAreaElement | null)?.focus();
  };

  return (
    <div ref={wrapRef} className="clay-island" data-tone={tone}>
      <button
        type="button"
        className="clay-island__capsule"
        onClick={onCapsule}
        aria-expanded={open}
        title={error && tone === 'error' ? error.message : label}
      >
        <span className="clay-island__glyph"><Glyph name={glyph} /></span>
        <span className="clay-island__label">{label}</span>
        {meta && <span className="clay-island__meta">{meta}</span>}
        {tone === 'busy' && steps.length > 0 && (
          <span className="clay-island__bar" style={{ ['--p' as string]: `${pct}%` }} aria-hidden="true" />
        )}
      </button>

      {open && anchor && createPortal(
        <div
          ref={panelRef}
          className="clay-island__panel"
          style={{ left: anchor.x, top: anchor.y }}
          role="dialog"
          aria-label={t('这一轮在做什么', 'Current run')}
        >
          <div className="clay-island__head">
            <span className="clay-island__title">{rt.activeSession?.name || t('当前任务', 'Current task')}</span>
            <span className="clay-island__time">{elapsed}</span>
          </div>
          <div className="clay-island__progress" style={{ ['--p' as string]: `${pct}%` }} />
          <ol className="clay-island__steps">
            {steps.length === 0 && <li className="clay-island__step is-pending">{t('还没有动作 · 正在思考', 'No actions yet · thinking')}</li>}
            {steps.map((s) => (
              <li key={s.id} className={`clay-island__step is-${s.state}`}>
                <span className="clay-island__step-glyph">
                  {s.state === 'running' ? <span className="clay-island__halo" /> : <Glyph name={s.state === 'failed' ? 'warn' : 'check'} />}
                </span>
                <span className="clay-island__step-kind"><Glyph name={s.kind === 'other' ? 'dot' : s.kind} /></span>
                <span className="clay-island__step-title">{s.title}</span>
                {s.state === 'running' && <span className="clay-island__step-ms">{t('进行中', 'running')}</span>}
              </li>
            ))}
          </ol>
          <div className="clay-island__foot">
            {streaming && (
              <button type="button" className="clay-island__act" onClick={() => { setOpen(false); void rt.interruptCurrent(); }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9" /></svg>
                {t('暂停', 'Pause')}
              </button>
            )}
            <button type="button" className="clay-island__act" onClick={focusComposer}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h10v6H7l-3 2.5v-2.5H3z" /></svg>
              {t('补一句', 'Add a note')}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ClayIsland;
