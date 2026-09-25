/**
 * Process Manager - 子进程追踪管理
 *
 * 功能：
 * - 追踪所有由 CLI 启动的子进程
 * - 提供进程列表、状态查询
 * - 支持单个/批量终止进程
 * - 退出时清理所有子进程
 */

import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { upsertInstance } from './serviceInstanceStore.js';
import { getAncestorPids, getDescendantPids, loadProcessTree, isPidAlive, normalizeWorkspaceRoot } from './processTree.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

const LOG_FILE_MAX_BYTES = 8 * 1024 * 1024;
const pendingLogWrites = new Map<string, string[]>();
let logFlushScheduled = false;
let flushInFlight = false;

const logFileSizes = new Map<string, number>();

function queueLogWrite(proc: TrackedProcess, text: string): void {
  const file = proc.logFilePath;
  if (!file) return;
  const buf = pendingLogWrites.get(file);
  if (buf) buf.push(text);
  else pendingLogWrites.set(file, [text]);
  if (logFlushScheduled) return;
  logFlushScheduled = true;
  setTimeout(() => { void flushLogWrites(); }, 0).unref?.();
}

async function flushLogWrites(): Promise<void> {
  logFlushScheduled = false;
  if (flushInFlight) {
    /* 上一批还在写 —— 重新排一次, 别并发写同一个 fd 把日志交错掉 */
    if (pendingLogWrites.size > 0) {
      logFlushScheduled = true;
      setTimeout(() => { void flushLogWrites(); }, 4).unref?.();
    }
    return;
  }
  flushInFlight = true;
  const batch = [...pendingLogWrites.entries()];
  pendingLogWrites.clear();
  try {
    for (const [file, chunks] of batch) {
      const text = chunks.join('');
      try {
        await fs.promises.appendFile(file, text, 'utf8');
        let size = logFileSizes.get(file);
        if (size === undefined) {
          size = (await fs.promises.stat(file)).size;
        } else {
          size += Buffer.byteLength(text, 'utf8');
        }
        logFileSizes.set(file, size);

        /* 超上限就砍掉前一半 —— 比按行 rotate 简单得多, 而且服务日志的价值集中在尾部 */
        if (size > LOG_FILE_MAX_BYTES) {
          const keepBytes = Math.floor(LOG_FILE_MAX_BYTES / 2);
          const fh = await fs.promises.open(file, 'r');
          const keep = Buffer.alloc(keepBytes);
          await fh.read(keep, 0, keepBytes, size - keepBytes);
          await fh.close();
          const header = `# … 前面的内容已因文件超过 ${Math.round(LOG_FILE_MAX_BYTES / 1024 / 1024)}MB 被截断 …\n`;
          await fs.promises.writeFile(file, header, { mode: 0o600 });
          await fs.promises.appendFile(file, keep);
          logFileSizes.set(file, Buffer.byteLength(header, 'utf8') + keepBytes);
        }
      } catch (err: any) {
        cliLogger.warn('PROCESS_MGR', `日志落盘失败, 停止对该文件写入: ${file} — ${err?.message}`);
      }
    }
  } finally {
    flushInFlight = false;
    /* 写这一批的期间又攒了新的 → 立刻排下一批 */
    if (pendingLogWrites.size > 0 && !logFlushScheduled) {
      logFlushScheduled = true;
      setTimeout(() => { void flushLogWrites(); }, 0).unref?.();
    }
  }
}

export interface TrackedProcess {
  pid: number;
  command: string;
  cwd: string;
  workspaceRoot: string;
  /**
   * 这个进程是 Neox 起的, 还是本来就在跑、被 service_adopt 纳管的.
   *
   * 唯一消费者是 killAllTracked (退出时清场): 不变量是 **"Neox 起的进程, Neox 负责关"**,
   * 而不是"凡是列表里的都杀" —— 用户自己在终端里起的 dev server 被 Neox 纳管只是为了
   * 能在面板里看到它, 关 Neox 时把它一起杀掉是越权的.
   *
   * register 时一次性写入, 之后永不变更 (它描述的是来源这个既成事实, 不是状态).
   */
  origin: 'spawned' | 'adopted';
  startTime: Date;
  status: 'running' | 'completed' | 'failed' | 'killed';
  exitCode?: number;
  endTime?: Date;
  background: boolean;
  // 可选：进程对象引用，用于更精细的控制
  processRef?: any;
  // 输出缓冲区（最近的 stdout/stderr 输出，ring buffer，仅供 LLM 快照）
  outputBuffer?: string[];
  /** 上一个 chunk 没以换行结尾 —— 下一个 chunk 的开头要接到最后一行上, 不是另起一行 */
  outputOpenLine?: boolean;
  // 全量输出落盘路径(~/.neox/tasks/<pid>-<startMs>.log)
  // 长跑命令(npm run dev, docker build)的输出可能远超 ring buffer 上限,
  // 落盘后 LLM 可以用 readfile 读取完整日志.
  logFilePath?: string;
  // ───── 服务治理元数据 (P0) ─────
  // name: 显示名. 默认从 command 推断 (e.g. "npm run dev" → "npm dev"),
  //   被 RunConfig adopt 后会被 RunConfig.name 覆盖.
  name?: string;
  // configId: 绑定到的 RunConfig.id. 一旦绑定就在 Services panel 显示为 Configured,
  //   否则显示为 Ad-hoc.
  configId?: string;
  // port: lsof / find-process 探测到的 LISTEN 端口. 起后 2s 异步扫一次, 5s 缓存.
  //   没探到就是 undefined (worker 类不监听端口的进程很正常).
  port?: number;
  // healthy: P2-2 healthcheck 周期检测结果. undefined = 未探测过 (没配 healthcheck).
  //   UI 据此显示 status pill: undefined → running 黄, true → healthy 绿, false → failed 红.
  healthy?: boolean;
  // healthCheckedAt: 最近一次健康探测时间戳, UI 显示"5s ago".
  healthCheckedAt?: number;
  // P3-3: 用户主动 stop 标记 — kill 时设, 进程退出后 autoRestart 不会触发.
  userKilled?: boolean;
  // 谁触发的 kill — UI Stop 按钮 / agent bash_kill tool / 其它系统行为.
  // BackgroundTaskNotifier 用这个让 agent 回复时分辨"是用户停的" vs "进程自己挂了":
  //   · 'user'   = 用户从 UI 点 Stop / 批量停止
  //   · 'agent'  = agent 调 bash_kill tool 主动停的
  //   · 'system' = onBeforeShutdown / auto-restart / OS OOM 等系统行为
  //   · undefined = 进程自己退出 (exit/crash), 没人调 kill
  terminatedBy?: 'user' | 'agent' | 'system';
  // P3-3: autoRestart 重启计数 (per process lifecycle).
  restartCount?: number;
  /* 进程种类 — Services 面板按这个字段过滤, 不靠 command 正则猜.
   *   · 'background-task' (默认): LLM execute_shell(background=true) / 用户起的服务进程,
   *     这些是"服务"语义, 应该出现在 Services 面板 + BackgroundTasksBar.
   *   · 'free-shell': 用户在 Services 面板 "新建 Shell 控制台" 起的纯交互 PTY
   *     (`exec /bin/zsh -i`), 是个 terminal session, 不是服务. 不进 Services 列表. */
  /* 'agent-task' = 派给外部 agent 的一次性任务: 会跑很久 (十几分钟) 但**不是服务**,
   * 不能只按时长判定, 否则服务面板会把它当长期服务摆着不走。 */
  kind?: 'background-task' | 'free-shell' | 'agent-task';
  /** 从 stdout 嗅探出的"真实启动类 / 服务身份" — Spring Boot 的 `Started GatewayApplication in N seconds`
   *  这类 banner 命中后, 比 command pattern 派生的 "Spring Boot" 更精确 (能区分多个 spring-boot 服务).
   *  优先级: configName > refinedName > command pattern > legacy displayName. */
  refinedName?: string;
}

/** Ring buffer 默认上限. npm run dev / webpack 启动期可能数千行, 500 不够用. */
const DEFAULT_RING_BUFFER_LINES = 5000;

/**
 * 从一段 stdout/stderr text 里嗅探"启动类名". 命中后返回该类名, 没命中返 null.
 *
 *   Spring Boot 启动 banner 格式: `Started <Class>Application in <N> seconds`
 *   IDEA Services panel 显示的"应用名"就是从这条 banner 抽出来的, 多个 spring-boot
 *   服务能区分开 (e.g. "GatewayApplication" / "UserApplication"), 比 command-derived
 *   的泛泛 "Spring Boot" 体验好得多.
 *
 *   设计:
 *     · 只扫一段 text, 命中第一个就返. 调用方负责"已 refined 就不再调"避免每 chunk 跑 regex.
 *     · 注意 banner 一定出现在 stdout, ANSI 颜色码可能嵌在中间, 但 .* 已经能跨过.
 *     · 也兼容 Spring Boot 3 的 `Started ... ApplicationKt` (Kotlin) 后缀.
 */
function detectStartupClassName(text: string): string | null {
  const m = text.match(/Started\s+([A-Z]\w+Application(?:Kt)?)\s+in\s+[\d.]+\s+seconds?/);
  if (m) return m[1];
  /* 可扩展: 加更多框架的 banner pattern. 不在此次范围. */
  return null;
}

/**
 * 从原始 command 推断一个简短可读的"显示名".
 *   "PORT=3000 NODE_ENV=dev npm run dev"  → "npm run dev"
 *   "/usr/bin/node ./server.js --watch"   → "node server.js"
 *   "mvn spring-boot:run -pl backend"     → "mvn spring-boot:run"
 * 给 UI / preamble 看, 不破坏原 command (那个用于精确匹配 RunConfig).
 */
function deriveDisplayName(command: string): string {
  if (!command) return '(unknown)';
  let s = command.trim();
  /* 砍掉首尾的 env prefix: VAR=value VAR2=value2 ... */
  s = s.replace(/^(?:\w+=\S+\s+)+/, '');
  /* 砍掉绝对路径里的目录部分 → 只留 binary 名 */
  s = s.replace(/^\/\S*\/([^/\s]+)/, '$1');
  /* 限长 + 去掉尾部空白 */
  if (s.length > 60) s = s.slice(0, 57) + '...';
  return s.trim();
}

/** 全量输出落盘根目录: ~/.neox/tasks/ */
function getTaskLogsDir(): string {
  return path.join(os.homedir(), NEOX_HOME_DIRNAME, 'tasks');
}

/** 确保落盘目录存在(失败不阻塞主流程, 落盘是 best-effort). */
function ensureLogsDir(): string | null {
  try {
    const dir = getTaskLogsDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 一次进程只清一次 (taskLogsCleanedAt 模块级标记, 避免重复扫盘)
    cleanupTaskLogsBestEffort(dir);
    return dir;
  } catch (err: any) {
    cliLogger.warn('PROCESS_MGR', 'Failed to create logs dir', { error: err?.message });
    return null;
  }
}

/**
 * 从盘上读某个 pid 的任务日志尾部。
 *
 * 文件名是 `<pid>-<startMs>.log` (startMs 就是为了防 pid 复用撞名)。给了 startTimeMs
 * 就精确定位; 没给就按 pid 前缀找**最新**的那个 —— 后者是 UI 只知道 pid 时的常见情形。
 */
function readTaskLogTail(pid: number, startTimeMs?: number, maxBytes = 256 * 1024): string | undefined {
  try {
    const dir = getTaskLogsDir();
    let file: string | undefined;
    if (startTimeMs !== undefined) {
      const candidate = path.join(dir, `${pid}-${startTimeMs}.log`);
      if (fs.existsSync(candidate)) file = candidate;
    }
    if (!file) {
      const prefix = `${pid}-`;
      const matches = fs.readdirSync(dir)
        .filter(n => n.startsWith(prefix) && n.endsWith('.log'))
        .sort();
      if (matches.length === 0) return undefined;
      file = path.join(dir, matches[matches.length - 1]);
    }
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    fs.closeSync(fd);
    return `# … 只显示最后 ${Math.round(maxBytes / 1024)}KB, 完整日志见 ${file} …\n` + buf.toString('utf8');
  } catch {
    return undefined;
  }
}

const TASK_LOG_RETENTION_DAYS = 7;
const TASK_LOG_MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200MB
let _taskLogsCleanedAt = 0;
function cleanupTaskLogsBestEffort(dir: string): void {
  // 一进程一小时内只清一次 — 减少 IO
  const now = Date.now();
  if (now - _taskLogsCleanedAt < 60 * 60 * 1000) return;
  _taskLogsCleanedAt = now;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoffTime = now - TASK_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const candidates: Array<{ fullPath: string; size: number; mtimeMs: number }> = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      // 仅处理 <pid>-<ms>.log 命名格式, 其它文件不动
      if (!/^\d+-\d+\.log$/.test(e.name)) continue;
      const fullPath = path.join(dir, e.name);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (stat.mtimeMs < cutoffTime) {
        try { fs.rmSync(fullPath, { force: true }); } catch {}
        continue;
      }
      candidates.push({ fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let totalSize = 0;
    for (const item of candidates) {
      totalSize += item.size;
      if (totalSize > TASK_LOG_MAX_TOTAL_BYTES) {
        try { fs.rmSync(item.fullPath, { force: true }); } catch {}
      }
    }
  } catch {
    // best effort
  }
}

export interface ProcessManagerEvents {
  'process:start': (process: TrackedProcess) => void;
  'process:exit': (process: TrackedProcess) => void;
  'process:kill': (process: TrackedProcess) => void;
  /** P2-1: 端口探测器在 setPort 时 emit, 用于 autoOpenSurface 联动. */
  'process:port-detected': (process: TrackedProcess) => void;
  /** P2-2: healthcheck 通过 / 失败时 emit, 用于 UI 状态指示. */
  'process:health-changed': (process: TrackedProcess, healthy: boolean) => void;
}

class ProcessManagerClass extends EventEmitter {
  private processes: Map<number, TrackedProcess> = new Map();
  private nextId: number = 1;

  /** 任何 mutator 末尾调一下, 同步 upsert 到 sqlite (better-sqlite3, <1ms).
   *  workspace_root 用 proc.cwd — 进程的工作目录通常就是 workspace root.
   *  db 不可用 (单测 / 工具脚本) 时 silent skip, 不影响 ProcessManager 正常运行. */
  private persist(proc: TrackedProcess): void {
    upsertInstance(proc, proc.workspaceRoot || proc.cwd);
  }

  /**
   * 注册一个新的子进程
   */
  register(options: {
    pid: number;
    command: string;
    cwd: string;
    /* 工程根 —— 服务归属的唯一依据 (见 TrackedProcess.workspaceRoot).
     * 不传时回落 cwd, 但所有生产调用点都该显式传, 否则子目录 spawn 会被记到错的工程下. */
    workspaceRoot?: string;
    /* 'adopted' = 进程本来就在跑, 只是被纳管 (service_adopt). 退出时不杀它. 默认 'spawned'. */
    origin?: 'spawned' | 'adopted';
    background: boolean;
    processRef?: any;
    /* 不传默认 'background-task' — 保持老调用兼容. free shell 入口必须显式传 'free-shell'. */
  /* 'agent-task' = 派给外部 agent 的一次性任务: 会跑很久 (十几分钟) 但**不是服务**,
   * 不能只按时长判定, 否则服务面板会把它当长期服务摆着不走。 */
  kind?: 'background-task' | 'free-shell' | 'agent-task';
  }): TrackedProcess {
    /* 父子去重: 若 options.pid 是某个已 tracked running 进程的后代 (任意深度)
     * → 直接返回那个祖先 record, 不重复注册.
     *
     *   场景: agent 起 `pnpm dev:antd` → pnpm 父被 timeout-adopted 注册 (PID P).
     *   pnpm 内部 spawn 出 `node ... vite` 子 (PID C). 第二次 shell adopt 流程
     *   (e.g. service_adopt / 又一次 execute_shell) 想注册 C → 这里检测到 C 的祖先链含 P,
     *   返 P 跳过. 这样 Services panel 只看到一个"pnpm: dev:antd"而不是"Node: vite + pnpm".
     *
     *   实现选择: 用 getAncestorPids(C) 反向查祖先 (单次 ps 顺链跑), 比对每个 tracked pid
     *   都 getDescendantPids 全树 BFS 高效得多 (服务面板常有 1-5 个 tracked 进程, ancestor
     *   链 ≤ 10 层, ps 走 ≤ 10 次即停).
     *
     *   重复注册自身 (相同 pid 又调一次 register) 也走这条短路 — 上层不该这么调, 但兜底.
     */
    if (options.pid > 0) {
      const existingSelf = this.processes.get(options.pid);
      if (existingSelf && existingSelf.status === 'running') {
        cliLogger.debug('PROCESS_MGR',
          `register PID=${options.pid} skipped — already tracked (cmd=${existingSelf.command.substring(0, 40)})`);
        return existingSelf;
      }
      const ancestors = getAncestorPids(options.pid);
      for (const ancestorPid of ancestors) {
        const ancestor = this.processes.get(ancestorPid);
        if (ancestor && ancestor.status === 'running') {
          cliLogger.info('PROCESS_MGR',
            `register PID=${options.pid} skipped — descendant of tracked PID=${ancestorPid} (${ancestor.command.substring(0, 40)})`);
          return ancestor;
        }
      }
    }

    const startTime = new Date();
    const process: TrackedProcess = {
      pid: options.pid,
      command: options.command,
      cwd: options.cwd,
      workspaceRoot: normalizeWorkspaceRoot(options.workspaceRoot || options.cwd),
      origin: options.origin ?? 'spawned',
      startTime,
      status: 'running',
      background: options.background,
      processRef: options.processRef,
      outputBuffer: [],
      kind: options.kind ?? 'background-task',
    };

    // 后台进程才落盘 — 前台进程是同步等待型, 输出已经在 result.stdout/stderr 里
    // 落盘文件名带 startMs 防 pid 复用碰撞
    if (options.background) {
      const dir = ensureLogsDir();
      if (dir) {
        const logFile = path.join(dir, `${options.pid}-${startTime.getTime()}.log`);
        process.logFilePath = logFile;
        try {
          // 写入 header 让 LLM / 用户读盘时知道上下文
          const header = `# bg task pid=${options.pid}\n# command: ${options.command}\n# cwd: ${options.cwd}\n# started: ${startTime.toISOString()}\n# ---\n`;
          fs.writeFileSync(logFile, header, { encoding: 'utf8', mode: 0o600 });
        } catch (err: any) {
          cliLogger.warn('PROCESS_MGR', 'Failed to init log file', { pid: options.pid, error: err?.message });
          process.logFilePath = undefined;
        }
      }
    }

    this.processes.set(options.pid, process);
    cliLogger.debug('PROCESS_MGR', `Registered process PID=${options.pid}`, {
      command: options.command.substring(0, 50),
      background: options.background,
      logFile: process.logFilePath,
    });

    this.persist(process);
    this.emit('process:start', process);
    return process;
  }

  markCompleted(pid: number, exitCode: number): void {
    const process = this.processes.get(pid);
    if (process) {
      process.status = exitCode === 0 ? 'completed' : 'failed';
      process.exitCode = exitCode;
      process.endTime = new Date();

      cliLogger.debug('PROCESS_MGR', `Process completed PID=${pid}`, {
        exitCode,
        duration: process.endTime.getTime() - process.startTime.getTime(),
      });

      this.persist(process);
      this.emit('process:exit', process);

      /* 5 分钟保留, 之后才彻底删 */
      setTimeout(() => {
        this.processes.delete(pid);
      }, 5 * 60 * 1000);
    }
  }

  markVanished(pid: number): void {
    const proc = this.processes.get(pid);
    if (!proc || proc.status !== 'running') return;
    proc.status = 'killed';
    proc.endTime = new Date();
    /* exitCode 故意不填 —— 不知道就是不知道, 别编一个 0 出来 */
    cliLogger.info('PROCESS_MGR', `PID=${pid} 已消失 (未收到退出事件), 标记为 killed`);
    this.persist(proc);
    this.emit('process:exit', proc);
    setTimeout(() => { this.processes.delete(pid); }, 5 * 60 * 1000).unref?.();
  }

  /**
   * 取最近 N 分钟内退出的进程 (status != running 且 endTime 在窗口内).
   * Services panel 用这个渲染"近况"区, 区别于 getBackgroundRunning() 的"运行中".
   */
  getRecentlyExited(withinMs: number = 5 * 60 * 1000): TrackedProcess[] {
    const now = Date.now();
    const out: TrackedProcess[] = [];
    for (const p of this.processes.values()) {
      if (p.status === 'running') continue;
      if (!p.endTime) continue;
      if (now - p.endTime.getTime() > withinMs) continue;
      out.push(p);
    }
    /* 最新退出的在前 */
    out.sort((a, b) => (b.endTime?.getTime() ?? 0) - (a.endTime?.getTime() ?? 0));
    return out;
  }

  /**
   * 取消注册进程（从追踪列表移除）
   */
  unregister(pid: number): void {
    const process = this.processes.get(pid);
    if (process) {
      this.processes.delete(pid);
      cliLogger.debug('PROCESS_MGR', `Unregistered process PID=${pid}`);
    }
  }

  /**
   * 获取所有正在运行的进程
   */
  getRunning(): TrackedProcess[] {
    return Array.from(this.processes.values()).filter(p => p.status === 'running');
  }

  /**
   * 获取所有后台运行的进程
   */
  getBackgroundRunning(): TrackedProcess[] {
    return Array.from(this.processes.values()).filter(
      p => p.status === 'running' && p.background
    );
  }

  /**
   * 获取所有进程（包括已完成的）
   */
  getAll(): TrackedProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * 获取最近的进程（按启动时间排序）
   */
  getRecent(limit: number = 10): TrackedProcess[] {
    return Array.from(this.processes.values())
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }

  /**
   * 根据 PID 获取进程
   */
  get(pid: number): TrackedProcess | undefined {
    return this.processes.get(pid);
  }

  /**
   * 服务治理元数据 setter — 设置 / 更新 name / configId / port / adoptable.
   *   - bindConfig: execute_shell normalize-match 到 RunConfig 时调
   *   - setPort: 端口探测器 (probeListeningPort) 找到 port 后调
   *   - setName: adopt 流程把 ad-hoc 升级为命名服务时调
   *   - markAdoptable: 启发判定到了"长服务"时调, UI 才显示 [adopt] 按钮
   * 失败 (pid 不存在) 静默 no-op, 不抛.
   */
  bindConfig(pid: number, configId: string, name?: string): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    proc.configId = configId;
    if (name) proc.name = name;
    this.persist(proc);
  }

  setName(pid: number, name: string): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    proc.name = name;
    this.persist(proc);
  }

  setPort(pid: number, port: number | undefined): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    const changed = proc.port !== port;
    proc.port = port;
    if (changed) this.persist(proc);
    /* P2-1: emit port-detected — main 进程 IPC bridge 据此触发 autoOpenSurface. */
    if (changed && port !== undefined) {
      this.emit('process:port-detected', proc);
    }
  }


  /** P2-2: healthcheck 探针通过/失败时, healthChecker 内部已 emit event, 同时调本方法写回. */
  setHealthy(pid: number, healthy: boolean): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    proc.healthy = healthy;
    proc.healthCheckedAt = Date.now();
    this.persist(proc);
  }

  /**
   * 按 configId 查所有绑定的活跃进程 (理论上正常情况只会有 1 个,
   * 出现 ≥2 说明前一次没清干净, 调用方应该 kill 老的).
   */
  findByConfigId(configId: string): TrackedProcess[] {
    const out: TrackedProcess[] = [];
    for (const p of this.processes.values()) {
      if (p.configId === configId && p.status === 'running') out.push(p);
    }
    return out;
  }

  /**
   * 按 command + cwd 严格匹配 (normalize 去空白后), 用于:
   *   1. execute_shell 起后自动 bind 到现有 RunConfig
   *   2. 检测重复启动 (同 cmd+cwd 已在跑 → 短路)
   */
  findByCommandCwd(command: string, cwd: string): TrackedProcess[] {
    const normalizeCommand = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '');
    const normCmd = normalizeCommand(command);
    const normCwd = cwd.replace(/\/+$/, '');
    const out: TrackedProcess[] = [];
    for (const p of this.processes.values()) {
      if (p.status !== 'running') continue;
      if (normalizeCommand(p.command) !== normCmd) continue;
      if (p.cwd.replace(/\/+$/, '') !== normCwd) continue;
      out.push(p);
    }
    return out;
  }

  /**
   * 按 port 查 (用于端口冲突诊断 — 谁占着这个端口?).
   * 只看 Neox 跟踪的进程, 外部进程要靠 lsof.
   */
  findByPort(port: number): TrackedProcess | undefined {
    for (const p of this.processes.values()) {
      if (p.status === 'running' && p.port === port) return p;
    }
    return undefined;
  }

  /**
   * 检查进程是否还在运行（通过发送信号0检测）
   */
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 刷新所有进程的状态（检查是否还活着）
   */
  refreshStatus(): void {
    for (const [pid, proc] of this.processes.entries()) {
      if (proc.status === 'running') {
        if (!this.isAlive(pid)) {
          proc.status = 'completed';
          proc.endTime = new Date();
          cliLogger.debug('PROCESS_MGR', `Process ${pid} is no longer alive, marked as completed`);
        }
      }
    }
  }

  /**
   * 终止指定进程
   * @param pid 进程ID
   * @param signal 信号类型，默认 SIGTERM
   * @param force 是否强制（SIGKILL）
   * @returns 是否成功发送信号
   */
  kill(
    pid: number,
    signal: NodeJS.Signals = 'SIGTERM',
    force: boolean = false,
    terminatedBy: 'user' | 'agent' | 'system' = 'system',
  ): boolean {
    const proc = this.processes.get(pid);

    try {
      // 首先尝试发送指定信号
      process.kill(pid, signal);
      cliLogger.info('PROCESS_MGR', `Sent ${signal} to process PID=${pid} (by=${terminatedBy})`);

      // 如果是强制模式，延迟后发送 SIGKILL
      if (force) {
        setTimeout(() => {
          try {
            if (this.isAlive(pid)) {
              process.kill(pid, 'SIGKILL');
              cliLogger.info('PROCESS_MGR', `Force killed process PID=${pid}`);
            }
          } catch {}
        }, 2000);
      }

      if (proc) {
        proc.status = 'killed';
        proc.endTime = new Date();
        proc.userKilled = true; /* P3-3: 阻止 autoRestart 后续触发 */
        proc.terminatedBy = terminatedBy;
        this.persist(proc);
        this.emit('process:kill', proc);
      }

      return true;
    } catch (error: any) {
      if (error.code === 'ESRCH') {
        // 进程不存在，更新状态
        if (proc) {
          proc.status = 'completed';
          proc.endTime = new Date();
          this.persist(proc);
        }
        cliLogger.debug('PROCESS_MGR', `Process ${pid} not found (already exited)`);
        return false;
      }
      cliLogger.error('PROCESS_MGR', `Failed to kill process ${pid}`, { error: error.message });
      return false;
    }
  }

  killProcessGroup(
    pid: number,
    signal: NodeJS.Signals = 'SIGTERM',
    terminatedBy: 'user' | 'agent' | 'system' = 'system',
  ): boolean {
    const descendants = getDescendantPids(pid);
    /* 倒序: 孙 → 子 → root, 让子进程先收到信号能做清理, 再传到父. */
    const orderedPids = [pid, ...descendants].reverse();

    let firstStageSent = 0;
    for (const p of orderedPids) {
      try {
        process.kill(p, signal);
        firstStageSent++;
      } catch { /* dead / 权限不够: 跳过 */ }
    }
    cliLogger.info('PROCESS_MGR',
      `killProcessGroup PID=${pid}: ${signal} (by=${terminatedBy}) → ${firstStageSent}/${orderedPids.length} pids (descendants=${descendants.length})`);

    const proc = this.processes.get(pid);
    if (proc) {
      proc.status = 'killed';
      proc.endTime = new Date();
      proc.userKilled = true; /* P3-3: 阻止 autoRestart 后续触发 */
      proc.terminatedBy = terminatedBy;
      this.persist(proc);
      this.emit('process:kill', proc);
    }

    /* 1.5s 后 SIGKILL 兜底, 抓 graceful 失败 / 卡死 / setsid 跳 group 的进程. */
    setTimeout(() => {
      let killedHard = 0;
      for (const p of orderedPids) {
        if (!isPidAlive(p)) continue;
        try {
          process.kill(p, 'SIGKILL');
          killedHard++;
        } catch { /* dead 了 */ }
      }
      if (killedHard > 0) {
        cliLogger.info('PROCESS_MGR',
          `killProcessGroup PID=${pid}: SIGKILL fallback → ${killedHard} pids still alive after 1.5s`);
      }
    }, 1500).unref?.();

    return firstStageSent > 0;
  }

  async killAllTracked(opts?: {
    /** 只清这个工程的进程; 不传 = 全清 (整个 app 退出) */
    workspaceRoot?: string;
    /** SIGTERM 到 SIGKILL 的宽限期, 默认 1.5s */
    graceMs?: number;
    terminatedBy?: 'user' | 'agent' | 'system';
  }): Promise<{ killed: number; skipped: number; hardKilled: number }> {
    const graceMs = opts?.graceMs ?? 1500;
    const terminatedBy = opts?.terminatedBy ?? 'system';
    const targetWs = opts?.workspaceRoot ? normalizeWorkspaceRoot(opts.workspaceRoot) : undefined;
    const targets: TrackedProcess[] = [];
    let skipped = 0;

    for (const proc of this.processes.values()) {
      if (proc.status !== 'running') continue;
      if (proc.origin === 'adopted') { skipped++; continue; }
      if (targetWs && proc.workspaceRoot !== targetWs) { skipped++; continue; }
      targets.push(proc);
    }
    if (targets.length === 0) {
      cliLogger.info('PROCESS_MGR', `killAllTracked: 无可清进程 (skipped=${skipped})`);
      return { killed: 0, skipped, hardKilled: 0 };
    }

    /* 先把整片进程树枚举完再发信号 —— 边杀边枚举会因为父进程先死而丢掉孤儿子进程. */
    const allPids: number[] = [];
    /* 整轮清场基于**同一张**进程树快照: 一次异步取表, N 个目标共享。
     * 既省掉 N-1 次 fork, 又拿到扫描该有的快照语义 (不会一个目标看到的树跟另一个不一致)。 */
    const tree = await loadProcessTree();
    for (const proc of targets) {
      const descendants = tree.descendantsOf(proc.pid);
      allPids.push(...[proc.pid, ...descendants].reverse());
    }

    for (const p of allPids) {
      try { process.kill(p, 'SIGTERM'); } catch { /* 已死 / 无权限 */ }
    }
    for (const proc of targets) {
      proc.status = 'killed';
      proc.endTime = new Date();
      proc.userKilled = true;
      proc.terminatedBy = terminatedBy;
      this.persist(proc);
      this.emit('process:kill', proc);
    }
    cliLogger.info('PROCESS_MGR',
      `killAllTracked: SIGTERM → ${targets.length} 个 tracked (含子孙共 ${allPids.length} pid), skipped=${skipped}`);

    await new Promise<void>((resolve) => { setTimeout(resolve, graceMs); });

    let hardKilled = 0;
    for (const p of allPids) {
      if (!isPidAlive(p)) continue;
      try { process.kill(p, 'SIGKILL'); hardKilled++; } catch { /* 已死 */ }
    }
    if (hardKilled > 0) {
      cliLogger.info('PROCESS_MGR', `killAllTracked: ${graceMs}ms 后仍存活 ${hardKilled} 个 pid, 已 SIGKILL`);
    }
    return { killed: targets.length, skipped, hardKilled };
  }

  /**
   * 终止所有正在运行的进程
   *
   * @deprecated 用 killAllTracked() —— 这个的 SIGKILL 兜底在调用方 process.exit() 前
   *   永远跑不到, 只能保证发出一发 SIGTERM. 留着仅为未迁移的 CLI 信号处理路径.
   */
  killAll(force: boolean = false): { killed: number; failed: number } {
    const running = this.getRunning();
    let killed = 0;
    let failed = 0;

    for (const proc of running) {
      // 后台进程尝试杀死整个进程组
      const success = proc.background
        ? this.killProcessGroup(proc.pid)
        : this.kill(proc.pid, 'SIGTERM', force);

      if (success) {
        killed++;
      } else {
        failed++;
      }
    }

    cliLogger.info('PROCESS_MGR', `Killed ${killed} processes, ${failed} failed`);
    return { killed, failed };
  }

  untrack(pid: number): boolean {
    return this.processes.delete(pid);
  }

  /**
   * 清理已完成的进程记录（保留最近N个）
   */
  cleanup(keepRecent: number = 20): number {
    const all = this.getAll();
    const completed = all.filter(p => p.status !== 'running');

    // 按结束时间排序，保留最近的
    completed.sort((a, b) => {
      const aTime = a.endTime?.getTime() || 0;
      const bTime = b.endTime?.getTime() || 0;
      return bTime - aTime;
    });

    let removed = 0;
    for (let i = keepRecent; i < completed.length; i++) {
      this.processes.delete(completed[i].pid);
      removed++;
    }

    return removed;
  }

  /**
   * 追加进程输出到缓冲区 + 落盘(若配置了 logFilePath)
   * @param pid 进程ID
   * @param text 输出文本
   * @param maxLines 最大保留行数，默认 5000(ring buffer 给 LLM 快照用,完整输出在 logFilePath)
   */
  appendOutput(pid: number, text: string, maxLines: number = DEFAULT_RING_BUFFER_LINES): void {
    const proc = this.processes.get(pid);
    if (!proc) return;

    if (!proc.outputBuffer) {
      proc.outputBuffer = [];
    }
    const lines = text.split('\n');
    const endsWithNewline = lines[lines.length - 1] === '';
    if (endsWithNewline) lines.pop();
    if (proc.outputOpenLine && proc.outputBuffer.length > 0 && lines.length > 0) {
      proc.outputBuffer[proc.outputBuffer.length - 1] += lines.shift()!;
    }
    proc.outputBuffer.push(...lines);
    if (lines.length > 0 || endsWithNewline) proc.outputOpenLine = !endsWithNewline;

    /* 启动 banner 嗅探 — 已经 refined 过就不再扫, 避免每个 chunk 反复 regex 跑 Spring Boot 后续 log.
     * 一旦命中 banner 拿到真实 class 名, refinedName 落地, 后续 BG_NOTIFIER / UI 拿到的就是
     * "GatewayApplication" 而不是泛泛的 "Spring Boot". */
    if (!proc.refinedName) {
      const refined = detectStartupClassName(text);
      if (refined) {
        proc.refinedName = refined;
        cliLogger.info('PROCESS_MGR', `pid=${pid} refinedName=${refined} (from stdout banner)`);
      }
    }
    // 限制缓冲区大小
    if (proc.outputBuffer.length > maxLines) {
      proc.outputBuffer = proc.outputBuffer.slice(-maxLines);
    }

    // 落盘(best-effort, 失败不影响主流程)
    if (proc.logFilePath) {
      queueLogWrite(proc, text);
    }
  }

  /** 取后台任务的全量日志文件路径(若进程是 foreground 或落盘失败则返回 undefined) */
  getLogFilePath(pid: number): string | undefined {
    return this.processes.get(pid)?.logFilePath;
  }

  /**
   * 获取进程的输出内容
   * @param pid 进程ID
   * @returns 输出文本，如果进程不存在返回空字符串
   */
  getOutput(pid: number): string {
    const proc = this.processes.get(pid);
    if (proc?.outputBuffer?.length) {
      return proc.outputBuffer.join('\n');
    }
    if (proc) {
      return readTaskLogTail(pid, proc.startTime?.getTime?.()) ?? readTaskLogTail(pid) ?? '';
    }
    return readTaskLogTail(pid) ?? '';
  }

  /**
   * 按 pid (+可选启动时刻) 读盘上的完整日志尾部。
   *
   * 只读**尾部**: 长跑服务的日志可能有几 MB, 而 xterm 只需要最后一屏往上翻的量,
   * 全量读进 renderer 是白白撑爆内存 (日志文件本身另有 8MB 上限, 见 flushLogWrites)。
   */
  readLogFromDisk(pid: number, startTimeMs?: number, maxBytes = 256 * 1024): string | undefined {
    return readTaskLogTail(pid, startTimeMs, maxBytes);
  }

  /**
   * 获取进程统计信息
   */
  getStats(): {
    total: number;
    running: number;
    backgroundRunning: number;
    completed: number;
    failed: number;
    killed: number;
  } {
    const all = this.getAll();
    return {
      total: all.length,
      running: all.filter(p => p.status === 'running').length,
      backgroundRunning: all.filter(p => p.status === 'running' && p.background).length,
      completed: all.filter(p => p.status === 'completed').length,
      failed: all.filter(p => p.status === 'failed').length,
      killed: all.filter(p => p.status === 'killed').length,
    };
  }

  /**
   * 格式化进程信息用于显示
   */
  formatProcess(proc: TrackedProcess): string {
    const duration = proc.endTime
      ? proc.endTime.getTime() - proc.startTime.getTime()
      : Date.now() - proc.startTime.getTime();

    const durationStr = this.formatDuration(duration);
    const statusIcon = this.getStatusIcon(proc.status);
    const bgIndicator = proc.background ? ' [BG]' : '';

    // 截断命令显示
    const cmdDisplay = proc.command.length > 40
      ? proc.command.substring(0, 37) + '...'
      : proc.command;

    return `${statusIcon} PID ${proc.pid}${bgIndicator} | ${cmdDisplay} | ${durationStr}`;
  }

  private getStatusIcon(status: TrackedProcess['status']): string {
    switch (status) {
      case 'running': return '🟢';
      case 'completed': return '✅';
      case 'failed': return '❌';
      case 'killed': return '🛑';
      default: return '⚪';
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }

  /**
   * P0-6: 服务状态 preamble — 只在状态 (pid/port/configId 集合) 变化时返回字符串,
   * 没变就返空串. 调用方拿到非空就 prepend 到 tool result 给 LLM, 不带就保持沉默.
   *   维护单一 lastServicesHash 字段, 进程级别. 多 session 共享 (我们没 sessionId 上下文).
   *   uptime 单调递增不进 hash, 不然每次必触发.
   */
  consumeServicesPreambleIfChanged(): string {
    const sig = this.computeServicesSig();
    if (sig === this.lastServicesHash) return '';
    this.lastServicesHash = sig;
    return this.formatServicesStatusLine();
  }

  private lastServicesHash: string = '';

  /** 不带状态的版本 — UI / 调试用. */
  servicesStatusLine(): string {
    return this.formatServicesStatusLine();
  }

  private computeServicesSig(): string {
    const running = this.getBackgroundRunning();
    const parts = running
      .map(p => `${p.pid}|${p.status}|${p.port ?? ''}|${p.configId ?? ''}|${p.name ?? ''}`)
      .sort();
    return parts.join(',');
  }

  private formatServicesStatusLine(): string {
    const running = this.getBackgroundRunning();
    if (running.length === 0) return '[services: none]';
    const parts: string[] = [];
    const configured = running.filter(p => p.configId);
    const adhoc = running.filter(p => !p.configId);
    for (const p of configured.slice(0, 5)) {
      const sec = Math.floor((Date.now() - p.startTime.getTime()) / 1000);
      const uptime = sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`;
      const port = p.port ? ` :${p.port}` : '';
      const label = p.name || p.configId;
      parts.push(`${label}${port}(${uptime})`);
    }
    if (adhoc.length > 0) parts.push(`${adhoc.length} adhoc`);
    return `[services: ${parts.join(' · ')}]`;
  }

  /**
   * 服务治理面向 LLM / UI 的统一摘要 — 一条进程的最小可读取信息.
   * 用于 bash_output / bash_kill / preamble 注入 / Services panel 渲染.
   */
  snapshotForDisplay(pid: number): {
    pid: number;
    command: string;
    display_name: string;
    cwd: string;
    status: TrackedProcess['status'];
    background: boolean;
    config_id?: string;
    port?: number;
    uptime_sec: number;
    healthy?: boolean;
    health_checked_at?: number;
  } | undefined {
    const p = this.processes.get(pid);
    if (!p) return undefined;
    return {
      pid: p.pid,
      command: p.command,
      display_name: p.name || deriveDisplayName(p.command),
      cwd: p.cwd,
      status: p.status,
      background: p.background,
      config_id: p.configId,
      port: p.port,
      uptime_sec: Math.floor((Date.now() - p.startTime.getTime()) / 1000),
      healthy: p.healthy,
      health_checked_at: p.healthCheckedAt,
    };
  }

  /**
   * 重置管理器（清除所有记录）
   */
  reset(): void {
    this.processes.clear();
    cliLogger.debug('PROCESS_MGR', 'Process manager reset');
  }
}

// 导出单例
export const processManager = new ProcessManagerClass();

export type TrackedProcessKind = 'background-task' | 'free-shell' | 'agent-task';
export type ProcessManager = ProcessManagerClass;
