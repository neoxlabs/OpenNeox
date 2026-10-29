import type { MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../../shared/ipc.js';

export type MenuAgentMode = 'work' | 'code';

interface CreateMenuTemplateOptions {
  onMenuAction: (action: MenuAction) => void;
  mode?: MenuAgentMode;
  /** UI 语言 (config.language) — Work 菜单跟随; code 菜单保持原英文不动。 */
  zh?: boolean;
}

export function createMenuTemplate(options: CreateMenuTemplateOptions): MenuItemConstructorOptions[] {
  const { onMenuAction, mode = 'code', zh = true } = options;
  const isMac = process.platform === 'darwin';
  const sendMenuAction = (action: MenuAction) => onMenuAction(action);

  if (mode === 'work') {
    const t = (zhText: string, enText: string) => (zh ? zhText : enText);
    return [
      ...(isMac ? [{
        label: 'Neox',
        submenu: [
          { role: 'about' as const, label: t('关于 Neox', 'About Neox') },
          { type: 'separator' as const },
          { label: t('偏好设置…', 'Preferences…'), accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('menu:open-settings') },
          { type: 'separator' as const },
          { role: 'services' as const },
          { type: 'separator' as const },
          { role: 'hide' as const, label: t('隐藏 Neox', 'Hide Neox') },
          { role: 'hideOthers' as const, label: t('隐藏其他', 'Hide Others') },
          { role: 'unhide' as const, label: t('全部显示', 'Show All') },
          { type: 'separator' as const },
          { role: 'quit' as const, label: t('退出 Neox', 'Quit Neox') },
        ],
      }] : []),
      {
        label: t('会话', 'Chats'),
        submenu: [
          /* ⌘N/⌘K/⌘⇧M 快捷键由 renderer 全局 keydown 处理 (NeoxShellHost/Composer),
           * 菜单项不配 accelerator — 配了会被 Electron 拦截, renderer 收不到按键。 */
          { label: t('新建会话', 'New Chat'), click: () => sendMenuAction('menu:new-session') },
          { label: t('搜索会话与消息', 'Search Chats'), click: () => sendMenuAction('menu:search') },
          { type: 'separator' as const },
          { label: t('打开项目…', 'Open Project…'), click: () => sendMenuAction('menu:open-project') },
          { type: 'separator' as const },
          /* ⌘W 默认 role:close 会关 BrowserWindow (用户体感=关 Neox)。改为关 tab;
           * 关窗口改到 ⌘⇧W (与 Chrome / VS Code 一致)。 */
          { label: t('关闭标签页', 'Close Tab'), accelerator: 'CmdOrCtrl+W', click: () => sendMenuAction('menu:close-tab') },
          ...(isMac
            ? []
            : [{ role: 'quit' as const, label: t('退出', 'Quit') }]),
        ],
      },
      {
        label: t('编辑', 'Edit'),
        submenu: [
          { role: 'undo' as const, label: t('撤销', 'Undo') },
          { role: 'redo' as const, label: t('重做', 'Redo') },
          { type: 'separator' as const },
          { role: 'cut' as const, label: t('剪切', 'Cut') },
          { role: 'copy' as const, label: t('复制', 'Copy') },
          { role: 'paste' as const, label: t('粘贴', 'Paste') },
          { role: 'selectAll' as const, label: t('全选', 'Select All') },
        ],
      },
      {
        label: t('视图', 'View'),
        submenu: [
          { role: 'resetZoom' as const, label: t('实际大小', 'Actual Size') },
          { role: 'zoomIn' as const, label: t('放大', 'Zoom In') },
          { role: 'zoomOut' as const, label: t('缩小', 'Zoom Out') },
          { type: 'separator' as const },
          { role: 'togglefullscreen' as const, label: t('进入/退出全屏', 'Toggle Full Screen') },
          /* devtools/reload 是工程条目, Work 只在 dev 构建留 (排查用) */
          ...(process.env.NODE_ENV === 'development' ? [
            { type: 'separator' as const },
            { role: 'reload' as const, accelerator: isMac ? 'Cmd+Alt+R' : 'Ctrl+Alt+R' },
            { role: 'toggleDevTools' as const },
          ] : []),
        ],
      },
      {
        label: t('窗口', 'Window'),
        submenu: [
          { role: 'minimize' as const, label: t('最小化', 'Minimize') },
          { role: 'zoom' as const, label: t('缩放', 'Zoom') },
          /* 不用 role:close — Electron 会强制绑 ⌘W 关窗, 与「关闭标签页」冲突 */
          {
            label: t('关闭窗口', 'Close Window'),
            accelerator: 'CmdOrCtrl+Shift+W',
            click: (_item, focusedWindow) => { focusedWindow?.close(); },
          },
          ...(isMac ? [
            { type: 'separator' as const },
            { role: 'front' as const, label: t('全部置于顶层', 'Bring All to Front') },
          ] : []),
        ],
      },
    ];
  }

  /* ---------- Code: 原全量工程菜单 (行为与历史完全一致) ---------- */
  return [
    ...(isMac ? [{
      label: 'Neox',
      submenu: [
        { role: 'about' as const, label: 'About Neox' },
        { type: 'separator' as const },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('menu:open-settings') },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Go to Home',
          accelerator: 'CmdOrCtrl+H',
          click: () => sendMenuAction('menu:go-home'),
        },
        { type: 'separator' as const },
        {
          label: 'Open Project...',
          accelerator: 'CmdOrCtrl+O',
          click: () => sendMenuAction('menu:open-project'),
        },
        // New Session(⌘N)/Save Session(⌘S)/Export Session(⌘E) 已移除:
        //   它们的 menu action 在 renderer 端无 handler(AppShell.onMenuAction 只处理
        //   open-project/go-home), 三个全局快捷键还会拦截按键 —— 尤其 ⌘S 会抢走 Monaco
        //   编辑器的保存。会话的新建/导出在应用内已有真实入口, 不需要这几个死菜单项。
        { type: 'separator' as const },
        /* ⌘W → 关编辑器/Surface tab; 关窗口走 Window 菜单 ⌘⇧W (勿用默认 role:close) */
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenuAction('menu:close-tab') },
        ...(isMac ? [] : [{ role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Cmd+R 默认是 reload 页面 —— 但 IDEA 风格 Cmd+R 是"替换", 让 editor 接管.
        // 这里把 reload 的快捷键挪到 Cmd+Alt+R, 避免和 replace 冲突.
        { role: 'reload' as const, accelerator: isMac ? 'Cmd+Alt+R' : 'Ctrl+Alt+R' },
        { role: 'forceReload' as const, accelerator: isMac ? 'Cmd+Shift+Alt+R' : 'Ctrl+Shift+Alt+R' },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        /* 不用 role:close — Electron 会强制绑 ⌘W 关窗, 与 Close Tab 冲突 */
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: (_item, focusedWindow) => { focusedWindow?.close(); },
        },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : []),
      ],
    },
  ];
}
