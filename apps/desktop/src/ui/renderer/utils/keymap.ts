/**
 * Keymap System — IntelliJ IDEA-style keyboard shortcuts
 *
 * - Action registry with default Mac/Win bindings (matching JetBrains defaults)
 * - localStorage persistence (no backend round-trip)
 * - Shortcut matcher for keydown events
 * - Subscribe API for live updates across components
 */

// ── Platform detection ──

export const isMac = (() => {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator as any).userAgentData?.platform || navigator.platform || '';
  return /mac/i.test(platform);
})();

// ── Types ──

export type KeymapActionId =
  // 文件树 (Project View) — 跟 IDEA Project View 默认绑定一致
  | 'file.newFile'
  | 'file.newFolder'
  | 'file.rename'
  | 'file.delete'
  | 'file.duplicate'
  | 'file.cut'
  | 'file.copy'
  | 'file.paste'
  | 'file.copyPath'
  | 'file.copyRelativePath'
  | 'file.revealInFinder'
  | 'file.openInTerminal'
  /* file.revert / file.attachToComposer 无快捷键绑定 (不在 KEYMAP_ACTIONS),
   * 但 fileActions 右键菜单用它们做 id */
  | 'file.revert'
  | 'file.attachToComposer'
  | 'file.selectAll';

export type KeymapCategory = '搜索' | '导航' | '会话' | '编辑器' | '应用' | '视图' | '文件';

/**
 * 上下文标记: 这个 action 在什么场景下生效
 *  - 'global'         全局,任何时候都响应
 *  - 'fileTreeFocused' 仅当文件树拥有键盘焦点时响应(用于解决 ⌘C/⌘V 跟编辑器冲突)
 *  - 'editorFocused'   仅当编辑器拥有焦点时响应
 *
 * 跟 IntelliJ IDEA 的 when="ProjectViewPopupMenu" 一致。
 */
export type KeymapContext = 'global' | 'fileTreeFocused' | 'editorFocused';

export interface KeymapAction {
  id: KeymapActionId;
  category: KeymapCategory;
  name: string;
  description: string;
  nameEn?: string;
  descriptionEn?: string;
  defaultMac: string;     // e.g. "Cmd+Shift+F"
  defaultWin: string;     // e.g. "Ctrl+Shift+F"
  /**
   * 默认 'global'。文件树 actions 应该用 'fileTreeFocused' 避免跟编辑器 ⌘C/⌘V 冲突
   */
  context?: KeymapContext;
}

/** Single key combo, parsed from a string like "Cmd+Shift+F" */
export interface ParsedShortcut {
  key: string;        // lowercased non-modifier key, e.g. "f"
  ctrl: boolean;
  meta: boolean;      // Cmd on Mac
  shift: boolean;
  alt: boolean;
}

// ── Action registry ──
//
// 表里每一行都必须"改绑即生效")。无 handler 的旧条目清单见文件顶部 KeymapActionId 注释。

const CATEGORY_EN: Record<KeymapCategory, string> = {
  搜索: 'Search', 导航: 'Navigate', 会话: 'Sessions',
  编辑器: 'Editor', 应用: 'Application', 视图: 'View', 文件: 'Files',
};

/** 一个 action 在当前语言下该显示的名字 / 说明 / 分组。缺英文时回落中文。 */
export function actionName(a: KeymapAction, isZh: boolean): string {
  return isZh ? a.name : (a.nameEn || a.name);
}
export function actionDescription(a: KeymapAction, isZh: boolean): string {
  return isZh ? a.description : (a.descriptionEn || a.description);
}
export function categoryLabel(c: KeymapCategory, isZh: boolean): string {
  return isZh ? c : (CATEGORY_EN[c] || c);
}

export const KEYMAP_ACTIONS: KeymapAction[] = [
  // ── 文件 (Project View) ── 跟 IDEA Project View 默认绑定一致
  {
    id: 'file.newFile',
    category: '文件',
    name: '新建文件',
    description: '在选中目录下创建新文件',
    nameEn: 'New File',
    descriptionEn: 'Create a file in the selected folder',
    defaultMac: 'Cmd+Alt+N',
    defaultWin: 'Ctrl+Alt+N',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.newFolder',
    category: '文件',
    name: '新建文件夹',
    description: '在选中目录下创建新文件夹',
    nameEn: 'New Folder',
    descriptionEn: 'Create a folder in the selected folder',
    defaultMac: 'Cmd+Alt+Shift+N',
    defaultWin: 'Ctrl+Alt+Shift+N',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.rename',
    category: '文件',
    name: '重命名',
    description: '重命名选中的文件或文件夹',
    nameEn: 'Rename',
    descriptionEn: 'Rename the selected file or folder',
    defaultMac: 'F2',
    defaultWin: 'F2',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.delete',
    category: '文件',
    name: '删除文件',
    description: '把选中文件移到系统回收站',
    nameEn: 'Delete File',
    descriptionEn: 'Move the selected file to the system trash',
    defaultMac: 'Delete',
    defaultWin: 'Delete',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.duplicate',
    category: '文件',
    name: '复制副本',
    description: '在同目录创建一个副本',
    nameEn: 'Duplicate',
    descriptionEn: 'Create a copy alongside the original',
    defaultMac: 'Cmd+D',
    defaultWin: 'Ctrl+D',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.cut',
    category: '文件',
    name: '剪切',
    description: '剪切到剪贴板,等待粘贴',
    nameEn: 'Cut',
    descriptionEn: 'Cut to the clipboard, ready to paste',
    defaultMac: 'Cmd+X',
    defaultWin: 'Ctrl+X',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.copy',
    category: '文件',
    name: '复制',
    description: '复制到剪贴板,等待粘贴',
    nameEn: 'Copy',
    descriptionEn: 'Copy to the clipboard, ready to paste',
    defaultMac: 'Cmd+C',
    defaultWin: 'Ctrl+C',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.paste',
    category: '文件',
    name: '粘贴',
    description: '把剪贴板内容粘贴到选中目录',
    nameEn: 'Paste',
    descriptionEn: 'Paste the clipboard into the selected folder',
    defaultMac: 'Cmd+V',
    defaultWin: 'Ctrl+V',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.copyPath',
    category: '文件',
    name: '复制绝对路径',
    description: '把选中文件的绝对路径写入系统剪贴板',
    nameEn: 'Copy Absolute Path',
    descriptionEn: 'Copy the absolute path to the system clipboard',
    defaultMac: 'Cmd+Shift+C',
    defaultWin: 'Ctrl+Shift+C',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.copyRelativePath',
    category: '文件',
    name: '复制相对路径',
    description: '把选中文件相对工作区的路径写入系统剪贴板',
    nameEn: 'Copy Relative Path',
    descriptionEn: 'Copy the workspace-relative path to the system clipboard',
    defaultMac: 'Cmd+Alt+Shift+C',
    defaultWin: 'Ctrl+Alt+Shift+C',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.revealInFinder',
    category: '文件',
    name: '在文件管理器中显示',
    description: '在系统文件管理器（Windows 资源管理器 / macOS Finder）中显示选中文件',
    nameEn: 'Reveal in File Manager',
    descriptionEn: 'Show the file in Explorer (Windows) or Finder (macOS)',
    defaultMac: 'Cmd+Alt+R',
    defaultWin: 'Ctrl+Alt+R',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.openInTerminal',
    category: '文件',
    name: '在终端中打开',
    description: '在系统终端中打开选中目录',
    nameEn: 'Open in Terminal',
    descriptionEn: 'Open the selected folder in your system terminal',
    defaultMac: 'Cmd+Alt+T',
    defaultWin: 'Ctrl+Alt+T',
    context: 'fileTreeFocused',
  },
  {
    id: 'file.selectAll',
    category: '文件',
    name: '全选(文件树)',
    description: '在文件树中选中当前可见的所有节点',
    nameEn: 'Select All (File Tree)',
    descriptionEn: 'Select every currently visible node in the file tree',
    defaultMac: 'Cmd+A',
    defaultWin: 'Ctrl+A',
    context: 'fileTreeFocused',
  },
];

/** Get default binding for current platform */
export function getDefaultBinding(action: KeymapAction): string {
  return isMac ? action.defaultMac : action.defaultWin;
}

// ── Storage ──
//
// 持久化:
//   - main 进程 SQLite app_state 表 (key='keymap:bindings')
//   - 通过 window.neox.getKeymapBindings / setKeymapBindings IPC
//   - 落盘到 ~/Library/Application Support/Neox/neox.db
//   - 跟 IDEA 写 ~/Library/.../JetBrains/.../keymaps/*.xml 设计哲学一致
//   - 不再使用 localStorage
//
// 特殊处理: getKeymapBindings 必须保持 sync API (现有大量调用方依赖),
// 用 module-level 缓存 + 异步 background load 实现:
//   1. 首次访问返回 defaults (sync)
//   2. 后台 IPC 加载用户自定义 bindings
//   3. 加载完成后 merge defaults + user, 通知 subscribers
//   4. React hook 通过 subscribeKeymap re-render

export type KeymapBindings = Record<KeymapActionId, string>;

function buildDefaultBindings(): KeymapBindings {
  const out = {} as KeymapBindings;
  for (const a of KEYMAP_ACTIONS) {
    out[a.id] = getDefaultBinding(a);
  }
  return out;
}

let cachedBindings: KeymapBindings = buildDefaultBindings();
let loadedFromBackend = false;
let loadPromise: Promise<void> | null = null;
const subscribers = new Set<() => void>();

/** 异步从 SQLite 加载用户自定义 bindings,merge 进 cache */
function loadFromBackend(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const result = await (window as any).neox?.getKeymapBindings?.();
      if (result?.success && result.bindings) {
        const knownIds = new Set<string>(KEYMAP_ACTIONS.map(a => a.id));
        const userBindings: Partial<KeymapBindings> = {};
        for (const [id, value] of Object.entries(result.bindings as Record<string, string>)) {
          if (knownIds.has(id)) userBindings[id as KeymapActionId] = value;
        }
        cachedBindings = { ...buildDefaultBindings(), ...userBindings };
      }
    } catch (e) {
      console.warn('[keymap] failed to load from backend, using defaults:', e);
    } finally {
      loadedFromBackend = true;
      subscribers.forEach(fn => fn());
    }
  })();
  return loadPromise;
}

// 模块加载时立即触发后台加载(下一帧前完成,大部分组件还没渲染)
if (typeof window !== 'undefined') {
  loadFromBackend();
}

/** 异步: 写入用户自定义 bindings 到 SQLite */
async function persistToBackend(): Promise<void> {
  try {
    // 只持久化跟 default 不一样的部分,减小存储体积
    const defaults = buildDefaultBindings();
    const userOverrides: Partial<KeymapBindings> = {};
    for (const id in cachedBindings) {
      const key = id as KeymapActionId;
      if (cachedBindings[key] !== defaults[key]) {
        userOverrides[key] = cachedBindings[key];
      }
    }
    await (window as any).neox?.setKeymapBindings?.(userOverrides);
  } catch (e) {
    console.error('[keymap] failed to persist to backend:', e);
  }
}

/** Read all bindings (with defaults merged in). Sync API. */
export function getKeymapBindings(): KeymapBindings {
  return cachedBindings;
}

/** 是否已经从 SQLite 加载完成(用于 settings UI 显示 loading 状态) */
export function isKeymapLoaded(): boolean {
  return loadedFromBackend;
}

/** 等待加载完成 */
export async function waitKeymapLoaded(): Promise<void> {
  if (loadedFromBackend) return;
  if (loadPromise) await loadPromise;
}

/** Get a single binding */
export function getBinding(id: KeymapActionId): string {
  return cachedBindings[id] || '';
}

/** Save a single binding (empty string clears it). Persist to SQLite async. */
export function setBinding(id: KeymapActionId, value: string): void {
  cachedBindings = { ...cachedBindings, [id]: value };
  subscribers.forEach(fn => fn());
  void persistToBackend();
}

/** Reset all bindings to platform defaults */
export function resetAllBindings(): void {
  cachedBindings = buildDefaultBindings();
  subscribers.forEach(fn => fn());
  // 清空 storage(后台异步)
  (async () => {
    try {
      await (window as any).neox?.resetKeymapBindings?.();
    } catch (e) {
      console.error('[keymap] failed to reset backend:', e);
    }
  })();
}

/** Reset a single binding to its default */
export function resetBinding(id: KeymapActionId): void {
  const action = KEYMAP_ACTIONS.find(a => a.id === id);
  if (!action) return;
  setBinding(id, getDefaultBinding(action));
}

/** Subscribe to binding changes */
export function subscribeKeymap(fn: () => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

// ── Shortcut parsing & matching ──

/** Parse "Cmd+Shift+F" → ParsedShortcut */
export function parseShortcut(value: string): ParsedShortcut | null {
  if (!value) return null;
  const parts = value.split('+').map(p => p.trim());
  const result: ParsedShortcut = {
    key: '', ctrl: false, meta: false, shift: false, alt: false,
  };
  for (const p of parts) {
    const lower = p.toLowerCase();
    /* 'mod' = 平台主修饰键: mac 上是 ⌘, 其它平台是 Ctrl。
     * 用它写出来的快捷键**一处声明两个平台都对**, 不用在每个 tooltip 里手写三元。
     * 已有的 cmd/ctrl 字面量原样保留 —— 那些是"就要这个键"的场合 (以及用户存在
     * localStorage 里的自定义绑定), 不能被这条改掉语义。 */
    if (lower === 'mod') { if (isMac) result.meta = true; else result.ctrl = true; }
    else if (lower === 'cmd' || lower === '⌘' || lower === 'meta') result.meta = true;
    else if (lower === 'ctrl' || lower === 'control') result.ctrl = true;
    else if (lower === 'shift' || lower === '⇧') result.shift = true;
    else if (lower === 'alt' || lower === 'option' || lower === '⌥') result.alt = true;
    else result.key = lower;
  }
  return result.key ? result : null;
}

// Special key → Mac symbol
const MAC_KEY_SYMBOLS: Record<string, string> = {
  enter: '↩', return: '↩',
  backspace: '⌫', delete: '⌦',
  tab: '⇥',
  escape: '⎋', esc: '⎋',
  space: '␣',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
  up: '↑', down: '↓', left: '←', right: '→',
  pageup: '⇞', pagedown: '⇟',
  home: '↖', end: '↘',
};

const WIN_KEY_LABELS: Record<string, string> = {
  enter: 'Enter', return: 'Enter',
  backspace: '←Backspace', delete: 'Delete',
  tab: 'Tab', escape: 'Esc', esc: 'Esc',
  space: 'Space',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
};

export function kbd(value: string): string {
  return formatShortcut(value);
}

/**
 * 裸修饰键前缀 —— 只在 `kbd()` 用不了时才用它。
 *
 * `parseShortcut` 是按 `+` 切的, 所以 `'mod++'` 这种键名本身就是加号的组合切不出来
 * (缩放的 ⌘+ 就是)。这类场合写 `` `${MOD_LABEL}+` ``。
 * 注意 mac 是 `⌘` 无连接符、Windows 是 `Ctrl+` 带连接符 —— 差异已经包在这个常量里,
 * 用的时候**不要再自己补 `+`**。
 */
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl+';

/** Format ParsedShortcut → display string ("⌘⇧F" on Mac, "Ctrl+Shift+F" on Win) */
export function formatShortcut(value: string): string {
  const p = parseShortcut(value);
  if (!p) return '';
  const keyLower = p.key.toLowerCase();

  if (isMac) {
    let s = '';
    if (p.ctrl) s += '⌃';
    if (p.alt) s += '⌥';
    if (p.shift) s += '⇧';
    if (p.meta) s += '⌘';
    // Use symbol for special keys, otherwise uppercase letter
    const sym = MAC_KEY_SYMBOLS[keyLower];
    s += sym || (p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1));
    return s;
  }

  const parts: string[] = [];
  if (p.ctrl) parts.push('Ctrl');
  if (p.meta) parts.push('Win');
  if (p.alt) parts.push('Alt');
  if (p.shift) parts.push('Shift');
  const winLabel = WIN_KEY_LABELS[keyLower];
  parts.push(winLabel || (p.key.length === 1 ? p.key.toUpperCase() : p.key.charAt(0).toUpperCase() + p.key.slice(1)));
  return parts.join('+');
}

/** Check if a keyboard event matches a shortcut string */
export function matchesShortcut(e: KeyboardEvent | React.KeyboardEvent, value: string): boolean {
  const p = parseShortcut(value);
  if (!p) return false;
  const eventKey = (e.key || '').toLowerCase();
  // Normalize special keys
  const norm = eventKey === ' ' ? 'space' : eventKey;
  return (
    norm === p.key &&
    e.ctrlKey === p.ctrl &&
    e.metaKey === p.meta &&
    e.shiftKey === p.shift &&
    e.altKey === p.alt
  );
}

/** Build a shortcut string from a KeyboardEvent (for capture input) */
export function eventToShortcut(e: KeyboardEvent | React.KeyboardEvent): string {
  const key = (e.key || '').toLowerCase();
  // Ignore modifier-only key presses
  if (['shift', 'control', 'alt', 'meta', 'option', 'cmd', 'command'].includes(key)) return '';
  const parts: string[] = [];
  if (e.metaKey) parts.push('Cmd');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Normalize key display (uppercase letter, special names)
  let displayKey = key.length === 1 ? key.toUpperCase() : key;
  if (key === ' ') displayKey = 'Space';
  else if (key === 'arrowup') displayKey = 'Up';
  else if (key === 'arrowdown') displayKey = 'Down';
  else if (key === 'arrowleft') displayKey = 'Left';
  else if (key === 'arrowright') displayKey = 'Right';
  else if (key === 'escape') displayKey = 'Esc';
  else if (key === 'enter') displayKey = 'Enter';
  else if (key === 'tab') displayKey = 'Tab';
  else if (key === 'backspace') displayKey = 'Backspace';
  else if (key === 'delete') displayKey = 'Delete';
  parts.push(displayKey);
  return parts.join('+');
}

/** Find action(s) that conflict with a given binding string */
export function findConflicts(value: string, excludeId?: KeymapActionId): KeymapActionId[] {
  if (!value) return [];
  const bindings = getKeymapBindings();
  const conflicts: KeymapActionId[] = [];
  for (const id in bindings) {
    if (id === excludeId) continue;
    if (bindings[id as KeymapActionId] === value) {
      conflicts.push(id as KeymapActionId);
    }
  }
  return conflicts;
}
