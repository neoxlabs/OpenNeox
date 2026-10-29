import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useTimelineFeed } from '../../../state/timelineFeedStore';
import { latestPlan, planName } from '../../agent-timeline/PlanStatusBar';
import type { TimelineEntry } from '../../../utils/workspaceUtils';
import { usePilotReports, type PilotReport } from '../usePilotReports';
import * as S from '../../shell/shellIcons';
import type { StageCard } from './StageCards';

const ACTIVE = new Set(['in_progress', 'verifying']);
const DONE = new Set(['completed', 'done']);
/** 汇报多久以内还算「刚」做完 */
const RECENT_MS = 12 * 3600_000;

/** 你交代的那句话 → 一行标题: 去掉「新活: / 帮我」这类开头, 取第一句, 太长截断 */
export function taskTitleOf(text: string): string {
  const first = text
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '')
    .replace(/^\s*(新活|任务|帮我|请|麻烦你?|再帮我)\s*[:：,，]?\s*/u, '')
    .split(/[。！？!?\n,，;；]/)[0]
    /* 标题只留「干什么」: 在哪 (在 x/ 下) 不要, 路径只留最后一节, 量词不要 */
    .replace(/^\s*在\s*\S+\s*(下面?|里面?|中|上)\s*/u, '')
    .replace(/\S*\/\S*/g, (p) => p.split('/').filter(Boolean).pop() ?? '')
    .replace(/(写|做|弄|搞|整)个/gu, '$1 ')
    .replace(/一个/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return first.length > 20 ? `${first.slice(0, 20).trim()}…` : first;
}

/** 手上这一步, 说人话 */
function stepOf(c: StageCard, zh: boolean): string {
  const t = (z: string, e: string) => (zh ? z : e);
  const file = String(c.args.path ?? c.args.file_path ?? c.args.targetPath ?? '').split('/').pop() || c.sub;
  switch (c.tool) {
    case 'execute_shell': {
      const cmd = String(c.args.command ?? '');
      if (/\b(pytest|unittest|test_|jest|vitest|npm (run )?test|go test|cargo test)/.test(cmd)) return t('跑测试', 'Running tests');
      if (/\b(pip|npm|pnpm|yarn|brew) (install|i|add)\b/.test(cmd)) return t('装依赖', 'Installing');
      return t('跑命令', 'Running a command');
    }
    /* 参数还在流式吐时还没有文件名 */
    case 'write_file': return file ? t(`写 ${file}`, `Writing ${file}`) : t('写文件', 'Writing a file');
    case 'edit_file': case 'edit': return file ? t(`改 ${file}`, `Editing ${file}`) : t('改文件', 'Editing a file');
  }
  return c.sub ? `${c.title} · ${c.sub}` : c.title;
}

/** 你最近一次交代事情的时间 (时间线里最后一条 user_message) */
function lastUserAt(entries: Array<{ type?: string; timestamp?: number }>): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'user_message') return Number(entries[i].timestamp) || 0;
  }
  return 0;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const KICKER: Record<PilotReport['status'], [string, string]> = {
  done: ['刚做完', 'Done'],
  failed: ['没办成', 'Didn\'t work'],
  blocked: ['等你拍板', 'Needs you'],
  progress: ['进展', 'Progress'],
};

export const StageHeadline: React.FC<{
  sessionId: string;
  workspacePath: string;
  streaming: boolean;
  userText: string;
  cards: StageCard[];
}> = ({ sessionId, workspacePath, streaming, userText, cards }) => {
  const { isZh } = useI18n();
  const t = (z: string, e: string) => (isZh ? z : e);
  const feed = useTimelineFeed();
  const plan = useMemo(() => latestPlan((feed ?? []) as TimelineEntry[]), [feed]);
  const reports = usePilotReports();
  const last = reports.find((r) => r.sessionId === sessionId);

  /* 用时: 从这一轮开跑那刻算 */
  const startedAt = useRef<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!streaming) { startedAt.current = null; return undefined; }
    startedAt.current ??= Date.now();
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  const files = useMemo(() => {
    const entries = (feed ?? []) as Array<{ type?: string; filePath?: string; targetPath?: string }>;
    let from = 0;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === 'user_message') { from = i + 1; break; }
    const seen: string[] = [];
    for (const e of entries.slice(from)) {
      if (e.type !== 'file_stream' && e.type !== 'edit_file') continue;
      const raw = String(e.filePath ?? e.targetPath ?? '');
      if (!raw) continue;
      const p = raw.startsWith('/') ? raw : `${workspacePath.replace(/\/$/, '')}/${raw}`;
      if (!seen.includes(p)) seen.push(p);
    }
    return seen.slice(-4);
  }, [feed, workspacePath]);

  if (streaming) {
    const planNow = plan?.steps.find((s) => ACTIVE.has(s.status ?? '')) ?? plan?.steps.find((s) => !DONE.has(s.status ?? ''));
    const title = planName(plan) || taskTitleOf(userText) || t('在想', 'Thinking');
    const running = [...cards].reverse().find((c) => c.status === 'running') ?? cards[cards.length - 1];
    const step = running ? stepOf(running, isZh) : planNow?.content || t('在想怎么办', 'Working out how');
    return (
      <div className="stage-headline is-working" aria-live="polite">
        <div className="stage-headline__kicker"><span className="stage-headline__pulse" aria-hidden />{t('正在做', 'Working on')}</div>
        <div className="stage-headline__title">{title}</div>
        <div className="stage-headline__step">
          <span>{step}</span>
          {startedAt.current != null && <span className="stage-headline__time">{fmtElapsed(now - startedAt.current)}</span>}
        </div>
      </div>
    );
  }

  /* 汇报得是这一轮的 (比你最近交代的那句晚): 不然左边是上一个活的结论、下面却是这一轮的文件 (实录: md2csv 标题配 wordcount 文件) */
  const askedAt = lastUserAt((feed ?? []) as Array<{ type?: string; timestamp?: number }>);
  if (!last || Date.now() - (last.lastAt ?? last.at) > RECENT_MS || (askedAt && (last.lastAt ?? last.at) < askedAt)) return null;
  const [kz, ke] = KICKER[last.status] ?? KICKER.done;
  const gist = last.summary.split(/(?<=[。！？!?.])\s*/)[0] || last.summary;
  const open = (p: string) => {
    const api = (window as unknown as { neox?: { surfaceOpenExternal?: (p: string) => Promise<unknown> } }).neox;
    void api?.surfaceOpenExternal?.(p);
  };
  return (
    <div className={`stage-headline is-${last.status}`}>
      <div className="stage-headline__kicker">{isZh ? kz : ke}</div>
      <div className="stage-headline__title">{last.title}</div>
      {gist && gist !== last.title && <div className="stage-headline__gist">{gist}</div>}
      {files.length > 0 && (
        <div className="stage-headline__files">
          {files.map((p) => (
            <button key={p} type="button" className="stage-headline__file" title={p} onClick={() => open(p)}>
              <S.IconFile size={14} aria-hidden />
              <span>{p.split('/').pop()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
