/**
 * 工具卡怎么画 —— 设计稿「时间线 · 定版 · 全部工具」(Clay Studio, 10-15) 第 1–7 页。
 *
 * 同一套卡片语言 (跟 nx-office / Explore 卡一致): 暖白底 · 1px 细边 · 圆角 12 ·
 * 底部一行灰字说明 + 右侧文字动作。颜色只出现在要说状态的地方 (改了的格子、失败的用例、在跑的成员)。
 * Work 模式也走这些卡 —— 它们说的是"做出来的东西", 不出命令 / 路径 / JSON (MCP 卡例外, 只在 Code 出现)。
 */
import React, { useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { absoluteToAssetUrl } from '../../../../shared/assetUrlPath';
import type { ToolCard } from './toolCardTypes';
import { mcpServerLabel, mcpToolLabel } from '../mcpNames';
import { renderExtraCard } from './ExtraCardViews';
import './tool-cards.css';

type Props<K extends ToolCard['kind']> = { card: Extract<ToolCard, { kind: K }>; zh: boolean };

const base = (p: string) => p.split(/[\\/]/).pop() || p;

function openFile(path: string): void {
  void (window as any).neox?.surfaceOpenExternal?.(path)?.catch?.(() => undefined);
}
function openUrl(url: string): void {
  const neox = (window as any).neox;
  if (neox?.openExternal) neox.openExternal(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'));
  else window.open(url, '_blank', 'noopener,noreferrer');
}

const Act: React.FC<{ onClick: () => void; children: React.ReactNode; title?: string }> = ({ onClick, children, title }) => (
  <button type="button" className="nx-tc__act" title={title} onClick={(e) => { e.stopPropagation(); onClick(); }}>{children}</button>
);

const Foot: React.FC<{ children?: React.ReactNode; acts?: React.ReactNode }> = ({ children, acts }) => (
  <div className="nx-tc__foot">
    <span className="nx-tc__foot-tx">{children}</span>
    {acts && <span className="nx-tc__foot-acts">{acts}</span>}
  </div>
);

/* ── 演示稿 ─────────────────────────────────────────────── */
const Slides: React.FC<Props<'slides'>> = ({ card, zh }) => {
  const shown = card.slides.slice(0, 6);
  return (
    <div className="nx-tc nx-tc--bare">
      <div className="nx-tc-slides">
        {shown.map((s, i) => (
          <div key={i} className={`nx-tc-slide${i === 1 ? ' is-accent' : ''}`}>
            <div className="nx-tc-slide__t">{s.title}</div>
            {/chart|图表|数据/i.test(`${s.layout ?? ''}${s.title}`)
              ? <div className="nx-tc-slide__bars"><i /><i /><i /></div>
              : <div className="nx-tc-slide__lines"><i /><i /></div>}
          </div>
        ))}
        {card.slides.length > shown.length && (
          <div className="nx-tc-slide is-more">+{card.slides.length - shown.length}</div>
        )}
      </div>
      {card.file && (
        <Foot acts={<Act onClick={() => openFile(card.file!)}>{zh ? '打开' : 'Open'}</Act>}>
          {base(card.file)}{card.total ? (zh ? ` · 共 ${card.total} 页` : ` · ${card.total} slides`) : ''}
        </Foot>
      )}
    </div>
  );
};

/* ── 分享网页 ───────────────────────────────────────────── */
const Link: React.FC<Props<'link'>> = ({ card, zh }) => {
  const [copied, setCopied] = useState(false);
  const shown = card.url.replace(/^https?:\/\//, '');
  return (
    <div className="nx-tc nx-tc-link">
      <span className="nx-tc-link__ico" aria-hidden>↗</span>
      <button type="button" className="nx-tc-link__url" onClick={() => openUrl(card.url)} title={card.url}>{shown}</button>
      <span className="nx-tc__foot-acts">
        <Act onClick={() => { void navigator.clipboard?.writeText(card.url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }); }}>
          {copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制链接' : 'Copy link')}
        </Act>
        <Act onClick={() => openUrl(card.url)}>{zh ? '打开' : 'Open'}</Act>
      </span>
    </div>
  );
};

/* ── 做视频 ─────────────────────────────────────────────── */
const Video: React.FC<Props<'video'>> = ({ card }) => {
  const [playing, setPlaying] = useState(false);
  const src = absoluteToAssetUrl(card.path);
  return (
    <div className="nx-tc-video">
      {playing
        ? <video src={src} controls autoPlay className="nx-tc-video__el" />
        : (
          <button type="button" className="nx-tc-video__cover" onClick={() => setPlaying(true)} aria-label="play">
            <video src={`${src}#t=0.1`} preload="metadata" muted className="nx-tc-video__el" />
            <span className="nx-tc-video__play" aria-hidden>▶</span>
            {card.duration && <span className="nx-tc-video__dur">{card.duration}</span>}
          </button>
        )}
    </div>
  );
};

/* ── 改图: 原图 → 结果 ──────────────────────────────────── */
const ImageEdit: React.FC<Props<'image_edit'>> = ({ card }) => (
  <div className="nx-tc-imgedit">
    <img className="nx-tc-imgedit__img" src={absoluteToAssetUrl(card.before)} alt="" draggable={false} />
    <span className="nx-tc-imgedit__arrow" aria-hidden>→</span>
    {card.after.slice(0, 3).map((p) => (
      <img key={p} className="nx-tc-imgedit__img is-after" src={absoluteToAssetUrl(p)} alt="" draggable={false} onClick={() => openFile(p)} />
    ))}
  </div>
);

/* ── 团队 ───────────────────────────────────────────────── */
const Team: React.FC<Props<'team'>> = ({ card, zh }) => (
  <div className="nx-tc nx-tc-team">
    {card.members.slice(0, 6).map((m, i) => (
      <div key={i} className={`nx-tc-team__m is-${m.state}`}>
        <span className={`nx-tc-team__av av-${i % 4}`} aria-hidden>{m.name.slice(0, 1)}</span>
        <span className="nx-tc-team__body">
          <span className="nx-tc-team__name">{m.name}</span>
          {m.action && <span className="nx-tc-team__act">{m.action}</span>}
        </span>
        <span className="nx-tc-team__st" aria-label={m.state}>
          {m.state === 'done' ? '✓' : m.state === 'failed' ? (zh ? '失败' : 'failed') : <i />}
        </span>
      </div>
    ))}
  </div>
);

/* ── 日程: 日期方块 ──────────────────────────────────────── */
function dateParts(iso: string, zh: boolean): { mon: string; day: string; wk: string; time: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const wkZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]!;
  const wkEn = d.toLocaleDateString('en-US', { weekday: 'short' });
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return {
    mon: zh ? `${d.getMonth() + 1}月` : d.toLocaleDateString('en-US', { month: 'short' }),
    day: String(d.getDate()),
    wk: zh ? wkZh : wkEn,
    time: hm,
  };
}
const Calendar: React.FC<Props<'calendar'>> = ({ card, zh }) => {
  const s = dateParts(card.start, zh);
  const e = card.end ? dateParts(card.end, zh) : null;
  const sub = [
    card.allDay ? (zh ? '全天' : 'All day') : s ? `${s.time}${e ? `–${e.time}` : ''}` : card.start,
    card.location,
    card.invitees ? (zh ? `已邀请 ${card.invitees} 人` : `${card.invitees} invited`) : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className="nx-tc nx-tc-cal">
      {s && (
        <div className="nx-tc-cal__tile">
          <span className="nx-tc-cal__mon">{s.mon}</span>
          <span className="nx-tc-cal__day">{s.day}</span>
          <span className="nx-tc-cal__wk">{s.wk}</span>
        </div>
      )}
      <div className="nx-tc-cal__body">
        <div className="nx-tc-cal__title">{card.title}</div>
        <div className="nx-tc-cal__sub">{sub}</div>
      </div>
    </div>
  );
};

/* ── 发消息: 蓝气泡 ─────────────────────────────────────── */
const Message: React.FC<Props<'message'>> = ({ card }) => (
  <div className="nx-tc-msg">
    <div className="nx-tc-msg__bubble">{card.text}</div>
    {(card.at || card.status) && <div className="nx-tc-msg__meta">{[card.at, card.status].filter(Boolean).join(' · ')}</div>}
  </div>
);

/* ── 方案: 蓝边卡 ───────────────────────────────────────── */
const Plan: React.FC<Props<'plan'>> = ({ card, zh }) => {
  /* 走 composer 现成的外部填充通道 (TimelineComposer 'neox:composer-fill'): send = 照常发送 / 运行中排队插话 */
  const send = (text: string) => window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, send: true } }));
  const fill = (text: string) => window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text, replace: true } }));
  return (
    <div className="nx-tc nx-tc-plan">
      <ol className="nx-tc-plan__steps">
        {card.steps.slice(0, 12).map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      <Foot
        acts={card.awaiting ? (
          <>
            <Act onClick={() => fill(zh ? '方案改一下：' : 'Change the plan: ')}>{zh ? '改一下' : 'Revise'}</Act>
            <button type="button" className="nx-tc__primary" onClick={() => send(zh ? '按这个做' : 'Go ahead with this plan')}>
              {zh ? '按这个做 ↵' : 'Go ahead ↵'}
            </button>
          </>
        ) : undefined}
      >
        {[
          card.files ? (zh ? `会改 ${card.files} 个文件` : `${card.files} files`) : '',
          card.steps.length ? (zh ? `${card.steps.length} 步` : `${card.steps.length} steps`) : '',
        ].filter(Boolean).join(' · ')}
      </Foot>
    </div>
  );
};

/* ── 资料库命中 ─────────────────────────────────────────── */
function highlight(text: string, query: string): React.ReactNode {
  const words = query.split(/[\s,，、]+/).map((w) => w.trim()).filter((w) => w.length >= 1).slice(0, 4);
  if (words.length === 0) return text;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}
const Knowledge: React.FC<Props<'knowledge'>> = ({ card }) => (
  <div className="nx-tc nx-tc-kb">
    {card.hits.slice(0, 5).map((h, i) => (
      <div key={i} className="nx-tc-kb__hit">
        <div className="nx-tc-kb__title">{h.title}{h.where ? <span> · {h.where}</span> : null}</div>
        <div className="nx-tc-kb__snip">…{highlight(h.snippet, card.query)}…</div>
      </div>
    ))}
  </div>
);

/* ── 测试结果条 ─────────────────────────────────────────── */
const Tests: React.FC<Props<'tests'>> = ({ card, zh }) => {
  const [raw, setRaw] = useState(false);
  const total = card.passed + card.failed + (card.skipped ?? 0) || 1;
  return (
    <div className="nx-tc nx-tc-tests">
      <div className="nx-tc-tests__bar" aria-hidden>
        <i className="is-ok" style={{ width: `${(card.passed / total) * 100}%` }} />
        <i className="is-fail" style={{ width: `${(card.failed / total) * 100}%` }} />
      </div>
      <div className="nx-tc-tests__sum">
        <b className={card.failed ? 'is-fail' : 'is-ok'}>
          {card.failed ? (zh ? `${card.failed} 个失败` : `${card.failed} failed`) : (zh ? '全部通过' : 'All passed')}
        </b>
        <span>{zh ? `通过 ${card.passed}` : `${card.passed} passed`}{card.skipped ? (zh ? ` · 跳过 ${card.skipped}` : ` · ${card.skipped} skipped`) : ''}</span>
      </div>
      {card.failures.slice(0, 4).map((f, i) => (
        <div key={i} className="nx-tc-tests__fail">
          <div className="nx-tc-tests__name">✕ {f.name}</div>
          {(f.expected !== undefined || f.actual !== undefined) ? (
            <div className="nx-tc-tests__ea">
              <span>{zh ? '期望' : 'Expected'}</span><code>{f.expected}</code>
              <span>{zh ? '实际' : 'Actual'}</span><code className="is-fail">{f.actual}</code>
            </div>
          ) : f.message ? <div className="nx-tc-tests__msg">{f.message}</div> : null}
        </div>
      ))}
      {raw && card.raw && <pre className="nx-tc-py__out nx-tc-tests__raw">{card.raw}</pre>}
      {card.raw && (
        <div className="nx-tc-tests__more">
          <Act onClick={() => setRaw((v) => !v)}>{raw ? (zh ? '收起输出' : 'Hide output') : (zh ? '看输出' : 'Show output')}</Act>
        </div>
      )}
    </div>
  );
};

/* ── Git ────────────────────────────────────────────────── */
const GitStatus: React.FC<Props<'git_status'>> = ({ card, zh }) => (
  <div className="nx-tc nx-tc-list">
    {card.files.slice(0, 12).map((f, i) => (
      <div key={i} className="nx-tc-list__row">
        <span className={`nx-tc-git__st st-${f.status.trim().charAt(0) || 'M'}`}>{f.status.trim() || 'M'}</span>
        <span className="nx-tc-list__main mono">{f.path}</span>
      </div>
    ))}
    {card.files.length === 0 && <div className="nx-tc-list__row is-empty">{zh ? '工作区干净' : 'Working tree clean'}</div>}
    <Foot>
      {[card.branch, card.ahead ? `↑${card.ahead}` : '', card.behind ? `↓${card.behind}` : '',
        card.files.length > 12 ? (zh ? `还有 ${card.files.length - 12} 个` : `+${card.files.length - 12}`) : ''].filter(Boolean).join(' · ')}
    </Foot>
  </div>
);
const GitLog: React.FC<Props<'git_log'>> = ({ card }) => (
  <div className="nx-tc nx-tc-list">
    {card.items.slice(0, 8).map((c, i) => (
      <div key={i} className="nx-tc-list__row">
        <span className="nx-tc-list__tag mono">{c.hash.slice(0, 7)}</span>
        <span className="nx-tc-list__main">{c.title}</span>
        <span className="nx-tc-list__side">{[c.author, c.when].filter(Boolean).join(' · ')}</span>
      </div>
    ))}
  </div>
);

/* ── 代码智能 ───────────────────────────────────────────── */
const Refs: React.FC<Props<'refs'>> = ({ card, zh }) => (
  <div className="nx-tc nx-tc-list">
    {card.items.slice(0, 10).map((r, i) => (
      <div key={i} className="nx-tc-list__row">
        {r.tag && <span className={`nx-tc-ref__tag is-${r.tag}`}>{zh ? ({ def: '定义', call: '调用', ref: '引用' } as const)[r.tag] : r.tag}</span>}
        <span className="nx-tc-list__main mono">{base(r.file)}{r.line ? `:${r.line}` : ''}</span>
        {r.text && <span className="nx-tc-list__side mono">{r.text}</span>}
      </div>
    ))}
  </div>
);
const Diagnostics: React.FC<Props<'diagnostics'>> = ({ card }) => (
  <div className="nx-tc nx-tc-list">
    {card.items.slice(0, 10).map((d, i) => (
      <div key={i} className="nx-tc-list__row">
        <span className={`nx-tc-diag__dot is-${d.severity}`} aria-hidden />
        <span className="nx-tc-list__main">{d.message}</span>
        <span className="nx-tc-list__side mono">{base(d.file)}{d.line ? `:${d.line}` : ''}{d.rule ? ` · ${d.rule}` : ''}</span>
      </div>
    ))}
  </div>
);

/* ── 启动服务 ───────────────────────────────────────────── */
const Service: React.FC<Props<'service'>> = ({ card, zh }) => (
  <div className="nx-tc nx-tc-svc">
    <span className={`nx-tc-svc__dot is-${card.status}`} aria-hidden />
    <span className="nx-tc-svc__name">{card.name}</span>
    {card.url && <button type="button" className="nx-tc-link__url" onClick={() => openUrl(card.url!)}>{card.url.replace(/^https?:\/\//, '')}</button>}
    {card.pid && <span className="nx-tc-list__side mono">pid {card.pid}</span>}
    <span className="nx-tc__foot-acts">
      {card.url && <Act onClick={() => openUrl(card.url!)}>{zh ? '打开' : 'Open'}</Act>}
      {/* 同 BackgroundTasksBar.openServicesSurface: 右栏服务面板, 选中这个 pid */}
      <Act onClick={() => window.dispatchEvent(new CustomEvent('neox:open-surface', {
        detail: {
          kind: 'services', source: { type: 'inline', content: '' }, title: zh ? '服务' : 'Services', pinned: true,
          metadata: typeof card.pid === 'number' ? { selectedPid: card.pid } : undefined, byUser: true,
        },
      }))}>{zh ? '日志' : 'Logs'}</Act>
    </span>
  </div>
);

/* ── 执行 Python ────────────────────────────────────────── */
const Python: React.FC<Props<'python'>> = ({ card }) => (
  <div className="nx-tc nx-tc-py">
    <pre className="nx-tc-py__code">{card.code.split('\n').slice(0, 14).join('\n')}</pre>
    {card.stdout && <pre className="nx-tc-py__out">{card.stdout.split('\n').slice(0, 16).join('\n')}</pre>}
    {card.images?.slice(0, 2).map((p) => <img key={p} className="nx-tc-py__img" src={absoluteToAssetUrl(p)} alt="" />)}
  </div>
);

/* ── 找工具 / MCP ───────────────────────────────────────── */
const ToolSearch: React.FC<Props<'tool_search'>> = ({ card }) => (
  <div className="nx-tc-chips">{card.tools.slice(0, 20).map((t) => <span key={t} className="nx-tc-chip">{t}</span>)}</div>
);
const Mcp: React.FC<Props<'mcp'>> = ({ card, zh }) => {
  const [raw, setRaw] = useState(false);
  const [full, setFull] = useState(false);
  const rows = (kv: Array<{ k: string; v: string }>) => kv.slice(0, 10).map((r) => (
    <div key={r.k} className="nx-tc-kv__row"><span className="nx-tc-kv__k">{r.k}</span><span className="nx-tc-kv__v">{r.v}</span></div>
  ));
  const lines = card.text ? card.text.split('\n') : [];
  const long = lines.length > 8 || (card.text?.length ?? 0) > 600;
  return (
    <div className="nx-tc nx-tc-kv">
      {card.params.length > 0 && <><div className="nx-tc-kv__h">{zh ? '参数' : 'Params'}</div>{rows(card.params)}</>}
      {card.result.length > 0 && <><div className="nx-tc-kv__h">{zh ? '结果' : 'Result'}</div>{rows(card.result)}</>}
      {card.text && (
        <>
          <div className="nx-tc-kv__h">{zh ? '结果' : 'Result'}</div>
          <div className={`nx-tc-mcp__text${long && !full ? ' is-clipped' : ''}`}>{card.text}</div>
        </>
      )}
      {raw && card.raw && <pre className="nx-tc-py__out">{card.raw.slice(0, 4000)}</pre>}
      <Foot acts={<>
        {long && <Act onClick={() => setFull((v) => !v)}>{full ? (zh ? '收起' : 'Less') : (zh ? '展开全部' : 'Show all')}</Act>}
        {card.raw && <Act onClick={() => setRaw((v) => !v)}>{raw ? (zh ? '收起原始数据' : 'Hide raw') : (zh ? '原始数据' : 'Raw data')}</Act>}
      </>}>{card.server ? `${mcpServerLabel(card.server, zh)} · ${mcpToolLabel(card.tool, zh)}` : ''}</Foot>
    </div>
  );
};

/* ── 只占一行的卡 (读文档 / 记忆 / 定时 / 发给队友 / 路线摘要) ── */
const Line: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="nx-tc-line">{children}</div>;

export const ToolCardView: React.FC<{ card: ToolCard }> = ({ card }) => {
  const { isZh: zh } = useI18n();
  switch (card.kind) {
    case 'slides': return <Slides card={card} zh={zh} />;
    case 'link': return <Link card={card} zh={zh} />;
    case 'video': return <Video card={card} zh={zh} />;
    case 'image_edit': return <ImageEdit card={card} zh={zh} />;
    case 'team': return <Team card={card} zh={zh} />;
    case 'calendar': return <Calendar card={card} zh={zh} />;
    case 'message': return <Message card={card} zh={zh} />;
    case 'plan': return <Plan card={card} zh={zh} />;
    case 'knowledge': return <Knowledge card={card} zh={zh} />;
    case 'tests': return <Tests card={card} zh={zh} />;
    case 'git_status': return <GitStatus card={card} zh={zh} />;
    case 'git_log': return <GitLog card={card} zh={zh} />;
    case 'refs': return <Refs card={card} zh={zh} />;
    case 'diagnostics': return <Diagnostics card={card} zh={zh} />;
    case 'service': return <Service card={card} zh={zh} />;
    case 'python': return <Python card={card} zh={zh} />;
    case 'tool_search': return <ToolSearch card={card} zh={zh} />;
    case 'mcp': return <Mcp card={card} zh={zh} />;
    case 'read_doc':
      return (
        <Line>
          <span className="mono">{base(card.file)}</span>
          {card.pages && <span>{zh ? `读了 ${card.pages} 页` : `pages ${card.pages}`}{card.totalPages ? (zh ? ` · 共 ${card.totalPages} 页` : ` of ${card.totalPages}`) : ''}</span>}
          {card.sheet && <span className="mono">{card.sheet}</span>}
          {card.rows !== undefined && card.cols !== undefined && <span>{zh ? `${card.cols} 列 × ${card.rows} 行` : `${card.cols} cols × ${card.rows} rows`}</span>}
          {card.chars !== undefined && !card.pages && card.rows === undefined && <span>{zh ? `${card.chars} 字` : `${card.chars} chars`}</span>}
        </Line>
      );
    case 'memory':
      return (
        <Line>
          <span className="nx-tc-line__q">“{card.text}”</span>
          {card.op === 'recall' && card.count !== undefined && <span>{zh ? `${card.count} 条相关` : `${card.count} related`}</span>}
          {card.scope && <span>{card.scope}</span>}
        </Line>
      );
    case 'schedule':
      return <Line><span className="mono">{card.when}</span><span>{card.what}</span>{card.next && <span>{zh ? `下次: ${card.next}` : `next: ${card.next}`}</span>}</Line>;
    case 'team_message':
      return <Line><span>{zh ? '发给' : 'To'} <b>{card.to}</b></span><span className="nx-tc-line__q">“{card.text}”</span></Line>;
    case 'route':
      return (
        <div className="nx-tc nx-tc-route">
          <svg className="nx-tc-route__map" viewBox="0 0 120 56" aria-hidden>
            <path d="M8 46 C 40 46, 46 14, 76 16 S 104 10, 112 8" fill="none" stroke="#4f84ff" strokeWidth="2.4" strokeLinecap="round" />
            <circle cx="8" cy="46" r="3.6" fill="#3f9a6a" /><circle cx="112" cy="8" r="3.6" fill="#d4543f" />
          </svg>
          <div className="nx-tc-cal__body">
            <div className="nx-tc-cal__title">{[card.minutes ? (zh ? `${card.minutes} 分钟` : `${card.minutes} min`) : '', card.summary].filter(Boolean).join(' · ')}</div>
            <div className="nx-tc-cal__sub">{card.detail ?? [card.from, card.to].filter(Boolean).join(' → ')}</div>
          </div>
        </div>
      );
    default:
      return renderExtraCard(card, zh) ?? null;
  }
};

export default ToolCardView;
