import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron';

/* 竖条 = 贴边的书签: 窗口往屏幕外让出 STRIP_OVERHANG, 系统窗口靠屏幕那一侧的圆角藏到屏幕外, 看起来是从边上长出来的 */
const STRIP_W = 50;
const STRIP_OVERHANG = 10;
const STRIP_H = 148;
const STRIP_GAP = 10;
const STRIP_TOP = 96;
const MIN_W = 320;
const MIN_H = 220;
/* 重叠超过小窗面积的这一比例才算「挡着主界面」 */
const OVERLAP_RATIO = 0.25;

type Side = 'left' | 'right';
interface Popout {
  name: string;
  win: BrowserWindow;
  owner: BrowserWindow;
  pinned: boolean;
  tucked: boolean;
  peeking: boolean;
  side: Side;
  /** 收起前 / 探出时要回到的完整位置 */
  restore: Rectangle | null;
  /** 程序自己 setBounds 引起的 move 不当成用户拖动 */
  selfMoveUntil: number;
  moveTimer: ReturnType<typeof setTimeout> | null;
  /** 探出时鼠标停在标题栏 (系统拖动区, 网页收不到鼠标) —— 等它真的离开窗口再缩回 */
  leaveWatch: ReturnType<typeof setInterval> | null;
}

const popouts = new Map<string, Popout>();
let hooked = false;

function send(p: Popout, type: string, extra: Record<string, unknown> = {}): void {
  if (p.owner.isDestroyed()) return;
  p.owner.webContents.send('surface-popout:event', {
    name: p.name, type, tucked: p.tucked, pinned: p.pinned, peeking: p.peeking, side: p.side, ...extra,
  });
}

function overlapRatio(a: Rectangle, b: Rectangle): number {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (w * h) / Math.max(1, a.width * a.height);
}

function neoxActive(): boolean {
  return BrowserWindow.getFocusedWindow() != null;
}

/** 层级: 钉住 = 一直最前; 收着的竖条 = Neox 在前台时浮在上面; 其余普通 */
function applyLevel(p: Popout): void {
  if (p.win.isDestroyed() || p.win.isFullScreen()) return;
  const onTop = p.pinned || (p.tucked && neoxActive());
  p.win.setAlwaysOnTop(onTop, 'floating');
}

function setBoundsQuiet(p: Popout, r: Rectangle): void {
  p.selfMoveUntil = Date.now() + 500;
  p.win.setBounds(r, process.platform === 'darwin');
  /* 46 宽的竖条上还挂着红绿灯就挤坏了 —— 只是竖条时藏起来, 探出 / 回原位再出来 */
  if (process.platform === 'darwin') p.win.setWindowButtonVisibility(!(p.tucked && !p.peeking));
}

/** 同一块屏、同一边已经收着的竖条, 按收起先后排位 */
function stripRect(p: Popout): Rectangle {
  const display = screen.getDisplayMatching(p.restore ?? p.win.getBounds());
  const wa = display.workArea;
  const same = [...popouts.values()].filter((o) =>
    o.tucked && o.side === p.side && o !== p
    && screen.getDisplayMatching(o.restore ?? o.win.getBounds()).id === display.id);
  const idx = same.length;
  const maxRows = Math.max(1, Math.floor((wa.height - STRIP_TOP) / (STRIP_H + STRIP_GAP)));
  const y = wa.y + STRIP_TOP + (idx % maxRows) * (STRIP_H + STRIP_GAP);
  const x = p.side === 'right' ? wa.x + wa.width - STRIP_W + STRIP_OVERHANG : wa.x - STRIP_OVERHANG;
  return { x, y, width: STRIP_W, height: STRIP_H };
}

function tuck(p: Popout): void {
  if (p.tucked || p.pinned || p.win.isDestroyed() || p.win.isFullScreen()) return;
  const b = p.win.getBounds();
  const o = p.owner.getBounds();
  p.restore = b;
  p.side = b.x + b.width / 2 >= o.x + o.width / 2 ? 'right' : 'left';
  p.tucked = true;
  p.peeking = false;
  p.win.setMinimumSize(1, 1);
  setBoundsQuiet(p, stripRect(p));
  applyLevel(p);
  send(p, 'state');
}

function untuck(p: Popout, focus: boolean): void {
  stopLeaveWatch(p);
  if (!p.tucked || p.win.isDestroyed()) return;
  p.tucked = false;
  p.peeking = false;
  p.win.setMinimumSize(MIN_W, MIN_H);
  if (p.restore) setBoundsQuiet(p, p.restore);
  applyLevel(p);
  send(p, 'state');
  if (focus) p.win.focus();
}

/** 探出: 原尺寸贴着竖条那一边展开 (竖条留在窗口里, 鼠标还在窗口上, 不会一出来就 mouseleave) */
function peek(p: Popout, on: boolean): void {
  stopLeaveWatch(p);
  if (!p.tucked || p.win.isDestroyed() || p.peeking === on || !p.restore) return;
  p.peeking = on;
  if (on) {
    const strip = p.win.getBounds();
    const wa = screen.getDisplayMatching(strip).workArea;
    const w = Math.min(p.restore.width, wa.width - 16);
    const h = Math.min(p.restore.height, wa.height - 16);
    const x = p.side === 'right' ? wa.x + wa.width - w : wa.x;
    const y = Math.max(wa.y + 8, Math.min(strip.y - 24, wa.y + wa.height - h - 8));
    p.win.setMinimumSize(1, 1);
    setBoundsQuiet(p, { x, y, width: w, height: h });
  } else {
    setBoundsQuiet(p, stripRect(p));
  }
  send(p, 'state');
}

function stopLeaveWatch(p: Popout): void {
  if (p.leaveWatch) { clearInterval(p.leaveWatch); p.leaveWatch = null; }
}

function cursorInside(p: Popout): boolean {
  const c = screen.getCursorScreenPoint();
  const b = p.win.getBounds();
  return c.x >= b.x - 4 && c.x <= b.x + b.width + 4 && c.y >= b.y - 4 && c.y <= b.y + b.height + 4;
}

function requestUnpeek(p: Popout): void {
  if (!p.peeking || p.win.isDestroyed()) return;
  if (!cursorInside(p)) { peek(p, false); return; }
  if (p.leaveWatch) return;
  p.leaveWatch = setInterval(() => {
    if (!p.peeking || p.win.isDestroyed()) { stopLeaveWatch(p); return; }
    if (!cursorInside(p)) { stopLeaveWatch(p); peek(p, false); }
  }, 200);
}

/** 用户回到主界面: 挡着它的小窗收到边上 */
function onOwnerFocus(owner: BrowserWindow): void {
  const ob = owner.getBounds();
  for (const p of popouts.values()) {
    if (p.owner !== owner || p.tucked || p.pinned || p.win.isDestroyed() || !p.win.isVisible()) continue;
    if (overlapRatio(p.win.getBounds(), ob) >= OVERLAP_RATIO) tuck(p);
  }
}

function syncLevels(): void {
  for (const p of popouts.values()) applyLevel(p);
}

export function registerSurfacePopout(win: BrowserWindow, name: string, owner: BrowserWindow): void {
  const p: Popout = {
    name, win, owner, pinned: false, tucked: false, peeking: false, side: 'right',
    restore: null, selfMoveUntil: Date.now() + 800, moveTimer: null, leaveWatch: null,
  };
  popouts.set(name, p);

  /* 挪动推给 renderer (拖回右栏合并): move 一路推坐标, 停下推 moved。
   * mac 有原生 moved (松手那一刻); 别的平台没有, 最后一次 move 后 300ms 当作停下。 */
  win.on('move', () => {
    if (Date.now() < p.selfMoveUntil) return;
    if (p.tucked) {
      /* 探出来时被用户拖走 = 想把它放在这儿: 退出收起, 当普通窗口 (之后照样能拖回右栏合并) */
      if (!p.peeking) return;
      stopLeaveWatch(p);
      p.tucked = false;
      p.peeking = false;
      p.restore = null;
      win.setMinimumSize(MIN_W, MIN_H);
      if (process.platform === 'darwin') win.setWindowButtonVisibility(true);
      applyLevel(p);
      send(p, 'state');
    }
    send(p, 'move', { bounds: win.getBounds() });
    if (p.moveTimer) clearTimeout(p.moveTimer);
    p.moveTimer = setTimeout(() => send(p, 'moved', { bounds: win.getBounds() }), process.platform === 'darwin' ? 600 : 300);
  });
  win.on('moved', () => {
    if (Date.now() < p.selfMoveUntil || (p.tucked && !p.peeking)) return;
    if (p.moveTimer) { clearTimeout(p.moveTimer); p.moveTimer = null; }
    send(p, 'moved', { bounds: win.getBounds() });
  });
  win.on('enter-full-screen', () => win.setAlwaysOnTop(false));
  win.on('leave-full-screen', () => applyLevel(p));
  win.on('closed', () => {
    if (p.moveTimer) clearTimeout(p.moveTimer);
    stopLeaveWatch(p);
    popouts.delete(name);
    send(p, 'closed');
    /* 后面的竖条往上补位 */
    for (const o of popouts.values()) if (o.tucked && !o.peeking && !o.win.isDestroyed()) setBoundsQuiet(o, stripRect(o));
  });

  if (!hooked) {
    hooked = true;
    app.on('browser-window-focus', (_e, w) => {
      if ([...popouts.values()].some((o) => o.owner === w)) onOwnerFocus(w);
      syncLevels();
    });
    /* 在 Neox 自己的窗口之间切焦点时 blur 先到、focus 后到 —— 等一拍再看是不是真的离开了 Neox */
    app.on('browser-window-blur', () => setTimeout(syncLevels, 60));
    ipcMain.handle('surface-popout:peek', (_e, n: string, on: boolean) => {
      const o = popouts.get(n);
      if (!o) return;
      if (on) peek(o, true); else requestUnpeek(o);
    });
    ipcMain.handle('surface-popout:untuck', (_e, n: string) => { const o = popouts.get(n); if (o) untuck(o, true); });
    ipcMain.handle('surface-popout:tuck', (_e, n: string) => { const o = popouts.get(n); if (o) tuck(o); });
    ipcMain.handle('surface-popout:pin', (_e, n: string, on: boolean) => {
      const o = popouts.get(n);
      if (!o) return;
      o.pinned = !!on;
      if (o.pinned) untuck(o, false);
      applyLevel(o);
      send(o, 'state');
    });
  }
  applyLevel(p);
}
