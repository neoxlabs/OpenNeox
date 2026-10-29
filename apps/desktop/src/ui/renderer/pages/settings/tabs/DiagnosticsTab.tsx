import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { PageTitle } from '../../../components/settings-base';
import { dispatchOpFailedFromError } from '../../../components/notifyEvents';
import './DiagnosticsTab.css';
import './DiagnosticsTab.clay.css';

type Kind = 'main' | 'sub' | 'side' | 'jev';
type BreakCode = 'system' | 'tools' | 'history' | 'expired' | 'upstream';
interface Summary {
  since: number;
  agent: { count: number; input: number; cacheRead: number };
  kinds: Record<Kind, { count: number; fails: number; avgMs: number | null }>;
  sideCalls: Array<{ kind: Kind; label: string; count: number; fails: number; avgMs: number | null; lastError?: string }>;
  breakCounts: Partial<Record<BreakCode, number>>;
  breaks: Array<{ t: number; label: string; model?: string; code: BreakCode; lost: number; detail?: string }>;
}

const REASON: Record<BreakCode, [string, string]> = {
  system: ['系统提示变了', 'System prompt changed'],
  tools: ['工具表变了 (解锁或淘汰了工具)', 'Tool list changed (a tool was unlocked or dropped)'],
  history: ['历史被改写 (压缩、回滚或改了早先的消息)', 'History rewritten (compaction, rollback or an earlier message changed)'],
  expired: ['隔太久没请求, 上游缓存过期', 'Idle too long — the provider cache expired'],
  upstream: ['前缀没变, 上游这次没命中', 'Prefix unchanged — the provider missed this time'],
};

const LABEL: Record<string, [string, string]> = {
  'session-title': ['会话标题', 'Session title'],
  'tool-summary': ['工具摘要', 'Tool summary'],
  on_track: ['跑偏检查', 'Drift check'],
  'announced,hold': ['收尾判定', 'Turn-end check'],
};

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
function fmtMs(ms: number | null): string {
  return ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function DiagnosticsTab(): React.ReactElement {
  const { isZh } = useI18n();
  const [hours, setHours] = React.useState(24);
  const [data, setData] = React.useState<Summary | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [crashReport, setCrashReport] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    Promise.resolve((window as any).neox?.getCrashReportPreference?.())
      .then((v: boolean | undefined) => { if (typeof v === 'boolean') setCrashReport(v); })
      .catch(() => { /* 读不到就保持未初始化 */ });
  }, []);

  const toggleCrashReport = async (enabled: boolean) => {
    setCrashReport(enabled);
    try {
      await (window as any).neox?.setCrashReportPreference?.(enabled);
    } catch (e) {
      setCrashReport(!enabled);
      dispatchOpFailedFromError(isZh ? '保存崩溃报告设置' : 'Save crash report setting', e);
    }
  };

  const load = React.useCallback(() => {
    setFailed(false);
    Promise.resolve((window as any).neox?.diagnosticsSummary?.(hours))
      .then((s: Summary | undefined) => { if (s) setData(s); else setFailed(true); })
      .catch(() => setFailed(true));
  }, [hours]);
  React.useEffect(() => { load(); }, [load]);

  const L = (pair: [string, string]) => (isZh ? pair[0] : pair[1]);
  const labelOf = (kind: Kind, label: string) => {
    if (LABEL[label]) return L(LABEL[label]);
    if (/^pack ×\d+$/.test(label)) return isZh ? '工具包预选' : 'Tool pack pre-selection';
    return kind === 'jev' ? `Jev · ${label}` : label;
  };
  const hit = data && data.agent.input > 0 ? Math.round((data.agent.cacheRead / data.agent.input) * 100) : null;
  const sideTotal = data ? data.kinds.side.count + data.kinds.jev.count : 0;
  const sideFails = data ? data.kinds.side.fails + data.kinds.jev.fails : 0;
  const breakTotal = data ? Object.values(data.breakCounts).reduce((a, b) => a + (b ?? 0), 0) : 0;

  return (
    <div className="diag-tab dg3">
      <PageTitle
        title={isZh ? '诊断' : 'Diagnostics'}
        subtitle={isZh ? '每次请求花了多少、缓存有没有命中、哪里出错' : 'How much each request cost, whether the cache hit, and where it failed'}
      />
      <p className="dg3-note">{isZh
        ? '缓存命中、缓存为什么掉了, 以及标题、摘要、Jev 这些侧路调用的次数和失败。'
        : 'Cache hits, why the cache dropped, and side calls like titles, summaries and Jev checks.'}</p>

      <section className="dg3-group">
        <h4 className="dg3-group__title">{isZh ? '隐私' : 'Privacy'}</h4>
        <div className="dg3-card">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={crashReport !== false}
              disabled={crashReport === null}
              onChange={(e) => toggleCrashReport(e.target.checked)}
            />
            <span>{isZh ? '发送崩溃报告' : 'Send crash reports'}</span>
          </label>
          <p className="dg3-note" style={{ margin: '6px 0 0' }}>{isZh
            ? '崩溃时把错误信息和调用栈发给我们, 帮我们定位问题。不含对话内容、文件内容或密钥。'
            : 'Send error messages and stack traces when the app crashes. No conversation content, file contents or keys are included.'}</p>
        </div>
      </section>

      <div className="diag-bar">
        <div className="usg-range" role="group" aria-label={isZh ? '时间范围' : 'Range'}>
          {[24, 24 * 7].map((h) => (
            <button key={h} type="button" className={`usg-range__btn${hours === h ? ' is-active' : ''}`} onClick={() => setHours(h)}>
              {h === 24 ? (isZh ? '24 小时' : '24 hours') : (isZh ? '7 天' : '7 days')}
            </button>
          ))}
        </div>
        <button type="button" className="diag-refresh" onClick={load}>{isZh ? '刷新' : 'Refresh'}</button>
      </div>

      {failed ? (
        <p className="diag-empty">{isZh ? '读不到诊断记录。' : 'Could not read the diagnostics log.'}</p>
      ) : !data ? (
        <p className="diag-empty neox-text-shimmer">{isZh ? '读取中…' : 'Loading…'}</p>
      ) : data.agent.count + sideTotal === 0 ? (
        <p className="diag-empty">{isZh ? '这段时间还没有请求。发一句话再来看。' : 'No requests in this range yet.'}</p>
      ) : (
        <>
          <div className="diag-stats">
            <div className="diag-stat">
              <span className="diag-stat__val">{data.agent.count}</span>
              <span className="diag-stat__lbl">{isZh ? 'Agent 请求' : 'Agent requests'}</span>
              <span className="diag-stat__sub">{isZh ? `其中子 Agent ${data.kinds.sub.count}` : `${data.kinds.sub.count} from sub-agents`}</span>
            </div>
            <div className="diag-stat">
              <span className="diag-stat__val">{hit === null ? '—' : `${hit}%`}</span>
              <span className="diag-stat__lbl">{isZh ? '缓存命中' : 'Cache hit'}</span>
              <span className="diag-stat__sub">{`${fmtTokens(data.agent.cacheRead)} / ${fmtTokens(data.agent.input)}`}</span>
            </div>
            <div className="diag-stat">
              <span className="diag-stat__val">{breakTotal}</span>
              <span className="diag-stat__lbl">{isZh ? '缓存失效' : 'Cache drops'}</span>
              <span className="diag-stat__sub">{isZh ? '命中明显下跌的次数' : 'Times the hit rate fell sharply'}</span>
            </div>
            <div className={`diag-stat${sideFails ? ' is-warn' : ''}`}>
              <span className="diag-stat__val">{sideTotal}</span>
              <span className="diag-stat__lbl">{isZh ? '侧路调用' : 'Side calls'}</span>
              <span className="diag-stat__sub">{sideFails ? (isZh ? `失败 ${sideFails}` : `${sideFails} failed`) : (isZh ? '全部成功' : 'All succeeded')}</span>
            </div>
          </div>

          <section className="dg3-group">
            <h4 className="dg3-group__title">{isZh ? '缓存为什么掉了' : 'Why the cache dropped'}</h4>
            <div className="dg3-card">
            {breakTotal === 0 ? (
              <p className="diag-empty">{isZh ? '这段时间缓存没有明显下跌。' : 'No sharp cache drops in this range.'}</p>
            ) : (
              <>
                <div className="diag-reasons">
                  {(Object.keys(REASON) as BreakCode[]).filter((c) => data.breakCounts[c]).map((c) => (
                    <div key={c} className="diag-reason" data-code={c}>
                      <b>{data.breakCounts[c]}</b><span>{L(REASON[c])}</span>
                    </div>
                  ))}
                </div>
                <div className="dg3-thead" aria-hidden="true">
                  <span>{isZh ? '时间' : 'Time'}</span>
                  <span>{isZh ? '事件' : 'Event'}</span>
                  <span>{isZh ? '模型' : 'Model'}</span>
                  <span>token</span>
                </div>
                <ul className="diag-list">
                  {data.breaks.map((b, i) => (
                    <li key={`${b.t}-${i}`} className="diag-row" title={b.detail ? `${L(REASON[b.code])}: ${b.detail}` : L(REASON[b.code])}>
                      <span className="diag-row__time">{new Date(b.t).toLocaleString(isZh ? 'zh-CN' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="diag-row__main">{L(REASON[b.code])}{b.detail ? <code>{b.detail}</code> : null}</span>
                      <span className="diag-row__meta">{b.model ?? b.label}</span>
                      <span className="diag-row__num">-{fmtTokens(b.lost)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            </div>
          </section>

          <section className="dg3-group">
            <h4 className="dg3-group__title">{isZh ? '侧路调用' : 'Side calls'}</h4>
            <div className="dg3-card">
            {data.sideCalls.length === 0 ? (
              <p className="diag-empty">{isZh ? '这段时间没有侧路调用。' : 'No side calls in this range.'}</p>
            ) : (
              <ul className="diag-list">
                {data.sideCalls.map((s) => (
                  <li key={`${s.kind}:${s.label}`} className={`diag-row is-compact${s.fails ? ' is-warn' : ''}`} title={s.lastError ?? undefined}>
                    <span className="diag-row__main">{labelOf(s.kind, s.label)}</span>
                    <span className="diag-row__meta">{isZh ? `${s.count} 次 · 平均 ${fmtMs(s.avgMs)}` : `${s.count}× · avg ${fmtMs(s.avgMs)}`}</span>
                    <span className="diag-row__num">{s.fails ? (isZh ? `失败 ${s.fails}` : `${s.fails} failed`) : '✓'}</span>
                  </li>
                ))}
              </ul>
            )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
