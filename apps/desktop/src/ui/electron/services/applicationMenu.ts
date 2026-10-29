
import { lazyElectron } from '../lazyElectron.js';

/* electron 走**运行时**取 —— 顶层静态 import 会让这个文件所在的整个 bundle
 * 在纯 Node 进程里加载失败, 把同包几十个跟 Electron 无关的 handler 一起带下水
 * (症状是极简版"桥上一条路由都没有", 报错里连 electron 三个字都没有)。
 * 见 lazyElectron.ts。Electron 宿主下拿到的是同一个对象, 行为一字不变。 */
const BrowserWindow = lazyElectron<typeof import('electron').BrowserWindow>('BrowserWindow');
const Menu = lazyElectron<typeof import('electron').Menu>('Menu');
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { normalizeAgentMode, workLikeMode } from '@neoxlabs/platform/runtime/agentMode.js';
import { createMenuTemplate, type MenuAgentMode } from './menuTemplate.js';

let appliedKey: string | null = null;

function normalizeMode(mode: unknown): MenuAgentMode {
  /* Pilot 用 Work 的简化菜单 */
  return workLikeMode(normalizeAgentMode(typeof mode === 'string' ? mode : null));
}

/** 应用当前模式的菜单。mode 缺省时读 config.defaultAgentMode。幂等 (同 mode+语言不重建)。 */
export function applyApplicationMenuForMode(mode?: string): void {
  let cfgMode: unknown = mode;
  let zh = true;
  try {
    const config = loadConfig();
    if (cfgMode == null) cfgMode = (config as { defaultAgentMode?: string }).defaultAgentMode;
    zh = ((config as { language?: string }).language ?? 'zh') !== 'en';
  } catch { /* config 读不到 → code 菜单兜底 */ }
  const m = normalizeMode(cfgMode);
  const key = `${m}|${zh ? 'zh' : 'en'}`;
  if (key === appliedKey) return;
  appliedKey = key;
  const menu = Menu.buildFromTemplate(createMenuTemplate({
    mode: m,
    zh,
    onMenuAction: (action) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('menu:action', action); } catch { /* window 正在关 */ }
      }
    },
  }));
  Menu.setApplicationMenu(menu);
}
