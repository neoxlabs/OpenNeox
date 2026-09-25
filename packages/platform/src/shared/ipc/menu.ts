export type MenuAction =
  | 'menu:go-home'
  | 'menu:save-session'
  | 'menu:export-session'
  | 'menu:new-session'
  | 'menu:open-project'
  | 'menu:search'
  | 'menu:voice-mode'
  | 'menu:open-settings'
  /* Windows 托盘快捷入口: 账户/关于复用设置页对应 tab, 不重复实现 auth/UI 状态。 */
  | 'menu:open-account'
  | 'menu:open-about'
  | 'menu:open-settings-providers'
  | 'menu:open-settings-remote'
  /* ⌘W: 关当前编辑器/Surface tab (勿用 role:close — 默认 ⌘W 会关整个窗口) */
  | 'menu:close-tab';
