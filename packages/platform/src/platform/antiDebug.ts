/**
 * antiDebug — 启动期反调试检测 (SEC-2 JS 层).
 *
 *  真正的 mac 反调试 = Hardened Runtime + entitlements (SEC-3) — kernel 层强保护.
 *    本模块只是 JS 层补充, 检测 Node 自带的 --inspect 类 debug 入口.
 *    对 lldb attach 这种内核级 attach 无效 — 那种靠签名 + Hardened Runtime 防.
 *
 * 检测项:
 *   1. Node 启动带 --inspect / --inspect-brk / --debug 类 flag
 *   2. process._debugPort 被打开 (运行时调试)
 *   3. NODE_OPTIONS 注入 --inspect (env 攻击面)
 *   4. (mac) DYLD_INSERT_LIBRARIES env 设了 → 怀疑被注入
 *
 * 命中:
 *   - dev 模式 / NEOX_SKIP_ANTI_DEBUG=1: 仅 audit log + warn, 不退出
 *   - 生产: audit log + warn + console.error. 退出 vs 继续由调用方决定 (传 strict=true 退).
 */

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

export type AntiDebugResult = {
  ok: boolean;
  hits: string[];
};

export function detectDebug(): AntiDebugResult {
  const hits: string[] = [];

  /* 1. execArgv */
  for (const a of process.execArgv || []) {
    if (/^--(inspect|debug)/.test(a)) hits.push(`execArgv:${a}`);
  }
  /* 2. _debugPort (runtime inspector attached) */
  if ((process as any)._debugPort && (process as any)._debugPort > 0) {
    hits.push(`_debugPort=${(process as any)._debugPort}`);
  }
  /* 3. NODE_OPTIONS env 注入 */
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (/--(inspect|debug)/.test(nodeOpts)) {
    hits.push(`NODE_OPTIONS:${nodeOpts.slice(0, 100)}`);
  }
  /* 4. mac dyld 注入 */
  if (process.platform === 'darwin') {
    const dyldInsert = process.env.DYLD_INSERT_LIBRARIES;
    if (dyldInsert) hits.push(`DYLD_INSERT_LIBRARIES:${dyldInsert.slice(0, 100)}`);
    const dyldInterpose = process.env.DYLD_INTERPOSE;
    if (dyldInterpose) hits.push(`DYLD_INTERPOSE`);
  }

  return { ok: hits.length === 0, hits };
}

/**
 * 启动期调一次. dev/test 模式只写 audit, 不退. 生产模式 + strict=true → 退.
 */
export function enforceAntiDebug(opts: { strict?: boolean } = {}): AntiDebugResult {
  if (process.env.NODE_ENV === 'development' || process.env.NEOX_SKIP_ANTI_DEBUG === '1') {
    return { ok: true, hits: [] };
  }
  const r = detectDebug();
  if (r.ok) {
    try { const { appendEntry } = _require('./auditLog.js'); void appendEntry('antidebug.clean', {}); } catch { /* ignore */ }
    return r;
  }
  /* 命中 */
  try {
    const { appendEntry } = _require('./auditLog.js');
    void appendEntry('antidebug.hit', { hits: r.hits });
  } catch { /* ignore */ }
  console.error('[antiDebug] suspicious flags detected:', r.hits);
  if (opts.strict) {
    console.error('[antiDebug] strict mode — exiting');
    process.exit(13);
  }
  return r;
}
