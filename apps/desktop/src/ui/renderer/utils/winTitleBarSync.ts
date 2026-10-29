
const CHROME_BAR_SELECTORS = [
  '.neox-topbar',
  '.workspace-header',
] as const;

/** 全屏表面（无独立 topbar 时，整页背景即「标题栏底」） */
const FULLPAGE_SURFACE_SELECTORS = [
  '.neox-loginpage',
  '.onboarding-page',
  '.welcome-page',
] as const;

/** 覆盖窗缘的遮罩层（悬浮卡片打开时，三大金刚底下是 overlay 不是卡片） */
const OVERLAY_SURFACE_SELECTORS = [
  '.settings-overlay',
] as const;

const HEIGHT_SELECTORS = [
  '.neox-topbar',
  '.workspace-header',
  '.onboarding-header',
] as const;

/** Win 引导顶栏 — 实色 chrome, 优先于整页/wallpaper 取样 */
const ONBOARDING_CHROME_SELECTORS = [
  '.onboarding-header',
] as const;

/** 无顶栏时的 token 顺序: page 色优先, material 最后 */
const PAGE_TOKEN_KEYS = [
  '--bg-primary',
  '--neox-bg-canvas',
  '--bg-elevated',
  '--neox-topbar-material-bg',
] as const;

/** 有顶栏时: material 优先 (跟 .neox-topbar 设计一致) */
const TOPBAR_TOKEN_KEYS = [
  '--neox-topbar-material-bg',
  '--bg-primary',
  '--neox-bg-canvas',
  '--bg-elevated',
] as const;

export function isUsableOverlayColor(v: string | undefined | null): v is string {
  if (!v) return false;
  const s = v.trim();
  if (!s) return false;
  if (s === 'transparent' || s === 'none' || s === 'inherit' || s === 'initial') return false;
  if (/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/i.test(s)) return false;
  /* color-mix / var() 未解析 → Electron setTitleBarOverlay 拒收 */
  if (/color-mix\(|\bvar\(/i.test(s)) return false;
  return true;
}

function readComputedBg(el: Element | null): string | undefined {
  if (!el || !(el instanceof HTMLElement)) return undefined;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return undefined;
  const bg = (style.backgroundColor || '').trim();
  return isUsableOverlayColor(bg) ? bg : undefined;
}

/** 沿祖先链找第一块不透明底色 */
function readEffectiveBg(el: Element | null): string | undefined {
  let node: Element | null = el;
  while (node && node !== document.documentElement.parentElement) {
    const bg = readComputedBg(node);
    if (bg) return bg;
    node = node.parentElement;
  }
  return undefined;
}

function firstVisible(selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    return el;
  }
  return null;
}

function hasVisibleChromeBar(): boolean {
  return firstVisible([...CHROME_BAR_SELECTORS]) != null;
}

/**
 * 在三大金刚大致位置取样 — OS overlay 浮在网页之上, elementFromPoint
 * 仍能打到下方 content, 这是跟肉眼色差对齐的最稳来源。
 */
function readBgUnderCaptionButtons(): string | undefined {
  const w = window.innerWidth || document.documentElement.clientWidth || 0;
  const h = window.innerHeight || document.documentElement.clientHeight || 0;
  if (w < 40 || h < 20) return undefined;
  /* caption 约 138×44, 取按钮区中部偏左一点 (避开最右 close 热区边缘) */
  const points: Array<[number, number]> = [
    [w - 90, 18],
    [w - 50, 18],
    [w - 120, 22],
    [w - 90, 8],
  ];
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    let el: Element | null = null;
    try {
      el = document.elementFromPoint(x, y);
    } catch {
      continue;
    }
    const bg = readEffectiveBg(el);
    if (bg) return bg;
  }
  return undefined;
}

function writeWinCaptionCssVars(opts: {
  color?: string;
  symbolColor?: string;
  height?: number;
}): void {
  const root = document.documentElement;
  if (opts.color && isUsableOverlayColor(opts.color)) {
    root.style.setProperty('--neox-win-caption-bg', opts.color);
  }
  if (opts.symbolColor) {
    root.style.setProperty('--neox-win-caption-fg', opts.symbolColor);
  }
  if (typeof opts.height === 'number' && opts.height > 0) {
    root.style.setProperty('--neox-win-caption-height', `${opts.height}px`);
  }
}

export function readWinChromeBackground(root: HTMLElement = document.documentElement): string | undefined {
  /* 0) Win 设置全屏时 — 跟 settings 实底对齐, 不能再读底下壳顶栏 */
  const settingsPage = firstVisible(['.settings-page']);
  if (settingsPage) {
    const stBg = getComputedStyle(settingsPage).getPropertyValue('--st-bg').trim();
    if (isUsableOverlayColor(stBg)) return stBg;
    const pageBg = readComputedBg(settingsPage) || readEffectiveBg(settingsPage);
    if (pageBg) return pageBg;
  }
  for (const sel of OVERLAY_SURFACE_SELECTORS) {
    const bg = readComputedBg(document.querySelector(sel)) || readEffectiveBg(document.querySelector(sel));
    if (bg) return bg;
  }

  /* 1) 真实顶栏 (主壳) */
  for (const sel of CHROME_BAR_SELECTORS) {
    const bg = readComputedBg(document.querySelector(sel));
    if (bg) return bg;
  }

  /* 1.5) 引导页: 优先读右上 caption 垫色 (::after 用 canvas), 再读 header */
  const onboardingPad = document.querySelector('.onboarding-page');
  if (onboardingPad) {
    const canvas = getComputedStyle(document.documentElement)
      .getPropertyValue('--neox-bg-canvas').trim()
      || getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
    if (isUsableOverlayColor(canvas)) return canvas;
  }
  for (const sel of ONBOARDING_CHROME_SELECTORS) {
    const bg = readComputedBg(document.querySelector(sel));
    if (bg) return bg;
  }

  const underCaption = readBgUnderCaptionButtons();
  if (underCaption) return underCaption;

  /* 3) 全屏页 */
  for (const sel of FULLPAGE_SURFACE_SELECTORS) {
    const bg = readEffectiveBg(document.querySelector(sel));
    if (bg) return bg;
  }

  /* 4) CSS token — 有顶栏用 material 优先, 否则 page 优先 */
  const rootCs = getComputedStyle(root);
  const tokenKeys = hasVisibleChromeBar() ? TOPBAR_TOKEN_KEYS : PAGE_TOKEN_KEYS;
  for (const key of tokenKeys) {
    const v = rootCs.getPropertyValue(key).trim();
    if (isUsableOverlayColor(v)) return v;
  }

  /* 5) 祖先兜底 */
  for (const el of [document.body, document.getElementById('root'), root]) {
    const bg = readComputedBg(el);
    if (bg) return bg;
  }
  return undefined;
}

export function readWinChromeHeight(): number {
  for (const sel of HEIGHT_SELECTORS) {
    const el = firstVisible([sel]);
    if (!el) continue;
    const h = Math.round(el.getBoundingClientRect().height);
    if (h >= 32 && h <= 72) return h;
  }
  /* welcome / login 无独立 header 时跟主 topbar 约定 44 */
  return 44;
}

export function readWinChromeForeground(root: HTMLElement = document.documentElement): string {
  const isDark = root.getAttribute('data-theme') === 'dark';
  /* 三大金刚图标色: 跟背景反差拉满, 不吃主题 muted 灰 (Win overlay 上会发脏) */
  return isDark ? '#f3f4f6' : '#1f2937';
}

/** UI 3 陶土外壳: 整窗实色画布, Win11 不再开 acrylic (见 syncWinTitleBar)。要恢复毛玻璃改成 false。 */
const SHELL_IS_SOLID_CANVAS: boolean = true;

export type WinTitleBarSyncResult = {
  skipped?: boolean;
  reason?: string;
  color?: string;
  symbolColor?: string;
  height?: number;
};

let lastAppliedKey = '';

/** 立刻把当前表面色同步到 Electron titleBarOverlay。非 win32 no-op。 */
export function syncWinTitleBar(): WinTitleBarSyncResult {
  const root = document.documentElement;
  if (root.getAttribute('data-platform') !== 'win32') {
    return { skipped: true, reason: 'not-win32' };
  }
  const isDark = root.getAttribute('data-theme') === 'dark';
  const sampled = readWinChromeBackground(root);
  const symbolColor = readWinChromeForeground(root);
  const height = readWinChromeHeight();
  /* 设置 / 登录 / 引导 = 实色页, 禁止 acrylic (跟 overlay 会色差).
   * 毛玻璃侧栏 / 欢迎页 = 开 Acrylic: 窗体透明, 侧栏半透 wash 才能透出 DWM 模糊,
   * 否则 Win 实色底 + CSS transparent = 纯黑一块 (Mac vibrancy 才是真透桌面). */
  const settingsOpen = Boolean(document.querySelector('.settings-page, .settings-overlay'));
  const solidPage = Boolean(
    document.querySelector('.neox-loginpage, .onboarding-page'),
  );
  const sidebarGlassOn = root.getAttribute('data-sidebar-glass') === 'on';
  const welcomeOpen = Boolean(document.querySelector('.welcome-page'));
  const glassRequested = !settingsOpen && !solidPage && (sidebarGlassOn || welcomeOpen);
  const wantAcrylic: boolean = glassRequested && SHELL_IS_SOLID_CANVAS === false;
  const backdrop = wantAcrylic ? 'acrylic' : 'none';
  /* Acrylic 必须配全透窗底, 否则材质被实色盖死; 实色模式仍用取样色. */
  const color = wantAcrylic ? '#00000000' : sampled;
  /* CSS 变量: 控件/caption 仍用取样色 (别用全透, 图标会糊成没底) */
  writeWinCaptionCssVars({ color: sampled ?? color, symbolColor, height });
  /* 同色反复 setBackgroundColor 会整窗闪 — 跳过 no-op */
  const key = `${color ?? ''}|${symbolColor ?? ''}|${height}|${backdrop}|${isDark ? 1 : 0}|sg=${sidebarGlassOn ? 1 : 0}`;
  if (key === lastAppliedKey) {
    return { skipped: true, reason: 'unchanged', color, symbolColor, height };
  }
  const api = (window as unknown as {
    neox?: {
      syncTitleBar?: (payload: {
        isDark?: boolean;
        color?: string;
        symbolColor?: string;
        height?: number;
        backdrop?: 'acrylic' | 'none';
      }) => Promise<unknown> | unknown;
    };
  }).neox;
  if (!api?.syncTitleBar) {
    return { skipped: true, reason: 'no-api', color, symbolColor, height };
  }
  lastAppliedKey = key;
  void api.syncTitleBar({
    isDark,
    color,
    symbolColor,
    height,
    backdrop,
  });
  return { color, symbolColor, height };
}

/**
 * 挂载 Windows 标题栏同步：启动重试 + 主题/DOM 变化。
 * 返回 disposer。
 */
export function installWinTitleBarSync(options?: {
  /** 额外依赖变化时由调用方再调一次；这里只管 DOM/主题 */
  retryMs?: number[];
}): () => void {
  const retries = options?.retryMs ?? [16, 50, 120, 300, 700, 1500, 3000];
  const root = document.documentElement;

  const sync = () => { syncWinTitleBar(); };
  sync();

  const timers = retries.map((d) => setTimeout(sync, d));

  const obs = new MutationObserver(sync);
  obs.observe(root, {
    attributes: true,
    attributeFilter: [
      'data-theme',
      'data-theme-pack',
      'data-platform',
      'data-sidebar-glass',
      'style',
      'class',
    ],
  });

  /* 页面切换 (onboarding ↔ welcome ↔ shell) 不改 data-theme，听 #root 直接子节点即可.
   * subtree:true 会在动画/虚拟列表里狂触发, 即便有去重也浪费. */
  const rootMount = document.getElementById('root') ?? document.body;
  let domTimer = 0;
  const syncDomDebounced = () => {
    window.clearTimeout(domTimer);
    domTimer = window.setTimeout(sync, 120);
  };
  const childObs = new MutationObserver(syncDomDebounced);
  childObs.observe(rootMount, { childList: true, subtree: false });
  /* LoginPage portal 到 body — 再听一层 */
  const bodyObs = rootMount === document.body
    ? null
    : (() => {
        const o = new MutationObserver(syncDomDebounced);
        o.observe(document.body, { childList: true, subtree: false });
        return o;
      })();

  let raf = 0;
  const onStyleMaybeChanged = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(sync);
  };
  window.addEventListener('neox:theme-pack-applied', onStyleMaybeChanged as EventListener);
  window.addEventListener('resize', onStyleMaybeChanged);
  /* 登录页 / 设置层开关常靠 React portal，再补一个轻量周期兜底（仅启动期） */
  const bootPoll = window.setInterval(sync, 800);
  const bootPollStop = window.setTimeout(() => clearInterval(bootPoll), 6000);

  return () => {
    timers.forEach(clearTimeout);
    clearInterval(bootPoll);
    clearTimeout(bootPollStop);
    window.clearTimeout(domTimer);
    obs.disconnect();
    childObs.disconnect();
    bodyObs?.disconnect();
    cancelAnimationFrame(raf);
    window.removeEventListener('neox:theme-pack-applied', onStyleMaybeChanged as EventListener);
    window.removeEventListener('resize', onStyleMaybeChanged);
  };
}
