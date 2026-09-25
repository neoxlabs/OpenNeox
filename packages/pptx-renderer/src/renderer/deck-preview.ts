/**
 * deck-preview — 整个 deck → 一张"正在被建出来"的 HTML 预览页
 *
 * ════════════════════════════════════════════════════════════════════════
 * 明康 : "在生成的过程中, 我希望能在右侧实现。因为我们有 surface 能力,
 * 所以锦上添花的是: 他边思考边生成, 右边的 surface 就能边看到这个 PPT 是如何
 * 一步步做出来的。"
 *
 * 关键是这**不是**一个"最终结果预览"。它要能表达三种状态并且随时可重渲:
 *     planned —— 大纲已定, 这一页还没开始画 (占位骨架 + 页标题)
 *     building —— 正在画 (骨架 + 呼吸动效)
 *     done —— 画完了 (真实内容)
 * 所以每次有进展就整页重渲一次, 推给 streaming surface (source.type='inline')。
 * 整页重渲而不是增量 patch —— deck 页数是几十量级, 重渲一次几毫秒, 换来的是
 * "任何时刻的输出都等于当前真实状态", 不会出现补丁丢失导致的鬼影。
 *
 * 输出必须 self-contained: surface 里是 srcdoc/inline, 没有外链的机会。
 * ════════════════════════════════════════════════════════════════════════
 */

import type { Presentation, Slide } from '../model/types.js';
import { renderSlideBodyHtml } from './slide-html.js';

export type SlideBuildState = 'planned' | 'building' | 'done' | 'failed';

export interface DeckPreviewSlide {
  /** 大纲里的页标题 —— planned 状态下唯一能显示的信息 */
  title: string;
  state: SlideBuildState;
  /** done 时的真实 slide 模型; 其它状态可为空 */
  slide?: Slide;
  /** 这一页用了哪个组件 (给用户看进度用) */
  component?: string;
  /** failed 时的原因 */
  error?: string;
}

export interface DeckPreviewOptions {
  /** deck 标题 */
  title?: string;
  /** 当前用的风格名 (给用户看) */
  styleName?: string;
  /** 缩略图宽度 px, 默认 420 */
  thumbWidth?: number;
  /** 强制深/浅色; 不传 = 跟宿主主题 (data-neox-host-theme, 没有则 prefers-color-scheme) */
  dark?: boolean;
}

/**
 * 渲染整个 deck 的构建态预览。
 * presentation 提供画布尺寸; slides 是"计划 + 状态", 长度可以大于
 * presentation.slides (还没画的页在 presentation 里不存在)。
 */
export function renderDeckPreviewHtml(
  presentation: Presentation,
  slides: DeckPreviewSlide[],
  opts?: DeckPreviewOptions,
): string {
  const thumbW = opts?.thumbWidth ?? 420;
  /* 接受 builder Presentation 或底层 model；缺少有效尺寸时退回标准 16:9。 */
  const pres = (presentation as unknown as { model?: Presentation }).model ?? presentation;
  presentation = pres;
  const ratio = presentation.slideWidth > 0
    ? presentation.slideHeight / presentation.slideWidth
    : 720 / 1280;
  const thumbH = Math.round(thumbW * ratio);
  /* 先按固定演示画布排版，再整体缩放到缩略图尺寸，
   * 使换行和导出使用相同的字号与布局基准。 */
  const stageW = 1280;
  const scale = stageW / presentation.slideWidth;
  const stageH = Math.round(stageW * ratio);
  const shrink = thumbW / stageW;

  const done = slides.filter((s) => s.state === 'done').length;
  const failed = slides.filter((s) => s.state === 'failed').length;
  const total = slides.length || 1;
  const pct = Math.round((done / total) * 100);

  const cards = slides
    .map((ds, i) => card(ds, i, presentation, scale, { stageW, stageH, shrink }))
    .join('\n');

  /* 默认同时支持宿主 data-neox-host-theme 与 prefers-color-scheme；
   * 显式 dark 选项时只使用指定色板，宿主属性优先于媒体查询。 */
  const LIGHT = { bg: '#f6f7f9', panel: '#ffffff', line: '#e5e7eb', ink: '#111827', sub: '#6b7280', accent: '#2563eb', sk: '#f1f2f4', skBar: '#e3e5e9' };
  const DARK = { bg: '#111214', panel: '#17181b', line: '#26282d', ink: '#e6e7ea', sub: '#8b8f98', accent: '#5b8cff', sk: '#1c1e22', skBar: '#2a2d33' };
  const vars = (p: typeof LIGHT) =>
    `--bg:${p.bg};--panel:${p.panel};--line:${p.line};--ink:${p.ink};--sub:${p.sub};--accent:${p.accent};--sk:${p.sk};--sk-bar:${p.skBar};`;
  const palette = opts?.dark === true
    ? `:root{${vars(DARK)}}`
    : opts?.dark === false
      ? `:root{${vars(LIGHT)}}`
      : `:root{${vars(LIGHT)}}
  @media (prefers-color-scheme: dark) { :root:not([data-neox-host-theme="light"]){${vars(DARK)}} }
  :root[data-neox-host-theme="dark"]{${vars(DARK)}}`;
  const c = { bg: 'var(--bg)', panel: 'var(--panel)', line: 'var(--line)', ink: 'var(--ink)', sub: 'var(--sub)', accent: 'var(--accent)' };

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  ${palette}
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background:${c.bg}; color:${c.ink}; padding:20px 22px 40px;
    font: 13px/1.55 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  }
  .hd { display:flex; align-items:baseline; gap:10px; margin-bottom:4px; }
  .hd h1 { font-size:17px; font-weight:600; letter-spacing:-0.01em; }
  .hd .style { color:${c.sub}; font-size:12px; }
  .meta { color:${c.sub}; font-size:12px; margin-bottom:14px; font-variant-numeric:tabular-nums; }
  .bar { height:3px; background:${c.line}; border-radius:2px; overflow:hidden; margin-bottom:22px; }
  .bar > i { display:block; height:100%; width:${pct}%; background:${c.accent}; transition:width .35s ease; }
  /* 固定列宽而不是 1fr 拉伸: 卡片一被拉宽, 里面按 ${thumbW} 排的画布就填不满,
   * 右侧留一道白边 —— 深色封面上这道白边尤其显眼 (实拍抓到过)。 */
  .grid { display:grid; grid-template-columns:repeat(auto-fill, ${thumbW}px); gap:20px; justify-content:start; }
  .card { border:1px solid ${c.line}; border-radius:10px; overflow:hidden; background:${c.panel}; }
  .card.is-building { border-color:${c.accent}; box-shadow:0 0 0 1px color-mix(in srgb, ${c.accent} 20%, transparent); }
  .card.is-failed { border-color:#c2453f; }
  .stage { position:relative; width:100%; height:${thumbH}px; overflow:hidden; background:#fff; }
  .stage.skeleton { background:var(--sk); }
  .cap { display:flex; align-items:center; gap:8px; padding:8px 11px; border-top:1px solid ${c.line}; }
  .cap .n { color:${c.sub}; font-variant-numeric:tabular-nums; font-size:11px; min-width:20px; }
  .cap .t { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cap .c { color:${c.sub}; font-size:11px; }
  .dot { width:7px; height:7px; border-radius:50%; flex:0 0 auto; }
  .dot.planned { background:${c.line}; }
  .dot.building { background:${c.accent}; animation:pulse 1.1s ease-in-out infinite; }
  .dot.done { background:#3fa45b; }
  .dot.failed { background:#c2453f; }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(.8)} }
  @media (prefers-reduced-motion: reduce) { .dot.building { animation:none } .sk i { animation:none } }
  /* 骨架屏: 用几条灰块示意版式, 让用户知道"这页规划成什么样了" */
  .sk { position:absolute; inset:0; padding:9%; display:flex; flex-direction:column; gap:5%; }
  .sk i { display:block; background:var(--sk-bar); border-radius:4px;
          animation:shimmer 1.6s ease-in-out infinite; }
  @keyframes shimmer { 0%,100%{opacity:.55} 50%{opacity:.95} }
  .err { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
         color:#c2453f; font-size:12px; padding:16px; text-align:center; }
</style></head>
<body>
  <div class="hd">
    <h1>${esc(opts?.title ?? '演示文稿')}</h1>
    ${opts?.styleName ? `<span class="style">${esc(opts.styleName)}</span>` : ''}
  </div>
  <div class="meta">${done} / ${total} 页已生成${failed ? ` · ${failed} 页失败` : ''}</div>
  <div class="bar"><i></i></div>
  <div class="grid">${cards}</div>
  <script>
  /* 自动跟到**正在渲染的那一页**。
   *
   * 【2026-08-10 用户实拍】"每次新一页渲染之后, 是全局跟着渲染, 并不是这一页跟着渲染"
   * 【2026-08-25 用户又报一次】"渲染的时候不是自动滚动, 每次都不是当前正在渲染的位置"
   *
   * 第一版有两个 bug, 都会让它"滚了, 但滚错地方":
   *   1. 判据只看**下标**不看状态: 一页从 building(骨架) 变成 done(真实内容) 时
   *      下标没变, prev === latest 直接 return。于是滚动只在骨架阶段发生过一次,
   *      等真实内容把卡片高度撑开, 之前算的位置早就偏了。签名必须带上状态。
   *   2. 在**解析期**就 scrollIntoView: 缩放画布 (transform scale) 和 web 字体都还没
   *      排完, 量到的位置不是终态。必须等布局稳定 —— 双 rAF, 有 document.fonts 再等它。
   *
   * surface 对 file 源是每 400ms 整页重载, 所以这段每次都会重跑; 靠签名去重,
   * 签名没变就不动, 免得把用户正在看的位置一遍遍抢走。
   */
  (function () {
    var cards = document.querySelectorAll('.card');
    var latest = -1, latestState = '';
    for (var i = 0; i < cards.length; i++) {
      var cn = cards[i].className;
      if (cn.indexOf('is-done') >= 0 || cn.indexOf('is-building') >= 0 || cn.indexOf('is-failed') >= 0) {
        latest = i;
        latestState = cn.indexOf('is-done') >= 0 ? 'done'
          : (cn.indexOf('is-failed') >= 0 ? 'failed' : 'building');
      }
    }
    if (latest < 0) return;

    /* 签名带上 deck 标识 —— 同一会话里做第二份 deck 时, 不能继承上一份的进度,
     * 否则新 deck 的第 1 页会被当成"看过了"而不滚。 */
    var deckId = (document.querySelector('.hd h1') || {}).textContent || 'deck';
    var key = 'neox-deck-follow';
    var sig = deckId + '#' + latest + ':' + latestState + '/' + cards.length;
    var prev = null;
    try { prev = sessionStorage.getItem(key); } catch (e) {}
    if (prev === sig) return;
    try { sessionStorage.setItem(key, sig); } catch (e) {}

    /* 等布局真的稳下来再滚 —— 双 rAF 跨过样式计算与首次绘制;
     * 字体没就绪时行高会变, 卡片高度跟着变, 所以有 fonts API 就再等它一次。 */
    var go = function () {
      var el = document.querySelectorAll('.card')[latest];
      if (el) el.scrollIntoView({ block: 'center' });
    };
    var afterLayout = function () { requestAnimationFrame(function () { requestAnimationFrame(go); }); };
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(afterLayout, afterLayout);
    } else {
      afterLayout();
    }
  })();
  </script>
</body></html>`;
}

function card(
  ds: DeckPreviewSlide,
  index: number,
  pres: Presentation,
  scale: number,
  stageBox: { stageW: number; stageH: number; shrink: number },
): string {
  const n = String(index + 1).padStart(2, '0');
  let stage: string;

  if (ds.state === 'done' && ds.slide) {
    /* 真实内容: 按整版尺寸排版, 再整体缩放 —— 换行点和导出一致 */
    const inner = renderSlideBodyHtml(pres, ds.slide, scale);
    stage = `<div class="stage"><div style="position:absolute;left:0;top:0;`
      + `width:${stageBox.stageW}px;height:${stageBox.stageH}px;overflow:hidden;`
      + `transform:scale(${stageBox.shrink.toFixed(5)});transform-origin:top left;">${inner}</div></div>`;
  } else if (ds.state === 'failed') {
    stage = `<div class="stage skeleton"><div class="err">这一页没生成出来<br/>${esc(ds.error ?? '')}</div></div>`;
  } else {
    stage = `<div class="stage skeleton"><div class="sk">
      <i style="height:14%;width:52%"></i>
      <i style="height:8%;width:34%"></i>
      <i style="height:34%;width:100%"></i>
      <i style="height:8%;width:78%"></i>
      <i style="height:8%;width:62%"></i>
    </div></div>`;
  }

  return `<div class="card is-${ds.state}">
    ${stage}
    <div class="cap">
      <span class="dot ${ds.state}"></span>
      <span class="n">${n}</span>
      <span class="t">${esc(ds.title || '（待定）')}</span>
      ${ds.component ? `<span class="c">${esc(ds.component)}</span>` : ''}
    </div>
  </div>`;
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
