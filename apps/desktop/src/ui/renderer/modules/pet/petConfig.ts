/**
 * petConfig — 宠物模块配置存储 (localStorage 单例 + React hook)
 *
 * 设计哲学: 跟 themePreset 同款 — 个人化 UI 偏好放 localStorage 即可, 不必走
 * SQLite. 不存敏感数据, 丢了无所谓 (用户重设一次), 跨设备的偏好由
 * "导出/导入设置" 通道 (后续) 统一负责.
 *
 * 真正的"宠物状态" (心情/饱食度/agent 当前在说什么等) 是 *运行时* state,
 * 由 PetWidget 内部的 hook 管理 — 那部分不进 localStorage, 重启归零.
 * 这里只存"我希望宠物长什么样 / 在哪 / 反不反应"这种配置.
 */

export type PetSkin =
  | 'robo-orange'  /* 橙色机器人 (RobotExpressive 原色) */
  | 'robo-azure'   /* 蓝色机器人 (色相 +55°) */
  | 'robo-violet'; /* 紫色机器人 (色相 +75°) */
/* 'custom-<uuid>' 是用户导入的 .glb 占的运行时 id, 不进 union — PetConfig.skin 类型放宽到 string. */

export type PetCorner = 'br' | 'bl' | 'tr' | 'tl';
/* 落点 — 用户拖出去之后, 松开吸附到最近角. 四角让宠物总停在不挡 main 区的位置.
 *   br=右下 (默认), bl=左下, tr=右上, tl=左上. */

export type PetSize = 'sm' | 'md' | 'lg';
/* sm=96px, md=128px (默认), lg=180px — 跟 IDEA / VSCode 的 "small/medium/large" 三档对齐 */

export interface PetCustomSkinMeta {
  /** 'custom-<uuid>' (跟 main 进程 petStorage 用同一 id) */
  id: string;
  name: string;
  /** main 进程 petStorage 返回的 fileName, 拼出 neox-pet://local/<fileName> */
  fileName: string;
  sizeBytes: number;
  importedAt: number;
}

import type { Pet2DSpec } from './pet2d.js';

export interface PetCustomSpriteMeta {
  /** 'sprite-<uuid>' (跟内置 'spr-*' 区分) */
  id: string;
  name: string;
  /** 文件名 (在 userData/pets/sprites/ 下) */
  fileName: string;
  sizeBytes: number;
  importedAt: number;
  /** 图集单元格尺寸 (px) — 由导入时 sharp 读出, 渲染器据此定位帧. 缺省回退 192×208. */
  cellWidth?: number;
  cellHeight?: number;
  /** Codex Pets manifest 描述 / 用户备注 */
  description?: string;
}

export interface PetConfig {
  /** 总开关 — 默认关 (商用版默认不打扰新用户, 让用户主动开). */
  enabled: boolean;
  /** 渲染模式 — svg=矢量原创形象(默认), 3d=.glb+Three.js, 2d=canvas 程序生成, sprite=像素 sprite sheet */
  mode: 'svg' | '3d' | '2d' | 'sprite';
  /** mode='svg' 时的色板变体 ('aurora'/'mint'/'peach'/'slate') */
  svgVariant: string;
  /** 当前 3D 形象. 'robo-*' 内置, 'custom-*' 用户导入. 仅 mode='3d' 时生效. */
  skin: PetSkin | string;
  /** 当前 sprite — 'spr-*' 内置, 'sprite-*' 用户导入. 仅 mode='sprite' 时生效. */
  activeSpriteId: string | null;
  /** 用户导入的 sprite sheet 元数据缓存 */
  customSprites: PetCustomSpriteMeta[];
  /** 默认贴靠的屏幕角落 (拖动松手后吸附过去) */
  corner: PetCorner;
  /** 尺寸档 */
  size: PetSize;
  /** Agent 说话气泡 — agent 输出 assistant_message 时浮气泡 N 秒 */
  speechBubble: boolean;
  /** Plan 进度条 — update_plan 事件触发, 完成数 / 总数 */
  showPlanProgress: boolean;
  /** 任务完成动画 — agent 跑完一轮 (run_result) 时宠物做开心动画 */
  reactOnTaskComplete: boolean;
  /** 出错抖动 — tool 报错 / agent 出错时宠物震一下 (引起注意, 跟 toast 互补) */
  reactOnError: boolean;
  /** 待机闲置动画 — 长时间无 agent 活动时眨眼/伸懒腰; 关掉则只在响应事件时动 */
  idleAnimations: boolean;
  /** 桌面置顶 — 给宠物窗口加 always-on-top (electron 子窗实现, P2 再做) */
  alwaysOnTop: boolean;
  /** 用户导入的 .glb skins 元数据缓存 — 真实文件在 main 进程 userData/pets/ 下
   * (索引存 main 的 index.json, 这份是 renderer 端拷贝便于 PetTab 列表 + PetWindow 解析).
   * PetTab 操作"导入 / 删除" 时, 拉 main 的 listCustomSkins 重建. */
  customSkins: PetCustomSkinMeta[];
  /** mode='2d' 时活跃的 spec id (从 savedPet2Ds 找) */
  active2DId: string | null;
  /** 用户保存的 2D 随机宠物 spec 列表 — 每个是一次"roll" 的结果, 用户可以 keep 多个备用 */
  savedPet2Ds: Pet2DSpec[];
  /** 已启用的"渲染器插件" id 列表 (核心只内置 svg+sprite; 3d 等重渲染器是按需启用的插件).
   *  只有在这里的插件, 其对应 mode 才会在 UI 出现 + 真正加载. */
  enabledPlugins: string[];
}

export const DEFAULT_PET_CONFIG: PetConfig = {
  enabled: false,
  mode: 'svg',
  svgVariant: 'aurora',
  skin: 'robo-orange',
  activeSpriteId: null,
  customSprites: [],
  corner: 'br',
  size: 'md',
  speechBubble: true,
  showPlanProgress: true,
  reactOnTaskComplete: true,
  reactOnError: true,
  idleAnimations: true,
  alwaysOnTop: false,
  customSkins: [],
  active2DId: null,
  savedPet2Ds: [],
  enabledPlugins: [],
};

const STORAGE_KEY = 'neox.petConfig.v1';

type Listener = (cfg: PetConfig) => void;

class PetConfigStore {
  private state: PetConfig = { ...DEFAULT_PET_CONFIG };
  private listeners = new Set<Listener>();

  constructor() {
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<PetConfig>;
          /* 合并 default — 老用户没有的新字段自动用默认; 新字段加上去 storage 里旧数据不爆 */
          this.state = { ...DEFAULT_PET_CONFIG, ...parsed };
          /* 2026-06 模式收敛 + 插件化:
           *   · 核心只内置 svg(灵动) + sprite(角色).
           *   · 2d(程序化卡通)彻底下线 → 老用户迁到 svg.
           *   · 3d 改成"渲染器插件": mode 仍合法, 但要在 enabledPlugins 里启用才出现.
           *     老用户之前在用 3d → 自动把 '3d' 加进 enabledPlugins, 保留他们的选择. */
          if (this.state.mode === '2d') {
            this.state.mode = 'svg';
          }
          if (this.state.mode === '3d' && !this.state.enabledPlugins.includes('3d')) {
            this.state.enabledPlugins = [...this.state.enabledPlugins, '3d'];
          }
        }
      } catch (e) {
        console.warn('[petConfig] failed to parse localStorage, using defaults:', e);
      }
    }
  }

  get(): PetConfig {
    return this.state;
  }

  set<K extends keyof PetConfig>(key: K, value: PetConfig[K]): void {
    this.state = { ...this.state, [key]: value };
    this.persist();
    this.notify();
  }

  toggle<K extends keyof PetConfig>(key: K): void {
    if (typeof this.state[key] === 'boolean') {
      this.set(key, !this.state[key] as PetConfig[K]);
    }
  }

  reset(): void {
    this.state = { ...DEFAULT_PET_CONFIG };
    this.persist();
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private persist(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (e) {
      console.warn('[petConfig] failed to persist to localStorage:', e);
    }
  }

  private notify(): void {
    for (const l of this.listeners) l(this.state);
  }
}

export const petConfig = new PetConfigStore();

/* React hook 包装 — 同 useExplorerSettings 风格 */
import { useEffect, useState } from 'react';

export function usePetConfig(): PetConfig {
  const [state, setState] = useState<PetConfig>(() => petConfig.get());
  useEffect(() => petConfig.subscribe(setState), []);
  return state;
}
