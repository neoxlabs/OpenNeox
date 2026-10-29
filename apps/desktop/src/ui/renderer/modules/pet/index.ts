/**
 * @neox/ui/pet — 桌宠模块 (P1 重做版)
 *
 * 设计目标: QQ 宠物医院翻版 — 2D sprite 拖拽宠物, 含心情/饱食度/状态机,
 *   可点击/拖动/喂食/陪玩交互. 跟 QQ 宠物的区别: 接 Agent 事件流, 显示
 *   "agent 现在在说什么 / 跑到 plan 第几步 / 报没报错". 详见 内部设计文档.
 *
 * 当前状态: Phase 0 — 配置存储 + Settings tab 已建. Phase 1 (sprite 渲染 + drag +
 *   agent 事件接入) 还没编码.
 */

export { petConfig, usePetConfig, DEFAULT_PET_CONFIG } from './petConfig.js';
export type { PetConfig, PetSkin, PetCorner, PetSize, PetCustomSpriteMeta } from './petConfig.js';
export { SPRITE_CANDIDATES, resolveSprite } from './spriteCandidates.js';
export type { SpriteCandidate } from './spriteCandidates.js';
export { PetSpriteSheet } from './PetSpriteSheet.js';
export { PET_SPRITE_STATES, moodToSpriteState } from './petSpriteStates.js';
export type { PetSpriteState } from './petSpriteStates.js';
/* PET_CANDIDATES + PetCandidate 在独立纯数据文件 petCandidates.ts —
 *   不依赖 Three.js, 静态 re-export 不会污染 PetPreview3D 的 lazy 拆分 chunk. */
export { PET_CANDIDATES, resolveSkin } from './petCandidates.js';
export type { PetCandidate } from './petCandidates.js';
export { usePetWindowSync } from './usePetWindowSync.js';
export { usePetAgentForwarder } from './usePetAgentForwarder.js';
