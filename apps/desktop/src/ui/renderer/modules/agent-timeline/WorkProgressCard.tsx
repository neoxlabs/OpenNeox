/**
 * Work 进度卡 —— 数据由 workProgress.ts 推出, 这里只管画 (定稿见 workProgress.ts 顶部)。
 *
 *   live   正在跑: 一行头 (成品图 · 名字 · 用时) + 细扫光 + 实际发生的步骤, 当前那步扫光
 *   static 跑完后点开折叠行: 只列步骤, 没有头和扫光
 *
 * 性能: 只有正在跑的那一轮是 live (每秒刷一次用时, 只刷头上那几个字); 历史轮折着不渲染这张卡。
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Row } from './timelineRows';
import { buildWorkProgress, type WorkArtKind, type WorkLine } from './workProgress';
import { rowsSeenImages } from './seenImagesContent';
import { SeenImagesView } from './cells/SeenImagesView';
import thumbSlides from '../../media/clay/thumb-slides.webp';
import thumbDoc from '../../media/clay/thumb-doc.webp';
import thumbSheet from '../../media/clay/thumb-sheet.webp';
import thumbImage from '../../media/clay/thumb-image.webp';
import artSearch from '../../media/clay/set-search.webp';
import artBell from '../../media/clay/set-bell.webp';
import brandMark from '../../assets/brand/mark-ring-96.webp?inline';
import './work-progress.css';

const ART: Record<WorkArtKind, string> = {
  slides: thumbSlides, doc: thumbDoc, sheet: thumbSheet, image: thumbImage, web: artSearch, life: artBell, none: brandMark,
};
const ART_LABEL: Record<WorkArtKind, [string, string]> = {
  slides: ['演示稿', 'Slides'], doc: ['文档', 'Document'], sheet: ['表格', 'Spreadsheet'], image: ['图片', 'Image'],
  web: ['查资料', 'Research'], life: ['办事', 'Errands'], none: ['', ''],
};
/** 最多显示最近几行, 更早的收成「前面还做了 N 步」 */
const MAX_LINES = 6;
/** 卡底那排截图最多几张 —— 取最近的, 跑的过程中最新那张最有用 */
const MAX_SEEN = 6;

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 釉面小球: 绿 = 做完 · 蓝 = 正在做 (白点呼吸) · 橙 = 没成功 / 等你 */
export const WorkCheck: React.FC<{ state: 'done' | 'now' | 'warn' }> = ({ state }) => (
  <span className={`nx-wp-ck is-${state}`} aria-hidden>
    {state === 'done' && (
      <svg viewBox="0 0 12 12"><path d="M2.6 6.3 5 8.6l4.5-5" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    )}
    {state === 'now' && <i />}
    {state === 'warn' && (
      <svg viewBox="0 0 12 12"><path d="M6 3v3.6M6 8.8v.1" stroke="#fff" strokeWidth="2" strokeLinecap="round" /></svg>
    )}
  </span>
);

const AGENT_TYPE_ZH: Record<string, string> = { explore: '调研', 'general-purpose': '交给帮手', plan: '规划', research: '调研', worker: '交给帮手' };

function lineText(l: WorkLine, zh: boolean): { head: string; obj: string } {
  const verb = zh && /^[\x20-\x7e]+$/.test(l.verb) ? (AGENT_TYPE_ZH[l.verb.trim().toLowerCase()] ?? '交给帮手') : l.verb;
  const head = l.state === 'now' && !/^正在/.test(verb) ? (zh ? `正在${verb}` : verb) : verb;
  return { head, obj: l.objs.join(zh ? '、' : ', ') };
}

export const WorkProgressCard: React.FC<{
  rows: Row[];
  live: boolean;
  zh: boolean;
  ask?: string;
}> = ({ rows, live, zh, ask }) => {
  const p = useMemo(() => buildWorkProgress(rows), [rows]);
  const seen = useMemo(() => rowsSeenImages(rows), [rows]);

  /* 用时: 从这一轮第一步开始算; 第一步还没时间戳时从卡片出现算 */
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const lines = p.lines.slice();
  if (live && p.thinkingNow && !lines.some((l) => l.state === 'now')) {
    lines.push({ verb: zh ? '正在想下一步' : 'Thinking about the next step', objs: [], count: 1, state: 'now' });
  }
  const hiddenEarlier = Math.max(0, lines.length - MAX_LINES);
  const shown = hiddenEarlier ? lines.slice(-MAX_LINES) : lines;

  const extra = [
    p.thinkCount ? (zh ? `想了 ${p.thinkCount} 次` : `thought ${p.thinkCount}×`) : '',
    p.internalCount ? (zh ? `整理了 ${p.internalCount} 次数据` : `processed data ${p.internalCount}×`) : '',
  ].filter(Boolean).join(' · ');

  const [labelZh, labelEn] = ART_LABEL[p.art];
  const label = zh ? labelZh : labelEn;
  /* 有成品名: 「秋季跑步入门 · 演示稿」; 没有: 类别在前、用户那句话在后 (原来整句当标题, 把「查资料」挤成了「查…」) */
  const head = p.name || label || (zh ? '处理中' : 'Working');
  const sub = p.name ? label : (ask ?? '');

  return (
    <div className={`nx-wp${live ? ' is-live' : ' is-static'}`}>
      {live && (
        <>
          <div className="nx-wp__head">
            <img className="nx-wp__art" src={ART[p.art]} alt="" draggable={false} />
            <div className="nx-wp__title">
              {head}
              {sub && <span> · {sub}</span>}
            </div>
            <div className="nx-wp__time">{clock(now - (p.startedAtMs ?? mountedAt))}</div>
          </div>
          <div className="nx-wp__sweep" aria-hidden />
        </>
      )}
      {(shown.length > 0 || hiddenEarlier > 0) && (
        <ul className="nx-wp__steps">
          {hiddenEarlier > 0 && (
            <li className="nx-wp__earlier">{zh ? `前面还做了 ${hiddenEarlier} 步` : `${hiddenEarlier} earlier steps`}</li>
          )}
          {shown.map((l, i) => {
            const { head, obj } = lineText(l, zh);
            return (
              <li key={`${i}-${l.verb}`} className={`nx-wp__step is-${l.state}`}>
                <WorkCheck state={l.state} />
                <span className={`nx-wp__tx${l.state === 'now' && live ? ' nx-wp__shim' : ''}`}>
                  {head}
                  {obj && <em> · {obj}</em>}
                </span>
                {l.count > 1 && <span className="nx-wp__n">×{l.count}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {extra && <div className="nx-wp__more">{zh ? `另外${extra}` : `Also ${extra}`}</div>}
      {seen.length > 0 && (
        <div className="nx-wp__seen">
          <SeenImagesView images={seen.slice(-MAX_SEEN)} compact />
        </div>
      )}
    </div>
  );
};

export default WorkProgressCard;
