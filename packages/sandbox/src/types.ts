/**
 * neox-sandbox — 解耦沙盒核心。
 *
 * 纯函数: (policy + 命令 + cwd) → spawn 规格。零 neox 依赖 (不 import config/runtime/logger),
 * 日志走注入的可选 onLog。做好、测好, 再由 shell adapter 接入。以后可原样抽成独立包。
 *
 * 四轴能力模型 (fs 读 / fs 写 / 网络 / 进程) + tier 预设 + 密钥护栏。
 * macOS: Seatbelt 参数化 profile (注入安全, 久经验证的基座白名单)。
 * Linux: bubblewrap 真 fs 隔离 (优先), 回落 unshare。
 * Windows: 阶段二 AppContainer（真 FS 隔离）/ 阶段一 restricted-token（Job）/ 直跑 cmd。
 */

/** 逻辑档位 —— 用户/模式选这个, 内部映射成 SandboxPolicy。 */
export type SandboxTier =
  | 'read-only'        // 只读: 读 all, 写 ∅, 网络 none。审查绝不改盘。
  | 'workspace-write'  // 默认: 读 all, 写 工作区+tmp+缓存, 网络 none。
  | 'workspace-net'    // workspace-write + 放开网络。
  | 'trusted';         // 完全放开 = 不沙盒 (显式解锁)。

/** 四轴能力策略 —— 后端把它翻译成 Seatbelt/bwrap 规则。 */
export interface SandboxPolicy {
  fs: {
    /** 读: 'all'(读无害, 且程序要读系统库/证书) 或限定 roots。默认 all。 */
    read: 'all' | { roots: string[] };
    /** 可写子树 (绝对路径)。工作区 + tmp + 包缓存。空 = 只读档。 */
    writeRoots: string[];
    /** 写内挖只读洞: 这些子路径即便落在某个 writeRoot 下也不可写 (护栏)。
     *  默认含 <ws>/.git、~/.ssh、~/.aws、~/.neox 等 —— 防 agent 偷改密钥/git 历史/沙盒逃逸。 */
    readOnlyWithin: string[];
  };
  net: SandboxNet;
  proc: { exec: boolean };
}

export type SandboxNet =
  | 'none'                       // 断网 (localhost 也断)。
  | 'localhost'                  // 只放 localhost (本地服务/代理)。
  | 'all';                       // 全放开。
  // v2: { proxyPort } —— 只放本地代理端口, 由代理做 domain allowlist。

/** 传给沙盒的一次执行。 */
export interface SandboxRun {
  command: string;
  cwd: string;
  /** shell, 默认按平台 (/bin/zsh | /bin/sh)。 */
  shell?: string;
}

/** 后端类型。 */
export type SandboxBackend =
  | 'seatbelt'
  | 'bwrap'
  | 'unshare'
  | 'appcontainer'
  | 'restricted-token'
  | 'none';

/** buildSandboxInvocation 的结果 —— 直接喂 child_process.spawn。 */
export interface SandboxInvocation {
  /** spawn 的程序 (sandbox-exec / bwrap / unshare / 或原 shell 若降级)。 */
  program: string;
  args: string[];
  /** 用了哪个后端。'none' = 未沙盒 (降级)。 */
  backend: SandboxBackend;
  /** 若降级/沙盒不可用, 原因 (上屏给用户)。 */
  degraded?: string;
  /** 清理临时 profile 文件等 (执行完调)。 */
  cleanup(): void;
}

/** 注入日志 (可选) —— 保持核心零 neox 耦合。 */
export type SandboxLogger = (level: 'debug' | 'info' | 'warn', msg: string) => void;

export interface SandboxOptions {
  logger?: SandboxLogger;
  /** 强制后端 (测试用); 不传自动探测。 */
  forceBackend?: SandboxBackend;
}
