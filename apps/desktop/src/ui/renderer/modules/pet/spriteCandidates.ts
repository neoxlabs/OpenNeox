/**
 * spriteCandidates — 内置 sprite sheet 候选清单 (纯数据)
 *
 * 全部从 /sprites/<id>.webp 本地加载, 100% CC0 / 我们自己代码生成.
 *
 * 后续:
 *   1. assets/pets/sprites/*.webp 是用 scripts/generate-pet-sprites.ts 生成的
 *      (Node canvas, 程序化绘制, 纯算法没用任何第三方 art) — 见那个脚本注释
 *   2. 用户从 PetDex / itch.io / Kenney 等下载的 sprite 走 customSprites
 *      (经 neox-pet:// 协议加载)
 */

export interface SpriteCandidate {
  id: string;
  name: string;
  nameEn: string;
  /** 本地 URL — 通过 vite publicDir 服务 */
  url: string;
  /** 一句话个性描述 (PetTab 卡片显示) */
  description: string;
  /** 由谁画的 / 资产来源 (License 信息) */
  attribution: string;
}

export const SPRITE_CANDIDATES: SpriteCandidate[] = [
  /* 2026-06: 移除脚本生成的通用内置 (橘喵/小兔/小幽灵) — 画质一般, 拉低第一印象.
   * 「角色」模式改为以"导入 / 发现已安装"为主 (Starcorn / PetDex / 社区作品),
   * 零素材的好看默认由「灵动 (Neo)」承担. 这里留空数组, 需要时再放精选 CC0 角色. */
];

/** 通过 id 解析 sprite URL + 图集尺寸 — built-in + customSprites 都查 */
export function resolveSprite(
  id: string | null,
  customSprites?: Array<{ id: string; fileName: string; cellWidth?: number; cellHeight?: number }>,
): { url: string; name: string; cellWidth?: number; cellHeight?: number } | null {
  if (!id) return null;
  if (id.startsWith('sprite-') && customSprites) {
    const found = customSprites.find((s) => s.id === id);
    /* sprites 走 sprite/ 子路径 — resolveCustomSkinPath 用这个区分 .glb 跟 sprite */
    if (found) return {
      url: `neox-pet://local/sprite/${found.fileName}`,
      name: found.fileName,
      cellWidth: found.cellWidth,
      cellHeight: found.cellHeight,
    };
  }
  const found = SPRITE_CANDIDATES.find((c) => c.id === id);
  if (found) return { url: found.url, name: found.name };
  /* 没匹配 (内置已空 / id 失效) → null, PetWindowRoot 显示"选个角色"提示 */
  return null;
}
