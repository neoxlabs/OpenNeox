
/** 图集描述 — built-in 默认 8×9 / 192×208, 导入的 sheet 按实际像素算 */
export interface SpriteAtlas {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

export const SPRITE_COLS = 8;
export const SPRITE_ROWS = 9;

/** 内置 sprite 的默认单元格尺寸 (我们自己生成的 sheet 是 192×208) */
export const CODEX_ATLAS: SpriteAtlas = {
  cols: SPRITE_COLS,
  rows: SPRITE_ROWS,
  cellWidth: 192,
  cellHeight: 208,
};

/* 向后兼容的常量别名 — 老代码 / 测试可能引用 */
export const SPRITE_FRAME_WIDTH = CODEX_ATLAS.cellWidth;
export const SPRITE_FRAME_HEIGHT = CODEX_ATLAS.cellHeight;
export const SPRITE_SHEET_WIDTH = CODEX_ATLAS.cellWidth * SPRITE_COLS;   /* 1536 */
export const SPRITE_SHEET_HEIGHT = CODEX_ATLAS.cellHeight * SPRITE_ROWS; /* 1872 */

/** 从整张 sheet 像素尺寸推出图集. 校验失败返回 null (调用方报错). */
export function atlasFromImageSize(width: number, height: number): SpriteAtlas | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  if (width % SPRITE_COLS !== 0 || height % SPRITE_ROWS !== 0) return null;
  return {
    cols: SPRITE_COLS,
    rows: SPRITE_ROWS,
    cellWidth: width / SPRITE_COLS,
    cellHeight: height / SPRITE_ROWS,
  };
}

export type PetSpriteState =
  | 'idle'           /* row 0 — 平时, 默认 */
  | 'running-right'  /* row 1 — 向右移动 (用户拖动 / agent 起步) */
  | 'running-left'   /* row 2 — 向左移动 */
  | 'waving'         /* row 3 — 打招呼 / 摸头反应 */
  | 'jumping'        /* row 4 — 任务完成庆祝 */
  | 'failed'         /* row 5 — 出错抖动 */
  | 'waiting'        /* row 6 — agent 跑长任务时, 等待中 */
  | 'running'        /* row 7 — 通用奔跑 */
  | 'review';

export interface SpriteStateDef {
  row: number;
  /** 每帧停留毫秒数. length = 实际播放帧数 (剩余列忽略). 跟 OpenPets PetAnimation 对齐. */
  frameDurationsMs: number[];
}

/** 跟 OpenPets PetAnimation.swift 完全一致 — 让 OpenPets / Codex / PetDex 的 sheet 直接能用 */
export const PET_SPRITE_STATES: Record<PetSpriteState, SpriteStateDef> = {
  idle:            { row: 0, frameDurationsMs: [2000, 880, 820, 880, 820, 2600] },
  'running-right': { row: 1, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left':  { row: 2, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving:          { row: 3, frameDurationsMs: [140, 140, 140, 280] },
  jumping:         { row: 4, frameDurationsMs: [140, 140, 140, 140, 280] },
  failed:          { row: 5, frameDurationsMs: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting:         { row: 6, frameDurationsMs: [150, 150, 150, 150, 150, 280] },
  running:         { row: 7, frameDurationsMs: [150, 150, 150, 150, 150, 280] },
  review:          { row: 8, frameDurationsMs: [150, 150, 150, 150, 150, 280] },
};

/** 该 state 的实际帧数 (列数) */
export function frameCount(state: PetSpriteState): number {
  return PET_SPRITE_STATES[state].frameDurationsMs.length;
}

/* 桌宠 mood (3D / 2D 共用语义) → sprite state 的映射 */
import type { PetMood } from './PetSceneR3F';
export function moodToSpriteState(mood: PetMood): PetSpriteState {
  switch (mood) {
    case 'idle':     return 'idle';
    case 'happy':    return 'waving';
    case 'success':  return 'jumping';
    case 'sleeping': return 'idle';      /* 没专门的睡眠状态, idle 兜底 */
    case 'error':    return 'failed';
    case 'speaking': return 'waving';
    case 'thinking': return 'waiting';
    case 'waiting':  return 'waiting';
    case 'running':  return 'running';
    case 'coding':   return 'review';    /* "在 review 代码" 语义最贴 coding */
    case 'reading':  return 'review';
    default:         return 'idle';
  }
}
