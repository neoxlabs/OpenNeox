import React from 'react';
import { Icon, addCollection } from '@iconify/react';
import { jbIcons } from './jbIconRegistry.generated';

const defaultIconProps = { width: 20, height: 20 };
const logoIconProps = { width: 24, height: 24 };
type SvgIconProps = React.SVGProps<SVGSVGElement>;

/* ==================== IDEA expUI tool window icons (iconify) ====================
 * 通过 jbIconRegistry.generated.ts 离线注入,直接复用 IDEA 2026.1 真 SVG。
 * Apache 2.0 (JetBrains)。命名 jb:toolwindows-{name}-dark
 *
 * addCollection 是幂等的,跟 FileTypeIcons.tsx 重复调用无副作用。 */
let __jbRegistered = false;
function ensureJbRegistered() {
  if (__jbRegistered) return;
  addCollection(jbIcons as any);
  __jbRegistered = true;
}
ensureJbRegistered();

const useIsDark = (): boolean => {
  const [dark, setDark] = React.useState(() => {
    if (typeof document === 'undefined') return true;
    return document.documentElement.getAttribute('data-theme') !== 'light';
  });
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const update = () => setDark(root.getAttribute('data-theme') !== 'light');
    const obs = new MutationObserver(update);
    obs.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    update();
    return () => obs.disconnect();
  }, []);
  return dark;
};

/** 暗色感知的 jb tool window 图标。Neox 默认 dark mode → -dark 变体。 */
const TW: React.FC<{ name: string; size?: number }> = ({ name, size = 24 }) => {
  const isDark = useIsDark();
  const finalName = isDark ? `jb:toolwindows-${name}-dark` : `jb:toolwindows-${name}`;
  return <Icon icon={finalName} width={size} height={size} />;
};

/** 暗色感知的 jb general action 图标 (工具窗 header 上的小按钮)。 */
const GEN: React.FC<{ name: string; size?: number }> = ({ name, size = 16 }) => {
  const isDark = useIsDark();
  const finalName = isDark ? `jb:general-${name}-dark` : `jb:general-${name}`;
  return <Icon icon={finalName} width={size} height={size} />;
};

/** 暗色感知的 jb actions 图标 (复合动作图标,带状态徽章)。 */
const ACT: React.FC<{ name: string; size?: number }> = ({ name, size = 16 }) => {
  const isDark = useIsDark();
  const finalName = isDark ? `jb:actions-${name}-dark` : `jb:actions-${name}`;
  return <Icon icon={finalName} width={size} height={size} />;
};

const Icons = {
  Link: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M8 12l4-4M6.5 8.5l-2 2a3.5 3.5 0 005 5l2-2M13.5 11.5l2-2a3.5 3.5 0 00-5-5l-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Paperclip: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M7 10.5l5-5a2.5 2.5 0 013.5 3.5l-6 6a4 4 0 01-5.5-5.5l6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Image: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="4" width="14" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="8" r="1.5" fill="currentColor" />
      <path d="M3 13l4-4 3 3 4-4 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Mic: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 9a5 5 0 0010 0M10 14.5V17M7.5 17h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Code: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M14 4 10 20"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Brain: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path d="M12 5c-1.5 0-2.7.8-3.4 2-.7-.3-1.4-.5-2.1-.5C4 6.5 2 8.5 2 11c0 1.5.7 2.8 1.8 3.7-.5.8-.8 1.8-.8 2.8 0 2.5 2 4.5 4.5 4.5.8 0 1.6-.2 2.3-.5.7 1.2 2 2 3.2 2s2.5-.8 3.2-2c.7.3 1.5.5 2.3.5 2.5 0 4.5-2 4.5-4.5 0-1-.3-2-.8-2.8 1.1-.9 1.8-2.2 1.8-3.7 0-2.5-2-4.5-4.5-4.5-.7 0-1.4.2-2.1.5-.7-1.2-1.9-2-3.4-2z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  Eye: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
  Sidebar: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="2" y="3" width="16" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3v14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  PanelRight: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="2" y="3" width="16" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 3v14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Layout: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="11" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Terminal: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="m7 9 3 3-3 3M12 15h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  File: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M3 1.5h6.5L13 5v9a0.5 0.5 0 0 1-0.5 0.5H3a0.5 0.5 0 0 1-0.5-0.5V2A0.5 0.5 0 0 1 3 1.5z" fill="#dfe1e5" fillOpacity="0.18" stroke="#9aa0a6" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M9 1.5V5h4" stroke="#9aa0a6" strokeWidth="1" strokeLinejoin="round"/>
    </svg>
  ),
  Folder: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M3 7 a2 2 0 0 1 2 -2 h4 l2 2 h8 a2 2 0 0 1 2 2 v9 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 V7 z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  ),
  FolderTree: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M3 7.2A1.2 1.2 0 0 1 4.2 6h4l1.6 1.8h10A1.2 1.2 0 0 1 21 9v8.8a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 17.8z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Chat: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M21 11.5a8.4 8.4 0 0 1-1 4 8.5 8.5 0 0 1-7.5 4.5 8.4 8.4 0 0 1-4-1L3 20l1-5a8.4 8.4 0 0 1-1-4 8.5 8.5 0 0 1 4.5-7.5 8.4 8.4 0 0 1 4-1H12a8.5 8.5 0 0 1 8 8z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Branch: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <circle cx="7" cy="5" r="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="7" cy="19" r="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="17" cy="7" r="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 7v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M17 9v.5a4 4 0 0 1-4 4H9.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  More: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="6" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="18" r="1.4" fill="currentColor" />
    </svg>
  ),
  Collapse: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M5 9l3-3 3 3M5 15l3 3 3-3M13 9l3-3 3 3M13 15l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Bell: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M18 16V10a6 6 0 1 0-12 0v6l-1.5 2a.5.5 0 0 0 .4.8h14.2a.5.5 0 0 0 .4-.8z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M10 21a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  Sparkles: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M10 3c.5 3.5 2 5 5.5 5.5C12 9 10.5 10.5 10 14c-.5-3.5-2-5-5.5-5.5C8 8 9.5 6.5 10 3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M17.5 13.5c.3 2 1.2 2.9 3 3.2-1.8.3-2.7 1.2-3 3.2-.3-2-1.2-2.9-3-3.2 1.8-.3 2.7-1.2 3-3.2z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Plus: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Send: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 17V5M6 9l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  User: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="6" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 18c0-4 3.5-7 7-7s7 3 7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Bot: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="5" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="10" r="1.5" fill="currentColor" />
      <circle cx="13" cy="10" r="1.5" fill="currentColor" />
    </svg>
  ),
  Home: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M3 10l7-7 7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 8v8a1 1 0 001 1h8a1 1 0 001-1V8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Trash: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M6 6v10a1 1 0 001 1h6a1 1 0 001-1V6M4 6h12M8 6V4a1 1 0 011-1h2a1 1 0 011 1v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Delete: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M6 6v10a1 1 0 001 1h6a1 1 0 001-1V6M4 6h12M8 6V4a1 1 0 011-1h2a1 1 0 011 1v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Settings: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2.2v1.9M10 15.9v1.9M17.8 10h-1.9M4.1 10H2.2M15.51 4.49l-1.34 1.34M5.83 14.17l-1.34 1.34M15.51 15.51l-1.34-1.34M5.83 5.83L4.49 4.49"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="10" cy="10" r="6.4" stroke="currentColor" strokeWidth="1.5" opacity="0.45" />
    </svg>
  ),
  /* 导出 —— 原来跟 Upload 一模一样 (向上箭头 + 底线), 在技能卡片上读作"上传",
   *   而那颗按钮干的是"把这个技能导出成文件"。改成箭头**从盒子里出去**: 盒子=技能,
   *   箭头=出去。跟 Upload (往上传) / Download (往下拉) 三个各自成义。 */
  Export: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M11.5 3.5H5A1.5 1.5 0 0 0 3.5 5v10A1.5 1.5 0 0 0 5 16.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 11l7.5-7.5M12.5 3.5h4v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  /* ── 技能附带内容的三个标记 (导入清单里用) ───────────────────────
   *   references / scripts / agents 是 skill 的约定子目录。导入前把这三样摆出来,
   *   用户才知道自己拿到的是"一页说明"还是"一套带脚本和子 agent 的东西"。
   *   都画在 20 网格、1.5 描边, 跟这一族其它图标同一副骨架。 */
  AssetDoc: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M11.5 2.5H6A1.5 1.5 0 0 0 4.5 4v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5l-4-4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11.5 2.5v4h4M7.5 11h5M7.5 13.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  AssetScript: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 8.5l2.2 2.2L6 12.9M10.5 13h3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  AssetAgent: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <rect x="3.5" y="6.5" width="13" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3.2v3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="2.6" r="1.1" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.6 10.4v1.4M12.4 10.4v1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ChevronDown: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Robot: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="4" y="6" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7.5" cy="10" r="1.5" fill="currentColor" />
      <circle cx="12.5" cy="10" r="1.5" fill="currentColor" />
      <path d="M8 13h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 3v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="2" r="1" fill="currentColor" />
    </svg>
  ),
  Metrics: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M3 17V7l4 4 3-6 4 5 3-4v11H3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
    </svg>
  ),
  Battery: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="6" width="13" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="16.5" y="8.5" width="1.5" height="3" rx="0.5" fill="currentColor" />
      <path d="M5.5 10h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  // 深度思考图标 (大脑 + 闪电)
  Thinking: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 2C6.5 2 4 4.5 4 7.5c0 1.5.5 2.5 1.5 3.5.5.5 1 1.5 1 2.5V15h7v-1.5c0-1 .5-2 1-2.5 1-1 1.5-2 1.5-3.5C16 4.5 13.5 2 10 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 15v1.5a2 2 0 002 2 2 2 0 002-2V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 6v2M8 8l2-2 2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Close: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  X: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  /* Minimize 图标统一在下方 (IDEA tool window 最小化) 定义 —— 这里曾有重复 key,
   * JS 后者覆盖前者 (esbuild "Duplicate key" warning), 删掉被覆盖的早定义。 */
  Edit: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M13 3l4 4-9 9H4v-4l9-9z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  Check: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 10l4 4 8-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Copy: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="6" y="6" width="10" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 14V4a2 2 0 012-2h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Loader: () => (
    <svg {...defaultIconProps} className="neox-spin" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="6.5" stroke="currentColor" strokeWidth="1.5" opacity="0.18" />
      <path d="M10 3.5a6.5 6.5 0 0 1 5.27 2.69" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Key: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="7" cy="13" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.5 10.5L17 3M17 3v3M17 3h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Sun: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  Moon: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M21 14.5A9 9 0 1 1 9.5 3a7.5 7.5 0 0 0 11.5 11.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  AutoTheme: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 5a7 7 0 0 1 0 14z" fill="currentColor" fillOpacity="0.4" />
    </svg>
  ),
  Pause: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="5" y="4" width="3" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="12" y="4" width="3" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Stop: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  ),
  Retry: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 10a6 6 0 0111.197-2.986M16 10a6 6 0 01-11.197 2.986" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  RefreshCw: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 10a6 6 0 0111.197-2.986M16 10a6 6 0 01-11.197 2.986" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Play: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M6 4l10 6-10 6V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  StepOver: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M4 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 4l2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 14h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  StepInto: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M10 4v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 10l2 2 2-2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  StepOut: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M4 16h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 16V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 10l2-2 2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Lightbulb: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 2a5 5 0 00-3 9v2a1 1 0 001 1h4a1 1 0 001-1v-2a5 5 0 00-3-9zM8 16h4M9 18h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Lock: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="4" y="9" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 9V6a3 3 0 016 0v3" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Wifi: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M3.5 9.5a10 10 0 0113 0M6.5 12.5a6 6 0 017 0M10 16.5a1 1 0 100-2 1 1 0 000 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Cloud: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M5.5 15a3.5 3.5 0 0 1-.8-6.9 4.5 4.5 0 0 1 8.6-1.3 3.5 3.5 0 0 1 .9 7H5.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Filter: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M3 5h14M5 10h10M7 15h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Replace: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 7h12M4 13h12M15 4l3 3-3 3M5 10l-3 3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Pin: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M12 2L8 6l-1 5 5-1 4-4M2 18l5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  AlertCircle: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v5M10 14h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Circle: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <circle cx="10" cy="10" r="6" fill="currentColor" />
    </svg>
  ),
  XCircle: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ExternalLink: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M15 10.5v4.5a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h4.5M12 3h5v5M8 12l9-9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  FolderOpen: () => (
    /* JetBrains New UI: 灰蓝填充 open folder (与 closed 相同样式,展开靠 chevron 区分) */
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.2a1 1 0 0 1 0.7 0.3l1 1a1 1 0 0 0 0.7 0.3h5.4a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5z"
        fill="#5c6470"
        stroke="#7a828e"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path
        d="M1.5 6.5h13"
        stroke="#3b4250"
        strokeWidth="0.8"
      />
    </svg>
  ),
  FolderPlus: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M3 5a2 2 0 012-2h3.586a1 1 0 01.707.293l1.414 1.414A1 1 0 0011.414 5H15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 9v4M8 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Refresh: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 10a6 6 0 0111.197-2.986M16 10a6 6 0 01-11.197 2.986" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M15 3v4h-4M5 17v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Chart: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="10" width="3" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="8.5" y="6" width="3" height="11" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="14" y="3" width="3" height="14" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Tools: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path
        d="M14.7 5.3a4.5 4.5 0 01-5.8 5.8l-4.7 4.7a2 2 0 102.8 2.8l4.7-4.7a4.5 4.5 0 005.8-5.8l-2 2-2-2 2-2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Hub: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14" cy="6" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="14" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 6h4M7 7.5l3 5M13 7.5l-3 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Plugin: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path
        d="M13.5 3.5a1.5 1.5 0 1 0-3 0v2H6.5A1.5 1.5 0 0 0 5 7v4h2a1.75 1.75 0 1 1 0 3.5H5V18.5A1.5 1.5 0 0 0 6.5 20H10v-2a1.75 1.75 0 1 1 3.5 0v2H17a1.5 1.5 0 0 0 1.5-1.5v-4h-2a1.75 1.75 0 1 1 0-3.5h2V7A1.5 1.5 0 0 0 17 5.5h-3.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Undo: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 8h10a4 4 0 110 8H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 5L4 8l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Redo: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M16 8H6a4 4 0 100 8h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M13 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  History: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v4l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 10a7 7 0 017-7M3 3v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Clock: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6v4l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Rollback: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 10a6 6 0 116 6H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 13l-3 3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2" fill="currentColor" />
    </svg>
  ),
  Search: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="m13.2 13.2 3.3 3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  FilePlus: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 4a2 2 0 012-2h5l5 5v9a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M11 2v5h5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 10v4M8 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Globe: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 10h14M10 3c-2.5 2-4 4.5-4 7s1.5 5 4 7c2.5-2 4-4.5 4-7s-1.5-5-4-7z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  WebSearch: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 8h10M8 3c-1.5 1.2-2.5 3-2.5 5s1 3.8 2.5 5c1.5-1.2 2.5-3 2.5-5s-1-3.8-2.5-5z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 12l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Download: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 3v10M6 9l4 4 4-4M4 17h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronRight: (props: SvgIconProps) => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none" {...props}>
      <path d="M7 5l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronLeft: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M13 5l-5 5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  TypeScript: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="14" height="14" rx="1.5" fill="#3178c6"/>
      <text x="2.6" y="12" fill="#fff" fontSize="6.5" fontWeight="700" fontFamily="-apple-system,sans-serif">TS</text>
    </svg>
  ),
  JavaScript: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="14" height="14" rx="1.5" fill="#f7df1e"/>
      <text x="3" y="12" fill="#222" fontSize="6.5" fontWeight="700" fontFamily="-apple-system,sans-serif">JS</text>
    </svg>
  ),
  Python: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5c-3 0-3 1.5-3 1.5v1.5h3v0.7H4S2 4.7 2 7.7s1.5 3 1.5 3H5V9.2s0-1.5 1.5-1.5h3s1.5 0 1.5-1.5V3S11 1.5 8 1.5zM6.4 2.8a0.75 0.75 0 1 1 0 1.5 0.75 0.75 0 0 1 0-1.5z" fill="#3776ab"/>
      <path d="M8 14.5c3 0 3-1.5 3-1.5v-1.5H8v-0.7h4S14 11.3 14 8.3s-1.5-3-1.5-3H11V6.8s0 1.5-1.5 1.5h-3S5 8.3 5 9.8V13s0 1.5 3 1.5zm1.6-1.3a0.75 0.75 0 1 1 0-1.5 0.75 0.75 0 0 1 0 1.5z" fill="#ffd43b"/>
    </svg>
  ),
  Java: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M5.5 4s-0.4 1.6 1.5 2.8c1.6 1 2 2 2 2s0.8-1.2-0.8-2.4C6.2 5 5.5 4 5.5 4z" fill="#e76f00"/>
      <path d="M7 8.2s-1.2 0.8 0.8 1.2c2.4 0.4 3.6-0.4 3.6-0.4s-0.4 0.6-2 0.8c-2 0.24-4-0.8-2.4-1.6z" fill="#5382a1"/>
      <path d="M4.5 10.5s-0.4 0.4 0.8 0.56c2 0.24 4.8 0 4.8-0.96 0 0-0.4 0.4-2.4 0.56-2.4 0.16-3.2-0.16-3.2-0.16z" fill="#5382a1"/>
      <path d="M5.5 12.2s-0.24 0.4 0.8 0.4c1.6 0.16 4 0 4-0.64 0 0-0.24 0.32-2 0.4-2 0.16-2.8-0.16-2.8-0.16z" fill="#5382a1"/>
      <path d="M11 13.5s0.5 0.4-0.6 0.7c-2 0.6-8.6 0.8-10.4 0 0 0 0.4 0.3 0.8 0.4 0 0 4 0.5 9 0 1-0.1 1.5-0.4 1.5-0.4s-0.2-0.4-0.3-0.7z" fill="#5382a1"/>
    </svg>
  ),
  Go: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3" width="14" height="10" rx="1.5" fill="#00add8"/>
      <text x="2.5" y="11" fill="#fff" fontSize="5.5" fontWeight="700" fontFamily="-apple-system,sans-serif">GO</text>
    </svg>
  ),
  Rust: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3" width="14" height="10" rx="1.5" fill="#dea584"/>
      <text x="2.5" y="11" fill="#222" fontSize="5.5" fontWeight="700" fontFamily="-apple-system,sans-serif">RS</text>
    </svg>
  ),
  Json: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M3 1.5h6.5L13 5v9a0.5 0.5 0 0 1-0.5 0.5H3a0.5 0.5 0 0 1-0.5-0.5V2A0.5 0.5 0 0 1 3 1.5z" fill="#fff" stroke="#cbcb41" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M9 1.5V5h4" stroke="#cbcb41" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M6.2 7.5c-0.6 0-0.8 0.4-0.8 0.8v1.4c0 0.4-0.4 0.6-0.4 0.6s0.4 0.2 0.4 0.6v1.4c0 0.4 0.2 0.8 0.8 0.8" stroke="#cbcb41" strokeWidth="0.9" fill="none" strokeLinecap="round"/>
      <path d="M9.8 7.5c0.6 0 0.8 0.4 0.8 0.8v1.4c0 0.4 0.4 0.6 0.4 0.6s-0.4 0.2-0.4 0.6v1.4c0 0.4-0.2 0.8-0.8 0.8" stroke="#cbcb41" strokeWidth="0.9" fill="none" strokeLinecap="round"/>
    </svg>
  ),
  Css: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M2 1.5h12l-1.1 11.8L8 14.8l-4.9-1.5L2 1.5z" fill="#264de4" stroke="#1a3aa8" strokeWidth="0.6" strokeLinejoin="round"/>
      <path d="M11.8 4.5H5.6l0.15 1.5h6.05l-0.4 4.4-3.4 0.95v0l-3.4-0.95-0.2-2.4h1.55l0.1 1.2 1.95 0.55 1.95-0.55 0.2-2.3H4.85L4.5 3h7.45l-0.15 1.5z" fill="#fff"/>
    </svg>
  ),
  Html: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M2 1.5h12l-1.1 11.8L8 14.8l-4.9-1.5L2 1.5z" fill="#e34c26" stroke="#a8341a" strokeWidth="0.6" strokeLinejoin="round"/>
      <path d="M11.8 4.5H5.6l0.15 1.5h6.05l-0.4 4.4-3.4 0.95v0l-3.4-0.95-0.2-2.4h1.55l0.1 1.2 1.95 0.55 1.95-0.55 0.2-2.3H4.85L4.5 3h7.45l-0.15 1.5z" fill="#fff"/>
    </svg>
  ),
  Markdown: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="3.5" width="14" height="9" rx="1" fill="#fff" stroke="#42a5f5" strokeWidth="1"/>
      <path d="M3 11V5l2 2.5L7 5v6M9.5 8.5l1.5 1.8 1.5-1.8M11 11V7" stroke="#42a5f5" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  ),
  Yaml: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M3 1.5h6.5L13 5v9a0.5 0.5 0 0 1-0.5 0.5H3a0.5 0.5 0 0 1-0.5-0.5V2A0.5 0.5 0 0 1 3 1.5z" fill="#fff" stroke="#c54a3a" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M9 1.5V5h4" stroke="#c54a3a" strokeWidth="1" strokeLinejoin="round"/>
      <text x="3.2" y="12.5" fill="#c54a3a" fontSize="4.5" fontWeight="bold" fontFamily="-apple-system,sans-serif">YML</text>
    </svg>
  ),
  /* JB 蓝色 sources root 文件夹 — 蓝色填充 + 浅色顶边 */
  FolderSources: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.2a1 1 0 0 1 0.7 0.3l1 1a1 1 0 0 0 0.7 0.3h5.4a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5z"
        fill="#3b73e8"
        stroke="#1e54c4"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M1.5 6.5h13" stroke="#1a44a8" strokeWidth="0.8" />
    </svg>
  ),
  /* Maven / Gradle 模块文件夹 — JB 灰蓝文件夹 + 右下蓝小点 (module marker) */
  FolderModule: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.2a1 1 0 0 1 0.7 0.3l1 1a1 1 0 0 0 0.7 0.3h5.4a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5z"
        fill="#5c6470"
        stroke="#7a828e"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M1.5 6.5h13" stroke="#3b4250" strokeWidth="0.8" />
      <circle cx="12.5" cy="11.5" r="2.2" fill="#3b73e8" stroke="#1e1f22" strokeWidth="0.8" />
    </svg>
  ),
  /* JB 排除文件夹 — 棕色填充 */
  FolderExcluded: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4.5A1 1 0 0 1 2.5 3.5h3.2a1 1 0 0 1 0.7 0.3l1 1a1 1 0 0 0 0.7 0.3h5.4a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V4.5z"
        fill="#a86438"
        stroke="#7a4422"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M1.5 6.5h13" stroke="#5a3018" strokeWidth="0.8" />
    </svg>
  ),
  /* XML 文件 — 红色 */
  Xml: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M3 1.5h6.5L13 5v9a0.5 0.5 0 0 1-0.5 0.5H3a0.5 0.5 0 0 1-0.5-0.5V2A0.5 0.5 0 0 1 3 1.5z" fill="#fff" stroke="#c54a3a" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M9 1.5V5h4" stroke="#c54a3a" strokeWidth="1" strokeLinejoin="round"/>
      <text x="3.2" y="12.5" fill="#c54a3a" fontSize="4.5" fontWeight="bold" fontFamily="-apple-system,sans-serif">XML</text>
    </svg>
  ),
  /* Properties / Config — 红齿轮 */
  Properties: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.2" stroke="#c54a3a" strokeWidth="1.2" fill="#fff"/>
      <path d="M8 2.5v1.8M8 11.7v1.8M2.5 8h1.8M11.7 8h1.8M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M4.1 11.9l1.3-1.3M10.6 5.4l1.3-1.3" stroke="#c54a3a" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  /* SQL 文件 — 蓝色圆柱 */
  Sql: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <ellipse cx="8" cy="3.5" rx="5" ry="1.5" fill="#5a8dee" stroke="#3a6dce" strokeWidth="1"/>
      <path d="M3 3.5v9c0 0.83 2.24 1.5 5 1.5s5-0.67 5-1.5v-9" fill="#5a8dee" stroke="#3a6dce" strokeWidth="1"/>
      <path d="M3 7c0 0.83 2.24 1.5 5 1.5s5-0.67 5-1.5M3 10.3c0 0.83 2.24 1.5 5 1.5s5-0.67 5-1.5" stroke="#3a6dce" strokeWidth="0.8" fill="none"/>
    </svg>
  ),
  /* Shell / Bash */
  Shell: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="#2d2d2d" stroke="#5a5a5a" strokeWidth="1"/>
      <path d="M4 7l2 2-2 2M8 11h3.5" stroke="#7ec699" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  /* 图片文件 */
  ImageFile: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#fff5d6" stroke="#d49a3a" strokeWidth="1"/>
      <circle cx="5.5" cy="6" r="1.2" fill="#d49a3a"/>
      <path d="M1.5 11l3.5-3.5 3 3 2.5-2.5 4 4" stroke="#d49a3a" strokeWidth="1" strokeLinejoin="round"/>
    </svg>
  ),
  /* Lock / Key 文件 */
  LockFile: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <rect x="3.5" y="7" width="9" height="7" rx="1" fill="#cfd2d8" stroke="#7a7d83" strokeWidth="1"/>
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="#7a7d83" strokeWidth="1.2" fill="none"/>
      <circle cx="8" cy="10" r="1" fill="#7a7d83"/>
    </svg>
  ),
  /* Toml / Ini */
  Toml: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M3 1.5h6.5L13 5v9a0.5 0.5 0 0 1-0.5 0.5H3a0.5 0.5 0 0 1-0.5-0.5V2A0.5 0.5 0 0 1 3 1.5z" fill="#fff" stroke="#9c6cd5" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M9 1.5V5h4" stroke="#9c6cd5" strokeWidth="1" strokeLinejoin="round"/>
      <text x="3" y="12.5" fill="#9c6cd5" fontSize="4.5" fontWeight="bold" fontFamily="-apple-system,sans-serif">TOML</text>
    </svg>
  ),
  /* Spring Boot application.yml — 绿色叶子 */
  SpringYaml: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path
        d="M13.5 2.2c-3 0.3-5.4 1.6-6.8 3.4-1.5 2-1.6 4.4-0.4 6 0.5 0.7 1.4 1.3 2.4 1.5 0 0-1.6-1-1.8-2.5 1.7 1.5 4 1.5 5.5 0.3 1.7-1.4 2.2-3.6 1.6-6.5-0.1-0.6-0.3-1.4-0.5-2.2z"
        fill="#6db33f"
        stroke="#4a8a2a"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <path d="M5 14c1-2 3-4 6-5" stroke="#4a8a2a" strokeWidth="1" strokeLinecap="round" fill="none" />
    </svg>
  ),
  /* Spring Boot 不同环境 application-xxx.yml — 橙色叶 */
  SpringYamlAlt: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path
        d="M13.5 2.2c-3 0.3-5.4 1.6-6.8 3.4-1.5 2-1.6 4.4-0.4 6 0.5 0.7 1.4 1.3 2.4 1.5 0 0-1.6-1-1.8-2.5 1.7 1.5 4 1.5 5.5 0.3 1.7-1.4 2.2-3.6 1.6-6.5-0.1-0.6-0.3-1.4-0.5-2.2z"
        fill="#e88d2a"
        stroke="#b86a1a"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <path d="M5 14c1-2 3-4 6-5" stroke="#b86a1a" strokeWidth="1" strokeLinecap="round" fill="none" />
    </svg>
  ),
  /* Maven pom.xml — 蓝色 M */
  MavenPom: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <text x="1" y="13" fill="#3b73e8" fontSize="13" fontWeight="700" fontFamily="-apple-system,sans-serif" fontStyle="italic">m</text>
    </svg>
  ),
  /* 通用 .txt 文本 */
  TextFile: () => (
    <svg {...defaultIconProps} viewBox="0 0 16 16" fill="none">
      <path d="M3 1.5h6.5L13 5v9a0.5 0.5 0 0 1-0.5 0.5H3a0.5 0.5 0 0 1-0.5-0.5V2A0.5 0.5 0 0 1 3 1.5z" fill="#fff" stroke="#9aa0a6" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M9 1.5V5h4" stroke="#9aa0a6" strokeWidth="1" strokeLinejoin="round"/>
      <path d="M5 8.5h6M5 10.5h6M5 12.5h4" stroke="#9aa0a6" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  ),
  Split: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3v14" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Plan: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="4" y="3" width="12" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3V2M13 3V2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 7h6M7 10h4M7 13h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ListChecks: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 5l1.5 1.5L8 4M4 10l1.5 1.5L8 9M4 15l1.5 1.5L8 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 5h5M11 10h5M11 15h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  QrCode: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="3" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="12" y="3" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="12" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="12" y="12" width="2" height="2" fill="currentColor" />
      <rect x="15" y="12" width="2" height="2" fill="currentColor" />
      <rect x="12" y="15" width="2" height="2" fill="currentColor" />
      <rect x="15" y="15" width="2" height="2" fill="currentColor" />
      <rect x="5" y="5" width="1" height="1" fill="currentColor" />
      <rect x="14" y="5" width="1" height="1" fill="currentColor" />
      <rect x="5" y="14" width="1" height="1" fill="currentColor" />
    </svg>
  ),
  List: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M4 5h12M4 10h12M4 15h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  GitBranch: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="14" r="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="14" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 8v4M8 6h4a2 2 0 012 2v2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  Activity: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M2 10h4l2-6 4 12 2-6h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Upload: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 13V3M6 7l4-4 4 4M4 17h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  CheckSquare: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 10l3 3 5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronUp: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M5 12l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Crosshair: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  Square: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="4" y="4" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  TrendingUp: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M3 14l5-5 3 3 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 6h4v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Users: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="7" cy="6" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 16c0-3 2.5-5 5-5s5 2 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="14" cy="7" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M18 16c0-2.5-2-4-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Server: (props: SvgIconProps) => (
    <svg {...defaultIconProps} {...props} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="3" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="12" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="6" cy="5.5" r="1" fill="currentColor" />
      <circle cx="6" cy="14.5" r="1" fill="currentColor" />
    </svg>
  ),
  Skill: (props: SvgIconProps) => (
    <svg {...defaultIconProps} {...props} viewBox="0 0 20 20" fill="none">
      <path d="M10 2l2 6h6l-5 4 2 6-5-4-5 4 2-6-5-4h6l2-6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  Shield: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 2l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V5l7-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7 10l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  AlertTriangle: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  Zap: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M11 2L5 11h5l-1 7 6-9h-5l1-7z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Sliders: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <line x1="4" y1="21" x2="4" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="4" y1="10" x2="4" y2="3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="21" x2="12" y2="12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="12" y1="8" x2="12" y2="3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="20" y1="21" x2="20" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="20" y1="12" x2="20" y2="3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="1" y1="14" x2="7" y2="14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="17" y1="16" x2="23" y2="16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  /* ==================== JetBrains Tool Window 图标 ==================== */
  Project: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M3 5.5A1.5 1.5 0 014.5 4h3l1.5 2h6.5A1.5 1.5 0 0117 7.5v7A1.5 1.5 0 0115.5 16h-11A1.5 1.5 0 013 14.5v-9z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 9.5h8M6 12h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Commit: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 10h3.8M13.2 10H17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Structure: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="3" y="3" width="5" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="9" width="6" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="14" width="6" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 6v9.5H11M5.5 10.5H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Run: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M5.5 4.2v11.6c0 .85.93 1.36 1.64.91l9.05-5.8a1.08 1.08 0 000-1.82L7.14 3.29A1.08 1.08 0 005.5 4.2z" fill="#62b543" stroke="#62b543" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  Debug: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <ellipse cx="10" cy="11" rx="4.2" ry="5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.8 11H2.5M14.2 11h3.3M5.8 14.2L3.5 16M14.2 14.2L16.5 16M5.8 7.8L3.5 6M14.2 7.8L16.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 4.5a2 2 0 014 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M10 7.5v6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Profile: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="8.2" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 16.2c1.2-2.2 3.2-3.5 5.5-3.5s4.3 1.3 5.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Database: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <ellipse cx="10" cy="5" rx="6.5" ry="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 5v5c0 1.22 2.91 2.2 6.5 2.2s6.5-.98 6.5-2.2V5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 10v5c0 1.22 2.91 2.2 6.5 2.2s6.5-.98 6.5-2.2v-5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  BuildHammer: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M11.5 2.5l5.5 2-1 3.5-5.5-2zM10 4l-7.5 7.5L4 13l7.5-7.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M2.5 16.5l4-4 2 2-4 4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  AISpark: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5 8.4 10.1 4 8.5l4.4-1.6z" fill="#e76f51" stroke="#e76f51" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="16" cy="4" r="1.2" fill="#e76f51" />
      <circle cx="4" cy="16" r="1" fill="#e76f51" />
    </svg>
  ),
  Star: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 2.5l2.35 4.76 5.25.76-3.8 3.7.9 5.23L10 14.5l-4.7 2.45.9-5.23-3.8-3.7 5.25-.76z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  TreeChevronRight: () => (
    <svg viewBox="0 0 16 16" fill="none" width="16" height="16" aria-hidden="true">
      <path
        d="M6.25 3.75 L10.5 8 L6.25 12.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),

  /** IDEA tool window 最小化按钮 (一根横线) */
  Minimize: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M5 14h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),

  /* ============ Activity bar icons ============
   * 这些原本用 JetBrains expUI (jb:toolwindows-*), 但它们的 SVG 是硬编码
   * #6C707E/#CED0D6 fill, 不是 currentColor, 导致在 light/dark 切换时:
   *   1. 跟 .activity-bar-btn 的 color 无关 —— hover/active 变色不起作用
   *   2. light 变体在白底上刻板 "镂空", 视觉噪声大
   * 改成下面的自绘 SVG (stroke="currentColor"), 跟着 CSS color 自然翻色.
   */
  TWProject: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5C3 6.12 4.12 5 5.5 5h3.17c.39 0 .76.15 1.04.43l1.86 1.86c.28.28.65.43 1.04.43H18.5c1.38 0 2.5 1.12 2.5 2.5v7.28c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 20 3 18.88 3 17.5V7.5Z" />
    </svg>
  ),
  TWMessages: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6.5C4 5.67 4.67 5 5.5 5h13c.83 0 1.5.67 1.5 1.5v8c0 .83-.67 1.5-1.5 1.5H11l-3.5 3v-3H5.5C4.67 16 4 15.33 4 14.5v-8Z" />
      <path d="M8 9.5h8M8 12h5" />
    </svg>
  ),
  TWCommit: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" />
    </svg>
  ),
  TWRun: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M7 5.5c0-.77.84-1.25 1.5-.86l10 6.5a1 1 0 0 1 0 1.72l-10 6.5c-.66.4-1.5-.09-1.5-.86v-13Z" />
    </svg>
  ),
  TWTerminal: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M7 10l3 2-3 2M13 14h4" />
    </svg>
  ),
  TWDebug: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 7a3 3 0 0 1 6 0v1H9V7Z" />
      <rect x="8" y="8" width="8" height="9" rx="4" />
      <path d="M3 10l2.5.8M3 14l2.5-.8M3 18l2.5-1.5M21 10l-2.5.8M21 14l-2.5-.8M21 18l-2.5-1.5M12 12v5" />
    </svg>
  ),
  /* 下面的 TW* 暂时保留 IDEA 原图 (不在 activity bar 用, 影响小) */
  TWStructure: () => <TW name="structure" />,
  TWProblems: () => <TW name="problems" />,
  TWBuild: () => <TW name="build" />,
  TWServices: () => <TW name="services" />,
  TWBookmarks: () => <TW name="bookmarks" />,
  TWTodo: () => <TW name="todo" />,
  TWFind: () => <TW name="find" />,
  TWNotifications: () => <TW name="notifications" />,
  TWSettings: () => <TW name="settings" />,
  TWDependencies: () => <TW name="dependencies" />,
  TWHierarchy: () => <TW name="hierarchy" />,
  TWDocumentation: () => <TW name="documentation" />,
  TWCoverage: () => <TW name="coverage" />,
  TWLearn: () => <TW name="learn" />,
  TWWeb: () => <TW name="web" />,
  TWRepositories: () => <TW name="repositories" />,

  /* ============ IDEA expUI general action icons (工具窗 header 上的按钮) ============
   * 用于 explorer-action-btn 这种 14-16px 的灰色描边动作图标。 */
  /** 注意: JBAdd 是纯 + 号 (没有文件壳),要新建文件请用 JBAddFile */
  JBAdd: () => <GEN name="add" />,
  /** IDEA "新建文件" 按钮 - 文件壳 + 蓝色 + 角标 (复合图标) */
  JBAddFile: () => <ACT name="addFile" />,
  JBAddDirectory: () => <ACT name="addDirectory" />,
  JBNewFolder: () => <ACT name="newFolder" />,
  JBLocate: () => <GEN name="locate" />,
  JBCollapseAll: () => <GEN name="collapseAll" />,
  JBExpandAll: () => <GEN name="expandAll" />,
  JBHide: () => <GEN name="hide" />,
  JBClose: () => <GEN name="close" />,
  JBMoreVertical: () => <GEN name="moreVertical" />,
  JBMoreHorizontal: () => <GEN name="moreHorizontal" />,
  JBChevronDown: () => <GEN name="chevronDown" />,
  JBChevronUp: () => <GEN name="chevronUp" />,
  JBChevronLeft: () => <GEN name="chevronLeft" />,
  JBChevronRight: () => <GEN name="chevronRight" />,
  JBSettings: () => <GEN name="settings" />,
  JBFilter: () => <GEN name="filter" />,


  /** NeoxN — 圆角方框 + N 字, About nav 入口用. 替代旧的 './icon.png' 3D PNG. */
  NeoxN: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 16.5 V8 L16 16.5 V8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),

  /** GitFork — 路由 (Routing) 用. 两条分叉象征模型路由策略 (origin → A/B). */
  GitFork: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 8 V11 a2 2 0 0 0 2 2 H16 a2 2 0 0 0 2 -2 V8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 13 V16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),

  /* Sliders / Shield 已在前文 (line 957/975) 定义, 这里复用即可不重复加.
   * Workflow 跟 Sliders 形似度高且 Workflow 是新增 — 保留. */

  /** Workflow — Orchestrator (运行模式) 用. 三节点网络象征 Agent 编排. */
  Workflow: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.8" />
      <rect x="15" y="4" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.8" />
      <rect x="9" y="14" width="6" height="6" rx="1.3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 7 H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 10 V14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),

  /** Radar — Perception (感知系统) 用. 雷达圈 + 扫描, 比 Brain 更精准 (跟 Memory 区分). */
  Radar: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <path d="M12 12 L19.5 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),

  /** Flask — Experimental (实验功能) 用. 烧瓶 + 液面 + 气泡, 实验语义. */
  Flask: () => (
    <svg {...defaultIconProps} viewBox="0 0 24 24" fill="none">
      <path d="M9 3 H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M10 3 V9.5 L5 18 a1.5 1.5 0 0 0 1.3 2.2 h11.4 A1.5 1.5 0 0 0 19 18 L14 9.5 V3" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M7.5 14 H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="11" cy="17" r="0.7" fill="currentColor" />
      <circle cx="14.5" cy="16" r="0.5" fill="currentColor" />
    </svg>
  ),
  /* ── 设置左栏 (UI 3.0 稿): 20 格 1.5 线宽, 跟 Shield / Zap 同一套 ── */
  CreditCard: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="2.75" y="4.25" width="14.5" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.75 8h14.5M5.5 12.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  IdCard: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="2.75" y="4.25" width="14.5" height="11.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7.25" cy="9" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.9 13c.4-1.2 1.3-1.8 2.35-1.8s1.95.6 2.35 1.8M11.75 8.5h3M11.75 11.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  ChartSquare: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <rect x="2.75" y="2.75" width="14.5" height="14.5" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 13.5v-2.5M10 13.5V8.5M14 13.5V6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  Palette: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 2.75a7.25 7.25 0 1 0 0 14.5c1 0 1.6-.7 1.6-1.5 0-.9-.7-1.3-.7-2.1 0-.9.7-1.5 1.6-1.5h1.6a3.15 3.15 0 0 0 3.15-3.15C17.25 5.6 14 2.75 10 2.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="6.5" cy="10" r="1" fill="currentColor" />
      <circle cx="8" cy="6.5" r="1" fill="currentColor" />
      <circle cx="12" cy="6.25" r="1" fill="currentColor" />
    </svg>
  ),
  Cube: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 2.5 16.5 6v8L10 17.5 3.5 14V6L10 2.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M3.5 6 10 9.5 16.5 6M10 9.5v8" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  Puzzle: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M8 3.5a1.75 1.75 0 0 1 3.5 0V5H15v3.5h-1.5a1.75 1.75 0 0 0 0 3.5H15v3.5h-3.5V14a1.75 1.75 0 0 0-3.5 0v1.5H4.5V12H6a1.75 1.75 0 0 0 0-3.5H4.5V5H8V3.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  ),
  Info: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 9v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="6.5" r="0.9" fill="currentColor" />
    </svg>
  ),
  Paw: () => (
    <svg {...defaultIconProps} viewBox="0 0 20 20" fill="none">
      <path d="M10 10.5c-2.3 0-4.25 2.1-4.25 3.9 0 1.3 1 1.85 2.1 1.85.9 0 1.4-.4 2.15-.4s1.25.4 2.15.4c1.1 0 2.1-.55 2.1-1.85 0-1.8-1.95-3.9-4.25-3.9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="4.75" cy="8.5" r="1.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7.75" cy="5.25" r="1.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.25" cy="5.25" r="1.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="15.25" cy="8.5" r="1.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
};

export type IconName = keyof typeof Icons;

export default Icons;
