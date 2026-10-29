import React from 'react';
import type { StepContent } from '../types';
import { useI18n } from '../../../hooks/useI18n';
import { useNeoxRuntimeOptional } from '../../../app/NeoxRuntimeContext';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';

type DeepResearchContent = Extract<StepContent, { type: 'deep_research' }>;

const STOP_REASON_ZH: Record<string, string> = {
  converged: '查到没有新线索',
  'worker-cap': '到调研员上限',
  'time-budget': '到时间预算',
  aborted: '被中断',
};
const STOP_REASON_EN: Record<string, string> = {
  converged: 'converged',
  'worker-cap': 'worker cap',
  'time-budget': 'time budget',
  aborted: 'aborted',
};

function fmtTokens(n: number): string {
  if (!n) return '0';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function useElapsed(startedAt: number | undefined, live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live || !startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, startedAt]);
  return startedAt ? now - startedAt : 0;
}

const WORKER_ICON: Record<string, string> = {
  queued: '○',
  running: '◐',
  done: '●',
  failed: '✕',
};

/** 跑着的那张 —— 一连串调研员 */
function LiveBody({ content, isZh, onOpenReport }: {
  content: DeepResearchContent;
  isZh: boolean;
  onOpenReport?: () => void;
}) {
  const workers = content.workers || [];
  const stopped = content.interrupted === true;
  /* 停了就别再让秒表往上爬 —— 那是这张卡最容易说谎的地方 */
  const elapsed = useElapsed(content.startedAt, content.phase === 'running' && !stopped);
  const s = content.stats;
  const doneCount = workers.filter((w) => w.status === 'done').length;
  const tokens = content.totalTokens || 0;
  /* 计划可能有几十上百条, 并发只有三四个 —— 摊开计划, 但别把卡片铺成一屏:
   * 动过的那些 (在跑/跑完/失败) 全显示, 排队的只露前几条, 剩下折成一行。 */
  const MAX_QUEUED_ROWS = 5;
  const active = workers.filter((w) => w.status !== 'queued');
  const queued = workers.filter((w) => w.status === 'queued');
  const shownWorkers = [...active, ...queued.slice(0, MAX_QUEUED_ROWS)];
  const hiddenQueued = queued.length - Math.min(queued.length, MAX_QUEUED_ROWS);

  return (
    <div
      className={[
        'nx-research is-live',
        stopped ? 'is-stopped' : '',
        onOpenReport ? 'is-clickable' : '',
      ].filter(Boolean).join(' ')}
      {...(onOpenReport ? {
        role: 'button' as const,
        tabIndex: 0,
        title: isZh ? '打开调研报告' : 'Open the research report',
        onClick: onOpenReport,
      } : {})}
    >
      {/* 抬头: 跑了多久 · 几路收了 · 查到多少 · 一共烧了多少 */}
      <div className="nx-research__stats">
        {content.startedAt && (
          <span className="nx-research__elapsed">{fmtElapsed(elapsed)}</span>
        )}
        <span className="nx-research__stat">
          <b>{doneCount}</b>/<b>{workers.length}</b>{isZh ? ' 角度' : ' angles'}
        </span>
        <span className="nx-research__sep">·</span>
        <span className="nx-research__stat">
          <b>{s.sources}</b>{isZh ? ' 来源' : ' sources'}
        </span>
        <span className="nx-research__sep">/</span>
        <span className="nx-research__stat">
          <b>{s.domains}</b>{isZh ? ' 站点' : ' sites'}
        </span>
        <span className="nx-research__sep">·</span>
        <span className="nx-research__stat">
          <b>{s.claims}</b>{isZh ? ' 条结论' : ' claims'}
        </span>
        {s.disputed > 0 && (
          <span className="nx-research__badge is-disputed">
            {isZh ? `${s.disputed} 条有分歧` : `${s.disputed} disputed`}
          </span>
        )}
        {stopped && (
          <span className="nx-research__badge is-stopped-tag">{isZh ? '已停' : 'stopped'}</span>
        )}
        {tokens > 0 && (
          <span className="nx-research__tokens" title={isZh ? '各路合计' : 'total across workers'}>
            ⛁ {fmtTokens(tokens)}
          </span>
        )}
      </div>

      {/* 中断了就把"东西还在"说清楚 —— 报告是随手落盘的, 这一轮的钱没白花 */}
      {stopped && (
        <div className="nx-research__foot">
          <span>
            {isZh
              ? `这轮没跑完，已经查到的都记在账本里了（${s.sources} 来源 · ${s.claims} 条结论）`
              : `Stopped early — everything found so far is on disk (${s.sources} sources · ${s.claims} claims)`}
          </span>
          {content.reportPath && (
            <span className="nx-research__path" title={content.reportPath}>
              {content.reportPath.split('/').slice(-2).join('/')}
            </span>
          )}
        </div>
      )}

      {/* 一连串调研员 —— 用户要的「看得见这么多 Agent 都在干活」 */}
      {workers.length > 0 && (
        <div className="nx-research__workers">
          {shownWorkers.map((w) => (
            <div className="nx-research__worker" data-status={w.status} key={w.id || w.question}>
              {/* 被中断时还挂着 running 的那几路: 它们**没跑完**, 不能再顶着"正在跑"的图标 */}
              <span className="nx-research__wicon">
                {stopped && w.status === 'running' ? '◌' : (WORKER_ICON[w.status] || '○')}
              </span>
              <span className="nx-research__wq" title={w.question}>{w.question}</span>
              {/* 干完的那一路给一句它查到了什么, 还在跑的给它此刻在动什么 */}
              {w.status === 'done' && w.summary
                ? <span className="nx-research__wsum">{w.summary}</span>
                : w.currentTool
                  ? <span className="nx-research__wact">{w.currentTool}</span>
                  : null}
              <span className="nx-research__wnums">
                {w.toolCount ? <span>{isZh ? `${w.toolCount} 工具` : `${w.toolCount} tools`}</span> : null}
                {w.tokens ? <span className="nx-research__wtok">{fmtTokens(w.tokens)}</span> : null}
              </span>
            </div>
          ))}
          {/* 排队的那一大截折成一行 —— 计划要看得见, 但不能把卡片铺成一屏 */}
          {hiddenQueued > 0 && (
            <div className="nx-research__worker nx-research__more" data-status="queued">
              <span className="nx-research__wicon">○</span>
              <span className="nx-research__wq">
                {isZh ? `还有 ${hiddenQueued} 条排队` : `${hiddenQueued} more queued`}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DeepResearchCard({ content }: { content: DeepResearchContent }) {
  /* 自己取语言, 不从父组件传 —— StepContentRenderer 那个组件本身没有 isZh
   * (它里面几个子组件各自 useI18n)。跟 EditDiffCard 同一种写法。 */
  const { isZh } = useI18n();
  const runtime = useNeoxRuntimeOptional();
  const sessionId = runtime?.activeSession?.id;
  const workspacePath = runtime?.workspacePath;

  const reportPath = content.reportPath;
  const openReport = React.useCallback(() => {
    if (!sessionId || !reportPath) return;
    openSurfaceFromPath({ sessionId, path: reportPath, workspacePath });
  }, [sessionId, reportPath, workspacePath]);
  const canOpen = Boolean(sessionId && reportPath);

  if (content.phase === 'running' || content.interrupted) {
    return <LiveBody content={content} isZh={isZh} onOpenReport={canOpen ? openReport : undefined} />;
  }

  const s = content.stats;
  const stopKey = content.stopReason || '';
  const stop = (isZh ? STOP_REASON_ZH : STOP_REASON_EN)[stopKey] ?? stopKey;

  return (
    <div
      className={canOpen ? 'nx-research is-clickable' : 'nx-research'}
      {...(canOpen ? {
        role: 'button' as const,
        tabIndex: 0,
        title: isZh ? '打开调研报告' : 'Open the research report',
        onClick: openReport,
      } : {})}
    >
      {/* 1. 统计行 */}
      <div className="nx-research__stats">
        <span className="nx-research__stat">
          <b>{s.sources}</b>{isZh ? ' 来源' : ' sources'}
        </span>
        <span className="nx-research__sep">·</span>
        <span className="nx-research__stat">
          <b>{s.domains}</b>{isZh ? ' 站点' : ' sites'}
        </span>
        <span className="nx-research__sep">·</span>
        <span className="nx-research__stat">
          <b>{s.claims}</b>{isZh ? ' 条结论' : ' claims'}
        </span>
        {s.disputed > 0 && (
          <span className="nx-research__badge is-disputed">
            {isZh ? `${s.disputed} 条有分歧` : `${s.disputed} disputed`}
          </span>
        )}
        {s.singleSource > 0 && (
          <span className="nx-research__badge is-single">
            {isZh ? `${s.singleSource} 条单一来源` : `${s.singleSource} single-source`}
          </span>
        )}
        {(s.unverified ?? 0) > 0 && (
          <span className="nx-research__badge is-unverified">
            {isZh ? `${s.unverified} 条未核实` : `${s.unverified} unverified`}
          </span>
        )}
      </div>

      {content.disputes.length > 0 && (
        <div className="nx-research__disputes">
          {content.disputes.map((d) => (
            <div className="nx-research__dispute" key={d.cid || d.text}>
              <div className="nx-research__claim">
                {d.text}
                {/* 同源自辩 ≠ 两家打架 —— 不标出来会把一份文档的自我限定读成来源冲突 */}
                {d.crossSource === false && (
                  <span className="nx-research__samesrc">{isZh ? '同一来源内部' : 'same source'}</span>
                )}
              </div>
              <div className="nx-research__sides">
                <div className="nx-research__side is-for">
                  <span className="nx-research__side-tag">
                    {d.crossSource === false ? (isZh ? '原文' : 'text') : (isZh ? '支持' : 'for')}
                  </span>
                  <span className="nx-research__quote">{d.support.quote}</span>
                  {d.support.host && <span className="nx-research__host">{d.support.host}</span>}
                </div>
                <div className="nx-research__side is-against">
                  <span className="nx-research__side-tag">{isZh ? '反对' : 'against'}</span>
                  <span className="nx-research__quote">{d.contradict.quote}</span>
                  {d.contradict.host && <span className="nx-research__host">{d.contradict.host}</span>}
                </div>
              </div>
              {d.lean && <div className="nx-research__lean">{isZh ? '倾向：' : 'Leaning: '}{d.lean}</div>}
            </div>
          ))}
        </div>
      )}

      {/* 3. 站点 */}
      {content.domains.length > 0 && (
        <div className="nx-research__domains">
          {content.domains.map((d) => (
            <span className="nx-research__chip" key={d}>{d}</span>
          ))}
          {s.domains > content.domains.length && (
            <span className="nx-research__chip is-more">+{s.domains - content.domains.length}</span>
          )}
        </div>
      )}

      {/* 4. 尾注 */}
      <div className="nx-research__foot">
        <span>
          {(isZh
            ? `${content.dispatched} 个调研员`
            : `${content.dispatched} ${content.dispatched === 1 ? 'worker' : 'workers'}`)
            + (stop ? ` · ${stop}` : '')}
        </span>
        {content.unexplored.length > 0 && (
          <span className="nx-research__pending">
            {isZh ? `${content.unexplored.length} 条线索没查` : `${content.unexplored.length} leads unexplored`}
          </span>
        )}
        {content.reportPath && (
          <span className="nx-research__path" title={content.reportPath}>
            {content.reportPath.split('/').slice(-2).join('/')}
          </span>
        )}
      </div>
    </div>
  );
}

export default DeepResearchCard;
