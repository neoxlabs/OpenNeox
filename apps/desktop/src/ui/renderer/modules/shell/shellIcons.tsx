import React from 'react';

/* ============================================================
 * Shell-scope SVG 图标集合
 *   - 只在 NeoxShell / TopBar / IconRail / Sidebar / RightPanel 里用
 *   - stroke="currentColor" 跟 Tailwind / CSS 配色无痛对齐
 *   - 全部 20x20 line-style, 与设计稿"细线几何感"风格一致
 * ============================================================ */

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

const BASE_SW = 1.75;      /* 16px 处的 viewBox 线宽 —— 现状基准, 不改观感 */
const BASE_SIZE = 16;
export function opticalStrokeWidth(size: number): number {
  const raw = BASE_SW * (BASE_SIZE / Math.max(1, size));
  return Math.min(2.6, Math.max(1.25, +raw.toFixed(2)));
}

const mk = (path: React.ReactNode) =>
  React.memo(function Icon({ size = 20, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={opticalStrokeWidth(size)}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
      >
        {path}
      </svg>
    );
  });

export const IconPanelLeft = mk(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></>);
export const IconAlert = mk(<><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>);
export const IconAlertCircle = mk(<><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4.5" /><path d="M12 16h.01" /></>);
export const IconHome = mk(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></>);
export const IconAgent = mk(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></>);
export const IconWorkflow = mk(<><rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="3" width="6" height="6" rx="1.5" /><rect x="9" y="15" width="6" height="6" rx="1.5" /><path d="M9 6h6M6 9v6a3 3 0 0 0 3 3h3M18 9v3a3 3 0 0 1-3 3h-3" /></>);
export const IconTools = mk(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>);
export const IconTeam = mk(<><circle cx="9" cy="8" r="3" /><circle cx="17" cy="10" r="2.5" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M14 20c.1-2.1 1.6-3.9 3.6-4.5" /></>);
export const IconSearch = mk(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
/* IconPlugin — 扩展模块, 侧栏「插件」入口 (简洁模块格). */
export const IconPlugin = mk(<>
  <rect x="3" y="3" width="8" height="8" rx="1.75" />
  <rect x="13" y="3" width="8" height="8" rx="1.75" />
  <rect x="3" y="13" width="8" height="8" rx="1.75" />
  <path d="M17 14v6M14 17h6" />
</>);
export const IconPlus = mk(<><path d="M12 5v14M5 12h14" /></>);
export const IconBell = mk(<><path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Z" /><path d="M10 21a2 2 0 0 0 4 0" /></>);
export const IconCog = mk(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>);
export const IconSend = mk(<><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" /></>);
export const IconDock = mk(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /></>);
export const IconCode = mk(<><path d="m16 18 6-6-6-6M8 6l-6 6 6 6" /></>);
export const IconEye = mk(<><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.8" /></>);
export const IconFile = mk(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
export const IconImage = mk(<><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m21 15-5-5L5 21" /></>);
export const IconTerminal = mk(<><path d="m4 7 5 5-5 5M12 19h8" /></>);
/* Computer Use —— 「在这台电脑上操作某个 App」。跟终端(命令)和浏览器(网页)都要分得开:
   显示器轮廓 + 底座, 一眼是"整台机器"而不是"一个窗口"。 */
export const IconDisplay = mk(<><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M9 21h6M12 17v4" /></>);
export const IconWeb = mk(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.4 3 14.6 0 18M12 3c-3 3.4-3 14.6 0 18" /></>);
export const IconBrowser = mk(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M7 7h.01M10 7h.01" /></>);
export const IconSpark = mk(<><path d="M12 2.4 14.2 9.8 21.6 12l-7.4 2.2L12 21.6l-2.2-7.4L2.4 12l7.4-2.2Z" /></>);
/* IconZap — 技能闪电 (经典 bolt), 12–16px 仍清晰. */
export const IconZap = mk(<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z" />);
export const IconClock = mk(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconMic = mk(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>);
export const IconLibrary = mk(<><path d="M4 4h3.5v16H4zM10.2 4h3.5v16h-3.5z" /><path d="m16.6 5 3.4.9-4.1 15.2-3.4-.9z" /></>);
export const IconLayers = mk(<><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>);
export const IconUpload = mk(<><path d="M12 3v12M6 9l6-6 6 6M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>);
export const IconBrain = mk(<><path d="M9 5a3 3 0 0 0-3 3v1a3 3 0 0 0-2 2.83V13a3 3 0 0 0 3 3v1a3 3 0 0 0 3 3h1V5H9Z" /><path d="M15 5a3 3 0 0 1 3 3v1a3 3 0 0 1 2 2.83V13a3 3 0 0 1-3 3v1a3 3 0 0 1-3 3h-1V5h2Z" /></>);
export const IconThinking = mk(
  <>
    <path d="M12 3.6c-3.4 0-5.8 1.9-6.2 4.4C3.6 8.7 2.4 10.5 2.8 12.6c.3 1.7 1.5 3 3.1 3.5-.1 2.6 2 4.7 4.7 4.7.5 0 1-.1 1.4-.2" />
    <path d="M12 3.6c3.4 0 5.8 1.9 6.2 4.4 2.2.7 3.4 2.5 3 4.6-.3 1.7-1.5 3-3.1 3.5.1 2.6-2 4.7-4.7 4.7-.5 0-1-.1-1.4-.2" />
    <path d="M12 3.6v16.8" />
  </>,
);
export const IconDatabase = mk(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>);
export const IconCheck = mk(<path d="m5 12 4 4 10-10" />);
export const IconPause = mk(<><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></>);
export const IconStop: React.FC<IconProps> = React.memo(function IconStop({ size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      {...rest}
    >
      <rect x="5" y="5" width="14" height="14" rx="3" />
    </svg>
  );
});
export const IconPencil = mk(<><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></>);
/* 扳手 —— 已封口 turn 的折叠行用它 ("这一段是干过的活")。
 * 与整套同风格: 20x20 line-style / 1.75 描边 / currentColor, 不带任何底色或 chip
 * (timeline 设计铁律: 图标裸化, 卡片只发可操作物)。 */
export const IconWrench = mk(
  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
);

export const IconChevronDown = mk(<path d="m6 9 6 6 6-6" />);
export const IconChevronRight = mk(<path d="m9 6 6 6-6 6" />);
export const IconChevronLeft = mk(<path d="m15 6-6 6 6 6" />);
export const IconArrowLeft = mk(<><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>);
export const IconTrash = mk(<><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></>);
/* IconFolder — 开口文件夹 (tab + 掀起前盖), 用户指定样式.
 *   比闭环扁 folder 轮廓更清晰, 16px 下仍可辨; stroke 由使用处定. */
export const IconFolder = mk(
  <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6c-.24.94-1.1 1.5-2.07 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
);
export const IconBook = mk(
  <>
    <path d="M12 7v13" />
    <path d="M12 7C10.4 5.5 8.2 4.8 5 4.8c-.7 0-1.3.6-1.3 1.3v10.3c0 .7.6 1.3 1.3 1.3 3.2 0 5.4.7 7 2.3" />
    <path d="M12 7c1.6-1.5 3.8-2.2 7-2.2.7 0 1.3.6 1.3 1.3v10.3c0 .7-.6 1.3-1.3 1.3-3.2 0-5.4.7-7 2.3" />
  </>
);
export const IconBulb = mk(
  <>
    <path d="M12 2.6a6.6 6.6 0 0 0-4 11.9c.62.47 1 1.2 1 1.98v.72h6v-.72c0-.78.38-1.51 1-1.98A6.6 6.6 0 0 0 12 2.6Z" />
    <path d="M9.7 20h4.6" />
  </>
);
export const IconCube = mk(
  <>
    <path d="m12 2.8 8.2 4.6v9.2L12 21.2l-8.2-4.6V7.4L12 2.8Z" />
    <path d="M3.8 7.4 12 12l8.2-4.6M12 12v9.2" />
  </>
);
/* IconFolderPlus / IconLocate / IconCollapseAll — IDE 模式 sidebar 头部 IDEA 风格按钮 */
export const IconFolderPlus = mk(
  <>
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6c-.24.94-1.1 1.5-2.07 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    <path d="M12 11v4M10 13h4" />
  </>
);
export const IconLocate = mk(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>);
export const IconMoreH = mk(<><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>);
export const IconCollapseAll = mk(<><path d="m6 9 6-6 6 6" /><path d="m6 15 6 6 6-6" /></>);
export const IconUndo = mk(<><path d="M9 14 4 9l5-5" /><path d="M4 9h9a6 6 0 0 1 0 12h-3" /></>);
/* IconUndo 的镜像 —— 「恢复」(把刚回退掉的改动再放回去)。
 * 跟回退是同一个动作的两个方向, 所以形状必须是同一个、只是朝向相反;
 * 换一个完全不同的图形 (比如刷新圈) 会让人以为是第三种操作。 */
export const IconRedo = mk(<><path d="M15 14l5-5-5-5" /><path d="M20 9h-9a6 6 0 0 0 0 12h3" /></>);
export const IconRefresh = mk(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></>);
export const IconHelp = mk(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2.25-2.5 4" /><path d="M12 17.5h.01" /></>);
export const IconSun = mk(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4" /></>);
export const IconPlay = mk(<path d="M7 5v14l12-7Z" />);
export const IconPaperclip = mk(<path d="m21.5 12.5-9 9a6 6 0 1 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7L9.5 19a2 2 0 0 1-2.8-2.8L14.5 8.5" />);
export const IconAt = mk(<><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></>);
export const IconChat = mk(<><path d="M21 12a8 8 0 0 1-8 8H6l-4 3v-9a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z" /></>);
/** 标签 — 切换用途 */
export const IconTag = mk(<><path d="M3 7.5V4a1 1 0 0 1 1-1h3.5a2 2 0 0 1 1.41.59l10.5 10.5a2 2 0 0 1 0 2.82l-3.5 3.5a2 2 0 0 1-2.82 0L3.59 9.91A2 2 0 0 1 3 8.5Z" /><circle cx="7" cy="7" r="1.2" /></>);
/** 导出 — 文档带下行箭头 */
export const IconExport = mk(<><path d="M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" /><path d="M15 3v4h4" /><path d="M12 11v6" /><path d="m9.5 14.5 2.5 2.5 2.5-2.5" /></>);
export const IconCopy = mk(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>);
export const IconUserCircle = mk(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.4 18.5a6.5 6.5 0 0 1 11.2 0" /></>);
export const IconLogout = mk(<><path d="M14 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" /><path d="M17 8l4 4-4 4" /><path d="M21 12H10" /></>);
export const IconFilter = mk(<><path d="M6 4h12M8 10h8M10 16h4" /><circle cx="18" cy="10" r="1.2" /><circle cx="14" cy="16" r="1.2" /><circle cx="10" cy="4" r="1.2" /></>);
export const IconPanelRight = mk(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>);

/* IconPhone — 单线条手机, 跟其它图标同 24×24 viewBox + 1.75 stroke. 没框没填充. */
export const IconPhone = mk(<>
  <rect x="7" y="3" width="10" height="18" rx="2" />
  <path d="M11 18h2" />
</>);

/* Cloud 系列 — outline 风, lucide style. 单线条 cloud + 可选向上/向下箭头.
 *   IconCloud         静态云 (session 在云端)
 *   IconCloudUp       云上箭头 (推到云端)
 *   IconCloudDown     云下箭头 (拉回本机)
 *   stroke 跟 currentColor, 父容器决定颜色. */
export const IconCloud = mk(
  <path d="M7 18a4 4 0 0 1-.9-7.9 5 5 0 0 1 9.5-1.4 4 4 0 0 1 .9 7.9H7Z" />
);
export const IconCloudUp = mk(<>
  <path d="M7 17.5a4 4 0 0 1-.9-7.9 5 5 0 0 1 9.5-1.4 4 4 0 0 1 1.4 7.6" />
  <path d="M12 21v-8M9 16l3-3 3 3" />
</>);
export const IconCloudDown = mk(<>
  <path d="M7 14a4 4 0 0 1-.9-7.9 5 5 0 0 1 9.5-1.4 4 4 0 0 1 1.4 7.6" />
  <path d="M12 13v8M9 18l3 3 3-3" />
</>);

export const IconScissors = mk(<><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M20 4 8.1 16.5M8.1 7.5 20 20" /></>);
export const IconClipboard = mk(<><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></>);
export const IconLink = mk(<><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1L11.5 4.4" /><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.4-1.4" /></>);

export const IconAlarm = mk(<><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.5 1.5" /><path d="M4.5 5 6.5 3M19.5 5l-2-2" /></>);
export const IconHandset = mk(
  <path d="M21 16.4v2.8a1.9 1.9 0 0 1-2 1.8A17.5 17.5 0 0 1 3 5a1.9 1.9 0 0 1 1.9-2h2.8a1.9 1.9 0 0 1 1.9 1.6c.1.9.3 1.8.6 2.6a1.9 1.9 0 0 1-.4 2L8.6 10.4a15 15 0 0 0 5 5l1.2-1.2a1.9 1.9 0 0 1 2-.4c.8.3 1.7.5 2.6.6a1.9 1.9 0 0 1 1.6 2Z" />,
);
export const IconCalendar = mk(<><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17" /><path d="M8 3v4M16 3v4" /></>);
export const IconMapPin = mk(<><path d="M12 21.5s-7-6.1-7-11.5a7 7 0 0 1 14 0c0 5.4-7 11.5-7 11.5Z" /><circle cx="12" cy="10" r="2.5" /></>);
export const IconMail = mk(<><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m3.5 7 8.5 6 8.5-6" /></>);
export const IconMessage = mk(<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-5 4.5Z" />);
