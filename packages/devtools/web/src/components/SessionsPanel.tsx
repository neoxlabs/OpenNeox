import { useState } from 'react';
import type { AgentNode, PathNode, PlanStep, SessionMonitor } from '../types';
import type { HistoryBundle, EffKey } from '../history';
import { Sparkline } from './Sparkline';
import { ago, fmtMs, fmtNum, fmtPct, rateColor } from '../util';

function State({ s }: { s: string }) {
  return <span className={`state s-${s}`}><span className="dot" />{s.replace('_', ' ')}</span>;
}

const EFF_ROWS: Array<{ key: EffKey; label: string; fmt: (v: number) => string; rate?: boolean; max?: number }> = [
  { key: 'totalTokens', label: 'Tokens', fmt: fmtNum },
  { key: 'cacheHitRate', label: 'Cache Hit %', fmt: fmtPct, rate: true, max: 1 },
  { key: 'toolSuccessRate', label: 'Tool Success %', fmt: fmtPct, rate: true, max: 1 },
  { key: 'avgIterationMs', label: 'Avg Iteration time', fmt: fmtMs },
  { key: 'thinkRatio', label: 'Think Ratio %', fmt: fmtPct, max: 1 },
  { key: 'repeatToolCalls', label: 'Repeat Calls', fmt: (v) => String(Math.round(v)) },
  { key: 'compactions', label: 'Compactions', fmt: (v) => String(Math.round(v)) },
  { key: 'toolFailure', label: 'Tool failures', fmt: (v) => String(Math.round(v)) },
];

function Efficiency({ s, history }: { s: SessionMonitor; history: HistoryBundle }) {
  const series = history.effFor(s.sessionId);
  return (
    <div className="eff">
      <div className="eff-row" style={{ color: 'var(--text-3)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.5px' }}>
        <span>Metric</span><span className="ev" style={{ fontWeight: 600 }}>Value</span><span>Trend</span>
      </div>
      {EFF_ROWS.map((r) => {
        const v = (s.efficiency as any)[r.key] as number;
        const color = r.rate ? rateColor(v) : 'var(--accent)';
        return (
          <div className="eff-row" key={r.key}>
            <span className="em">{r.label}</span>
            <span className="ev" style={r.rate ? { color } : undefined}>{r.fmt(v)}</span>
            <span className="et"><Sparkline data={series[r.key]} color={color} max={r.max} width={56} height={18} fill={false} /></span>
          </div>
        );
      })}
    </div>
  );
}

function Agent({ a }: { a: AgentNode }) {
  return (
    <div className="agent">
      <span className="br">{a.kind === 'main' ? '●' : a.kind === 'background' ? '◐' : '└'}</span>
      <span className="aid">{a.id}</span>
      <span className={`ktag ${a.kind}`}>{a.kind}</span>
      <span style={{ display: 'flex', gap: 10, alignItems: 'center', overflow: 'hidden' }}>
        <State s={a.state} />
        {a.currentTool && <span className="tool">{a.currentTool}</span>}
      </span>
      <span className="am">{a.currentTool && a.toolElapsedMs ? fmtMs(a.toolElapsedMs) : `tc ${a.toolCalls}`}</span>
    </div>
  );
}

function Plan({ plan }: { plan: PlanStep[] }) {
  if (!plan.length) return <div className="empty" style={{ padding: '4px 0' }}>no plan declared</div>;
  const done = plan.filter((p) => p.status === 'completed').length;
  return (
    <>
      <div className="plan-top"><span>{done} / {plan.length} steps</span><span>{Math.round((done / plan.length) * 100)}%</span></div>
      <div className="plan-bar"><i style={{ width: `${(done / plan.length) * 100}%` }} /></div>
      {plan.map((p, i) => (
        <div key={i} className={`plan-item ${p.status === 'completed' ? 'done' : p.status === 'in_progress' ? 'active' : ''}`}>
          <span className="mk">{p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '▸' : '○'}</span>
          <span className="step">{p.step}</span>
        </div>
      ))}
    </>
  );
}

function ExecPath({ path }: { path: PathNode[] }) {
  const tail = path.slice(-24);
  return (
    <div className="exec">
      <div className="sect-h sm" style={{ padding: '0 0 10px' }}>Execution Path <span className="badge" style={{ background: 'transparent', color: 'var(--text-3)' }}>{path.length} steps</span></div>
      {tail.length === 0 ? <div className="empty" style={{ padding: 0 }}>no path yet</div> : (
        <div className="path">
          {tail.map((n, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {i > 0 && <span className="parrow">▸</span>}
              <span className={`pn ${n.kind} ${n.ok === false ? 'bad' : ''}`} title={n.detail || ''}>{n.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({ s, history }: { s: SessionMonitor; history: HistoryBundle }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="trow click cols-sess" onClick={() => setOpen((o) => !o)}>
        <State s={s.state} />
        <span className="sess-id">{s.sessionId}</span>
        <span className="r-num mono">{ago(s.startedAt)}</span>
        <span className="r-num tnum">{s.iteration}</span>
        <span className="r-num tnum">{s.toolCalls}</span>
        <span className="r-num mono">{s.ctxMax ? `${fmtNum(s.ctxUsed)} / ${fmtNum(s.ctxMax)}` : '—'}</span>
        <span className={`chev ${open ? 'open' : ''}`}>›</span>
      </div>
      {open && (
        <>
          <div className="detail">
            <div><div className="dh">Efficiency</div><Efficiency s={s} history={history} /></div>
            <div><div className="dh">Agents <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>({s.agents.length})</span></div>{s.agents.map((a) => <Agent key={a.id} a={a} />)}</div>
            <div><div className="dh">Plan</div><Plan plan={s.plan} /></div>
          </div>
          <ExecPath path={s.path} />
          {s.lastError && <div style={{ padding: `0 var(--pad) 16px`, color: 'var(--red)', fontSize: 12 }}>! {s.lastError}</div>}
        </>
      )}
    </>
  );
}

export function SessionsPanel({ sessions, history }: { sessions: SessionMonitor[]; history: HistoryBundle }) {
  return (
    <div className="col-main">
      <div className="sect-h">Sessions <span className="badge">{sessions.length} active</span></div>
      <div className="thead cols-sess">
        <span>Status</span><span>Session ID</span><span className="r-num">Elapsed</span>
        <span className="r-num">Iters</span><span className="r-num">Tools</span><span className="r-num">Context</span><span />
      </div>
      {sessions.length === 0 && <div className="empty">暂无活跃 session — 在 Neox 里发起一次对话即可看到实时拓扑。</div>}
      {sessions.map((s) => <SessionRow key={s.sessionId} s={s} history={history} />)}
    </div>
  );
}
