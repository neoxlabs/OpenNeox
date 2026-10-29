/* ============================================================
 * KindHomeView — 所有 surface kind 的统一 home 引导页
 *
 *   一套 .sfc-landing 结构: hero icon + 标题 + 描述 + 多个 CTA.
 *   配置在 KIND_CONFIGS, 加 kind 加一条即可.
 *
 *   行为:
 *     · CTA onClick 闭包里访问 sessionId / workspacePath
 *     · CTA 自决: 直接调 action (openExistingPdf/openExistingDocx/...) 或 dispatch 'neox:open-surface'
 *
 *   sheet/docx/pdf 历史上各有 SheetHomeView/DocxHomeView/PdfHomeView 三份重复样板, 现在合一.
 * ============================================================ */

import React from 'react';
import type { SurfaceKind } from '../../../state/surfaceStore';
import { openSurfaceFromPath } from '../../../state/openSurfaceFromPath';
import { createBlankSheet, openExistingSheet } from '../../../state/sheetActions';
import { openExistingDocx } from '../../../state/docxActions';
import { openExistingPdf } from '../../../state/pdfActions';
import { useI18n } from '../../../hooks/useI18n';
import { NeoxIllus } from '../../../media/illus';

interface HomeAction {
  label: string;
  hint: string;
  iconPath?: React.ReactNode;
  /** true → primary 玻璃拟态强调色按钮; 一个 home 最多一个 primary. */
  primary?: boolean;
  onClick: (ctx: { sessionId: string; workspacePath?: string; surfaceId: string }) => void;
}

interface HomeConfig {
  hero: React.ReactNode;
  title: string;
  desc: string;
  actions: HomeAction[];
}

const illusHero = (src: string) => (
  <img className="sfc-kind-home__art" src={src} alt="" aria-hidden draggable={false} />
);
const ctaIcon = (path: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);

/* 常用 CTA icon — 重复构造太啰嗦, 提到顶层. */
const ICON_OPEN_FILE = ctaIcon(<path d="M3 7 a2 2 0 0 1 2 -2 H9 L11 7 H19 a2 2 0 0 1 2 2 V17 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z" />);
const ICON_PLUS = ctaIcon(<><path d="M12 5 V19" /><path d="M5 12 H19" /></>);

function getKindConfigs(isZh: boolean): Partial<Record<SurfaceKind, HomeConfig>> {
  return {
    code: {
      hero: illusHero(NeoxIllus.code),
      title: isZh ? '源码' : 'Code',
      desc: isZh ? '浏览源码, 语法高亮 + 搜索' : 'Browse source with syntax highlighting and search',
      actions: [
        {
          label: isZh ? '打开文件' : 'Open file',
          hint: '',
          iconPath: ICON_OPEN_FILE,
          primary: true,
          onClick: async ({ sessionId, workspacePath }) => {
            const api = (window as any).neox;
            if (!api?.openFileDialog) return;
            const picked = await api.openFileDialog({
              defaultPath: workspacePath,
              filters: [
                { name: 'Source code', extensions: ['ts','tsx','js','jsx','mjs','cjs','py','go','rs','java','kt','c','h','cpp','cs','rb','php','swift','sh','yml','yaml','toml','xml','sql','css','scss','less','html','vue','svelte','json','jsonc','json5','md'] },
                { name: 'All Files', extensions: ['*'] },
              ],
            });
            if (picked) openSurfaceFromPath({ sessionId, path: picked, workspacePath });
          },
        },
      ],
    },

    sheet: {
      hero: illusHero(NeoxIllus.sheet),
      title: isZh ? '表格' : 'Sheet',
      desc: isZh ? '新建或打开 .xlsx / .csv 文件' : 'Create or open .xlsx / .csv files',
      actions: [
        {
          label: isZh ? '新建表格' : 'New sheet',
          hint: '',
          iconPath: ICON_PLUS,
          primary: true,
          onClick: ({ sessionId, workspacePath }) => { void createBlankSheet({ sessionId, workspacePath }); },
        },
        {
          label: isZh ? '打开表格' : 'Open sheet',
          hint: '',
          iconPath: ICON_OPEN_FILE,
          onClick: ({ sessionId, workspacePath }) => { void openExistingSheet({ sessionId, workspacePath }); },
        },
      ],
    },

    docx: {
      hero: illusHero(NeoxIllus.docx),
      title: 'Word',
      desc: isZh ? '打开 .docx 文件查看' : 'Open .docx files to view',
      actions: [
        {
          label: isZh ? '打开 Word' : 'Open Word',
          hint: '',
          iconPath: ICON_OPEN_FILE,
          primary: true,
          onClick: ({ sessionId, workspacePath }) => { void openExistingDocx({ sessionId, workspacePath }); },
        },
      ],
    },

    pdf: {
      hero: illusHero(NeoxIllus.pdf),
      title: 'PDF',
      desc: isZh ? '打开 .pdf 文件浏览' : 'Open .pdf files to browse',
      actions: [
        {
          label: isZh ? '打开 PDF' : 'Open PDF',
          hint: '',
          iconPath: ICON_OPEN_FILE,
          primary: true,
          onClick: ({ sessionId, workspacePath }) => { void openExistingPdf({ sessionId, workspacePath }); },
        },
      ],
    },

    pptx: {
      hero: illusHero(NeoxIllus.pptx),
      title: 'PowerPoint',
      desc: isZh ? '打开 .pptx / .ppt · 首次使用会自动下载渲染引擎 (~350MB)' : 'Open .pptx / .ppt · first use downloads the render engine (~350MB)',
      actions: [
        {
          label: isZh ? '打开 PPT' : 'Open PPT',
          hint: '',
          iconPath: ICON_OPEN_FILE,
          primary: true,
          onClick: async ({ sessionId, workspacePath }) => {
            const api = (window as any).neox;
            const picked = await api.openFileDialog?.({
              defaultPath: workspacePath,
              filters: [
                { name: 'PowerPoint', extensions: ['pptx', 'ppt', 'pptm', 'pps', 'ppsx', 'ppsm', 'potx', 'potm', 'odp'] },
                { name: 'All Files', extensions: ['*'] },
              ],
            });
            if (picked) openSurfaceFromPath({ sessionId, path: picked, workspacePath });
          },
        },
      ],
    },

    web: {
      hero: illusHero(NeoxIllus.web),
      title: isZh ? '浏览器' : 'Browser',
      desc: isZh ? '内嵌浏览器, 支持多标签页' : 'Embedded browser with tabs',
      actions: [
        {
          label: isZh ? '新建标签页' : 'New tab',
          hint: '',
          iconPath: ICON_PLUS,
          primary: true,
          onClick: ({ sessionId }) => {
            window.dispatchEvent(new CustomEvent('neox:open-surface', {
              detail: { kind: 'web', source: { type: 'url', url: 'about:blank' }, title: isZh ? '新标签页' : 'New tab', sessionId, byUser: true },
            }));
          },
        },
      ],
    },

    plan: {
      hero: illusHero(NeoxIllus.board),
      title: isZh ? '方案画布' : 'Plan canvas',
      desc: isZh ? '章节 + 状态, 实时更新' : 'Sections and status, updated live',
      actions: [
        {
          label: isZh ? '新建方案' : 'New plan',
          hint: '',
          iconPath: ICON_PLUS,
          primary: true,
          onClick: ({ sessionId }) => {
            window.dispatchEvent(new CustomEvent('neox:open-surface', {
              detail: {
                kind: 'plan', title: isZh ? '方案' : 'Plan',
                source: { type: 'inline', content: isZh ? '# 方案\n\n' : '# Plan\n\n', mime: 'text/markdown' },
                sessionId, byUser: true,
              },
            }));
          },
        },
      ],
    },

    todo: {
      hero: illusHero(NeoxIllus.task),
      title: isZh ? '清单' : 'Todo',
      desc: isZh ? 'Agent 自动维护进度' : 'The agent keeps progress in sync',
      actions: [
        {
          label: isZh ? '新建清单' : 'New todo',
          hint: '',
          iconPath: ICON_PLUS,
          primary: true,
          onClick: ({ sessionId }) => {
            window.dispatchEvent(new CustomEvent('neox:open-surface', {
              detail: {
                kind: 'todo', title: isZh ? '清单' : 'Todo',
                source: { type: 'inline', content: isZh ? '[ ] 第一项\n' : '[ ] First item\n', mime: 'text/markdown' },
                sessionId, byUser: true,
              },
            }));
          },
        },
      ],
    },
  };
}

interface Props {
  kind: SurfaceKind;
  sessionId: string;
  surfaceId: string;
  workspacePath?: string;
}

export const KindHomeView: React.FC<Props> = ({ kind, sessionId, surfaceId, workspacePath }) => {
  const { isZh } = useI18n();
  const cfg = getKindConfigs(isZh)[kind];
  if (!cfg) {
    return (
      <div className="sfc-landing sfc-kind-home">
        <div className="sfc-landing__title">{isZh ? `${kind} 暂无引导页` : `No home view for ${kind}`}</div>
      </div>
    );
  }
  return (
    <div className="sfc-landing sfc-kind-home">
      <div className="sfc-landing__hero">{cfg.hero}</div>
      <h2 className="sfc-landing__title">{cfg.title}</h2>
      <p className="sfc-landing__desc">{cfg.desc}</p>
      <div className="sfc-kind-home__actions">
        {cfg.actions.map((a, i) => (
          <button
            key={i}
            type="button"
            className={`sfc-kind-home__btn${a.primary ? ' sfc-kind-home__btn--primary' : ''}`}
            onClick={() => a.onClick({ sessionId, workspacePath, surfaceId })}
          >
            {a.iconPath && (
              <span className="sfc-kind-home__btn-icon" aria-hidden="true">{a.iconPath}</span>
            )}
            <span className="sfc-kind-home__btn-label">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default KindHomeView;
