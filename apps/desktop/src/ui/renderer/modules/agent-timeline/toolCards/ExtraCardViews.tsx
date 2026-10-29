/**
 * 10-21 补齐的工具卡画法 (数据见 extraParsers.ts)。跟 ToolCardView 同一套语言:
 * 暖白底 · 细边 · 圆角 12 · 底栏灰字; 颜色只用来说状态 (加行绿 / 删行红 / 用量快满变橙)。
 */
import React from 'react';
import type { ToolCard } from './toolCardTypes';
import './extra-cards.css';

type C<K extends ToolCard['kind']> = Extract<ToolCard, { kind: K }>;
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const fmtK = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : String(n));

const Commit: React.FC<{ card: C<'commit'>; zh: boolean }> = ({ card, zh }) => (
  <div className="nx-tc nx-xc-commit">
    <div className="nx-xc-commit__row">
      <svg className="nx-xc-commit__ic" viewBox="0 0 20 20" aria-hidden><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M2 10h4.4M13.6 10H18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      <span className="nx-xc-commit__msg">{card.message}</span>
      {card.hash && <code className="nx-xc-commit__hash">{card.hash}</code>}
    </div>
    <div className="nx-tc__foot">
      <span className="nx-tc__foot-tx">
        {card.branch && <span className="nx-xc-branch">{card.branch}</span>}
        {card.files ? (zh ? ` ${card.files} 个文件` : ` ${card.files} files`) : ''}
        {card.insertions ? <span className="nx-xc-add"> +{card.insertions}</span> : null}
        {card.deletions ? <span className="nx-xc-del"> −{card.deletions}</span> : null}
      </span>
    </div>
  </div>
);

const Branch: React.FC<{ card: C<'branch'>; zh: boolean }> = ({ card, zh }) => (
  <div className="nx-tc-line">
    <span className="nx-xc-branch">{card.name}</span>
    <span>{card.checkout ? (zh ? '新建并切过去了' : 'created and checked out') : (zh ? '新建分支' : 'branch created')}</span>
  </div>
);

const Blame: React.FC<{ card: C<'blame'>; zh: boolean }> = ({ card, zh }) => {
  const authors = new Set(card.rows.map((r) => r.author)).size;
  return (
    <div className="nx-tc nx-xc-blame">
      {card.rows.slice(0, 12).map((r, i) => {
        const same = i > 0 && card.rows[i - 1]!.hash === r.hash;
        return (
          <div key={r.line} className={`nx-xc-blame__row${same ? ' is-cont' : ''}`}>
            <span className="nx-xc-blame__who">{same ? '' : /^0+$/.test(r.hash) || r.author === 'Not Committed Yet'
              ? (zh ? '还没提交' : 'Uncommitted') : `${r.author} · ${r.date.slice(5)}`}</span>
            <span className="nx-xc-blame__ln">{r.line}</span>
            <code className="nx-xc-blame__code">{r.code}</code>
          </div>
        );
      })}
      <div className="nx-tc__foot"><span className="nx-tc__foot-tx">
        {base(card.file)} · {zh ? `${card.rows.length} 行 · ${authors} 个人改过` : `${card.rows.length} lines · ${authors} authors`}
      </span></div>
    </div>
  );
};

const Monitor: React.FC<{ card: C<'monitor'>; zh: boolean }> = ({ card, zh }) => (
  <div className="nx-tc-line nx-xc-mon">
    {card.op !== 'stop' && <span className="nx-xc-mon__dot" aria-hidden />}
    {card.op === 'start' && <><span>{zh ? '盯着' : 'Watching'}</span><span className="mono">{card.watching}</span><span>{zh ? '有动静再叫我' : "I'll be woken when it fires"}</span></>}
    {card.op === 'stop' && <span>{zh ? '不盯了' : 'Stopped watching'}</span>}
    {card.op === 'list' && (card.items?.length
      ? card.items.map((m, i) => <span key={i} className="mono">{m.watching}{m.fires ? ` (${m.fires})` : ''}</span>)
      : <span>{zh ? '没有在盯的' : 'Nothing watched'}</span>)}
  </div>
);

const Context: React.FC<{ card: C<'context'>; zh: boolean }> = ({ card, zh }) => {
  const warn = card.pct >= 70;
  const mark = card.compactAt && card.budget ? Math.round((card.compactAt / card.budget) * 100) : undefined;
  return (
    <div className="nx-tc nx-xc-ctx">
      <div className="nx-xc-ctx__bar">
        <span className={`nx-xc-ctx__fill${warn ? ' is-warn' : ''}`} style={{ width: `${card.pct}%` }} />
        {mark !== undefined && mark < 100 && <span className="nx-xc-ctx__mark" style={{ left: `${mark}%` }} title={zh ? '到这里会自动压缩' : 'auto-compact here'} />}
      </div>
      <div className="nx-tc__foot"><span className="nx-tc__foot-tx">
        {zh ? `上下文用了 ${card.pct}%` : `Context ${card.pct}% used`}
        {card.used && card.budget ? ` · ${fmtK(card.used)} / ${fmtK(card.budget)}` : ''}
        {mark !== undefined ? (zh ? ` · ${mark}% 时自动压缩` : ` · auto-compact at ${mark}%`) : ''}
      </span></div>
    </div>
  );
};

export function renderExtraCard(card: ToolCard, zh: boolean): React.ReactNode | undefined {
  switch (card.kind) {
    case 'commit': return <Commit card={card} zh={zh} />;
    case 'branch': return <Branch card={card} zh={zh} />;
    case 'blame': return <Blame card={card} zh={zh} />;
    case 'monitor': return <Monitor card={card} zh={zh} />;
    case 'context': return <Context card={card} zh={zh} />;
    default: return undefined;
  }
}
