import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../hooks/useI18n';
import { formatCompactToolArgs } from '../formatCompactToolArgs';
import { ProviderBrandIcon, inferProviderBrand } from '../ProviderBrandIcon';
import { SubAgentMark } from './SubAgentMark';
import { AgentBrandLogo } from '../components/AgentBrandLogo';
import { DotSpinner } from '../../../components/DotSpinner';



function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

/* ---------- worker / delegation shared helpers ---------- */
const AGENT_STATUS_CLS: Record<string, string> = {
  running: 'is-running',
  completed: 'is-done',
  done: 'is-done',
  failed: 'is-fail',
  error: 'is-fail',
};

export const WorkerView: React.FC<{
  agentId?: string;
  role?: string;
  model?: string;
  task?: string;
  status?: string;
  summary?: string;
  error?: string;
}> = ({ agentId, role, model, task, status, summary, error }) => {
  const { isZh } = useI18n();
  const cls = AGENT_STATUS_CLS[status ?? 'running'] ?? 'is-running';
  /* status 原样是内部枚举 (running/completed/…), 转成用户语言的短标签 */
  const statusLabel = status === 'running' ? (isZh ? '运行中' : 'Running')
    : (status === 'completed' || status === 'done') ? (isZh ? '完成' : 'Done')
    : (status === 'failed' || status === 'error') ? (isZh ? '失败' : 'Failed')
    : status;
  return (
    <div className={`atl-worker ${cls}`}>
      <div className="atl-worker__head">
        <span className="atl-worker__role">{role || 'Worker'}</span>
        {model && <span className="atl-worker__model">{model}</span>}
        {agentId && <span className="atl-worker__id">#{agentId.slice(0, 6)}</span>}
        {statusLabel && <span className="atl-worker__status">{statusLabel}</span>}
      </div>
      {task && <div className="atl-worker__task">{task}</div>}
      {summary && <div className="atl-worker__summary">{summary}</div>}
      {error && <div className="atl-worker__error">{error}</div>}
    </div>
  );
};

/* ---------- delegation ----------
 * 设计要点:
 *   · running 时左边出 dot/spinner, 别让用户以为对话已经结束
 *   · 后台 agent 必须明确打 "后台运行" badge — 用户的最大困惑就是 "agent 跑哪去了, 没消息了?"
 *   · COMPLETED 状态收紧, 不再大写英文摆中间, 改成右上角小字
 *   · toolCount 仅在 >0 时显示, 0 工具反而是噪音(看到 "0 工具" 用户会以为 agent 啥也没做)
 *   · toolRecords 在卡片体里展开, 用 ├/└ 树状显示 task-agent 内部跑过的工具序列,
 *     让用户一眼看懂 Plan Agent 实际做了哪几步, 而不是只看到一段文字描述. */

/** 把 role / roleName 标准化成 CSS modifier 后缀 — verify / plan / code / shell / explore.
 *  未知 role 返回 null 走默认紫色样式. */
function resolveRoleModifier(role?: string, roleName?: string): string | null {
  const key = (role || roleName || '').toLowerCase().trim();
  if (!key) return null;
  if (key.includes('verify')) return 'verify';
  if (key.includes('plan')) return 'plan';
  if (key.includes('code')) return 'code';
  if (key.includes('shell')) return 'shell';
  if (key.includes('explore')) return 'explore';
  return null;
}

/** VerifyAgent 末尾会输出 `VERDICT: PASS | FAIL | PARTIAL`(我们 system prompt 强制的格式).
 *  这里抠出来上浮成头部 chip — 让用户一眼看到验证结果, 不用翻 summary. */
function parseVerdict(summary?: string): 'PASS' | 'FAIL' | 'PARTIAL' | null {
  if (!summary) return null;
  const m = /VERDICT\s*[::]\s*(PASS|FAIL|PARTIAL)\b/i.exec(summary);
  if (!m) return null;
  const v = m[1].toUpperCase();
  return v === 'PASS' || v === 'FAIL' || v === 'PARTIAL' ? v : null;
}

function formatDelegationArgs(raw?: string): string {
  return formatCompactToolArgs(raw);
}

/** 子 agent 完整过程弹窗 —— **只在点开时才创建**(父组件条件渲染), 关掉即卸载。
 *
 * 性能上的三个约束 (用户点名"弹窗还要渲染, 需要注意性能"):
 *   1. 不点不建 DOM —— 子 agent 动辄几十上百条工具, 无条件挂在虚拟列表里是纯浪费;
 *   2. 超长只渲染尾部 200 条 + 一行"更早的 N 步已省略" —— 弹窗是给人扫读的, 不是日志归档;
 *   3. portal 到 body —— 不参与 timeline 的测高, 不会再触发那套虚拟窗口重算 (今天刚根治过)。
 */
const TRACE_MAX_ROWS = 200;

const DelegationTracePopup: React.FC<{
  title: string;
  records: Array<{ name: string; args?: string; status: 'running' | 'done' | 'error'; duration?: number }>;
  onClose: () => void;
}> = ({ title, records, onClose }) => {
  const { isZh } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const shown = records.length > TRACE_MAX_ROWS ? records.slice(-TRACE_MAX_ROWS) : records;
  const omitted = records.length - shown.length;
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="atl-trace-mask" onClick={onClose} role="presentation">
      <div className="atl-trace-popup" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="atl-trace-popup__head">
          <span className="atl-trace-popup__title">{title}</span>
          <span className="atl-trace-popup__count">
            {isZh ? `${records.length} 步` : `${records.length} steps`}
          </span>
          <button type="button" className="atl-trace-popup__close" onClick={onClose}
            aria-label={isZh ? '关闭' : 'Close'}>×</button>
        </header>
        <ul className="atl-trace-popup__list">
          {omitted > 0 && (
            <li className="atl-delegation__tools-more">
              {isZh ? `… 更早的 ${omitted} 步已省略` : `… ${omitted} earlier steps omitted`}
            </li>
          )}
          {shown.map((rec, i) => (
            <li key={i} className={`atl-delegation__rec is-${rec.status}`}>
              <span className="atl-delegation__rec-marker" aria-hidden>
                {rec.status === 'running' ? '●' : rec.status === 'error' ? '✗' : '✓'}
              </span>
              <span className="atl-delegation__rec-name">{rec.name}</span>
              {rec.args && (
                <span className="atl-delegation__rec-args" title={rec.args}>
                  {formatDelegationArgs(rec.args)}
                </span>
              )}
              {typeof rec.duration === 'number' && rec.duration > 0 && (
                <span className="atl-delegation__rec-dur">{formatMs(rec.duration)}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
};

export const DelegationView: React.FC<{
  role?: string;
  roleName?: string;
  model?: string;
  task?: string;
  status?: string;
  summary?: string;
  error?: string;
  toolCount?: number;
  currentStatus?: string;
  isBackground?: boolean;
  toolRecords?: Array<{
    name: string;
    args?: string;
    status: 'running' | 'done' | 'error';
    duration?: number;
  }>;
}> = ({ role, roleName, model, task, status, summary, error, toolCount, currentStatus, isBackground, toolRecords }) => {
  const { isZh } = useI18n();
  const isRunning = status === 'running';
  const cls = AGENT_STATUS_CLS[status ?? (isRunning ? 'running' : 'completed')] ?? 'is-done';
  const statusLabel =
    status === 'completed' ? (isZh ? '完成' : 'Done') :
    status === 'error' ? (isZh ? '失败' : 'Failed') :
    isBackground ? (isZh ? '后台运行中' : 'Running in background') : (isZh ? '运行中' : 'Running');
  const records = (toolRecords ?? []).filter((r) => r.name !== 'report_to_conductor');
  /* 后台 agent 的 toolCount 常年是 0, 只有 toolRecords 在涨 —— 取大的那个 */
  const stepCount = Math.max(toolCount ?? 0, records.length);
  const failedRecord = records.find((r) => r.status === 'error');
  const runningRecord = [...records].reverse().find((r) => r.status === 'running');
  /* 一行摘要按优先级: 失败的那个 > 正在跑的那个 > 最后做完的那个 */
  const headline = failedRecord ?? runningRecord ?? records[records.length - 1];
  const [detailOpen, setDetailOpen] = useState(false);
  /* B: 按 role 区分色系 — verify=橙(警示/质量) / plan=蓝(规划) / code|shell=紫(执行,默认) */
  const roleModifier = resolveRoleModifier(role, roleName);
  /* C: 解析 VerifyAgent 在 summary 末尾的 VERDICT 行, 在卡片头部用大 chip 上浮.
   *    用户最关心"通过了吗", 不该让他翻 summary 找一行 */
  const verdict = parseVerdict(summary);
  const [summaryOpen, setSummaryOpen] = useState(false);
  /* VERDICT 行已经上浮成卡头标签, 正文里不再说一遍 */
  const shownSummary = verdict ? summary?.replace(/^\s*VERDICT\s*[::]\s*(PASS|FAIL|PARTIAL)\b.*$/gim, '').trim() : summary;
  const longSummary = !!shownSummary && (shownSummary.split('\n').length > 3 || shownSummary.length > 220);

  return (
    <div className={`atl-acard ${cls}${roleModifier ? ` atl-acard--${roleModifier}` : ''}`}>
      <div className="atl-acard__head">
        {/* 卡头头像 = 模型品牌 logo (10-21 用户「缺 DeepSeek 的 logo, 太素」); 认不出品牌才用派发图标 */}
        <span className="atl-acard__logo">
          <AgentBrandLogo model={model} size={16} fallback={<SubAgentMark running={isRunning} aria-hidden />} />
        </span>
        <span className="atl-acard__name">{roleName || role || (isZh ? '子 Agent' : 'Sub-agent')}</span>
        {model && (
          /* 品牌 logo 已经是卡头头像, 这里只写模型名 */
          <span className="atl-acard__model" title={model}><span>{model}</span></span>
        )}
        {isBackground && <span className="atl-acard__badge">{isZh ? '后台' : 'BG'}</span>}
        {verdict && (
          <span className={`atl-delegation__verdict atl-delegation__verdict--${verdict.toLowerCase()}`}>
            {verdict === 'PASS' ? '✓ PASS' : verdict === 'FAIL' ? '✗ FAIL' : '◐ PARTIAL'}
          </span>
        )}
        <span className="atl-acard__status">
          <i aria-hidden />
          {statusLabel}
          {stepCount > 0 && <em>{isZh ? `${stepCount} 步` : `${stepCount} steps`}</em>}
        </span>
      </div>

      <div className="atl-acard__body">
        {task && <div className="atl-acard__task" title={task}>{task}</div>}

        {isRunning && (currentStatus || isBackground) && (
          <div className="atl-acard__live">
            <DotSpinner size={12} />
            <span>{currentStatus || (isZh ? '主对话已结束，它在后台继续跑，完成后会通知你' : 'Keeps running in the background — you’ll be notified')}</span>
          </div>
        )}

        {/* 一行: 它现在 / 最后在做的那一步; 整串过程点开弹窗看 (折叠态不渲染任何工具行) */}
        {headline && (
          <button
            type="button"
            className={`atl-acard__step is-${headline.status}`}
            onClick={(e) => { e.stopPropagation(); setDetailOpen(true); }}
            title={isZh ? '查看这个子 agent 的完整过程' : "Open this sub-agent's full trace"}
          >
            <span className="atl-acard__step-mark" aria-hidden>
              {headline.status === 'running' ? '●' : headline.status === 'error' ? '✗' : '✓'}
            </span>
            <span className="atl-acard__step-name">{headline.name}</span>
            {headline.args && <span className="atl-acard__step-args" title={headline.args}>{formatDelegationArgs(headline.args)}</span>}
            {records.length > 1 && <span className="atl-acard__step-more">{isZh ? `共 ${records.length} 步 ›` : `${records.length} steps ›`}</span>}
          </button>
        )}

        {shownSummary && (
          <>
            <div className={`atl-acard__output${summaryOpen ? ' is-open' : ''}`}>
              {String(shownSummary).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/^#+\s*/gm, '')}
            </div>
            {longSummary && (
              <button type="button" className="atl-acard__more" onClick={() => setSummaryOpen((v) => !v)}>
                {summaryOpen ? (isZh ? '收起' : 'Show less') : (isZh ? '展开全部' : 'Show all')}
              </button>
            )}
          </>
        )}
        {error && <div className="atl-acard__error"><b>{error}</b></div>}
      </div>
      {detailOpen && (
        <DelegationTracePopup
          title={roleName || role || 'Agent'}
          records={records}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </div>
  );
};


