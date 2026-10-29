/* 必须第一个加载: 它接管主窗口 addEventListener, 之后注册的鼠标/键盘监听才会同步到 Surface 独立窗口 */
import './utils/ownerDoc';
import React from 'react';
import ReactDOM from 'react-dom/client';
import AppShell from './app/AppShell';
import './App.css';
import { AppStoreProvider } from '../state/appStore';
import ErrorBoundary from './components/ErrorBoundary';
import { WinWindowControls } from './components/WinWindowControls';
import { installUserTimingSweeper } from './perf/userTimingSweeper';
import { applyMotionPreference, applyWindowVibrancy } from './state/motionPreferences';
import { installJankRecorder } from './perf/jankRecorder';
import { getGlobalLanguage } from './hooks/useI18n';
import { bootEdition, registerEditionSlots } from './modules/shell/editionSlots';

/* 掉帧记录器 —— 默认关闭 (常驻 rAF 会让浏览器无法进入空闲)。
   localStorage['neox.perf.jank']='1' 打开, 之后 window.__neoxJank.dump() 取数。 */
installJankRecorder();

/* 动效档位必须在 React 首次渲染**之前**同步写到 <html data-motion>。
   晚一帧就意味着第一帧按默认档渲染 —— 关了动效的用户仍会先看见一下动效。 */
applyMotionPreference();
applyWindowVibrancy();
/* <html lang> 跟持久化的界面语言对齐 —— index.html 里写死的是 "en"。
   之后语言切换由 setGlobalLanguage 继续维护。 */
try { document.documentElement.lang = getGlobalLanguage(); } catch { /* ignore */ }

/* 发行版能力钩子 + 常驻服务 (带账号体系的发行版在这里装 gateway-key 同步等)。
   必须早于任何组件渲染; 公开构建里什么都不做, 见 modules/shell/editionSlots.ts。 */
bootEdition();

/* 给 User Timing 缓冲区封顶 — 根治 Monaco InputLatency 埋点 performance.measure 泄漏
   (长会话 renderer 内存涨到数 GB → GC 空转 → UI 卡顿)。见 userTimingSweeper.ts。 */
installUserTimingSweeper();

{
  const hot = (import.meta as any).hot;
  if (hot) {
    hot.on('vite:beforeUpdate', (payload: { updates?: Array<{ path?: string }> }) => {
      try {
        const paths = (payload?.updates ?? []).map((u) => u.path ?? '');
        const storeTouched = paths.some((p) => /\/state\/appStore\.[jt]sx?$/.test(p) || p.includes('/state/appStore.'));
        if (storeTouched || document.querySelector('.atl-msg.is-streaming, .atl-msg.is-pending')) {
          location.reload();
        }
      } catch { /* noop */ }
    });
  }
}

try {
  const w = window as any;
  const fromHash = location.hash.includes('neox_debug=1');
  const fromQuery = location.search.includes('neox_debug=1');
  const fromGlobal = typeof w.__NEOX_DEBUG__ === 'boolean' ? w.__NEOX_DEBUG__ : false;
  const fromPreload = typeof w.neox?.debugEnabled === 'boolean' ? w.neox.debugEnabled : false;
  w.__NEOX_DEBUG__ = fromHash || fromQuery || fromGlobal || fromPreload;
} catch { /* renderer 安全沙箱里 location 可能受限 — 默认 false */ }

// Suppress react-virtuoso "Zero-sized element" warnings
// These fire during initial layout before container has height — harmless
const _origWarn = console.warn;
console.warn = (...args: any[]) => {
  if (typeof args[0] === 'string' && args[0].includes('react-virtuoso')) return;
  _origWarn.apply(console, args);
};

async function seedDefaultAgentMode(): Promise<void> {
  try {
    const api = (window as any).neox;
    const r = await Promise.race([
      api?.agentModeGetDefault?.(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SEED_AGENT_MODE_TIMEOUT_MS)),
    ]);
    const m = r?.defaultAgentMode;
    /* 'assistant' = 已下线的 Life, 配置迁移已改写成 work; 这里再兜一次 */
    if (m === 'assistant' || m === 'work' || m === 'code' || m === 'pilot') {
      (window as any).__neoxDefaultAgentMode = m === 'code' || m === 'pilot' ? m : 'work';
    }
  } catch { /* 读不到 → code 回落 */ }
}
const SEED_AGENT_MODE_TIMEOUT_MS = 3_000;

/* 挂载闸门 —— 等主进程的 auth 恢复 + sqlite 迁移跑完。
 *
 * 窗口现在排在 auth/sqlite **之前**创建 (见 electron/bootstrap/appLifecycle.ts), 好处是
 * 点完图标立刻有真窗口 + index.html 的启动骨架在动; 代价是渲染层可能在存储就绪前就开始
 * 发 IPC。与其去审计每一个 handler 能不能"半就绪"运行, 不如在挂载这一个点上等一下 ——
 * 这段时间用户看到的是骨架动画, 跟改之前"什么都没有"相比只赚不亏。
 *
 * 超时兜底: 闸门万一没 resolve (主进程崩在 whenReady 里 / 老版本 preload 没这个方法),
 * 也必须挂载 —— 停在骨架上连错误页都出不来, 比数据竞争更糟。 */
const STARTUP_GATE_TIMEOUT_MS = 10_000;

async function waitForStartupGate(): Promise<void> {
  const api = (window as any).neox;
  if (typeof api?.startupWaitReady !== 'function') return;
  try {
    await Promise.race([
      api.startupWaitReady(),
      new Promise((resolve) => setTimeout(resolve, STARTUP_GATE_TIMEOUT_MS)),
    ]);
  } catch { /* 闸门本身出错不该挡住挂载 */ }
}

/* 骨架从"页面开始加载"算起最多活这么久。
 *
 * 12s 而不是原来的 8s: 挂载闸门自己就可能等到 10s (STARTUP_GATE_TIMEOUT_MS), 8s 会在
 * 首次启动做 sqlite 迁移时提前把骨架撕掉, 露出半截空白页。取"闸门上限 + 2s 余量"。 */
const SKELETON_HARD_REMOVE_MS = 12_000;

/** 首屏几步同时进主进程那份无条件落盘的启动面包屑 —— 卡住时要能跟主进程阶段对齐看。 */
function startupCrumb(msg: string): void {
  try { (window as any).neox?.logDebug?.('STARTUP', msg); } catch { /* 没有 preload 就算了 */ }
}
startupCrumb('renderer script evaluated');

window.setTimeout(() => {
  const el = document.getElementById('app-skeleton');
  if (!el) return;
  console.warn('[Startup] #app-skeleton 兜底拆除 —— AppShell 没有在预期时间内接管首屏');
  const mounted = (document.getElementById('root')?.childElementCount ?? 0) > 0;
  startupCrumb(`skeleton hard-remove fired, reactMounted=${mounted}`);
  if (mounted) {
    el.remove();
    return;
  }
  /* React 还没挂上就把骨架拆了 = 纯白屏, 那比一张转圈的图还糟 —— 用户连"它到底在干活
   * 还是死了"都判断不出来。所以这种情况不拆, 改成一句能照着做的话:
   * 启动被卡住只有两种出路 (重开 / 跳过签名自检), 直接写出来, 别让人去找日志。 */
  const hint = el.querySelector('.sk-hint');
  if (hint) {
    const zh = (document.documentElement.lang || '').startsWith('zh');
    hint.textContent = zh
      ? '启动卡住了 · 请退出后重开; 仍然卡住就在终端里设 NEOX_SKIP_CODESIGN_CHECK=1 再启动'
      : 'Startup is stuck · quit and reopen; if it persists, launch with NEOX_SKIP_CODESIGN_CHECK=1';
    (hint as HTMLElement).style.animation = 'none';
    (hint as HTMLElement).style.opacity = '1';
    (hint as HTMLElement).style.maxWidth = '30rem';
    (hint as HTMLElement).style.textAlign = 'center';
    (hint as HTMLElement).style.lineHeight = '1.6';
  }
}, SKELETON_HARD_REMOVE_MS);

void Promise.all([waitForStartupGate(), seedDefaultAgentMode()]).finally(() => {
  startupCrumb('gate settled → mounting React');
  /* 外壳插槽先注册再挂载 —— 让第一帧就是最终形态, 不先闪一下本地兜底再被替换掉。
   * 公开构建里它不注册任何东西, 见 modules/shell/editionSlots.ts。 */
  registerEditionSlots();
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <ErrorBoundary>
      <AppStoreProvider>
        <AppShell />
        {/* Win 自绘三大金刚：portal 到 body，覆盖引导/欢迎/主壳/设置全表面 */}
        <WinWindowControls />
      </AppStoreProvider>
    </ErrorBoundary>,
  );
});
