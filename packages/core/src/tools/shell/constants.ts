/**
 * Shell execution constants are centralized so descriptions, messages, and
 * timeout logic share one source of truth.
 */

/** 秒级以内完成的命令 — agent 体感"同步返回"的边界。超过此阈值 UI 才开始显示 progress。 */
export const PROGRESS_THRESHOLD_MS = 2_000;

/** assistant 主线程响应性预算 — 超过此时长前台命令应该转后台,避免 agent 被 bash 卡住。 */
export const ASSISTANT_BLOCKING_BUDGET_MS = 15_000;

/**
 * 前台 bash 命令的默认兜底超时。agent 可以通过 timeout 参数覆写(不超过 BASH_MAX_TIMEOUT_MS)。
 * 注:这只是模块 export 的静态常量;**业务代码应调 `getBashDefaultTimeoutMs()` / `getBashMaxTimeoutMs()`**
 * 从 agentRuntimeConfig 走三级决策(env / config / default)
 */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;

/** 前台 bash 命令允许的最大超时(静态默认;读 config 请用 getBashMaxTimeoutMs)。 */
export const BASH_MAX_TIMEOUT_MS = 600_000;

/** 后台 bash 启动后收集前 N 秒输出再返回。 */
export const BACKGROUND_COLLECT_MS = 8_000;

/**
 * 长运行命令正则 — 没显式设 background=true 时,命中这些自动提升为 background。
 * 配合 shellCommandGuards.isAutoBackgroundAllowed 黑名单(sleep/vim/top 等)做最终决策。
 *
 * 设计原则:只放那些**不会误伤**的、典型意义上的长任务。
 * (npm test 故意没放 — 单测可短可长,agent 自己决策)
 */
export const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
  // dev / serve / watch
  /\bnpm\s+run\s+(dev|start|serve|watch)\b/,
  /\byarn\s+(dev|start|serve|watch)\b/,
  /\bpnpm\s+(dev|start|serve|watch)\b/,
  /\bnode\s+\S*server\b/,
  /\bnodemon\b/,
  /\bnext\s+dev\b/,
  /\bvite\b(?!.*build)/,
  /\btsc\s+(--watch|-w)\b/,
  /\btail\s+-f\b/,
  /\bdocker-compose\s+up\b(?!\s+.*-d)/,

  // Python servers
  /\buvicorn\b/,
  /\bgunicorn\b/,
  /\bflask\s+run\b/,
  /\bpython\s+.*manage\.py\s+runserver\b/,
];

/**
 * Install, build, test, and migrate commands run in the foreground with the
 * configured upper timeout because their completion result is useful to the
 * caller.
 */
export const LONG_FINITE_COMMAND_PATTERNS: RegExp[] = [
  // install / build — 单次跑但经常 >2min
  /\bnpm\s+(install|ci|update)\b(?!\s+(--help|-h))/,
  /\byarn\s+(install|add)\b/,
  /\bpnpm\s+(install|i|add|update)\b/,
  /\bnpm\s+run\s+build\b/,
  /\byarn\s+build\b/,
  /\bpnpm\s+build\b/,
  /\bcargo\s+(build|install|run|test)\b/,
  /\bgo\s+(build|install|mod\s+download|test)\b/,
  /\bmvn\s+(install|package|clean|compile|test)\b/,
  /\bgradle\s+(build|assemble|test)\b/,
  /\bpip\s+install\b/,
  /\bpoetry\s+install\b/,
  /\bdocker\s+build\b/,
  /\bdocker\s+compose\s+build\b/,
  /\bmake\b(?!\s+(help|-h|--help))/,

  // DB migrations
  /\bprisma\s+migrate\b/,
  /\bnpm\s+run\s+db:/,
];
