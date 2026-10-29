export function bodyOf(el: Element | null | undefined): HTMLElement {
  return el?.ownerDocument?.body ?? document.body;
}

export function winOf(el: Element | null | undefined): Window {
  return el?.ownerDocument?.defaultView ?? window;
}

/* 没有锚点元素的弹层 (右键菜单只拿到鼠标坐标、快捷键开的对话框): 用「最近一次按下鼠标 / 键盘的那个窗口」。
 * 主窗口在这里登记, 每个独立窗口开出来时由 FloatingSurfaces 调 trackInteractionIn 登记。 */
/* 这个模块被组件链 import 时会立刻挂监听; 单测跑在 node 环境 (没有 document), 导入期不能碰 DOM。 */
const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
let lastDoc: Document | null = hasDom ? document : null;
export function trackInteractionIn(win: Window): () => void {
  const note = () => { lastDoc = win.document; };
  win.addEventListener('pointerdown', note, true);
  win.addEventListener('keydown', note, true);
  win.addEventListener('contextmenu', note, true);
  return () => {
    win.removeEventListener('pointerdown', note, true);
    win.removeEventListener('keydown', note, true);
    win.removeEventListener('contextmenu', note, true);
    if (lastDoc === win.document) lastDoc = hasDom ? document : null;
  };
}
if (hasDom) trackInteractionIn(window);

/** 最近一次操作发生的那个窗口的 document (已关掉的窗口退回主窗口) */
export function interactionDoc(): Document {
  if (!lastDoc) return document;
  if (lastDoc !== document && (lastDoc.defaultView == null || lastDoc.defaultView.closed)) lastDoc = document;
  return lastDoc;
}

export function interactionWin(): Window {
  return interactionDoc().defaultView ?? window;
}

/* ── 主窗口的鼠标 / 键盘监听, 同步挂到每个 Surface 独立窗口上 ──
 * 全应用有上百处 document/window.addEventListener('mousedown' | 'keydown' …): 点外面关菜单、Esc 关弹层、快捷键。
 * 查看器整块搬进独立窗口后, 那边的点击和按键主窗口收不到 —— 菜单关不掉、Esc 没反应。
 * 一处处改不完也会漏, 所以在入口拦一次: 主窗口这几类监听登记下来, 每个独立窗口开出来时照样挂一份, 关窗时摘掉。
 * 事件是真事件 (target 是独立窗口里被点的元素), 「点在菜单里还是外面」的判断照常成立。 */
/* move 也要: 分隔条 / 拉伸这类拖动都是按下后在 window 上听 move, 不同步的话独立窗口里拖不动 */
const MIRRORED_EVENTS = new Set([
  'mousedown', 'mouseup', 'mousemove', 'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
  'click', 'keydown', 'keyup', 'contextmenu',
]);
type MirrorReg = { scope: 'doc' | 'win'; type: string; listener: EventListenerOrEventListenerObject; options?: boolean | AddEventListenerOptions };
const mirrorRegs: MirrorReg[] = [];
const mirrorWins = new Set<Window>();
const captureOf = (o?: boolean | EventListenerOptions) => (typeof o === 'boolean' ? o : !!o?.capture);
const targetIn = (w: Window, scope: 'doc' | 'win'): EventTarget => (scope === 'doc' ? w.document : w);

function patchMirror(scope: 'doc' | 'win'): void {
  const t = scope === 'doc' ? document : window;
  const add = t.addEventListener.bind(t);
  const remove = t.removeEventListener.bind(t);
  t.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (!listener) return;
    add(type, listener, options);
    if (!MIRRORED_EVENTS.has(type)) return;
    if (mirrorRegs.some((r) => r.scope === scope && r.type === type && r.listener === listener && captureOf(r.options) === captureOf(options))) return;
    mirrorRegs.push({ scope, type, listener, options });
    for (const w of mirrorWins) targetIn(w, scope).addEventListener(type, listener, options);
  };
  t.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
    if (!listener) return;
    remove(type, listener, options);
    if (!MIRRORED_EVENTS.has(type)) return;
    const i = mirrorRegs.findIndex((r) => r.scope === scope && r.type === type && r.listener === listener && captureOf(r.options) === captureOf(options));
    if (i < 0) return;
    mirrorRegs.splice(i, 1);
    for (const w of mirrorWins) { try { targetIn(w, scope).removeEventListener(type, listener, options); } catch { /* 窗口已关 */ } }
  };
}
if (hasDom) {
  patchMirror('doc');
  patchMirror('win');
}

/** 独立窗口开出来时调用: 把主窗口现有的这类监听全挂过去, 之后新加的也自动同步; 返回的函数在关窗时调用 */
export function mirrorMainListenersTo(win: Window): () => void {
  mirrorWins.add(win);
  for (const r of mirrorRegs) targetIn(win, r.scope).addEventListener(r.type, r.listener, r.options);
  return () => {
    mirrorWins.delete(win);
    if (win.closed) return;
    for (const r of mirrorRegs) { try { targetIn(win, r.scope).removeEventListener(r.type, r.listener, r.options); } catch { /* 已关 */ } }
  };
}
