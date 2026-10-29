/**
 * overlay-entry.ts — "computer use 被操控" 叠加层的渲染入口
 *
 * 跟 pet-entry.tsx 平行的独立入口 (vite rollupOptions.input.overlay → overlay.html).
 * 纯 TS + canvas。全屏穿透。Windows 退出靠桥钩子 (Esc / 点左上角退出钮);
 * mac 停在「退出」钮上时窗口收点击.
 *
 * 两态, 没有「可点收场」:
 *   1. 整屏蓝色操控遮罩 (Windows 用窗级 opacity, 不再叠 CSS 蓝).
 *   2. 自绘虚拟光标 — 矢量箭头, 缓动到目标点 + 轨迹. 系统光标在注入期间由桥藏掉.
 *   3. 动作涟漪; 左上角固定「退出」钮 (尺寸必须跟 input_lock.rs STOP_* 对齐).
 *
 * 事件契约 (跟主进程 computerOverlayHandlers 严格对齐):
 *   主→此: 'overlay:state'   { visible, app?, steps?, activeIndex? }
 *   主→此: 'overlay:pointer' { app, action, label, x, y, phase:'move'|'act'|'done', risk? }
 *   此→主: 'overlay:hello'   (就绪握手, 主进程收到后回一条当前 state)
 *
 * x/y 是【物理屏幕坐标】, 窗口全屏且无缩放, 可直接当 CSS px 用.
 *
 * 自测: 打开 overlay.html?demo=1 或控制台执行 window.__overlayDemo() —— 不依赖主进程,
 *       自动跑一段"移动→点击→写值→高风险点击"的假动作, 肉眼即可验收视觉效果.
 */

export {};

/* ────────────────────────────── 契约类型 ────────────────────────────── */

type PointerPhase = 'move' | 'act' | 'done';
type Risk = 'safe' | 'high';

interface OverlayPointerPayload {
  app: string;
  action: string;
  label: string;
  x: number;
  y: number;
  phase: PointerPhase;
  risk?: Risk;
}

interface OverlayStatePayload {
  visible: boolean;
  app?: string;
  steps?: string[];
  activeIndex?: number;
}

interface OverlayBridge {
  onState(cb: (state: OverlayStatePayload) => void): () => void;
  onPointer(cb: (evt: OverlayPointerPayload) => void): () => void;
  hello(): void;
  setIgnoreMouse(ignore: boolean): void;
  stop(): void;
}

declare global {
  interface Window {
    overlayBridge?: OverlayBridge;
    __overlayDemo?: () => void;
  }
}

/* ────────────────────────────── 常量 ────────────────────────────── */

const COLOR_CYAN = '#22d3ee';
const COLOR_CYAN_LIGHT = '#67e8f9';
const COLOR_CYAN_DARK = '#0891b2';
const COLOR_RISK = '#fb923c';
const COLOR_RISK_DARK = '#f87171';
/* Win 叠加层用实色窗 + DWM opacity 做蓝罩, CSS 半透明叠上去会再压一层. */
const NATIVE_DIM = /Windows/i.test(navigator.userAgent);

const DUR_CURSOR_MS = 320;   /* 光标缓动时长 (ease-out) */
const DUR_RIPPLE_MS = 520;   /* 涟漪扩散时长 */
const DUR_LABEL_MS = 1400;   /* 动作标签停留时长 */
const DUR_FADE_MS = 420;     /* 整层淡入淡出 */

const TRAIL_MAX = 14;        /* 轨迹保留点数 */
const TRAIL_TTL_MS = 420;    /* 轨迹点存活时长 */

/* ────────────────────────────── canvas 初始化 ────────────────────────────── */

const root = document.getElementById('overlay-root') ?? document.body;

const canvas = document.createElement('canvas');
canvas.id = 'overlay-canvas';
canvas.style.cssText =
  'position:fixed;inset:0;width:100vw;height:100vh;display:block;pointer-events:none;';
root.appendChild(canvas);

/* 取到就固定成非空常量：下面的绘制函数都是闭包，类型收窄不会跨函数保留，
 * 在这里一次性断言比每个调用点各写一次判空干净。 */
const ctx: CanvasRenderingContext2D = (() => {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('[overlay-entry] 2d context unavailable');
  return context;
})();

let vw = 0;
let vh = 0;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  vw = window.innerWidth;
  vh = window.innerHeight;
  canvas.width = Math.max(1, Math.round(vw * dpr));
  canvas.height = Math.max(1, Math.round(vh * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

resize();
window.addEventListener('resize', resize);

/* ────────────────────────────── 状态胶囊 (DOM) ────────────────────────────── */

const styleEl = document.createElement('style');
styleEl.textContent = [
  '#overlay-dim{position:fixed;inset:0;pointer-events:none;',
  'background:linear-gradient(180deg,rgba(59,130,246,0.20),rgba(30,64,175,0.14));',
  'opacity:0;transition:opacity .4s ease;}',
  '#overlay-dim.on{opacity:1;}',
  '#overlay-glow{position:fixed;inset:0;pointer-events:none;opacity:0;',
  'box-shadow:inset 0 0 0 4px rgba(147,197,253,0.55),inset 0 0 56px rgba(37,99,235,0.16);',
  'transition:opacity .4s ease;}',
  '#overlay-glow.on{opacity:1;}',
  /* 退出钮固定左上, 跟 input_lock.rs STOP_* 对齐: left 16, top 14, 88x32 @96dpi */
  '#overlay-stop{position:fixed;left:16px;top:14px;z-index:3;',
  'width:88px;height:32px;padding:0;border-radius:999px;border:1px solid rgba(251,146,60,.7);',
  'background:rgba(194,65,12,.92);color:#fff7ed;font:700 13px/32px "Segoe UI",system-ui,sans-serif;',
  'text-align:center;cursor:pointer;pointer-events:auto;',
  'opacity:0;transform:translateY(-6px);transition:opacity .26s ease,transform .26s ease;}',
  '#overlay-stop.on{opacity:1;transform:translateY(0);}',
  '#overlay-stop:hover{background:rgba(234,88,12,.95);}',
  '#overlay-capsule{',
  'position:fixed;left:112px;top:14px;display:flex;align-items:center;gap:10px;',
  'padding:8px 14px;border-radius:999px;',
  'background:rgba(2,6,23,0.88);',
  'border:1px solid rgba(34,211,238,0.45);',
  'box-shadow:0 0 18px rgba(34,211,238,0.18),inset 0 0 12px rgba(34,211,238,0.08);',
  'font:500 13px/1 "Segoe UI",system-ui,-apple-system,sans-serif;',
  'color:rgba(226,255,255,0.94);letter-spacing:.02em;white-space:nowrap;',
  'opacity:0;transform:translateY(-6px);transition:opacity .26s ease,transform .26s ease;',
  'pointer-events:none;}',
  '#overlay-capsule.on{opacity:1;transform:translateY(0);}',
  '#overlay-capsule .ov-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;',
  'background:' + COLOR_CYAN + ';box-shadow:0 0 10px ' + COLOR_CYAN + ';',
  'mix-blend-mode:screen;animation:ov-pulse 1.6s ease-in-out infinite;}',
  '@keyframes ov-pulse{0%,100%{opacity:.35;transform:scale(.82);}',
  '50%{opacity:1;transform:scale(1.12);}}',
].join('');
document.head.appendChild(styleEl);

const dimEl = document.createElement('div');
dimEl.id = 'overlay-dim';
const glowEl = document.createElement('div');
glowEl.id = 'overlay-glow';
document.body.append(dimEl, glowEl);

const stopBtn = document.createElement('button');
stopBtn.id = 'overlay-stop';
stopBtn.type = 'button';
stopBtn.textContent = '退出';
document.body.appendChild(stopBtn);

const capsule = document.createElement('div');
capsule.id = 'overlay-capsule';
const capsuleDot = document.createElement('span');
capsuleDot.className = 'ov-dot';
const capsuleText = document.createElement('span');
capsule.append(capsuleDot, capsuleText);
document.body.appendChild(capsule);

let lastAction = '';

const ACTION_ZH: Record<string, string> = {
  click: '点击', click_at: '点击', hover: '悬停', double_click: '双击', drag: '拖动',
  type: '输入', key: '按键',
  scroll: '滚动', show_menu: '右键', act: '操作',
};

function pointerCaption(evt: OverlayPointerPayload): string {
  const verb = ACTION_ZH[evt.action] || '';
  const label = (evt.label || '').trim();
  if (verb && label) return `${verb} ${label}`;
  return label || verb || (evt.action || '').trim();
}

function renderCapsule(): void {
  const app = state.app ? `正在操作 · ${state.app}` : '正在操作';
  const act = lastAction ? ` · ${lastAction}` : '';
  capsuleText.textContent = `${app}${act} · Esc`;
}

/* ────────────────────────────── 动画状态 ────────────────────────────── */

interface TrailPoint { x: number; y: number; t: number; }
interface Ripple { x: number; y: number; t0: number; risk: Risk; }
interface ActionLabel { text: string; x: number; y: number; t0: number; risk: Risk; }

const state: OverlayStatePayload = { visible: false };
let dismissed = false;

let running = false;
let lastFrameTs = 0;
let layerAlpha = 0;               /* 0..1 缓动后的整层不透明度 */

const cursor = { x: -200, y: -200 };   /* 当前 (缓动中) 位置 */
const cursorFrom = { x: -200, y: -200 };
const cursorTo = { x: -200, y: -200 };
let cursorT0 = -1;                     /* 缓动起点时间戳, <0 = 未启动 */
let cursorVisible = false;

const trail: TrailPoint[] = [];
const ripples: Ripple[] = [];
let actionLabel: ActionLabel | null = null;

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/* ────────────────────────────── 绘制辅助 ────────────────────────────── */

function roundRectPath(x: number, y: number, w: number, h: number, r: number): Path2D {
  const p = new Path2D();
  const rr = Math.min(r, w / 2, h / 2);
  p.moveTo(x + rr, y);
  p.arcTo(x + w, y, x + w, y + h, rr);
  p.arcTo(x + w, y + h, x, y + h, rr);
  p.arcTo(x, y + h, x, y, rr);
  p.arcTo(x, y, x + w, y, rr);
  p.closePath();
  return p;
}

/* 矢量箭头 — 自绘 (尖角落在原点 0,0, 指向右下), 不用系统光标图 */
function cursorPath(): Path2D {
  const p = new Path2D();
  p.moveTo(0, 0);
  p.lineTo(0, 20);
  p.lineTo(5.2, 15.3);
  p.lineTo(8.7, 22.2);
  p.lineTo(11.9, 20.6);
  p.lineTo(8.4, 13.9);
  p.lineTo(15.2, 13.4);
  p.closePath();
  return p;
}

/* ────────────────────────────── 三层绘制 ────────────────────────────── */

function drawWash(alpha: number): void {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (!NATIVE_DIM) {
    const g = ctx.createLinearGradient(0, 0, 0, vh);
    g.addColorStop(0, '#93c5fd');
    g.addColorStop(0.4, '#60a5fa');
    g.addColorStop(1, '#1e3a8a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
  }
  ctx.strokeStyle = NATIVE_DIM ? 'rgba(186,230,253,0.55)' : 'rgba(186,230,253,0.9)';
  ctx.lineWidth = NATIVE_DIM ? 3 : 4;
  ctx.strokeRect(3, 3, vw - 6, vh - 6);
  ctx.restore();
}

function drawTrail(now: number, alpha: number): void {
  if (trail.length < 2) return;
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    const age = (now - b.t) / TRAIL_TTL_MS;
    if (age >= 1) continue;
    const k = i / trail.length;            /* 越靠后 (越新) 越亮 */
    const aAlpha = (1 - age) * k * 0.7 * alpha;
    if (aAlpha <= 0.01) continue;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = aAlpha;
    ctx.strokeStyle = COLOR_CYAN_LIGHT;
    ctx.lineWidth = 1 + 3 * k;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawCursor(alpha: number): void {
  if (!cursorVisible) return;
  ctx.save();
  ctx.translate(cursor.x, cursor.y);
  ctx.scale(1.15, 1.15);
  ctx.globalAlpha = alpha;

  const p = cursorPath();
  const g = ctx.createLinearGradient(0, 0, 16, 22);
  g.addColorStop(0, COLOR_CYAN_LIGHT);
  g.addColorStop(1, COLOR_CYAN_DARK);

  ctx.shadowColor = COLOR_CYAN;
  ctx.shadowBlur = 20;
  ctx.fillStyle = g;
  ctx.fill(p);

  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.stroke(p);
  ctx.restore();
}

function drawRipples(now: number, alpha: number): void {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    const t = (now - rp.t0) / DUR_RIPPLE_MS;
    if (t >= 1) { ripples.splice(i, 1); continue; }
    const e = easeOutCubic(clamp01(t));
    const radius = 8 + (46 - 8) * e;
    const a = 0.8 * (1 - t) * alpha;
    const color = rp.risk === 'high' ? COLOR_RISK_DARK : COLOR_CYAN;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    /* 内圈 — 让涟漪更有"科技感"的层次 */
    ctx.globalAlpha = a * 0.5;
    ctx.beginPath();
    ctx.arc(rp.x, rp.y, radius * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawLabel(now: number, alpha: number): void {
  if (!actionLabel) return;
  const t = (now - actionLabel.t0) / DUR_LABEL_MS;
  if (t >= 1) { actionLabel = null; return; }

  /* 前 8% 淡入, 后 25% 淡出 */
  const fadeIn = clamp01(t / 0.08);
  const fadeOut = clamp01((1 - t) / 0.25);
  const a = fadeIn * fadeOut * alpha;
  if (a <= 0.01) return;

  const text = actionLabel.text;
  const risk = actionLabel.risk === 'high';
  const accent = risk ? COLOR_RISK : COLOR_CYAN;

  ctx.save();
  ctx.font = '500 12.5px "Segoe UI",system-ui,-apple-system,sans-serif';
  ctx.textBaseline = 'middle';
  const padX = 11;
  const dotR = 3.5;
  const gap = 8;
  const textW = ctx.measureText(text).width;
  const boxH = 26;
  const boxW = padX * 2 + dotR * 2 + gap + textW;

  let bx = actionLabel.x + 16;
  let by = actionLabel.y + 16;
  if (bx + boxW > vw - 8) bx = actionLabel.x - 16 - boxW;
  if (by + boxH > vh - 8) by = actionLabel.y - 16 - boxH;

  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(2,6,23,0.82)';
  ctx.strokeStyle = risk ? 'rgba(251,146,60,0.65)' : 'rgba(34,211,238,0.55)';
  ctx.lineWidth = 1;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 16;
  const box = roundRectPath(bx, by, boxW, boxH, 13);
  ctx.fill(box);
  ctx.shadowBlur = 0;
  ctx.stroke(box);

  /* 左侧小圆点 */
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(bx + padX + dotR, by + boxH / 2, dotR, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(236,254,255,0.96)';
  ctx.fillText(text, bx + padX + dotR * 2 + gap, by + boxH / 2 + 0.5);
  ctx.restore();
}

/* ────────────────────────────── 帧循环 ────────────────────────────── */

function start(): void {
  if (running) return;
  running = true;
  lastFrameTs = 0;
  requestAnimationFrame(frame);
}

function isCanvasBusy(now: number): boolean {
  if (state.visible) return true;
  if (layerAlpha > 0.001 && layerAlpha < 0.999) return true;
  if (cursorT0 >= 0 && (now - cursorT0) < DUR_CURSOR_MS) return true;
  if (trail.length > 0) return true;
  if (ripples.length > 0) return true;
  if (actionLabel) return true;
  return false;
}

function setAmbientVisible(on: boolean): void {
  /* Win 窗已经是半透明蓝底, CSS 渐变 + 内发光会再叠一层「过于蓝」。 */
  if (!NATIVE_DIM) {
    dimEl.classList.toggle('on', on);
    glowEl.classList.toggle('on', on);
  }
}

function frame(now: number): void {
  const dt = lastFrameTs === 0 ? 16 : Math.min(now - lastFrameTs, 64);
  lastFrameTs = now;

  const target = state.visible ? 1 : 0;
  const step = dt / DUR_FADE_MS;
  layerAlpha = target > layerAlpha
    ? Math.min(target, layerAlpha + step)
    : Math.max(target, layerAlpha - step);

  ctx.clearRect(0, 0, vw, vh);

  if (!state.visible && layerAlpha <= 0.001) {
    layerAlpha = 0;
    running = false;
    setAmbientVisible(false);
    return;
  }

  drawWash(layerAlpha);
  updateCursor(now);
  pruneTrail(now);

  drawTrail(now, layerAlpha);
  drawRipples(now, layerAlpha);
  drawCursor(layerAlpha);
  drawLabel(now, layerAlpha);

  if (!isCanvasBusy(now) && state.visible && layerAlpha >= 0.999) {
    running = false;
    return;
  }

  requestAnimationFrame(frame);
}

function updateCursor(now: number): void {
  if (cursorT0 < 0) return;
  const t = clamp01((now - cursorT0) / DUR_CURSOR_MS);
  const e = easeOutCubic(t);
  cursor.x = cursorFrom.x + (cursorTo.x - cursorFrom.x) * e;
  cursor.y = cursorFrom.y + (cursorTo.y - cursorFrom.y) * e;
  if (t < 1) pushTrail(now);
}

function pushTrail(now: number): void {
  const last = trail[trail.length - 1];
  if (last && Math.hypot(cursor.x - last.x, cursor.y - last.y) < 3) return;
  trail.push({ x: cursor.x, y: cursor.y, t: now });
  if (trail.length > TRAIL_MAX) trail.splice(0, trail.length - TRAIL_MAX);
}

function pruneTrail(now: number): void {
  while (trail.length > 0 && now - trail[0].t > TRAIL_TTL_MS) trail.shift();
}

/* ────────────────────────────── 事件处理 ────────────────────────────── */

function handleState(next: OverlayStatePayload): void {
  state.visible = !!next.visible;
  if (state.visible) {
    dismissed = false;
    if (typeof next.app === 'string') state.app = next.app;
    if (Array.isArray(next.steps)) state.steps = next.steps;
    if (typeof next.activeIndex === 'number') state.activeIndex = next.activeIndex;
    capsule.classList.add('on');
    stopBtn.classList.add('on');
    setAmbientVisible(true);
    renderCapsule();
    start();
  } else {
    dismissed = true;
    lastAction = '';
    capsule.classList.remove('on');
    stopBtn.classList.remove('on');
    setAmbientVisible(false);
    window.overlayBridge?.setIgnoreMouse(true);
    layerAlpha = 0;
    start();
  }
}

function handlePointer(evt: OverlayPointerPayload): void {
  if (!evt || typeof evt.x !== 'number' || typeof evt.y !== 'number') return;
  if (dismissed) return;
  const risk: Risk = evt.risk === 'high' ? 'high' : 'safe';

  if (typeof evt.app === 'string' && evt.app) {
    state.app = evt.app;
  }
  const caption = pointerCaption(evt);
  if (caption) lastAction = caption;
  renderCapsule();

  state.visible = true;
  capsule.classList.add('on');
  stopBtn.classList.add('on');
  setAmbientVisible(true);

  if (evt.x >= 0 && evt.y >= 0) {
    cursorFrom.x = cursor.x < 0 ? evt.x : cursor.x;
    cursorFrom.y = cursor.y < 0 ? evt.y : cursor.y;
    cursorTo.x = evt.x;
    cursorTo.y = evt.y;
    cursorT0 = performance.now();
    cursorVisible = true;
  }

  if (evt.phase === 'act') {
    ripples.push({ x: evt.x, y: evt.y, t0: performance.now(), risk });
    const text = pointerCaption(evt);
    if (text) {
      actionLabel = { text, x: evt.x, y: evt.y, t0: performance.now(), risk };
    }
  } else if (evt.phase === 'done') {
    actionLabel = null;
  }

  start();
}

/* ────────────────────────────── demo 自测 ────────────────────────────── */

function runDemo(): void {
  const now = performance.now();
  cursor.x = vw * 0.12;
  cursor.y = vh * 0.16;
  cursorFrom.x = cursor.x;
  cursorFrom.y = cursor.y;
  cursorTo.x = cursor.x;
  cursorTo.y = cursor.y;
  cursorT0 = now;
  cursorVisible = true;
  state.visible = true;
  state.app = '记事本';
  capsule.classList.add('on');
  stopBtn.classList.add('on');
  setAmbientVisible(true);
  renderCapsule();
  start();

  const seq: Array<Partial<OverlayPointerPayload>> = [
    { action: '点击', label: '点击 · 文件(F)', x: vw * 0.18, y: vh * 0.09, phase: 'act', risk: 'safe' },
    { action: '移动', label: '移动 · 文本编辑器', x: vw * 0.5, y: vh * 0.55, phase: 'move', risk: 'safe' },
    { action: '写值', label: '写值 · 文本编辑器', x: vw * 0.5, y: vh * 0.55, phase: 'act', risk: 'safe' },
    { action: '移动', label: '移动 · 帮助(H)', x: vw * 0.82, y: vh * 0.09, phase: 'move', risk: 'safe' },
    { action: '点击', label: '点击 · 删除 (高风险)', x: vw * 0.82, y: vh * 0.09, phase: 'act', risk: 'high' },
    { action: 'done', label: '', x: vw * 0.82, y: vh * 0.09, phase: 'done', risk: 'safe' },
  ];

  seq.forEach((item, i) => {
    window.setTimeout(() => {
      handlePointer({
        app: '记事本',
        action: item.action ?? '',
        label: item.label ?? '',
        x: item.x ?? 0,
        y: item.y ?? 0,
        phase: (item.phase ?? 'move') as PointerPhase,
        risk: item.risk,
      });
    }, 700 + i * 950);
  });
}

window.__overlayDemo = runDemo;

/* ────────────────────────────── 与主进程握手 ────────────────────────────── */

const bridge = window.overlayBridge;
if (bridge) {
  bridge.onState(handleState);
  bridge.onPointer(handlePointer);
  bridge.hello();
  const stopNow = (e?: Event): void => {
    e?.preventDefault();
    e?.stopPropagation();
    bridge.stop();
  };
  stopBtn.addEventListener('click', stopNow);
  let mouseIgnored = true;
  const setIgnore = (next: boolean): void => {
    if (next === mouseIgnored) return;
    mouseIgnored = next;
    bridge.setIgnoreMouse(next);
  };
  document.addEventListener('mousemove', (e) => {
    if (!state.visible) {
      setIgnore(true);
      return;
    }
    /* 只在「退出」钮上收点击. 整层关穿透会把下面应用的顶栏吃掉. */
    const r = stopBtn.getBoundingClientRect();
    const onStop = e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
    setIgnore(!onStop);
  }, { passive: true });
} else {
  console.warn('[overlay-entry] window.overlayBridge 未注入 (preload 未加载?)');
}

/* 自测入口: overlay.html?demo=1 立刻跑一遍假动作 */
if (new URLSearchParams(window.location.search).get('demo') === '1') {
  window.setTimeout(runDemo, 300);
}
