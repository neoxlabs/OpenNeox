/**
 * petCandidates — 桌宠候选清单 (纯数据, 不含任何 Three.js / 渲染依赖)
 *
 * 拆出来的原因: PetPreview3D 静态 import 整个 Three.js 子树, 大. PetTab 通过 lazy
 * 把它拆 chunk; 但 PET_CANDIDATES 是普通 PetTab 主路径要用的元数据 (卡片标题/描述),
 * 不该跟 PetPreview3D 同模块 —— 否则 vite 会因为 静态 + 动态 双 import 把 chunk 合回去.
 *
 * 这个文件保持 ≤ 200 行纯数据 / 类型, 没有 react 没有 three, 静态 export 安全.
 */

export interface PetCandidate {
  id: string;
  name: string;
  nameEn: string;
  /** 本地 URL (vite publicDir=assets, 所以 /pets/x.glb → assets/pets/x.glb) */
  url: string;
  /** 自动播这个 clip; RobotExpressive 带 14 个 */
  defaultClip?: string;
  /** 全部可用 clip (后续真桌宠按 mood 切) */
  clips?: string[];
  /** HSL 色相旋转 (0-1). 0=原色, 0.33=暖橙→翠绿, 0.66=暖橙→蓝紫 */
  hueShift?: number;
  /** LLM-driven 性格 (Phase 1 真接通后 by LLM 生成, 这里先列预期) */
  personality?: string;
  license: string;
  author: string;
  source: string;
  bytes: number;
  note?: string;
}

export const PET_CANDIDATES: PetCandidate[] = [
  {
    id: 'robo-orange',
    name: '橙小帅',
    nameEn: 'Citrus Bot',
    url: `${import.meta.env.BASE_URL}pets/robot.glb`,
    defaultClip: 'Idle',
    clips: ['Idle', 'Walking', 'Running', 'Dance', 'Jump', 'Wave', 'Yes', 'No', 'ThumbsUp', 'Sitting', 'Punch'],
    hueShift: 0,
    personality: '热情活泼, 任务完成时会跳舞庆祝, 没事就 ThumbsUp',
    license: 'CC-BY 4.0 (需在 About 页署名 Tomás Laulhé, 允许商用, 终身免费)',
    author: 'Tomás Laulhé',
    source: '本地 assets/pets/robot.glb',
    bytes: 463988,
    note: '⭐ 14 套动画 — Wave/ThumbsUp/Dance/Yes/No/Sitting/Punch 都有, 跟桌宠的 mood 状态一一对应',
  },
  {
    id: 'robo-azure',
    name: '蓝精灵',
    nameEn: 'Azure Bot',
    url: `${import.meta.env.BASE_URL}pets/robot.glb`,
    defaultClip: 'Idle',
    clips: ['Idle', 'Walking', 'Running', 'Dance', 'Jump', 'Wave', 'Yes', 'No', 'ThumbsUp', 'Sitting', 'Punch'],
    hueShift: 0.55,
    personality: '冷静理性, 思考时眼神锐利, 报错时礼貌摇头 (No 动画)',
    license: 'CC-BY 4.0 (复用同一 .glb, 色相旋转 +55°)',
    author: 'Tomás Laulhé',
    source: '本地 assets/pets/robot.glb (hueShift=0.55)',
    bytes: 0,
    note: '同一 mesh + 蓝色调 + 不同 LLM 人格 = 一只新桌宠, 包体零增量',
  },
  {
    id: 'robo-violet',
    name: '紫罗兰',
    nameEn: 'Violet Bot',
    url: `${import.meta.env.BASE_URL}pets/robot.glb`,
    defaultClip: 'Idle',
    clips: ['Idle', 'Walking', 'Running', 'Dance', 'Jump', 'Wave', 'Yes', 'No', 'ThumbsUp', 'Sitting', 'Punch'],
    hueShift: 0.75,
    personality: '神秘古怪, 偶尔自言自语, 喜欢 Sitting 看你工作',
    license: 'CC-BY 4.0 (复用同一 .glb, 色相旋转 +75°)',
    author: 'Tomás Laulhé',
    source: '本地 assets/pets/robot.glb (hueShift=0.75)',
    bytes: 0,
    note: '紫调 + 慢半拍的人格 — 适合喜欢 chill 体验的用户',
  },
];

/**
 * 通过 skin id 拿 .glb url + hueShift. PetWindowRoot / PetTab 共用.
 *
 * customSkins 是 PetConfig.customSkins 列表 (用户导入的 .glb 元数据). custom-*
 * id 走 neox-pet:// 协议 (main 进程 protocol handler 服务 userData/pets/<fileName>).
 * 用户导入的 .glb 没有色相和 clips 元数据 — 用 0 / undefined.
 *
 * 找不到 skin (cfg 写的 id 在内置和 custom 列表都不存在, 比如用户删过) → fallback 内置 robo-orange.
 */
export function resolveSkin(
  skinId: string,
  customSkins?: Array<{ id: string; fileName: string }>,
): { url: string; hueShift: number; clips?: string[] } {
  if (skinId.startsWith('custom-') && customSkins) {
    const found = customSkins.find((c) => c.id === skinId);
    if (found) return { url: `neox-pet://local/${found.fileName}`, hueShift: 0 };
  }
  const found = PET_CANDIDATES.find((c) => c.id === skinId);
  if (found) return { url: found.url, hueShift: found.hueShift ?? 0, clips: found.clips };
  /* fallback: 默认 robo-orange */
  const fallback = PET_CANDIDATES[0];
  return { url: fallback.url, hueShift: fallback.hueShift ?? 0, clips: fallback.clips };
}
