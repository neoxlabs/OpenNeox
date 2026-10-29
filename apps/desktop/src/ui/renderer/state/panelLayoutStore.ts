import { useSyncExternalStore } from 'react';


export type PanelLayoutMode = 'split' | 'swap' | 'tabs' | 'float';

const STORAGE_KEY = 'neox:panelLayout';
const VALID: readonly PanelLayoutMode[] = ['split', 'swap', 'tabs', 'float'];

const DEFAULT_LAYOUT: PanelLayoutMode = 'split';

let current: PanelLayoutMode = read();
const listeners = new Set<() => void>();

function read(): PanelLayoutMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'tabs') return DEFAULT_LAYOUT;
    return VALID.includes(v as PanelLayoutMode) ? (v as PanelLayoutMode) : DEFAULT_LAYOUT;
  } catch {
    /* 隐私窗口 / 禁用站点数据: 读不到就按默认版面, 不影响使用 */
    return DEFAULT_LAYOUT;
  }
}

export function getPanelLayout(): PanelLayoutMode {
  return current;
}

export function setPanelLayout(next: PanelLayoutMode): void {
  if (!VALID.includes(next) || next === current) return;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* 存不下也照常切, 只是重启回默认 */ }
  listeners.forEach((fn) => fn());
}

export function ensureSurfaceVisible(): void {
  /* tabs 版面下"看得见"= 选中 Surface 那个选项卡; 左右并排的两种本来就看得见。 */
  if (current === 'tabs') setActiveTab('surface');
}

export function ensureMainVisible(): void {
  if (current === 'tabs') setActiveTab('timeline');
}

/* ---- tabs 版面下当前选中的是哪一个 ---- */
export type PanelTab = 'timeline' | 'surface';

const TAB_KEY = 'neox:panelTab';
function readTab(): PanelTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'surface' ? 'surface' : 'timeline';
  } catch {
    return 'timeline';
  }
}
let activeTab: PanelTab = readTab();

export function getActivePanelTab(): PanelTab {
  return activeTab;
}

export function setActiveTab(next: PanelTab): void {
  if (next === activeTab) return;
  activeTab = next;
  try { localStorage.setItem(TAB_KEY, next); } catch { /* 存不下也照常切, 只是重启回默认 */ }
  listeners.forEach((fn) => fn());
}

export function useActivePanelTab(): PanelTab {
  return useSyncExternalStore(subscribePanelLayout, getActivePanelTab, getActivePanelTab);
}

export function subscribePanelLayout(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/* React 侧入口 —— useSyncExternalStore, 订阅粒度到"用到版面的那几个组件" */
export function usePanelLayout(): PanelLayoutMode {
  return useSyncExternalStore(subscribePanelLayout, getPanelLayout, getPanelLayout);
}
