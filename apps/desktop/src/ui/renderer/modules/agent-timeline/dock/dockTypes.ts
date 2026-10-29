import type React from 'react';

/** 语义色 —— 只描述"这件事处于什么状态", 具体颜色由 dock.css 的 tone 变量决定 */
export type DockTone =
  | 'running'   /* 正在进行 (蓝/主色 + 呼吸点) */
  | 'attention' /* 等用户处理 (琥珀 + 脉冲) */
  | 'ok'        /* 成功收尾 */
  | 'warn'      /* 中断 / 暂停 */
  | 'err'       /* 失败 */
  | 'muted';    /* 中性信息 */

/** 药丸尾部动作 —— icon 或短英文文案 (Allow / Deny)。两者择一, 文案优先。 */
export interface DockPillAction {
  id: string;
  icon?: React.ReactNode;
  /** 短标签, 如 Allow / Deny —— 比纯 icon 不易撞车 (两个 ✕ 曾让用户迷惑) */
  label?: string;
  title: string;
  danger?: boolean;
  /** 正向动作 (Allow) 用成功色 */
  primary?: boolean;
  onClick: () => void;
}

export interface DockPill {
  /** 全局唯一; 跨渲染保持稳定 (用它记忆展开态 / 提醒是否已经播过) */
  id: string;
  tone: DockTone;
  icon: React.ReactNode;
  /** 主文案 —— 必须短 (中文 ≤ 8 字), 长的放 detail */
  label: string;
  /** 右侧小字: 计时 / 计数 */
  meta?: string;
  /** 展开态与 ⋯ 菜单里显示的补充说明 */
  detail?: string;
  /**
   * 排序权重, 越小越靠前。同权重按 updatedAt 倒序 (最新的在最前)。
   * 约定: 10 待办/审阅 · 20 运行中 · 30 计划 · 40 已收尾
   */
  weight: number;
  attention?: boolean;
  expandDetail?: boolean;
  /** 最近一次状态变化的时间戳 —— 同权重内越新越靠前 */
  updatedAt: number;
  actions?: DockPillAction[];
  /** 点药丸主体做什么; 有 panel 时默认是开/关面板 */
  onActivate?: () => void;
  /** 展开面板的内容 (完整列表 / 明细), 渲染在药丸行下方 */
  panel?: React.ReactNode;
  autoOpenPanel?: boolean;
  panelInline?: boolean;
  /** 浮层标题 (缺省用 label); 浮层标题行右边的小字 (缺省用 meta) */
  popTitle?: string;
  popMeta?: string;
  /** 无障碍名称, 缺省用 label */
  ariaLabel?: string;
}

/** 排序: 要处理的最前 → 权重 → 最新 */
export function sortDockPills(pills: DockPill[]): DockPill[] {
  return [...pills].sort((a, b) => {
    if (!!b.attention !== !!a.attention) return b.attention ? 1 : -1;
    if (a.weight !== b.weight) return a.weight - b.weight;
    return b.updatedAt - a.updatedAt;
  });
}
