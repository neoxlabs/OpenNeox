
/** 崩溃类型: JS 层异常 / 原生崩溃 (下次启动补报) / 会话库打不开或损坏恢复 / 卡顿 (窗口未响应、主进程事件循环卡住)。 */
export type CrashKind = 'js' | 'native' | 'db' | 'hang';

/** 哪个宿主。 */
export type CrashApp = 'cli' | 'desktop';

/**
 * 进程角色: 主进程 / runtime worker (线程) / runtime 子进程 / 桌面渲染进程 / GPU / Utility。
 * renderer / gpu / utility 由 Electron 的 render-process-gone / child-process-gone 事件上报。
 */
export type CrashProcessRole = 'main' | 'worker' | 'process' | 'renderer' | 'gpu' | 'utility';

/**
 * 上报载荷 —— 字段名与云端契约一一对应, 别改名。
 * 可选字段序列化时自然消失 (JSON.stringify 丢 undefined), 服务端按缺省处理。
 */
export interface CrashReportPayload {
  kind: CrashKind;
  app: CrashApp;
  version: string;
  commit?: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  process: CrashProcessRole;
  exitCode?: number;
  signal?: string;
  /** ≤500 字, 已脱敏 */
  message: string;
  /** ≤40 帧, 已脱敏 (JS 层崩溃) */
  stack?: string[];
  /** ≤20 帧, `模块!符号` (原生崩溃) */
  nativeFrames?: string[];
  /** kind + 首个有意义栈帧的哈希 —— 本机限频与服务端归并都用它 */
  dedupeKey: string;
  /** ISO 时间 */
  occurredAt: string;
  /** 匿名安装 id (不是账号 id) */
  installId: string;
  /** 已登录时可带, 便于定位个别用户的连续崩溃 */
  userId?: string;
}

/** 硬上限 —— 上报体积、本机落盘量、限频窗口都在这。 */
export const CRASH_LIMITS = {
  /** message 截断长度 (字) */
  messageChars: 500,
  /** JS 栈最多保留的帧数 */
  stackFrames: 40,
  /** 原生栈最多保留的帧数 */
  nativeFrames: 20,
  /** 离线队列最多保留条数 */
  queueMaxFiles: 50,
  /** 离线队列最长保留时间 (7 天) */
  queueTtlMs: 7 * 24 * 60 * 60 * 1000,
  /** 同一 dedupeKey 一天内本机最多上报次数 */
  perDedupePerDay: 3,
  /** 限频窗口 (一天) */
  dedupeWindowMs: 24 * 60 * 60 * 1000,
} as const;
