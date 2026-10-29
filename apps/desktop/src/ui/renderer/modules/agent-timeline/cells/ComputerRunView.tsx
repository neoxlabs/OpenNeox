import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { localFileUrl } from '../computerTimelineCard';
import { formatComputerDuration } from '../computerRunSummary';
import '../toolCards/tool-cards.css';


export interface ComputerRunStepView {
  text: string;
  ok?: boolean;
  ms?: number;
  error?: string;
  /** 这一步的补充说明 (浏览器卡用它标"定位失效已自愈") */
  note?: string;
}

export const ComputerRunView: React.FC<{
  app?: string;
  /** data:image/png;base64,… — os-bridge 的 icon op 给的 */
  icon?: string;
  steps: ComputerRunStepView[];
  /** 窗口截图的**本地路径**, 走 neox-asset:// 协议渲染 */
  screenshot?: string;
  totalMs?: number;
  ok?: boolean;
  /** 只看一眼 (computer_snapshot) 时没有步骤, 用这行说明看到了什么 */
  note?: string;
  /** 浏览器卡底栏 (设计稿第 1 页): 控制台报错 · 失败请求 · 页面接口 · 在浏览器里看 */
  foot?: { consoleErrors?: number; failedRequests?: number; apiCalls?: number; url?: string };
}> = ({ app, icon, steps, screenshot, totalMs, ok, note, foot }) => {
  const { isZh } = useI18n();
  const failedIdx = steps.findIndex((s) => s.ok === false);

  return (
    <div className="atl-computer">
      <div className="atl-computer__head">
        {icon
          ? <img className="atl-computer__logo" src={icon} alt="" aria-hidden />
          : <span className="atl-computer__logo atl-computer__logo--blank" aria-hidden />}
        <span className="atl-computer__app">{app || (isZh ? '这台电脑' : 'This Mac')}</span>
        {steps.length > 0 && (
          <span className="atl-computer__meta">
            {isZh ? `${steps.length} 步` : `${steps.length} steps`}
            {typeof totalMs === 'number' ? ` · ${formatComputerDuration(totalMs, isZh)}` : ''}
          </span>
        )}
        {ok === false && (
          <span className="atl-computer__badge atl-computer__badge--err">
            {failedIdx >= 0
              ? (isZh ? `第 ${failedIdx + 1} 步失败` : `step ${failedIdx + 1} failed`)
              : (isZh ? '失败' : 'failed')}
          </span>
        )}
      </div>

      {note && <div className="atl-computer__note">{note}</div>}

      <div className={`atl-computer__body${screenshot ? ' has-shot' : ''}`}>
        {screenshot && (
          <img
            className="atl-computer__shot"
            src={localFileUrl(screenshot)}
            alt={isZh ? `${app ?? ''} 窗口截图` : `${app ?? ''} window screenshot`}
            loading="lazy"
          />
        )}
        {steps.length > 0 && (
          <ol className="atl-computer__steps">
            {steps.map((s, i) => (
              <li key={i} className={s.ok === false ? 'is-failed' : undefined}>
                <span className="atl-computer__step-mark" aria-hidden>
                  {s.ok === false
                    ? <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="8" cy="8" r="5.5" /><path d="M8 5.2v3.3M8 10.8v.1" /></svg>
                    : <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 8.5 3 3 6-7" /></svg>}
                </span>
                <span className="atl-computer__step-text">{s.text}</span>
                {typeof s.ms === 'number' && s.ms > 0 && (
                  <span className="atl-computer__step-ms">{formatComputerDuration(s.ms, isZh)}</span>
                )}
                {s.note && <span className="atl-computer__step-note">{s.note}</span>}
                {s.error && <span className="atl-computer__step-err">{s.error}</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
      {foot && (
        <div className="atl-computer__foot">
          <span>
            {[
              foot.consoleErrors ? <span key="c">{isZh ? '控制台 ' : 'Console '}<b className="is-err">{isZh ? `${foot.consoleErrors} 个报错` : `${foot.consoleErrors} errors`}</b></span> : null,
              foot.failedRequests ? <span key="f">{isZh ? '请求 ' : 'Requests '}<b className="is-err">{isZh ? `${foot.failedRequests} 个失败` : `${foot.failedRequests} failed`}</b></span> : null,
              foot.apiCalls ? <span key="a">{isZh ? `调了 ${foot.apiCalls} 个接口` : `${foot.apiCalls} API calls`}</span> : null,
              screenshot ? <span key="s">{isZh ? '最后一张截图' : 'Last screenshot'}</span> : null,
            ].filter(Boolean).reduce<React.ReactNode[]>((acc, n, i) => (i ? [...acc, ' · ', n] : [n]), [])}
          </span>
          {foot.url && (
            <button
              type="button"
              className="atl-computer__foot-act"
              onClick={(e) => {
                e.stopPropagation();
                const neox = (window as any).neox;
                if (neox?.openExternal) neox.openExternal(foot.url).catch(() => undefined);
                else window.open(foot.url, '_blank', 'noopener,noreferrer');
              }}
            >
              {isZh ? '在浏览器里看' : 'Open in browser'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ComputerRunView;
