import { createRequire } from 'node:module';

/**
 * 是否跑在打包后的 Electron 里 —— **运行时**取, 不在顶层 import electron。
 *
 * 顶层 `import { app } from 'electron'` 会让所有 import 这个文件的模块
 * (providerHandlers 等) 在纯 Node 后端里**整包加载失败**:
 *   `Named export 'app' not found. The requested module 'electron' is a CommonJS module`
 * 一个 import 带垮同包几十个 handler, 症状是"桥上一条路由都没有",
 * 看不出跟 electron 有关 —— 这个坑同一天踩了两次 (healthCheckService 是另一次)。
 *
 * 非 Electron 宿主一律按"未打包"处理: 极简版的 profile 由壳通过 NEOX_PROFILE /
 * NEOX_*_BASE 显式传下来, 不靠 isPackaged 猜。
 */
function isPackagedApp(): boolean {
  try {
    return createRequire(import.meta.url)('electron')?.app?.isPackaged === true;
  } catch {
    return false;
  }
}

/* ============================================================
 * cloudEndpoints — Neox 客户端连哪个云端的唯一 source of truth (main 进程).
 *
 *   决策规则
 *   --------
 *     1. 显式环境变量最高优先 (NEOX_API_BASE / NEOX_GATEWAY_BASE / NEOX_WEB_BASE).
 *        dev 时用户可以 `NEOX_API_BASE=http://x npx electron .` 临时切换.
 *     2. 否则:
 *        - app.isPackaged === true (打包后)→ prod 三件套
 *        - 否则 (dev) → local localhost
 *
 *   切换不在 UI 暴露 — 切换 server 等于换账户体系, token / cached membership
 *   全跟 server 强绑, 一旦半切换会乱套. 需要切就重 build 一份.
 *
 *   preload.cjs 走同样规则 (无法 import ESM, 复制了一遍). 两边保持一致即可.
 * ============================================================ */

export interface CloudEndpointsTriple {
  api: string;
  gateway: string;
  web: string;
}

const PRESETS = {
  local: {
    api:     'http://localhost:3721',
    gateway: 'http://localhost:8088',
    web:     'http://localhost:3000',
  },
  prod: {
    api:     'https://neox-dev.com',
    gateway: 'https://gateway.neox-dev.com',
    web:     'https://neox-dev.com',
  },
} as const;

function pickBaseProfile(): CloudEndpointsTriple {
  const explicit = (process.env.NEOX_PROFILE || '').toLowerCase();
  if (explicit === 'prod') return PRESETS.prod;
  if (explicit === 'local') return PRESETS.local;
  const looksProd = [process.env.NEOX_API_BASE, process.env.NEOX_GATEWAY_BASE, process.env.NEOX_WEB_BASE]
    .some((v) => typeof v === 'string' && v && !/^https?:\/\/(?:localhost|127\.|0\.0\.0\.0)/i.test(v));
  if (looksProd) return PRESETS.prod;
  return PRESETS.prod;
}

/** 主入口 — main 进程任意 service 用这个拿当前应当连接的 endpoints. */
export function resolveCloudEndpoints(): CloudEndpointsTriple {
  const base = pickBaseProfile();
  return {
    api:     process.env.NEOX_API_BASE     || base.api,
    gateway: process.env.NEOX_GATEWAY_BASE || base.gateway,
    web:     process.env.NEOX_WEB_BASE     || base.web,
  };
}

/** 把当前 endpoints 注入 process.env, 让 module-level 读 process.env 的旧 service
 *  (neoxRoutingService / authHandlers / 子进程 server) 透明工作. main.ts 启动时调一次. */
export function applyToProcessEnv(): void {
  const explicit = (process.env.NEOX_PROFILE || '').toLowerCase();
  const hadEnvBase = !!(process.env.NEOX_API_BASE || process.env.NEOX_GATEWAY_BASE || process.env.NEOX_WEB_BASE);
  const profile = isPackagedApp() ? 'prod (packaged)'
    : explicit === 'local' ? 'local (NEOX_PROFILE=local)'
    : explicit === 'prod' ? 'prod (NEOX_PROFILE=prod)'
    : hadEnvBase ? 'env-override (NEOX_*_BASE 显式指定)'
    : 'prod (dev 默认 · 要连本地请显式 NEOX_PROFILE=local)';

  const ep = resolveCloudEndpoints();
  if (!process.env.NEOX_API_BASE)     process.env.NEOX_API_BASE     = ep.api;
  if (!process.env.NEOX_GATEWAY_BASE) process.env.NEOX_GATEWAY_BASE = ep.gateway;
  if (!process.env.NEOX_WEB_BASE)     process.env.NEOX_WEB_BASE     = ep.web;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[cloudEndpoints] active profile: ${profile}`);
  console.log(`  NEOX_API_BASE     = ${process.env.NEOX_API_BASE}`);
  console.log(`  NEOX_GATEWAY_BASE = ${process.env.NEOX_GATEWAY_BASE}`);
  console.log(`  NEOX_WEB_BASE     = ${process.env.NEOX_WEB_BASE}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
