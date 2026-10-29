/**
 * diagram-pages — 以图示为主体的四个页型.
 *
 * 【为什么必须有这一层】diagram-bits 把组件造出来了, 但**没有任何模板调用它** ——
 * 那等于没造。这套引擎今晚已经在同一个坑里栽了七次 (customPath 字段不存在导致
 * 整个形状库无人可用 · maxLines 只影响测量不影响输出 · cornerRadius 两个渲染器
 * 都不认 · decor 那条 HTML→PNG 管线至今零调用方 …), 症状全都是
 * "能力做完了, 但从调用方看过去什么都没变"。
 *
 * 所以组件和页型必须同一批交付。页型是 agent 唯一能选的东西。
 *
 * 【选型是语义决定的, 不是好看决定的】
 *   processFlow   内容有**先后**   → 箭头链
 *   versusPage    内容有**对立**   → 双面板
 *   hierarchyPage 内容有**高低**   → 金字塔
 *   funnelPage    内容**逐级收窄** → 漏斗
 * 拿漏斗去画三个并列的要点, 观众会以为它们之间有流失关系 —— 图示画错
 * 比不画更糟, 因为它传达了内容里不存在的意思。
 */

import type { Slide } from '@neoxlabs/pptx-renderer';
import { render } from '../bridge/render.js';
import { VStack, Text } from '../compose/dsl.js';
import { activeTheme } from './theme.js';
import { iconGlyph } from './icon-bits.js';
import { dividerMotif, nothing, titleSizeForBox } from './motif-bits.js';
import { bleedBandFrame } from './page-frame.js';
import {
  flowArrow, versusBlock, pyramidStack, funnelStack,
  type FlowStep, type VersusSide, type StackLevel,
} from './diagram-bits.js';
import { chevronFlow, foldRibbon, stairArrow, podium3D } from './step-figures.js';
import { nodeChain } from './chain-bits.js';
import { proportionBar } from './dataviz-bits.js';
import type { IconName } from './icon-bits.js';

/* 标题区需要的高度: kicker(26) + 间距(12) + 标题(约 67) + 间距(12) + 记号(16).
 * 传内容高而不是色带高 —— 色带该多高由 bleedBandFrame 按各风格的斜切比例反解,
 * 调用方不可能知道那个比例 (featureGrid 就是在这里把整页压到 0.72 密度的)。 */
const HEAD_H = 140;

/** 四个页型共用的标题区 —— 出血色带压标题, 图示在带下 */
function headBand(slide: Slide, kicker: string | undefined, title: string | undefined) {
  const t = activeTheme();
  const { band, main } = bleedBandFrame(slide, { contentHeight: HEAD_H });

  render(slide,
    VStack({ gap: 12, align: 'stretch', justify: 'center', width: band.bounds.width, height: band.bounds.height }, [
      kicker
        ? Text(kicker, {
            fontSize: 14, bold: true, color: band.accent,
            letterSpacingPt: 2.4, uppercase: true,
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
      title
        ? Text(title, {
            fontSize: titleSizeForBox(title, band.bounds.width, { max: 36, min: 24, maxLines: 2 }),
            bold: true, color: band.ink, letterSpacingPt: -0.2,
            fontLatin: t.fonts.displayLatin, fontEast: t.fonts.displayEast,
          })
        : nothing(),
      title ? dividerMotif(64, 16, band.accent) : nothing(),
    ]),
    { bounds: band.bounds, assertNoOverlap: false },
  );
  return main;
}

/* ============================================================
 * processFlow —— 步骤有先后
 * ============================================================ */

export interface ProcessFlowSlots {
  kicker?: string;
  title?: string;
  steps: Array<FlowStep & { icon?: IconName }>;
  /**
   * 箭头的画法。
   *   separated  (默认) 五个**分离**的箭头 + 回声轮廓 + 斜引线 + 图标徽章。
   *              每一步都有说明时用它 —— 说明就挂在斜引线尽头。
   *   interlocked 咬合成一条连续的箭头链, 说明写在箭头内部。
   *              步骤多、每步只有几个字时更紧凑。
   *   ribbon     一条折叠的纸带, 编号在带上, 说明用发丝引线上下交替引出。
   *              最"平", 适合步骤是流水作业、没有强弱之分的场合。
   *   stair      两个一层往上垒 + 顶端一个大箭头。**最后一项是目标/结果**,
   *              所以只在"层层递进指向一个终点"时用, 平行的五步用它是误导。
   *   chain      圆节点 + 弧形箭头链。节点里放图标, 说明在下方。
   *              步骤是"环节"而不是"动作"时更贴切 (角色/阶段/关卡)。
   *
   * 五种都是同一个语义 (有先后), 只是画法不同 —— 所以是 variant 而不是五个页型。
   * 给 agent 五个语义相同的页型只会让它选错, 而选错页型比画得朴素严重得多。
   *
   * 默认给 separated 是因为它明显更好看: 分离留出空气、回声轮廓给形状余像、
   * 锐角有速度感、斜引线和箭头同角度。这几样是"看着像设计过"的来源。
   */
  variant?: 'separated' | 'interlocked' | 'ribbon' | 'stair' | 'chain';
  /** 图示下方的一句结论 (可选) —— 图讲"怎么走", 这句讲"所以呢" */
  note?: string;
}

export function processFlow(slide: Slide, slots: ProcessFlowSlots) {
  const t = activeTheme();
  const main = headBand(slide, slots.kicker, slots.title);

  const items = slots.steps.map((s) => ({ label: s.label, desc: s.desc, icon: s.icon }));
  const v = slots.variant ?? 'separated';

  /* 这四种都自带引线/说明的排布, 所以各自要整块主区, 不再叠 VStack */
  if (v !== 'interlocked') {
    const figure = v === 'ribbon'
      ? foldRibbon({ items, width: main.bounds.width, height: main.bounds.height })
      : v === 'stair'
        ? stairArrow({ items, width: main.bounds.width, height: main.bounds.height })
        : v === 'chain'
          ? nodeChain({
              steps: items, width: main.bounds.width, height: main.bounds.height,
              track: 'row', connector: 'arc', labelPlacement: 'below',
            })
          : chevronFlow({ items, width: main.bounds.width, height: main.bounds.height });
    render(slide, figure, { bounds: main.bounds, assertNoOverlap: false, fit: false });
    return;
  }

  /* 步骤多了每格就窄, 字会被斜切挤掉 —— 按格宽给高度, 窄格用高一点的箭头
   * 换取文字区的纵向空间。5 步以上再挤就该换页型了, 那是调用方的决定。 */
  const perW = main.bounds.width / Math.max(1, slots.steps.length);
  const flowH = perW < 220 ? 210 : 190;

  render(slide,
    VStack({ gap: 26, align: 'center', width: main.bounds.width }, [
      flowArrow({ steps: slots.steps, width: main.bounds.width, height: flowH }),
      slots.note
        ? Text(slots.note, {
            fontSize: 15, color: main.muted, width: Math.round(main.bounds.width * 0.82),
            textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
    ]),
    { bounds: main.bounds, assertNoOverlap: false },
  );
}

/* ============================================================
 * versusPage —— 两者对立
 * ============================================================ */

export interface VersusPageSlots {
  kicker?: string;
  title?: string;
  left: VersusSide;
  right: VersusSide;
  /** 中缝徽章文字, 默认 VS */
  badge?: string;
  /**
   * 两侧的**占比**, 比如 {left: 62, right: 38}。给了就在面板下方画一条占比条。
   * 只在两者确实构成一个整体的切分时给 (预算分配/份额/工时占比);
   * "自建 vs 外包"这种选择题没有占比, 硬给一个数就是编的。
   */
  share?: { left: number; right: number };
  note?: string;
}

export function versusPage(slide: Slide, slots: VersusPageSlots) {
  const t = activeTheme();
  const main = headBand(slide, slots.kicker, slots.title);

  /* 面板高度按条目数算, 不写死: 条目少时写死高度会留出一大片空面板,
   * 那片空白会被读成"这里还有没写完的东西"。 */
  const rows = Math.max(
    (slots.left.items ?? []).length,
    (slots.right.items ?? []).length,
  );
  const panelH = Math.min(main.bounds.height - (slots.note ? 54 : 0), 130 + rows * 34);

  render(slide,
    VStack({ gap: 22, align: 'center', width: main.bounds.width }, [
      versusBlock({
        left: slots.left, right: slots.right, label: slots.badge,
        width: main.bounds.width, height: panelH,
      }),
      slots.share
        ? proportionBar({
            segments: [{ value: slots.share.left }, { value: slots.share.right }],
            width: main.bounds.width, height: 16,
          })
        : nothing(),
      slots.note
        ? Text(slots.note, {
            fontSize: 15, color: main.muted, width: Math.round(main.bounds.width * 0.82),
            textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
    ]),
    { bounds: main.bounds, assertNoOverlap: false },
  );
}

/* ============================================================
 * hierarchyPage / funnelPage —— 层级 与 逐级收窄
 * ============================================================ */

export interface TaperPageSlots {
  kicker?: string;
  title?: string;
  levels: StackLevel[];
  note?: string;
}

function taperPage(slide: Slide, slots: TaperPageSlots, kind: 'pyramid' | 'funnel') {
  const t = activeTheme();
  const main = headBand(slide, slots.kicker, slots.title);

  const noteH = slots.note ? 54 : 0;
  const h = Math.min(main.bounds.height - noteH, slots.levels.length * 110);
  /* 塔和漏斗都不该通栏: 一个占满整幅版心的三角形会把版面撑得很笨重,
   * 而且梯形的斜边越平越不像塔。收到 0.62~0.7 幅宽, 两侧留白反而托住它。 */
  const w = Math.round(main.bounds.width * (kind === 'pyramid' ? 0.62 : 0.70));

  const figure = kind === 'pyramid'
    ? pyramidStack({ levels: slots.levels, width: w, height: h })
    : funnelStack({ levels: slots.levels, width: w, height: h });

  render(slide,
    VStack({ gap: 20, align: 'center', width: main.bounds.width }, [
      figure,
      slots.note
        ? Text(slots.note, {
            fontSize: 15, color: main.muted, width: Math.round(main.bounds.width * 0.82),
            textAlign: 'ctr',
            fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
          })
        : nothing(),
    ]),
    { bounds: main.bounds, assertNoOverlap: false },
  );
}

/** 层级页 —— 战略/规划/执行, 能力分级这类"有高低之分"的内容 */
export function hierarchyPage(slide: Slide, slots: TaperPageSlots) {
  taperPage(slide, slots, 'pyramid');
}

/** 漏斗页 —— 曝光→点击→成交, 候选→入围→中标这类"逐级流失"的内容 */
export function funnelPage(slide: Slide, slots: TaperPageSlots) {
  taperPage(slide, slots, 'funnel');
}


/* ============================================================
 * orbitPage —— 若干要素围绕一个核心
 * ============================================================ */

export interface OrbitPageSlots {
  kicker?: string;
  title?: string;
  /** 围绕核心的要素, 3~6 个 */
  items: Array<FlowStep & { icon?: IconName }>;
  /** 中心那个"核心"的图标 (可选) —— 它代表被围绕的那个东西 */
  centerIcon?: IconName;
  note?: string;
}

/**
 * 椭圆轨道 + 中心立体讲台。
 *
 * 【和 processFlow 的区别是语义不是画法】processFlow 画的是"有先后";
 * 这里画的是"**围绕**" —— 若干要素共同支撑/环绕一个核心, 它们之间**没有顺序**。
 * 拿它去画有先后的五步是误导 (观众会以为这五件事是并列的),
 * 反过来拿箭头链去画"五个支撑要素"同样是误导 (观众会去找那个不存在的顺序)。
 */
export function orbitPage(slide: Slide, slots: OrbitPageSlots) {
  const t = activeTheme();
  const main = headBand(slide, slots.kicker, slots.title);
  const b = main.bounds;
  const noteH = slots.note ? 44 : 0;
  const h = b.height - noteH;

  /* 讲台和中心图标先画 —— 轨道和球要压在它前面 */
  const trackW = Math.round(Math.min(b.width * 0.82, h * 2.4));
  const trackX = b.x + Math.round((b.width - trackW) / 2);

  /* 【第二次返工】球太大是主因: 86px 的深色球 + 105px 光晕在这个构图里过重,
   * 四个球几乎连成一条深色横带, 中间的讲台被 02/03 夹住, "围绕"读不出来。
   * 参照图的球只有 ~64px 且更浅 —— 环绕感来自"轻的点绕着重的核心",
   * 球一重, 主次就反了。球收到 72, 讲台同时收窄并上移, 给弧线让出位置。 */
  const pw = Math.round(Math.min(210, trackW * 0.24));
  render(slide, podium3D({ width: pw, height: Math.round(pw * 0.28) }), {
    bounds: { x: b.x + Math.round((b.width - pw) / 2), y: b.y + Math.round(h * 0.26), width: pw, height: Math.round(pw * 0.60) },
    assertNoOverlap: false, fit: false,
  });
  if (slots.centerIcon) {
    const d = Math.round(pw * 0.24);
    render(slide, iconGlyph(slots.centerIcon, { size: d, color: t.accent }), {
      bounds: { x: b.x + Math.round((b.width - d) / 2), y: b.y + Math.round(h * 0.13), width: d, height: d },
      assertNoOverlap: false, fit: false,
    });
  }

  render(slide,
    nodeChain({
      steps: slots.items, width: trackW, height: h,
      track: 'ellipse', connector: 'none', nodeStyle: 'sphere', nodeSize: 72,
      labelPlacement: 'below', showTrack: true,
    }),
    { bounds: { x: trackX, y: b.y, width: trackW, height: h }, assertNoOverlap: false, fit: false },
  );

  if (slots.note) {
    render(slide, Text(slots.note, {
      fontSize: 14, color: main.muted, textAlign: 'ctr', width: Math.round(b.width * 0.8),
      fontLatin: t.fonts.textLatin, fontEast: t.fonts.textEast,
    }), {
      bounds: { x: b.x + Math.round(b.width * 0.1), y: b.y + h + 4, width: Math.round(b.width * 0.8), height: noteH },
      assertNoOverlap: false,
    });
  }
}
