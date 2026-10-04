
import fs from 'fs';
import path from 'path';
import os from 'os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

// ==================== 类型 ====================

/** 快捷键动作标识 */
export type KeyAction =
  | 'submit'             // 提交输入
  | 'newline'            // 插入换行
  | 'interrupt'          // 中断执行
  | 'exit'               // 退出
  | 'search'             // 搜索 (Ctrl+F)
  | 'historyUp'          // 历史上一条
  | 'historyDown'        // 历史下一条
  | 'toggleThinking'     // 切换 thinking 展开/折叠
  | 'toggleContextMenu'  // 切换上下文菜单
  | 'toggleAgentScreen'  // 切换 agent 屏幕
  | 'interruptInput'     // 打开中断输入框
  | 'clearInput'         // 清空输入
  | 'tabComplete'        // Tab 补全
  | 'pasteImage'         // 粘贴图片
  | 'bgPanelFocus'       // 聚焦后台任务面板
  | 'bgKill'             // 终止后台任务
  | 'bgRemove'           // 移除后台任务;

/** 单个快捷键绑定 */
export interface KeyBinding {
  /** 动作标识 */
  action: KeyAction;
  /** 按键描述，如 "ctrl+f", "shift+enter", "escape", "tab" */
  key: string;
  /** Chord 组合键序列：如 ["ctrl+k", "ctrl+c"] 表示先按 Ctrl+K 再按 Ctrl+C */
  chord?: string[];
  /** 显示标签（给 HintLine 用） */
  label?: string;
  /** 仅在某个上下文生效 */
  when?: 'running' | 'idle' | 'always';
}

/** 用户配置文件格式 */
export interface KeybindingsConfig {
  /** 用户自定义绑定（覆盖默认） */
  bindings?: KeyBinding[];
  /** 禁用的默认动作 */
  disabled?: KeyAction[];
}

// ==================== 默认绑定 ====================

const DEFAULT_BINDINGS: KeyBinding[] = [
  { action: 'submit', key: 'return', label: 'Enter', when: 'always' },
  { action: 'newline', key: 'shift+return', label: 'Shift+Enter', when: 'always' },
  { action: 'interrupt', key: 'escape', label: 'ESC', when: 'running' },
  { action: 'exit', key: 'ctrl+c', label: 'Ctrl+C ×2', when: 'always' },
  { action: 'search', key: 'ctrl+f', label: 'Ctrl+F', when: 'always' },
  { action: 'historyUp', key: 'up', label: '↑', when: 'idle' },
  { action: 'historyDown', key: 'down', label: '↓', when: 'idle' },
  { action: 'toggleThinking', key: 'ctrl+o', label: 'Ctrl+O', when: 'always' },
  { action: 'toggleContextMenu', key: 'ctrl+t', label: 'Ctrl+T', when: 'always' },
  { action: 'toggleAgentScreen', key: 'ctrl+g', label: 'Ctrl+G', when: 'always' },
  { action: 'interruptInput', key: 'i', label: 'i', when: 'running' },
  { action: 'clearInput', key: 'ctrl+u', label: 'Ctrl+U', when: 'always' },
  { action: 'tabComplete', key: 'tab', label: 'Tab', when: 'idle' },
  { action: 'pasteImage', key: 'ctrl+v', label: 'Ctrl+V', when: 'idle' },
  { action: 'bgPanelFocus', key: 'tab', label: 'Tab', when: 'running' },
];

// ==================== KeybindingsManager ====================

export class KeybindingsManager {
  private bindings: Map<KeyAction, KeyBinding> = new Map();
  private disabled: Set<KeyAction> = new Set();
  private configPath: string;
  /** Chord state: stores the first key of a chord sequence */
  private chordPendingKey: string | null = null;
  private chordTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly CHORD_TIMEOUT_MS = 1500;

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(os.homedir(), NEOX_HOME_DIRNAME, 'keybindings.json');
    this.loadDefaults();
    this.loadUserConfig();
  }

  private loadDefaults(): void {
    for (const binding of DEFAULT_BINDINGS) {
      this.bindings.set(binding.action, binding);
    }
  }

  private loadUserConfig(): void {
    try {
      if (!fs.existsSync(this.configPath)) return;
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const config: KeybindingsConfig = JSON.parse(raw);

      // Apply disabled actions
      if (config.disabled) {
        for (const action of config.disabled) {
          this.disabled.add(action);
        }
      }

      // Apply user bindings (override defaults)
      if (config.bindings) {
        for (const binding of config.bindings) {
          this.bindings.set(binding.action, binding);
        }
      }

      cliLogger.info('KEYBINDINGS', `Loaded ${config.bindings?.length || 0} custom bindings`);
    } catch (err: any) {
      cliLogger.debug('KEYBINDINGS', `Failed to load user keybindings: ${err.message}`);
    }
  }

  /** 获取动作的当前绑定 */
  getBinding(action: KeyAction): KeyBinding | null {
    if (this.disabled.has(action)) return null;
    return this.bindings.get(action) || null;
  }

  /** 获取动作的按键字符串 */
  getKey(action: KeyAction): string | null {
    const binding = this.getBinding(action);
    return binding?.key || null;
  }

  /** 获取动作的显示标签 */
  getLabel(action: KeyAction): string {
    const binding = this.getBinding(action);
    return binding?.label || binding?.key || action;
  }

  /** 检查 Ink key event 是否匹配某个动作 */
  matches(action: KeyAction, input: string, key: {
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    return?: boolean;
    escape?: boolean;
    tab?: boolean;
    backspace?: boolean;
    delete?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
  }, context: 'running' | 'idle' = 'idle'): boolean {
    const binding = this.getBinding(action);
    if (!binding) return false;

    // Check context
    if (binding.when && binding.when !== 'always' && binding.when !== context) return false;

    // Chord support: if binding has a chord sequence
    if (binding.chord && binding.chord.length >= 2) {
      return this.matchChord(binding.chord, input, key);
    }

    return matchKeyString(binding.key, input, key);
  }

  /** Match a chord sequence (e.g., ["ctrl+k", "ctrl+c"]) */
  private matchChord(chord: string[], input: string, key: any): boolean {
    const currentKeyStr = buildKeyString(input, key);
    if (!currentKeyStr) return false;

    if (this.chordPendingKey === null) {
      // First key in chord — check if it matches chord[0]
      if (normalizeKeyStr(currentKeyStr) === normalizeKeyStr(chord[0])) {
        this.chordPendingKey = chord[0];
        // Set timeout to clear chord state
        if (this.chordTimeout) clearTimeout(this.chordTimeout);
        this.chordTimeout = setTimeout(() => {
          this.chordPendingKey = null;
        }, KeybindingsManager.CHORD_TIMEOUT_MS);
        return false; // Don't fire yet, waiting for second key
      }
      return false;
    }

    // Second key in chord — check if pending matches chord[0] and current matches chord[1]
    if (normalizeKeyStr(this.chordPendingKey) === normalizeKeyStr(chord[0]) &&
        normalizeKeyStr(currentKeyStr) === normalizeKeyStr(chord[1])) {
      // Full chord matched
      this.chordPendingKey = null;
      if (this.chordTimeout) { clearTimeout(this.chordTimeout); this.chordTimeout = null; }
      return true;
    }

    // Chord broken — reset
    this.chordPendingKey = null;
    if (this.chordTimeout) { clearTimeout(this.chordTimeout); this.chordTimeout = null; }
    return false;
  }

  /** Check if a chord is pending (for UI feedback) */
  isChordPending(): boolean {
    return this.chordPendingKey !== null;
  }

  getChordPendingKey(): string | null {
    return this.chordPendingKey;
  }

  /** 获取所有有效绑定 */
  getAllBindings(): KeyBinding[] {
    return [...this.bindings.values()].filter(b => !this.disabled.has(b.action));
  }

  /** 获取按上下文过滤的绑定（给 HintLine 用） */
  getBindingsForContext(context: 'running' | 'idle'): KeyBinding[] {
    return this.getAllBindings().filter(b =>
      !b.when || b.when === 'always' || b.when === context
    );
  }

  /** 重新加载配置 */
  reload(): void {
    this.bindings.clear();
    this.disabled.clear();
    this.loadDefaults();
    this.loadUserConfig();
  }

  /** 生成默认配置文件（如果不存在） */
  generateDefaultConfig(): string {
    const config: KeybindingsConfig = {
      bindings: DEFAULT_BINDINGS,
      disabled: [],
    };
    return JSON.stringify(config, null, 2);
  }
}

// ==================== Key Matching ====================

/**
 * 匹配按键字符串，如 "ctrl+f", "shift+return", "escape", "tab", "i"
 */
function matchKeyString(keyStr: string, input: string, key: {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
}): boolean {
  const parts = keyStr.toLowerCase().split('+');
  const modifiers = new Set(parts.slice(0, -1));
  const mainKey = parts[parts.length - 1];

  // Check modifiers
  if (modifiers.has('ctrl') !== !!key.ctrl) return false;
  if (modifiers.has('shift') !== !!key.shift) return false;
  if (modifiers.has('meta') !== !!key.meta) return false;

  // Check main key
  switch (mainKey) {
    case 'return': case 'enter': return !!key.return;
    case 'escape': case 'esc': return !!key.escape;
    case 'tab': return !!key.tab;
    case 'backspace': return !!key.backspace;
    case 'delete': return !!key.delete;
    case 'up': return !!key.upArrow;
    case 'down': return !!key.downArrow;
    case 'left': return !!key.leftArrow;
    case 'right': return !!key.rightArrow;
    default:
      // Single character key
      return input.toLowerCase() === mainKey;
  }
}

/** Build a key string from Ink key event (reverse of matchKeyString) */
function buildKeyString(input: string, key: { ctrl?: boolean; shift?: boolean; meta?: boolean;
  return?: boolean; escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean;
  upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean;
}): string | null {
  const parts: string[] = [];
  if (key.ctrl) parts.push('ctrl');
  if (key.shift) parts.push('shift');
  if (key.meta) parts.push('meta');

  if (key.return) parts.push('return');
  else if (key.escape) parts.push('escape');
  else if (key.tab) parts.push('tab');
  else if (key.backspace) parts.push('backspace');
  else if (key.delete) parts.push('delete');
  else if (key.upArrow) parts.push('up');
  else if (key.downArrow) parts.push('down');
  else if (key.leftArrow) parts.push('left');
  else if (key.rightArrow) parts.push('right');
  else if (input) parts.push(input.toLowerCase());
  else return null;

  return parts.join('+');
}

/** Normalize key string for comparison */
function normalizeKeyStr(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace('enter', 'return').replace('esc', 'escape');
}

// ==================== 全局单例 ====================

let _globalManager: KeybindingsManager | null = null;

export function getKeybindingsManager(): KeybindingsManager {
  if (!_globalManager) {
    _globalManager = new KeybindingsManager();
  }
  return _globalManager;
}

export function initKeybindingsManager(configPath?: string): KeybindingsManager {
  _globalManager = new KeybindingsManager(configPath);
  return _globalManager;
}
