
import { roundPathCorners } from '@neoxlabs/pptx-renderer';
import type { Motif, StyleSpec } from './styleSpec.js';

export interface MotifPath {
  d: string;
  viewBox: { width: number; height: number };
}

/* ============================================================
 * 装饰片 —— 每个 motif 的"签名图形", 用在标题条 / 章节页 / 背景
 * ============================================================ */

/** 标题左侧的记号 —— 每个 motif 一种, 这是"一眼认出是同一套"的关键 */
export function titleMark(spec: StyleSpec): MotifPath {
  const r = spec.radius.path;
  switch (spec.motif) {
    case 'chevron':
      /* 斜切块: 右侧出尖 */
      return { d: roundPathCorners('M0 0 L44 0 L64 32 L44 64 L0 64 Z', r), viewBox: { width: 64, height: 64 } };
    case 'ribbon':
      /* 丝带头: 右侧内凹燕尾 */
      return { d: roundPathCorners('M0 0 L64 0 L52 32 L64 64 L0 64 Z', r), viewBox: { width: 64, height: 64 } };
    case 'capsule':
      /* 全圆角方块 */
      return { d: roundPathCorners('M0 0 L64 0 L64 64 L0 64 Z', 22), viewBox: { width: 64, height: 64 } };
    case 'line':
      /* 一根粗竖线 */
      return { d: 'M0 4 L6 4 L6 60 L0 60 Z', viewBox: { width: 64, height: 64 } };
    case 'none':
    default:
      return { d: 'M0 0 L64 0 L64 64 L0 64 Z', viewBox: { width: 64, height: 64 } };
  }
}

/** 流程/步骤里的"推进"图形 —— 有向, 表示从这一步到下一步 */
export function advanceShape(spec: StyleSpec): MotifPath {
  const r = spec.radius.path;
  switch (spec.motif) {
    case 'chevron':
      /* 明康参考图那个肥箭羽: 尾部内凹 + 头部出尖 */
      return {
        d: roundPathCorners('M0 0 L104 0 L160 60 L104 120 L0 120 L56 60 Z', r),
        viewBox: { width: 160, height: 120 },
      };
    case 'ribbon':
      /* 横幅 + 燕尾 */
      return {
        d: roundPathCorners('M0 20 L160 20 L160 100 L0 100 L14 60 Z', r),
        viewBox: { width: 160, height: 120 },
      };
    case 'capsule':
      /* 胶囊 (两端全圆) —— 用路径画, 保证和其它 motif 走同一条渲染通道 */
      return {
        d: 'M60 20 L100 20 A40 40 0 0 1 100 100 L60 100 A40 40 0 0 1 60 20 Z',
        viewBox: { width: 160, height: 120 },
      };
    case 'line':
      /* 细长条 + 端点方块 */
      return { d: 'M0 56 L160 56 L160 64 L0 64 Z', viewBox: { width: 160, height: 120 } };
    case 'none':
    default:
      return { d: 'M0 30 L160 30 L160 90 L0 90 Z', viewBox: { width: 160, height: 120 } };
  }
}

/** 章节页 / 封面的大面积背景装饰 */
export function backdropShape(spec: StyleSpec): MotifPath {
  const r = spec.radius.path * 2;
  switch (spec.motif) {
    case 'chevron':
      return { d: roundPathCorners('M120 0 L400 0 L400 300 L120 300 L0 150 Z', r), viewBox: { width: 400, height: 300 } };
    case 'ribbon':
      return { d: roundPathCorners('M0 0 L400 0 L400 240 L200 300 L0 240 Z', r), viewBox: { width: 400, height: 300 } };
    case 'capsule':
      return {
        d: 'M150 0 L400 0 L400 300 L150 300 A150 150 0 0 1 150 0 Z',
        viewBox: { width: 400, height: 300 },
      };
    case 'line':
      return { d: 'M0 0 L400 0 L400 4 L0 4 Z', viewBox: { width: 400, height: 300 } };
    case 'none':
    default:
      return { d: 'M0 0 L400 0 L400 300 L0 300 Z', viewBox: { width: 400, height: 300 } };
  }
}


/**
 * 竖切: 把整版切成左右两块, 返回**色块那一侧**的轮廓。
 * side='left' → 色块在左, 边界在 x≈width*ratio。
 *
 * skew 是边界的水平摆动量, 也是留给排版的危险区 —— page-frame 会按它退让,
 * 否则斜边会啃到文字 (这是斜切版最容易翻的车)。
 */
export function splitPanelShape(
  spec: StyleSpec,
  opts: { width: number; height: number; ratio: number; side?: 'left' | 'right' },
): MotifPath & { skew: number } {
  const { width: w, height: h } = opts;
  const left = (opts.side ?? 'left') === 'left';
  const e = w * opts.ratio;

  /* 所有分支都按"色块在左"画, 最后需要的话整体镜像 —— 免得每种 motif 写两遍。 */
  let d: string;
  let skew: number;
  switch (spec.motif) {
    case 'chevron': {
      /* 斜切: 上宽下窄。摆动量按版高走, 10% 已经很明显但还不至于吃掉一整栏。 */
      skew = h * 0.1;
      d = `M0 0 L${f(e + skew)} 0 L${f(e - skew)} ${f(h)} L0 ${f(h)} Z`;
      break;
    }
    case 'ribbon': {
      /* 燕尾: 边界在半高处内凹一口, 呼应丝带的缺口 */
      skew = w * 0.03;
      d = `M0 0 L${f(e)} 0 L${f(e - skew)} ${f(h / 2)} L${f(e)} ${f(h)} L0 ${f(h)} Z`;
      break;
    }
    case 'capsule': {
      /* 外鼓的弧: 用二次贝塞尔, 控制点放到 e+bulge*2 才能鼓到 e+bulge */
      skew = w * 0.035;
      d = `M0 0 L${f(e - skew)} 0 Q${f(e + skew * 2)} ${f(h / 2)} ${f(e - skew)} ${f(h)} L0 ${f(h)} Z`;
      break;
    }
    case 'line':
    case 'none':
    default:
      /* 直边。line 风格的克制本来就是它的识别度, 不该硬给它加个花边。 */
      skew = 0;
      d = `M0 0 L${f(e)} 0 L${f(e)} ${f(h)} L0 ${f(h)} Z`;
      break;
  }

  if (!left) d = mirrorX(d, w);
  return { d, viewBox: { width: w, height: h }, skew };
}

/**
 * 横切: 顶部一条通栏出血色带, 返回色带轮廓。下边界随 motif 变化。
 * 色带是"把标题压在深色上"的最省事做法 —— 不动内容结构就能给一页立住重心。
 */
export function bandShape(
  spec: StyleSpec,
  opts: { width: number; height: number },
): MotifPath & { skew: number } {
  const { width: w, height: h } = opts;
  let d: string;
  let skew: number;
  switch (spec.motif) {
    case 'chevron':
      /* 下边界斜着走 —— 右低左高, 和 chevron 的前进方向一致 */
      skew = h * 0.22;
      d = `M0 0 L${f(w)} 0 L${f(w)} ${f(h - skew)} L0 ${f(h)} Z`;
      break;
    case 'ribbon':
      /* 下边界中间垂一个尖 —— 横幅的下摆 */
      skew = h * 0.18;
      d = `M0 0 L${f(w)} 0 L${f(w)} ${f(h - skew)} L${f(w / 2)} ${f(h)} L0 ${f(h - skew)} Z`;
      break;
    case 'capsule':
      /* 右下角一个大圆角 */
      skew = h * 0.3;
      d = `M0 0 L${f(w)} 0 L${f(w)} ${f(h - skew)} Q${f(w)} ${f(h)} ${f(w - skew)} ${f(h)} L0 ${f(h)} Z`;
      break;
    case 'line':
    case 'none':
    default:
      skew = 0;
      d = `M0 0 L${f(w)} 0 L${f(w)} ${f(h)} L0 ${f(h)} Z`;
      break;
  }
  return { d, viewBox: { width: w, height: h }, skew };
}

function f(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** 沿 x=w/2 镜像一条 path —— 只处理 M/L/Q/Z (上面用到的全部指令) */
function mirrorX(d: string, w: number): string {
  const tokens = d.match(/[MLQZ]|-?[\d.]+/g) ?? [];
  const out: string[] = [];
  let cmd = '';
  let nums: number[] = [];
  const flush = () => {
    if (!cmd) return;
    if (cmd === 'Z') { out.push('Z'); }
    else {
      const m = nums.map((n, i) => (i % 2 === 0 ? f(w - n) : f(n)));
      out.push(cmd + m.join(' '));
    }
    nums = [];
  };
  for (const tk of tokens) {
    if (/[MLQZ]/.test(tk)) { flush(); cmd = tk; }
    else nums.push(parseFloat(tk));
  }
  flush();
  return out.join(' ');
}

/**
 * 分隔符 —— 标题和正文之间那根线 / 那个记号。
 * strokeOnly 的路径在导出时走 fill="none"。
 */
export function dividerShape(spec: StyleSpec): MotifPath {
  switch (spec.motif) {
    case 'chevron':
      return { d: 'M0 0 L48 0 L56 8 L48 16 L0 16 Z', viewBox: { width: 56, height: 16 } };
    case 'ribbon':
      return { d: 'M0 0 L56 0 L48 8 L56 16 L0 16 Z', viewBox: { width: 56, height: 16 } };
    case 'capsule':
      return { d: 'M8 0 L48 0 A8 8 0 0 1 48 16 L8 16 A8 8 0 0 1 8 0 Z', viewBox: { width: 56, height: 16 } };
    case 'line':
    case 'none':
    default:
      return { d: 'M0 6 L56 6 L56 10 L0 10 Z', viewBox: { width: 56, height: 16 } };
  }
}

/* ============================================================
 * 层次配方 —— "艺术细节"的真正来源
 * ============================================================
 * 拆明康那张 WPS 参考图时发现的: 那个好看的箭头**不是一个更强的形状**,
 * 是三层叠出来的 —— 半透明大箭羽 + 实色胶囊 + 白色圆。
 * 所以"精致"来自图层错位 + 透明度, 不来自形状库。
 * 这里把这条配方固化, 每个 motif 都按同样的逻辑出三层。
 */

export interface LayerRecipe {
  /** 背衬层: 更大、更淡、错位 —— 制造纵深 */
  backdrop: { path: MotifPath; scale: number; offsetX: number; offsetY: number; colorRole: 'accentSoft' | 'subtle' };
  body: { path: MotifPath; colorRole: 'accent' | 'ink'; keepAspect?: boolean };
  /** 是否要一个白色圆(放编号) */
  badge: boolean;
}

export function stepLayerRecipe(spec: StyleSpec): LayerRecipe {
  const adv = advanceShape(spec);
  switch (spec.motif) {
    case 'chevron':
      return {
        backdrop: { path: adv, scale: 1.3, offsetX: 0.28, offsetY: -0.28, colorRole: 'accentSoft' },
        body: { path: capsulePath(spec), colorRole: 'accent' },
        badge: true,
      };
    case 'ribbon':
      return {
        backdrop: { path: adv, scale: 1.18, offsetX: 0.1, offsetY: -0.16, colorRole: 'accentSoft' },
        body: { path: capsulePath(spec), colorRole: 'accent' },
        badge: true,
      };
    case 'capsule':
      return {
        backdrop: { path: adv, scale: 1.22, offsetX: 0.18, offsetY: -0.2, colorRole: 'accentSoft' },
        body: { path: capsulePath(spec), colorRole: 'accent' },
        badge: true,
      };
    case 'line':
      return {
        backdrop: { path: adv, scale: 1, offsetX: 0, offsetY: 0, colorRole: 'subtle' },
        body: { path: dotPath(), colorRole: 'accent', keepAspect: true },
        badge: false,
      };
    case 'none':
    default:
      return {
        backdrop: { path: adv, scale: 1, offsetX: 0, offsetY: 0, colorRole: 'subtle' },
        body: { path: capsulePath(spec), colorRole: 'accent' },
        badge: false,
      };
  }
}

/** 胶囊 (stadium) —— 两端全圆, 用真圆弧画 */
export function capsulePath(_spec: StyleSpec): MotifPath {
  return {
    d: 'M30 0 L170 0 A30 30 0 0 1 170 60 L30 60 A30 30 0 0 1 30 0 Z',
    viewBox: { width: 200, height: 60 },
  };
}

/** 实心圆点 —— line motif 的节点 */
export function dotPath(): MotifPath {
  return {
    d: 'M16 0 A16 16 0 0 1 16 32 A16 16 0 0 1 16 0 Z',
    viewBox: { width: 32, height: 32 },
  };
}

/** motif → 一句给出图模型的形容, 让配图和形态语言不打架 */
export const MOTIF_IMAGE_HINT: Record<Motif, string> = {
  chevron: 'dynamic diagonal composition, forward motion',
  ribbon: 'ceremonial banner composition, centered and formal',
  capsule: 'soft rounded composition, friendly and approachable',
  line: 'clean linear composition, generous negative space',
  none: 'plain uncluttered composition',
};
