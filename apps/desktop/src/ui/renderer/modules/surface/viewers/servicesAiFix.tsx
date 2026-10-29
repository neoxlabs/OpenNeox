
import React, { useEffect, useState } from 'react';
import { NeoxIllus } from '../../../media/illus';

export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

export function formatAgo(ts: number): string {
  return formatUptime(Math.max(0, Math.floor((Date.now() - ts) / 1000)));
}

/** 新建服务不填 ID 时按名称生成 (只留字母数字), 名称是中文 / 空就用类型 + 时间戳 */
export function autoServiceId(name: string, kind: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `${kind}-${Date.now().toString(36)}`;
}

export interface ServiceConfigProposal {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  springProfiles?: string[];
  summary: string;
  changes: string[];
}

export interface AiDraft { name: string; command: string; cwd: string; env?: Record<string, string>; springProfiles?: string[] }

export type AiState =
  | { phase: 'idle' }
  | { phase: 'loading'; startedAt: number }
  | { phase: 'done'; proposal: ServiceConfigProposal; before: AiDraft }
  | { phase: 'error'; message: string };

export async function requestAiConfig(workspacePath: string, configId: string | undefined, draft: AiDraft, isZh: boolean): Promise<AiState> {
  try {
    const r = await (window as any).neox?.serviceSuggestConfig?.(workspacePath, { configId, ...draft, lang: isZh ? 'zh' : 'en' });
    if (!r?.ok || !r.proposal) return { phase: 'error', message: r?.error || (isZh ? 'AI 没给出可用的配置' : 'No usable suggestion') };
    return { phase: 'done', proposal: r.proposal, before: draft };
  } catch (err: any) {
    return { phase: 'error', message: err?.message || String(err) };
  }
}

export const AiSparkIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M19 15l.8 1.9 1.9.8-1.9.8L19 20.4l-.8-1.9-1.9-.8 1.9-.8z" />
  </svg>
);

const envText = (env?: Record<string, string>) => Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
const norm = (s: string) => s.trim().replace(/\s+/g, ' ');

/** AI 读工程时的三步 —— 只是节奏提示, 真实请求是一次; 按时间推进, 最后一步停在进行中直到返回 */
const LoadingSteps: React.FC<{ isZh: boolean; startedAt: number }> = ({ isZh, startedAt }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 400); return () => clearInterval(t); }, []);
  const steps = isZh
    ? ['读取工程结构 · 模块 / 版本 / profile', '对照最近一次启动日志', '生成能跑起来的配置']
    : ['Reading the project · modules / versions / profiles', 'Checking the last run log', 'Writing a config that starts'];
  const at = Math.min(steps.length - 1, Math.floor((now - startedAt) / 2500));
  return (
    <ol className="svc-cfg__ai-steps">
      {steps.map((s, i) => (
        <li key={s} className={i < at ? 'is-done' : i === at ? 'is-active' : ''}>
          <span className="svc-cfg__ai-step-dot" aria-hidden="true" />{s}
        </li>
      ))}
    </ol>
  );
};

/** 弹窗内的 AI 面板: 盖在字段区上, 不另开窗口 */
export const ServiceAiPanel: React.FC<{
  isZh: boolean;
  state: AiState;
  onDiscard: () => void;
  onApply: (p: ServiceConfigProposal) => void;
  onRetry: () => void;
}> = ({ isZh, state, onDiscard, onApply, onRetry }) => {
  if (state.phase === 'idle') return null;
  if (state.phase === 'loading') {
    return (
      <div className="svc-cfg__ai-panel is-loading" role="status">
        <img className="svc-cfg__ai-illus" src={NeoxIllus.diagHero} alt="" draggable={false} />
        <div className="svc-cfg__ai-title">{isZh ? 'AI 正在看你的工程' : 'AI is reading your project'}</div>
        <LoadingSteps isZh={isZh} startedAt={state.startedAt} />
      </div>
    );
  }
  if (state.phase === 'error') {
    return (
      <div className="svc-cfg__ai-panel is-error" role="alert">
        <img className="svc-cfg__ai-illus" src={NeoxIllus.nomatch} alt="" draggable={false} />
        <div className="svc-cfg__ai-title">{isZh ? '这次没给出配置' : 'No config this time'}</div>
        <div className="svc-cfg__ai-sub">{state.message}</div>
        <div className="svc-cfg__ai-actions">
          <button type="button" className="svc-cfg__btn" onClick={onDiscard}>{isZh ? '返回' : 'Back'}</button>
          <button type="button" className="svc-cfg__btn is-primary" onClick={onRetry}>{isZh ? '再试一次' : 'Try again'}</button>
        </div>
      </div>
    );
  }
  const { proposal: p, before } = state;
  const rows: Array<{ label: string; from: string; to: string }> = [
    { label: isZh ? '启动命令' : 'Command', from: before.command, to: p.command },
    { label: isZh ? '工作目录' : 'Directory', from: before.cwd || '.', to: p.cwd || '.' },
    { label: 'Spring profile', from: (before.springProfiles ?? []).join(','), to: (p.springProfiles ?? before.springProfiles ?? []).join(',') },
    { label: isZh ? '环境变量' : 'Env', from: envText(before.env), to: envText({ ...before.env, ...p.env }) },
  ];
  const changed = rows.filter((r) => norm(r.from) !== norm(r.to));
  return (
    <div className="svc-cfg__ai-panel is-done" role="dialog" aria-label={isZh ? 'AI 建议的配置' : 'Suggested config'}>
      <div className="svc-cfg__ai-head">
        <img className="svc-cfg__ai-illus is-small" src={NeoxIllus.codeRebuild} alt="" draggable={false} />
        <div>
          <div className="svc-cfg__ai-kicker"><AiSparkIcon size={12} />{isZh ? 'AI 建议 · 确认后填进表单' : 'AI suggestion · fills the form after you confirm'}</div>
          <div className="svc-cfg__ai-title">{p.summary || (isZh ? '配置已检查' : 'Config checked')}</div>
        </div>
      </div>
      {p.changes.length > 0 && (
        <ul className="svc-cfg__ai-reasons">{p.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
      )}
      {changed.length === 0 ? (
        <div className="svc-cfg__ai-same">{isZh ? '现在的配置不用改' : 'Nothing to change'}</div>
      ) : (
        <div className="svc-cfg__ai-diff">
          {changed.map((r) => (
            <div key={r.label} className="svc-cfg__ai-diff-row">
              <div className="svc-cfg__ai-diff-label">{r.label}</div>
              {r.from.trim() && <code className="is-from">{r.from}</code>}
              <code className="is-to">{r.to || (isZh ? '(空)' : '(empty)')}</code>
            </div>
          ))}
        </div>
      )}
      <div className="svc-cfg__ai-actions">
        <button type="button" className="svc-cfg__btn" onClick={onDiscard}>{isZh ? '放弃' : 'Discard'}</button>
        <button type="button" className="svc-cfg__btn is-primary" onClick={() => onApply(p)} disabled={changed.length === 0}>
          {isZh ? '用这个配置' : 'Use this config'}
        </button>
      </div>
    </div>
  );
};
