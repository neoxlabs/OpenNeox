
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { exportPptx } from '@neoxlabs/pptx-renderer';
import type { Slide } from '@neoxlabs/pptx-renderer';
import * as T from '@neoxlabs/pptx-compose';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import {
  beginDeck, getDeck, endDeck, markBuilding, completeSlide, failSlide,
  deckSurfacePayload, deckPreviewHtml, deckProgress,
} from './deckSession.js';
import { inspectPptxBytes, isMustFix } from './pptxInspect.js';

/* ============================================================
 * 模板表 —— agent 看到的"页型"清单
 * ============================================================
 * 全部走 compose 声明式引擎: 真实字体测量 + 自动换行 + 元素自动下推,
 * 所以这里不存在手算坐标导致的重叠。 */
type TemplateFn = (slide: Slide, slots: any) => unknown;

interface TemplateDef {
  fn: TemplateFn;
  /** 给模型看的槽位说明 */
  slots: string;
  /**
   * 必填槽位。检查它不是防御性编程 ——
   * 少一个槽位, 模板会在 `slots.rows[0]` 这种地方炸出
   * "Cannot read properties of undefined (reading '0')",
   * 模型拿到这句话完全不知道该补什么, 于是原样重试, 一直失败。
   * 前置校验把它变成"data-table 缺 rows", 模型一次就能改对。
   */
  required: string[];
  /**
   * 一些模板的必填是"二选一"(chart-focus: 单系列 data 或多系列 categories+series),
   * 简单的 required 列表表达不了。给这类模板一个自定义校验, 返回缺什么。
   * 不做成通用 DSL —— 目前只有一个模板需要, 加个钩子比发明一套规则语言划算。
   */
  requireOneOf?: (slots: Record<string, unknown>) => string[];
}

export const TEMPLATES: Record<string, TemplateDef> = {
  'cover-hero': { fn: T.coverHero, required: ['title'], slots: 'title(必填), tag?, subtitle?, footerText?, backgroundImage?(满出血封面图)' },
  'section-divider': { fn: T.sectionDivider, required: ['sectionNumber', 'title'], slots: 'sectionNumber, title, subtitle?' },
  'agenda': { fn: T.agenda, required: ['items'], slots: 'items[{title, desc?}] (2-6 项, 按顺序), title?(默认"目录"), kicker?' },
  'title-body': { fn: T.titleBody, required: ['title', 'body'], slots: 'title, body(string|string[]), kicker?, footerText?' },
  'bullet-list': { fn: T.bulletList, required: ['items'], slots: 'items(string[]), title?, kicker?, footerText?' },
  'two-column': { fn: T.twoColumn, required: ['leftTitle', 'leftBody', 'rightTitle', 'rightBody'], slots: 'leftTitle, leftBody, rightTitle, rightBody, title?, kicker?, footerText?' },
  'three-column': { fn: T.threeColumn, required: ['columns'], slots: 'columns[{title, body}], title?, kicker?' },
  'contrast': { fn: T.contrast, required: ['left', 'right'], slots: 'left{label,headline,body?}, right{label,headline,body?}' },
  'timeline': { fn: T.timeline, required: ['steps'], slots: 'steps[{label, detail?}], title?, kicker?' },
  /* spark / progress 给数字一个**参照系** —— 光一个 "68%" 回答不了"这是好是坏、
   * 在往哪走"。两个都给时只画 spark (一张卡两套参照系, 观众不知道该看哪个)。
   * progress.lowerIsBetter 在"越小越好"的指标上必须传, 否则"214米/目标200"
   * 会被画成达标色 —— 方向无法从数值推断。 */
  'kpi-cards': {
    fn: T.kpiCards, required: ['cards'],
    slots: 'cards[{value, label, subLabel?, spark?(数值数组·缺数据给 null 不给 0), '
         + 'progress?{value, target, max?, lowerIsBetter?}, ring?(0~1·比例型指标), '
         + 'rating?{value, max?}(有上限刻度的指标)}], title?, kicker?; '
         + '四种形状一张卡**只画一个**, 优先级 spark > progress > ring > rating',
  },
  'numbers-hero': { fn: T.numbersHero, required: ['numbers'], slots: 'numbers[{value, label}], headline?, kicker?' },
  'data-focus': { fn: T.dataFocus, required: ['number', 'story'], slots: 'number, story(string|string[]), label?, unit?, kicker?' },
  'data-table': { fn: T.dataTable, required: ['headers', 'rows'], slots: 'headers[], rows[][], title?, kicker?, columnAlign?, columnWidths?(相对权重, 如 [2,1,1,1])' },
  /* chartType 选型不是风格偏好, 是**语义**: line=同一个量随时间怎么走 (逐月/逐季),
   * column=离散类目之间比高低, bar=类目名长或条目多 (排名榜)。选错等于图形和内容
   * 说的不是一件事。默认 column 只是兜底, 趋势数据必须显式给 line。 */
  'chart-focus': {
    fn: T.chartFocus,
    required: ['data'],
    /* 单系列给 data; 多系列给 categories + series。两者给一套即可 —— 原来硬性
     * required:['data'] 会把多系列调用直接挡回去 (做完了但调不到, 又一次)。 */
    requireOneOf: (s) => {
      const hasData = Array.isArray(s.data) && (s.data as unknown[]).length > 0;
      const hasSeries = Array.isArray(s.series) && (s.series as unknown[]).length > 0
        && Array.isArray(s.categories) && (s.categories as unknown[]).length > 0;
      return hasData || hasSeries ? [] : ['data (单系列) 或 categories+series (多系列)'];
    },
    slots: 'chartType?(line=时间趋势|column=类目比较|bar=横向排名|stacked=构成占比), title?, kicker?, unit?, '
         + 'note?(一句结论), variant?(standard|editorial: 杂志式·无刻度·柱顶直标数值·两色交替; 只对单系列非负柱状图生效, 稳健金融风格默认); '
         + '单系列: data[{label, value, note?(柱顶小注, editorial 用)}]; 多系列: categories[] + series[{name, values[]}] (values 按 categories 顺序). '
         + '负值直接给负数; **缺数据给 null 不要给 0** —— 0 会画成"这期是零", null 才是"这期没数据"(折线断开/柱子留空)',
  },
  /* icon 是**语义**槽位: 只在图标和这一项有真实对应时传 (病虫预警→warning · 机收减损→truck)。
   * 想不出配哪个就别传, 会退回统一记号 —— 硬凑一个图标等于告诉观众一个不存在的意思。 */
  'feature-grid': {
    fn: T.featureGrid, required: ['items'],
    slots: `items[{title, desc, icon?, iconColor?}], title?, kicker?; icon 从这份清单里选: ${T.ICON_NAMES.join(' ')}`,
  },
  'quote-page': { fn: T.quotePage, required: ['quote'], slots: 'quote, attribution?, kicker?' },
  'manifesto': { fn: T.manifesto, required: ['text'], slots: 'text, attribution?, kicker?' },
  'editorial-split': { fn: T.editorialSplit, required: ['title', 'body'], slots: 'title, body, kicker?, image?, imageSide?(left|right)' },
  'image-gallery': { fn: T.imageGallery, required: ['images'], slots: 'images[], captions?, title?, kicker?' },
  'photo-spread': { fn: T.photoSpread, required: ['images'], slots: 'images[] (3-4 张, 第 1 张是大图), title?, kicker?' },
  'hero-image-quote': { fn: T.heroImageQuote, required: ['quote'], slots: 'quote, image?, attribution?, kicker?' },

  'process-flow': {
    fn: T.processFlow, required: ['steps'],
    slots: `steps[{label, desc?, icon?}] (3-5 步, **有先后**), title?, kicker?, note?; `
         + `variant?: separated(默认·分离箭头+回声轮廓+斜引线+图标徽章) | interlocked(咬合成一条链) `
         + `| ribbon(折叠纸带) | stair(层层垒高+顶端大箭头·**最后一项是目标**) | chain(圆节点+弧箭头); `
         + `icon 从这份清单里选: ${T.ICON_NAMES.join(' ')}`,
  },
  'versus-page': {
    fn: T.versusPage, required: ['left', 'right'],
    slots: 'left{title, items[]}, right{title, items[]}, badge?(默认 VS), '
         + 'share?{left, right}(两侧占比·只在确实构成一个整体的切分时给), title?, kicker?, note?',
  },
  'hierarchy-page': {
    fn: T.hierarchyPage, required: ['levels'],
    slots: 'levels[{label, desc?}] (2-4 层, **从高到低**), title?, kicker?, note?',
  },
  'funnel-page': {
    fn: T.funnelPage, required: ['levels'],
    slots: 'levels[{label, desc?}] (3-4 级, **从多到少**逐级收窄), title?, kicker?, note?',
  },
  /* orbit 和 process-flow 的区别是**语义**不是画法: 前者画"围绕"(要素之间没有顺序),
   * 后者画"有先后"。互相拿错会让观众去找一个不存在的关系。 */
  'orbit-page': {
    fn: T.orbitPage, required: ['items'],
    slots: `items[{label, desc?, icon?}] (3-6 个, **共同围绕一个核心且彼此无顺序**), `
         + `centerIcon?(中心那个核心的图标), title?, kicker?, note?; icon 清单同上`,
  },
};

const TEMPLATE_IDS = Object.keys(TEMPLATES);

/** 返回缺失的必填槽位名 (空数组 = 齐了) */
function missingSlots(tpl: TemplateDef, slots: Record<string, unknown>): string[] {
  if (tpl.requireOneOf) return tpl.requireOneOf(slots);
  return tpl.required.filter((k) => {
    const v = slots[k];
    if (v == null) return true;
    if (typeof v === 'string' && !v.trim()) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });
}

const STYLE_LINE = Object.values(T.STYLE_SPECS)
  .map((s) => `${s.id} (${s.displayName} · ${s.suitedFor})`)
  .join('; ');

/* ============================================================
 * 公共小工具
 * ============================================================ */

function requireSession(context?: { sessionId?: string }): string | null {
  return context?.sessionId ?? null;
}

function err(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ error: message, ...extra });
}

/** 把预览 HTML 落盘 —— surface 盯着这个文件, 写完它自己就刷了 */
async function flushPreview(sessionId: string): Promise<void> {
  const st = getDeck(sessionId);
  const html = deckPreviewHtml(sessionId);
  if (!st || !html) return;
  await fs.mkdir(path.dirname(st.previewPath), { recursive: true });
  await fs.writeFile(st.previewPath, html, 'utf8');
}

function slugify(s: string): string {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '')   /* 文件名非法字符 */
    .trim()
    .slice(0, 40) || 'deck';
}

/* ============================================================
 * deck_begin
 * ============================================================ */

interface DeckBeginArgs {
  title: string;
  outline: Array<{ title: string; template: string }>;
  brief?: string;
  styleId?: string;
  outputPath?: string;
  slideSize?: { width: number; height: number };
}

export const deckBeginTool: Tool = {
  name: 'deck_begin',
  description: `Start a multi-slide deck. Call this FIRST, then deck_add_slide once per page, then deck_export.

Use this instead of create_slides for ANY deck with more than ~5 slides, or with paragraph-length text —
per-page calls keep each tool argument small (long single-call JSON gets truncated and is unrecoverable).

What it does: picks/freezes a visual style, opens a live preview in the user's right-hand panel showing every
planned page as a skeleton, then refreshes that panel as each page lands. The user watches the deck get built.

Styles (omit styleId and one is chosen from \`brief\` — never blocks): ${STYLE_LINE}

Page templates for the outline: ${TEMPLATE_IDS.join(' / ')}

Plan the whole outline up front — the preview shows the user your plan before any page exists, and the outline
index is how deck_add_slide addresses pages.`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  aliases: ['deckBegin', 'begin_deck'],

  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Deck title, shown in the preview header and used for the output folder.' },
      outline: {
        type: 'array',
        description: 'Every page, in order. Each { title, template }. Plan the full deck here.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            template: { type: 'string', description: `One of: ${TEMPLATE_IDS.join(' / ')}` },
          },
          required: ['title', 'template'],
        },
      },
      brief: { type: 'string', description: "The user's request in their own words — used to auto-pick a style when styleId is omitted." },
      styleId: { type: 'string', description: `Optional explicit style. One of: ${Object.keys(T.STYLE_SPECS).join(' / ')}` },
      outputPath: { type: 'string', description: 'Optional .pptx path (absolute or workspace-relative). Default: <date>-<title>/<title>.pptx' },
      slideSize: { type: 'object', description: 'CSS px. Default {width:1280, height:720} (16:9).' },
    },
    required: ['title', 'outline'],
  },

  async function(args: DeckBeginArgs, context): Promise<string> {
    if (args.slideSize
      && (args.slideSize.width !== 1280 || args.slideSize.height !== 720)) {
      return err(
        `slideSize 目前只支持 1280×720 (16:9), 收到 ${args.slideSize.width}×${args.slideSize.height}。`
        + ' 20 个页面模板都是按这个画布排的 —— 换尺寸会让内容错位, 不会自动适配。'
        + ' 去掉 slideSize 参数即可。',
      );
    }
    const sessionId = requireSession(context);
    if (!sessionId) {
      return err('deck_begin 需要 sessionId (runner 应通过 context 注入). 这是 runtime 问题, 不是参数问题.');
    }
    if (!args?.title?.trim()) return err('title 必填');
    if (!Array.isArray(args?.outline) || args.outline.length === 0) {
      return err('outline 必填且非空 —— 先把整份 deck 的页型规划出来, 用户在预览里看到的就是这份规划');
    }

    const bad = args.outline.filter((o) => !TEMPLATES[o?.template]);
    if (bad.length) {
      return err(
        `未知模板: ${[...new Set(bad.map((b) => String(b?.template)))].join(', ')}`,
        { validTemplates: TEMPLATE_IDS },
      );
    }

    const workspace = getWorkspaceRootFromContext();
    if (!workspace) {
      return err('workspaceContext 未绑定 (runner 每回合应通过 AsyncLocalStorage 注入). 报给用户让他们检查会话 workspace.');
    }

    const spec = args.styleId
      ? T.STYLE_SPECS[args.styleId]
      : T.pickStyleForBrief(args.brief ?? args.title);
    if (!spec) {
      return err(`未知 styleId: ${args.styleId}`, { validStyles: Object.keys(T.STYLE_SPECS) });
    }

    /* 输出目录: 跟 create_slides 同一条纪律 —— 永远不往 workspace 根扔文件 */
    const d = new Date();
    const datePrefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let outAbs: string;
    if (args.outputPath && path.isAbsolute(args.outputPath)) {
      outAbs = args.outputPath;
    } else if (args.outputPath) {
      outAbs = path.join(workspace, args.outputPath);
    } else {
      const slug = slugify(args.title);
      outAbs = path.join(workspace, `${datePrefix}-${slug}`, `${slug}.pptx`);
    }
    if (!outAbs.endsWith('.pptx')) outAbs += '.pptx';
    const previewPath = path.join(path.dirname(outAbs), 'preview.html');

    /* 同一会话重开一份 deck: 丢掉旧的, surfaceId 相同所以标签会原地换内容 */
    if (getDeck(sessionId)) endDeck(sessionId);

    beginDeck({
      sessionId,
      title: args.title,
      styleId: spec.id,
      styleName: spec.displayName,
      outline: args.outline.map((o) => ({ title: o.title, component: o.template })),
      slideSize: args.slideSize,
      previewPath,
      outputPath: outAbs,
    });
    await flushPreview(sessionId);

    const payload = deckSurfacePayload(sessionId, { first: true, filePath: previewPath });
    if (!payload) return err('deck 状态创建失败 (内部错误)');
    return JSON.stringify(payload);
  },
};

/* ============================================================
 * deck_add_slide
 * ============================================================ */

interface DeckAddSlideArgs {
  index: number;
  slots: Record<string, unknown>;
  template?: string;
  decor?: { intensity?: string; corner?: string };
}

const DECOR_INTENSITY = new Set(['subtle', 'normal', 'bold']);
const DECOR_CORNER = new Set(['tr', 'br', 'bl', 'tl']);
const NO_DECOR = new Set(['data-table', 'chart-focus', 'cover-hero', 'section-divider']);

export const deckAddSlideTool: Tool = {
  name: 'deck_add_slide',
  description: `Build ONE page of the deck started by deck_begin. Call once per page, in order.

\`index\` is the 0-based position in the outline you gave deck_begin. \`slots\` is the content for that page's
template. Templates and their slots:
${Object.entries(TEMPLATES).map(([id, t]) => `  ${id}: ${t.slots}`).join('\n')}

Colors, fonts, sizes and corner radii all come from the style frozen by deck_begin — there is deliberately no
way to set them per page. Keep each call to one page's content; that is what keeps the JSON small enough to
survive generation.

The right-hand preview refreshes on its own after each call. A page that fails is marked in the preview and
skipped in the export; the rest of the deck is unaffected, so keep going.

Calling again with an index that is already built REPLACES that page in place (the old page stays if the redo
fails) — that is how you fix pages deck_export's self-check flags. Pages may be built in any order; the export
follows the outline order.

\`decor\` (optional) draws a vector backdrop under the page in the deck's own colours: {intensity: 'subtle' |
'normal' | 'bold', corner: 'tr' | 'br' | 'bl' | 'tl'}. It is rhythm, not wallpaper: 'subtle' on a few body
pages, 'normal' on one or two breathing pages, none on the rest. Ignored on cover-hero / section-divider (they
already carry a full-page backdrop in the deck's style) and on data-table / chart-focus (the content fills the page).`,
  group: 'agent',
  resultType: 'ephemeral',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  aliases: ['deckAddSlide', 'add_slide'],

  parameters: {
    type: 'object',
    properties: {
      index: { type: 'number', description: '0-based index into the outline passed to deck_begin.' },
      slots: { type: 'object', description: "Content for this page's template (see the per-template slot list in the description)." },
      template: { type: 'string', description: 'Optional override of the outline template for this page.' },
      decor: {
        type: 'object',
        description: "Optional vector backdrop under the page: {intensity: 'subtle'|'normal'|'bold', corner: 'tr'|'br'|'bl'|'tl'}.",
        properties: {
          intensity: { type: 'string', enum: ['subtle', 'normal', 'bold'] },
          corner: { type: 'string', enum: ['tr', 'br', 'bl', 'tl'] },
        },
      },
    },
    required: ['index', 'slots'],
  },

  async function(args: DeckAddSlideArgs, context): Promise<string> {
    const sessionId = requireSession(context);
    if (!sessionId) return err('deck_add_slide 需要 sessionId (runtime 问题).');

    const st = getDeck(sessionId);
    if (!st) return err('还没有进行中的 deck —— 先调 deck_begin 规划大纲.');

    const i = Number(args?.index);
    if (!Number.isInteger(i) || i < 0 || i >= st.slides.length) {
      return err(`index 越界: ${args?.index} (大纲共 ${st.slides.length} 页, 有效 0..${st.slides.length - 1})`);
    }
    const templateId = args.template ?? st.slides[i]!.component ?? '';
    const tpl = TEMPLATES[templateId];
    if (!tpl) return err(`未知模板: ${templateId}`, { validTemplates: TEMPLATE_IDS });
    if (!args?.slots || typeof args.slots !== 'object') return err('slots 必填 (object)');

    /* 前置校验 —— 缺槽位在这里说清楚, 别等模板炸在 rows[0] 上 */
    const missing = missingSlots(tpl, args.slots as Record<string, unknown>);
    if (missing.length) {
      failSlide(sessionId, i, `缺少必填槽位: ${missing.join(', ')}`);
      await flushPreview(sessionId);
      return err(`${templateId} 缺少必填槽位: ${missing.join(', ')}`, {
        index: i, expectedSlots: tpl.slots, progress: deckProgress(sessionId),
      });
    }

    const spec = T.STYLE_SPECS[st.styleId] ?? T.DEFAULT_STYLE_SPEC;

    const decor = args.decor && typeof args.decor === 'object' ? args.decor : undefined;
    if (decor?.intensity && !DECOR_INTENSITY.has(decor.intensity)) {
      return err(`decor.intensity 只能是 subtle / normal / bold, 收到 ${decor.intensity}`);
    }
    if (decor?.corner && !DECOR_CORNER.has(decor.corner)) {
      return err(`decor.corner 只能是 tr / br / bl / tl, 收到 ${decor.corner}`);
    }
    const decorSkipped = !!decor && NO_DECOR.has(templateId);

    const prev = st.slides[i]!;
    const replacing = prev.state === 'done' ? prev.slide : undefined;

    markBuilding(sessionId, i);
    const slide = st.pres.slides.add();

    try {
      await T.withActiveStyle(spec, () => {
        (slide as any).templateId = templateId;
        if (decor && !decorSkipped) {
          /* 必须在模板之前画: z 序就是调用序, 画在后面会盖住文字。
           * seed 用页序: 逐页形状不同, 同一份 deck 每次导出完全一致。 */
          T.pageDecor(slide, {
            intensity: decor.intensity as 'subtle' | 'normal' | 'bold' | undefined,
            corner: decor.corner as 'tr' | 'br' | 'bl' | 'tl' | undefined,
            seed: i + 1,
          });
        }
        tpl.fn(slide, args.slots);
        const NO_CHROME = new Set(['cover-hero', 'section-divider']);
        const tplId = templateId;
        if (!NO_CHROME.has(tplId)) {
          /* onDark 只描述**左下角**(页脚所在处)的底色。看完 20 页底部条得出的规律:
           * 带深色面板的页型深的都在左边, 所以右下角的页码永远在浅底。 */
          const DARK_LEFT = new Set([
            'bullet-list', 'data-focus', 'editorial-split',
            'photo-spread', 'contrast', 'hero-image-quote',
          ]);
          const dark = DARK_LEFT.has(tplId);
          T.slideChrome(slide, {
            footerText: (args.slots as Record<string, unknown>)?.footerText as string | undefined,
            pageNumber: ((args.slots as Record<string, unknown>)?.pageNumber as number | undefined) ?? i + 1,
            onDark: dark,
          });
        }
      });
    } catch (e) {
      /* 半成品 slide 必须撤掉, 否则导出里夹一张刷了底色没有字的空页 */
      st.pres.slides.removeLast();
      const msg = e instanceof Error ? e.message : String(e);
      if (replacing) {
        /* 重做没成: 旧页原样留着, 不能因为一次失败的修改把本来好好的一页弄丢 */
        st.slides[i] = prev;
        await flushPreview(sessionId);
        return JSON.stringify({
          ok: false, index: i, template: templateId, error: msg,
          progress: deckProgress(sessionId),
          hint: '重做没成功, 原来那一页保留着没动. 可以换个模板或精简内容再试同一个 index.',
        });
      }
      failSlide(sessionId, i, msg);
      await flushPreview(sessionId);
      return JSON.stringify({
        ok: false, index: i, template: templateId, error: msg,
        progress: deckProgress(sessionId),
        hint: '这一页没成, 已在预览里标红. 可以换个模板或精简内容重试同一个 index; 也可以跳过继续下一页.',
      });
    }

    if (replacing) {
      const models = st.pres.model.slides;
      const at = models.indexOf(replacing);
      if (at >= 0) models.splice(at, 1);
      st.pres.slides.rehydrate();
    }
    completeSlide(sessionId, i, st.pres.model.slides.indexOf(slide._model));

    await flushPreview(sessionId);
    return JSON.stringify({
      ok: true, index: i, template: templateId,
      ...(replacing ? { replaced: true } : {}),
      ...(decorSkipped
        ? {
          note: templateId === 'cover-hero' || templateId === 'section-divider'
            ? 'decor 没画: 封面/章节页自带整页背景构成, 装饰层会被它盖住 —— 这两页不用传 decor'
            : 'decor 没画: data-table / chart-focus 的版心被内容占满, 装饰只会横穿表格或图表',
        }
        : {}),
      progress: deckProgress(sessionId),
    });
  },
};

/* ============================================================
 * deck_export
 * ============================================================ */

export const deckExportTool: Tool = {
  name: 'deck_export',
  description: `Write the deck built by deck_begin/deck_add_slide to a .pptx and end the deck session.

Returns the absolute path. Follow up with open_surface({kind:'pptx', source:{type:'file', path}}) so the user
can page through the real file.

Pages are written in outline order. Pages that failed are simply absent from the export — the returned summary
lists them, so tell the user which ones didn't make it rather than letting them discover the gap.

The export runs the layout self-check (the same one open_surface enforces). If \`selfCheck.passed\` is false the
deck stays open and \`selfCheck.mustFix\` names the outline index of each page to fix: redo those pages with
deck_add_slide (same index — trim the text, never shrink fonts), then deck_export again.`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe',
  isReadOnly: false,
  aliases: ['deckExport', 'export_deck'],

  parameters: {
    type: 'object',
    properties: {
      outputPath: { type: 'string', description: 'Optional override of the path chosen by deck_begin.' },
      keepOpen: { type: 'boolean', description: 'Keep the deck session alive so you can still fix pages. Default false.' },
    },
  },

  async function(args: { outputPath?: string; keepOpen?: boolean }, context): Promise<string> {
    const sessionId = requireSession(context);
    if (!sessionId) return err('deck_export 需要 sessionId (runtime 问题).');

    const st = getDeck(sessionId);
    if (!st) return err('没有进行中的 deck —— 先 deck_begin.');
    if (st.pres.model.slides.length === 0) {
      return err('一页都没生成成功, 不导出空文件.', { progress: deckProgress(sessionId) });
    }

    const workspace = getWorkspaceRootFromContext();
    let outAbs = st.outputPath;
    if (args?.outputPath) {
      outAbs = path.isAbsolute(args.outputPath)
        ? args.outputPath
        : path.join(workspace ?? path.dirname(st.outputPath), args.outputPath);
      if (!outAbs.endsWith('.pptx')) outAbs += '.pptx';
    }

    const built = st.slides
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => s.state === 'done' && s.slide && st.pres.model.slides.includes(s.slide));
    const models = st.pres.model.slides;
    models.splice(0, models.length, ...built.map(({ s }) => s.slide!));
    models.forEach((m, k) => { m.index = k + 1; });
    st.pres.slides.rehydrate();
    /* 导出后第 n 页 (1 起) → 大纲 index */
    const outlineIndexOfPage = built.map(({ idx }) => idx);

    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    const file = await exportPptx(st.pres);
    const bytes = file.bytes();
    await fs.writeFile(outAbs, Buffer.from(bytes));

    /* 导出即自检 —— 进程内, 跟 open_surface 交付闸门同一把尺子。有必修问题就把 deck 留着,
     * 点名到大纲 index, agent 直接重做那几页, 不用等 open_surface 被拒了再回头找。 */
    let selfCheck: Record<string, unknown>;
    let needsFix = false;
    try {
      const report = await inspectPptxBytes(bytes, { pptxPath: outAbs });
      needsFix = report.mustFixCount > 0;
      if (needsFix) {
        selfCheck = {
          passed: false,
          mustFixCount: report.mustFixCount,
          mustFix: report.issues.filter(isMustFix).slice(0, 30).map((x) => {
            const index = x.slide != null ? outlineIndexOfPage[x.slide - 1] : undefined;
            return {
              index,
              title: index != null ? st.slides[index]?.title : undefined,
              kind: x.kind,
              message: x.message,
            };
          }),
        };
      } else {
        selfCheck = {
          passed: true,
          warnings: report.warnings,
          /* deck 级节奏提示 (连续文字页 / 没有章节页 / 全无图) —— 不拦, 但值得看一眼 */
          deckNotes: report.issues.filter((x) => x.kind.startsWith('deck-')).map((x) => x.message),
        };
      }
    } catch (e) {
      selfCheck = {
        available: false,
        reason: `自检读不了刚导出的文件: ${e instanceof Error ? e.message : String(e)}`,
        instruction: '交付时如实说明排版没有经过自动校验, 不许声称已验证。',
      };
    }

    const progress = deckProgress(sessionId);
    const failed = st.slides
      .map((s, i) => (s.state === 'failed' ? { index: i, title: s.title, error: s.error } : null))
      .filter(Boolean);
    /* planned 状态 = agent 漏调了 deck_add_slide, 跟"画砸了"是两回事, 分开报 */
    const skipped = st.slides
      .map((s, i) => (s.state === 'planned' || s.state === 'building' ? { index: i, title: s.title } : null))
      .filter(Boolean);

    /* 有必修问题时不关 deck —— 关了就没法原地重做那几页了 */
    if (!args?.keepOpen && !needsFix) endDeck(sessionId);

    return JSON.stringify({
      ok: true,
      path: outAbs,
      previewPath: st.previewPath,
      styleId: st.styleId,
      slideCount: st.pres.model.slides.length,
      progress,
      failed,
      skipped,
      selfCheck,
      ...(needsFix
        ? {
          deckStillOpen: true,
          next: '先把 selfCheck.mustFix 点名的页用 deck_add_slide (同一个 index) 重做 —— 删字, 不要缩字号 —— '
            + '再 deck_export。open_surface 用同一把尺子复检, 现在打开会被拒。',
        }
        : { next: `open_surface({kind:'pptx', source:{type:'file', path:'${outAbs}'}})` }),
    });
  },
};

export const DECK_TOOLS: Tool[] = [deckBeginTool, deckAddSlideTool, deckExportTool];
