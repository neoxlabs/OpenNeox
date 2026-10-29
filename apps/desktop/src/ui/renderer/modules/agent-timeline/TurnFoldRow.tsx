import brandMark from '../../assets/brand/mark-ring-96.webp?inline'; // 13px 显示, 原 512px PNG 每轮一行都要解码
import React, { useState, useCallback, useMemo } from 'react';
import { IconChevronDown, IconChevronRight } from '../shell/shellIcons';
import { ToolGlyph } from './components/ToolGlyph';
import { plainHiddenTally, type Row } from './timelineRows';
import { rowsSeenImages } from './seenImagesContent';
import { useAgentModeVariant } from '../../hooks/useAgentModeVariant';
import { SeenImagesView } from './cells/SeenImagesView';
import { foldDelegations } from './foldDelegations';
import './turnfold-team.css';
import { ProviderBrandIcon, inferProviderBrand } from './ProviderBrandIcon';
import { WorkProgressCard, WorkCheck } from './WorkProgressCard';
import { buildWorkProgress } from './workProgress';

/** 折叠头下面最多摆几张 —— 再多就是 +N, 点一下展开 */
const SEEN_STRIP_MAX = 6;

interface TurnFoldRowProps {
  fold: Extract<Row, { kind: 'turn_fold' }>;
  /** 展开后渲染子行 —— 由 TimelineSteps 传进来, 避免这里反向依赖渲染器 */
  renderRows: (rows: Row[]) => React.ReactNode;
  zh: boolean;
}

/** 时长: 秒 / 分秒 / 时分。拿不到就不显示, 不编。 */
function formatDuration(ms: number | undefined, zh: boolean): string | null {
  if (ms === undefined || ms < 0) return null;
  if (ms < 950) return zh ? `${Math.max(1, Math.round(ms))} 毫秒` : `${Math.max(1, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return zh ? `${s} 秒` : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return zh ? `${m} 分 ${rest} 秒` : `${m}m ${rest}s`;
  }
  const h = Math.floor(m / 60);
  return zh ? `${h} 小时 ${m % 60} 分` : `${h}h ${m % 60}m`;
}

export const TurnFoldRow: React.FC<TurnFoldRowProps> = ({ fold, renderRows, zh }) => {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded(v => !v), []);

  /* Work: 整轮藏起来的步骤在末尾合并成一行, 说清楚是什么 (不再每组各挂一行「另有 1 个中间步骤」) */
  const { isWork, isCode } = useAgentModeVariant();
  const hiddenLine = useMemo(() => {
    if (!isWork || !expanded) return null;
    const t = plainHiddenTally(fold.rows);
    const parts = [
      t.think ? (zh ? `想了 ${t.think} 次` : `thought ${t.think}×`) : '',
      t.process ? (zh ? `处理数据 ${t.process} 次` : `processed data ${t.process}×`) : '',
      t.browse ? (zh ? `翻看文件 ${t.browse} 次` : `looked through files ${t.browse}×`) : '',
    ].filter(Boolean);
    return parts.length ? `${zh ? '幕后还做了：' : 'Behind the scenes: '}${parts.join(' · ')}` : null;
  }, [isWork, expanded, fold.rows, zh]);

  const [showAll, setShowAll] = useState(false);
  const workSteps = useMemo(() => (isWork ? buildWorkProgress(fold.rows).stepCount : 0), [isWork, fold.rows]);

  const seen = useMemo(() => rowsSeenImages(fold.rows), [fold.rows]);
  const team = useMemo(() => foldDelegations(fold.rows), [fold.rows]);

  const duration = formatDuration(fold.durationMs, zh);
  const parts: string[] = [];
  if (duration) parts.push(zh ? `已工作 ${duration}` : `Worked ${duration}`);
  if (fold.opCount > 0) parts.push(zh ? `${fold.opCount} 次操作` : `${fold.opCount} ${fold.opCount === 1 ? 'op' : 'ops'}`);
  else if (fold.thinkCount > 0) parts.push(zh ? '想了一下' : 'Thought it through');
  if (parts.length === 0) parts.push(zh ? '过程' : 'Details');
  if (fold.fileCount > 0 && !isWork) {
    parts.push(zh ? `${fold.fileCount} 个文件` : `${fold.fileCount} ${fold.fileCount === 1 ? 'file' : 'files'}`);
  }
  const codeDone = isCode && !expanded;
  if (codeDone) {
    parts.length = 0;
    parts.push(zh ? '做好了' : 'Done');
    if (duration) parts.push(duration);
    if (fold.opCount > 0) parts.push(zh ? `${fold.opCount} 步` : `${fold.opCount} ${fold.opCount === 1 ? 'step' : 'steps'}`);
  } else if (isCode && fold.fileCount > 0) {
    parts[parts.length - 1] = zh ? `改了 ${fold.fileCount} 个文件` : parts[parts.length - 1];
  }
  if (isWork) {
    parts.length = 0;
    parts.push(zh ? '做好了' : 'Done');
    if (duration) parts.push(duration);
    if (workSteps > 0) parts.push(zh ? `${workSteps} 步` : `${workSteps} ${workSteps === 1 ? 'step' : 'steps'}`);
  }

  return (
    <div className={`atl-turnfold${expanded ? ' atl-turnfold--open' : ''}${codeDone ? ' is-code-done' : ''}`}>
      <button
        type="button"
        className="atl-turnfold__head"
        onClick={toggle}
        aria-expanded={expanded}
        title={zh ? '点击展开这一轮的全部过程' : 'Click to expand this turn'}
      >
        <span className="atl-turnfold__icon" aria-hidden>
          {isWork
            ? <WorkCheck state={fold.hasInterrupted || fold.hasFailure ? 'warn' : 'done'} />
            : codeDone
              ? <WorkCheck state={fold.hasInterrupted || fold.hasFailure ? 'warn' : 'done'} />
              : isCode
                ? <ToolGlyph name="group" />
                : <img className="nx-brand-vortex" src={brandMark} alt="" width={13} height={13} draggable={false} />}
        </span>
        <span className="atl-turnfold__label">
          {isCode
            ? parts.map((p, i) => (i === 0 ? <b key={i}>{p}</b> : <React.Fragment key={i}>{' · '}{p}</React.Fragment>))
            : parts.join(' · ')}
        </span>
        {/* 分工: 这一轮派了几个子 Agent、用的哪些模型、它们一共做了多少步 —— 折叠着也看得见谁干的活 */}
        {team && (
          <span
            className={`atl-turnfold__team${team.failed > 0 ? ' is-failed' : ''}`}
            title={team.models.map((m) => `${m.model} × ${m.count}`).join('\n')}
          >
            <span className="atl-turnfold__team-icons" aria-hidden>
              {team.models.slice(0, 3).map((m) => (
                <ProviderBrandIcon key={m.model} brand={inferProviderBrand({ name: m.model })} size={12} />
              ))}
            </span>
            <span className="atl-turnfold__team-text">
              {zh ? `${team.count} 个子 Agent` : `${team.count} ${team.count === 1 ? 'sub-agent' : 'sub-agents'}`}
              {team.models.length === 1 && <em>{team.models[0].model}</em>}
              {team.steps > 0 && <em>{zh ? `${team.steps} 步` : `${team.steps} steps`}</em>}
            </span>
          </span>
        )}
        {(fold.addCount > 0 || fold.delCount > 0) && (
          <span
            className="atl-turnfold__diff"
            title={zh
              ? '本轮所有编辑动作累计的增删行数（同一文件改多次会累加），不等于最终净 diff'
              : 'Total lines added/removed across every edit this turn (repeated edits to one file add up) — not the final net diff'}
          >
            {fold.addCount > 0 && <span className="atl-turnfold__add">+{fold.addCount}</span>}
            {fold.delCount > 0 && <span className="atl-turnfold__del">−{fold.delCount}</span>}
          </span>
        )}
        {/* 用户点了停止 —— 必须在折叠态就看得见, 且不能跟"失败"混为一谈。
            中断常发生在模型还没吐字之前, 不标这一枚, 整轮就只剩"已工作 1 秒 · 3 次操作",
            用户分不清是自己停的还是它自己挂了。 */}
        {fold.hasInterrupted && (
          <span className="atl-turnfold__stopped" title={zh ? '这一轮被你停止了' : 'you stopped this turn'}>
            {zh ? '已停止' : 'stopped'}
          </span>
        )}
        {/* 折进去的内容里有失败, 必须在折叠态就看得见 —— 否则折叠等于藏错误。
            但这一轮是用户自己停的时候不喊: 那些"失败"是 abort 的产物, 不是程序出问题,
            两枚一起挂着反而让人以为"我停了它还崩了"。 */}
        {fold.hasFailure && !fold.hasInterrupted && (
          <span className="atl-turnfold__fail" title={zh ? '这一轮中有失败的操作' : 'contains failures'}>
            {zh ? '有失败' : 'failed'}
          </span>
        )}
        <span className="atl-turnfold__caret" aria-hidden>
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </span>
      </button>
      {/* 折着的时候也要看得见它看过的图 —— 放在按钮外面 (按钮里不能套按钮)。
        * 展开后: Code 图回到各自那一步; Work 由 WorkProgressCard 卡底那排接着显示 */}
      {!expanded && seen.length > 0 && (
        <div className="atl-turnfold__seen">
          <SeenImagesView images={seen.slice(0, SEEN_STRIP_MAX)} compact />
          {seen.length > SEEN_STRIP_MAX && (
            <button type="button" className="atl-turnfold__seen-more" onClick={toggle}>+{seen.length - SEEN_STRIP_MAX}</button>
          )}
        </div>
      )}
      {expanded && isWork && !showAll && (
        <div className="atl-turnfold__body">
          <WorkProgressCard rows={fold.rows} live={false} zh={zh} />
          <button type="button" className="nx-wp-fold-all" onClick={() => setShowAll(true)}>
            {zh ? '看全部过程 ›' : 'Show everything ›'}
          </button>
        </div>
      )}
      {expanded && (!isWork || showAll) && (
        <div className="atl-turnfold__body">
          {renderRows(fold.rows)}
          {hiddenLine && <div className="nx-work-hidden-steps">{hiddenLine}</div>}
        </div>
      )}
    </div>
  );
};

export default TurnFoldRow;
