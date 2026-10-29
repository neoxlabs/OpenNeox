/**
 * PlanSurfaceViewer — 长任务作战图 (markdown + 章节状态 + 导航)
 *
 * 内容是 markdown, 增量靠 update_plan 工具的 5 种 op:
 *   - content / append / replace_section / set_section_status / add_note
 * 章节状态用 `<!-- status: pending|in_progress|done -->` HTML 注释标在 heading 行尾,
 * 这里把注释换成可见徽章再喂 Markdown.
 *
 * 布局:
 *   ┌──────────────────────────────────┐
 *   │  左 nav: ## 章节列表 + 状态点    │  右 body: 完整 markdown
 *   └──────────────────────────────────┘
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Markdown from '../../../components/Markdown';
import type { Surface, PlanSectionStatus } from '../../../state/surfaceStore';
import { useI18n } from '../../../hooks/useI18n';
import { dispatchHint } from '../../../components/notifyEvents';

interface Props {
  surface: Surface;
  workspacePath?: string;
}

interface SectionEntry {
  level: number;
  title: string;
  status: PlanSectionStatus | null;
  slug: string;
}

const STATUS_RE = /<!--\s*status:\s*(pending|in_progress|done)\s*-->/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseSections(content: string): SectionEntry[] {
  const out: SectionEntry[] = [];
  const seen = new Set<string>();
  for (const line of content.split('\n')) {
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const level = m[1].length;
    const sm = STATUS_RE.exec(m[2]);
    const status = (sm?.[1]?.toLowerCase() as PlanSectionStatus | undefined) ?? null;
    const title = m[2].replace(STATUS_RE, '').trim();
    if (!title) continue;
    /* slug 去重: 重复标题加 -2 -3 ... */
    let slug = slugify(title);
    let n = 1;
    while (seen.has(slug)) { n++; slug = `${slugify(title)}-${n}`; }
    seen.add(slug);
    out.push({ level, title, status, slug });
  }
  return out;
}

/** 把 markdown 内容里的 status 注释换成可见 HTML 徽章, 并给 heading 加 id 锚点(用 setext 不支持, 改用注入 anchor span 思路太复杂 — 让浏览器 scrollIntoView 用 querySelectorAll 找 heading text) */
function transformContent(content: string): string {
  return content.split('\n').map((line) => {
    const m = HEADING_RE.exec(line);
    if (!m) return line;
    const sm = STATUS_RE.exec(m[2]);
    if (!sm) return line;
    const status = sm[1].toLowerCase() as PlanSectionStatus;
    const titleClean = m[2].replace(STATUS_RE, '').trimEnd();
    const badge = `<span class="plan-badge plan-badge--${status}" title="${status}"></span>`;
    return `${m[1]} ${titleClean} ${badge}`;
  }).join('\n');
}

function readSource(surface: Surface): Promise<string> {
  if (surface.source.type === 'inline') return Promise.resolve(surface.source.content);
  if (surface.source.type === 'file') {
    const api = (window as any).neox;
    const reader = api?.surfaceReadFile ?? api?.readFile;
    if (!reader) return Promise.reject(new Error('neox.surfaceReadFile not available'));
    return reader(surface.source.path).then((res: any) => {
      if (res?.success === false) throw new Error(res.error || 'read failed');
      return typeof res === 'string' ? res : (res?.content ?? '');
    });
  }
  return Promise.reject(new Error('plan surface only supports inline or file source'));
}

export const PlanSurfaceViewer: React.FC<Props> = ({ surface, workspacePath }) => {
  const { isZh } = useI18n();
  const [raw, setRaw] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  const copyPlan = useCallback(() => {
    if (!raw) return;
    navigator.clipboard.writeText(raw).then(
      () => dispatchHint(isZh ? '已复制方案 Markdown' : 'Plan markdown copied', 'success'),
      () => dispatchHint(isZh ? '复制失败' : 'Copy failed', 'warning'),
    );
  }, [raw, isZh]);

  useEffect(() => {
    let cancelled = false;
    readSource(surface)
      .then((txt) => { if (!cancelled) { setRaw(txt); setError(null); } })
      .catch((err: any) => { if (!cancelled) setError(err?.message || String(err)); });
    return () => { cancelled = true; };
  }, [surface.source, surface.updatedAt]);

  const sections = useMemo(() => parseSections(raw), [raw]);
  const transformed = useMemo(() => transformContent(raw), [raw]);
  const basePath = surface.source.type === 'file' ? surface.source.path : undefined;

  /* 进度统计 — 算 done / 总数, 忽略没标状态的 heading */
  const progress = useMemo(() => {
    const tracked = sections.filter(s => s.status !== null);
    const done = tracked.filter(s => s.status === 'done').length;
    return { done, total: tracked.length };
  }, [sections]);

  const scrollToSection = (title: string, slug: string) => {
    const root = document.querySelector('.sfc-plan__body');
    if (!root) return;
    /* 在 body 里找匹配 heading 文本(去掉 badge span) — 用 textContent 包含匹配 */
    const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const h of Array.from(headings)) {
      const txt = (h.textContent || '').trim();
      if (txt.startsWith(title) || txt === title) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveSlug(slug);
        return;
      }
    }
  };

  if (error) {
    return (
      <div className="sfc-empty sfc-empty--error">
        <div className="sfc-empty__title">{isZh ? '无法加载方案' : 'Failed to load plan'}</div>
        <div className="sfc-empty__msg">{error}</div>
      </div>
    );
  }
  if (!raw) {
    return (
      <div className="sfc-empty">
        <div className="sfc-empty__title">{isZh ? '还没有方案' : 'No plan yet'}</div>
        <div className="sfc-empty__msg">{isZh ? 'Agent 开始规划后, 步骤会出现在这里' : 'Steps appear here once the agent starts planning'}</div>
      </div>
    );
  }

  return (
    <div className="sfc-plan">
      <aside className="sfc-plan__nav" aria-label={isZh ? '章节导航' : 'Section navigation'}>
        {progress.total > 0 && (
          <div className="sfc-plan__progress">
            <div className="sfc-plan__progress-bar">
              <div
                className="sfc-plan__progress-fill"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
            <div className="sfc-plan__progress-label">
              <span>{isZh ? `${progress.done} / ${progress.total} 阶段完成` : `${progress.done} / ${progress.total} stages done`}</span>
              <button
                type="button"
                className="sfc-plan__copy-btn"
                onClick={copyPlan}
                title={isZh ? '复制方案 Markdown 原文' : 'Copy plan markdown'}
                aria-label={isZh ? '复制方案' : 'Copy plan'}
              >
                <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
                  <path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" />
                </svg>
              </button>
            </div>
          </div>
        )}
        {progress.total === 0 && (
          <div className="sfc-plan__progress">
            <div className="sfc-plan__progress-label">
              <span>{isZh ? '方案' : 'Plan'}</span>
              <button
                type="button"
                className="sfc-plan__copy-btn"
                onClick={copyPlan}
                title={isZh ? '复制方案 Markdown 原文' : 'Copy plan markdown'}
                aria-label={isZh ? '复制方案' : 'Copy plan'}
              >
                <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
                  <path d="M2.5 9.5V3a1 1 0 0 1 1-1H9" />
                </svg>
              </button>
            </div>
          </div>
        )}
        <ul className="sfc-plan__navlist">
          {sections.map((s) => (
            <li
              key={s.slug}
              className={`sfc-plan__navitem sfc-plan__navitem--l${Math.min(s.level, 4)}${activeSlug === s.slug ? ' is-active' : ''}`}
            >
              <button
                type="button"
                className="sfc-plan__navbtn"
                onClick={() => scrollToSection(s.title, s.slug)}
              >
                <span className={`plan-badge plan-badge--${s.status ?? 'none'}`} aria-hidden="true" />
                <span className="sfc-plan__navtitle">{s.title}</span>
              </button>
            </li>
          ))}
          {sections.length === 0 && (
            <li className="sfc-plan__navempty">{isZh ? '尚无章节 — 用 ## / ### 写章节标题' : 'No sections yet — use ## / ### headings'}</li>
          )}
        </ul>
      </aside>
      <div className="sfc-plan__body">
        <Markdown content={transformed} basePath={basePath} workspacePath={workspacePath} />
      </div>
    </div>
  );
};

export default PlanSurfaceViewer;
