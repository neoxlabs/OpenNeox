/**
 * run_dev_server — 启动 dev server 并自动探到端口, 一步到位为 browser 验证 recipe 备料.
 *
 * 设计意图 (Browser 验证 recipe 的入口工具):
 *   agent 改完 UI/web 代码 → run_dev_server({command:'npm run dev'})
 *     → 返回 {pid, port, url, status, next}
 *     → 接着调 browser_navigate(url) + browser_get_console_logs / screenshot
 *   完整 recipe 见 verification-mandate.ts 的"Browser 验证 recipe"段.
 *
 * 相比直接 execute_shell(background=true):
 *   1. 自动复用: 已有同命令 bg 进程 → 直接返回它的 pid/port/url, 不再 spawn
 *   2. 自动探端口: poll probeListeningPort 直到拿到端口或超时, agent 不用自己再 sleep+probe
 *   3. 结构化输出: JSON {status, pid, port, url, next}, agent 一眼能接下一步
 *   4. recipe hint: next 字段直接告诉 agent 接下来该调什么 browser_* 工具
 *
 * 失败模式 (status 字段):
 *   started      新进程, port 探到, url 可用
 *   reused       命中已有 bg 进程, 直接返回它的 pid/port
 *   port_pending 进程在跑但 wait_seconds 内没探到端口 (慢启动 / 不监听 TCP 的任务)
 *   exited       启动后秒退 (EADDRINUSE / 配置错), 带 recentOutput 帮 agent 诊断
 *   error        spawn 本身失败
 */

import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { getToolServices, getToolLogger } from '../runtimeToolServices.js';
import { getWorkspaceRootFromContext } from '@neoxlabs/kernel/tools/workspaceContext.js';
import { getBackgroundTaskCallback } from './shellUiCallbacks.js';
import { runBackgroundShellCommand } from './backgroundShellExecution.js';
import { probeListeningPort, isLikelyLongRunningCommand } from '@neoxlabs/platform/platform/portProbe.js';

interface RunDevServerArgs {
  command: string;
  cwd?: string;
  /** 单端口期望值; 给了之后即使 probePort 失败, 也会回填 url=http://localhost:<port_hint>
   *  让 agent 至少能尝试 browser_navigate. 大多数 dev server (vite=5173/next=3000) 端口固定. */
  port_hint?: number;
  /** 探端口最长等待秒数. 默认 20s (vite/next 冷启动 5-10s, 大项目可能 15s+).
   *  超时不算失败 — 仍返 pid + port_pending, agent 可决定再等或换路径. */
  wait_seconds?: number;
}

interface RunDevServerResult {
  status: 'started' | 'reused' | 'port_pending' | 'exited' | 'error';
  pid?: number;
  port?: number;
  url?: string;
  command: string;
  message: string;
  /** 给 agent 的下一步 recipe hint — Browser 验证 recipe 的承接指令.
   *  恒为非空, 用于驱动 LLM 在 yield 前完成 browser 验证. */
  next: string;
  recentOutput?: string;
  exitCode?: number;
}

const DEFAULT_WAIT_SECONDS = 20;
const PROBE_INTERVAL_MS = 500;

function buildUrl(port: number): string {
  return `http://localhost:${port}`;
}

function nextHint(url: string | undefined, status: RunDevServerResult['status'], recentOutput?: string): string {
  if (status === 'exited' || status === 'error') {
    if (recentOutput && /EADDRINUSE|address already in use/i.test(recentOutput)) {
      return '端口被占 (EADDRINUSE). 下一步: service_scan() 找出占用该端口的进程 (返回 pid + 命令), 确认是旧实例残留就 bash_kill({pid}) 后再 run_dev_server; 是别的服务在用就换 port_hint. 不要不查直接重试同命令.';
    }
    return '进程未成功启动. 先读 recentOutput 找根因 (端口冲突 / 配置错 / 依赖缺); 修了再重试 run_dev_server, 别盲目重试同命令.';
  }
  if (!url) {
    return '进程在跑但没探到监听端口. 选项: (a) 用 port_hint 再调一次明确端口; (b) 这个任务不监听 TCP, 走 service_scan / bash_output 看状态; (c) 等几秒再 run_dev_server 复用判定走一次.';
  }
  return [
    `下一步 (Browser 验证 recipe):`,
    `  1. browser_navigate({ url: "${url}" })`,
    `  2. browser_wait_for({ selector: <你改的关键元素>, timeout: 5000 })  // 或 wait_for_navigation`,
    `  3. browser_get_console_logs()  // 必检, 红色 error 一律不能放过`,
    `  4. browser_screenshot()  // 截一张, 卡 yield 前给用户看`,
    `  5. 任一步失败 → 修代码, 重跑这套 recipe; 全过 → 才能 yield 并报"已验证通过".`,
  ].join('\n');
}

export const runDevServerTool: Tool = {
  name: 'run_dev_server',
  description: `Start a dev server or long-running process and automatically discover the port it listens on — one step that also prepares everything the Browser verification recipe needs.

WHEN TO USE:
- After changing UI / web / frontend / backend code, use this to start the service, then verify through the browser
- Better than execute_shell(background=true): this tool reuses an existing process, probes the port automatically and returns a structured URL
- If a dev server is already running it is detected and reused, so nothing is spawned twice (avoids EADDRINUSE)

Returns JSON {status, pid, port, url, message, next}:
- status='started'/'reused' → take url and call browser_navigate
- status='port_pending'    → the process is running but is not listening (worker/cron style), or is slow to start; see next
- status='exited'/'error'  → startup failed; recentOutput has the real stdout/stderr — fix and retry

The next field always carries the full Browser verification recipe. Follow it through before yielding; do not skip it.

Parameters:
- command (required)      command to run, e.g. "npm run dev" / "vite" / "uvicorn app:app --reload"
- cwd      (optional)     working directory to spawn in (defaults to the workspace root)
- port_hint (optional)    expected port (vite=5173 / next=3000 / cra=3000); used to build the URL if detection fails
- wait_seconds (optional) maximum seconds to wait while probing for the port (default 20)`,
  group: 'agent',
  resultType: 'contextual',
  parallelSafety: 'unsafe', /* 启动服务有 side effect, 别并发 */
  isReadOnly: false,
  aliases: ['start_dev_server', 'launch_dev', 'spawn_dev_server'],

  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command to run, e.g. "npm run dev" / "vite" / "uvicorn app:app --reload"',
      },
      cwd: {
        type: 'string',
        description: 'Working directory to spawn in (defaults to the workspace root)',
      },
      port_hint: {
        type: 'number',
        description: 'Expected port (vite=5173 / next=3000 / cra=3000). Used to build the URL if the port cannot be detected',
      },
      wait_seconds: {
        type: 'number',
        description: 'Maximum seconds to wait while probing for the port (default 20)',
      },
    },
    required: ['command'],
  },

  async function(args: RunDevServerArgs, context): Promise<string> {
    const services = getToolServices();
    const logger = getToolLogger();
    const command = String(args?.command ?? '').trim();
    if (!command) {
      return JSON.stringify({
        status: 'error',
        command: args?.command ?? '',
        message: 'command 不能为空',
        next: '提供 command 参数, e.g. "npm run dev"',
      } as RunDevServerResult);
    }

    /* workspaceRoot 通过 AsyncLocalStorage 注入 (runWithWorkspaceRoot), agent runner 包了一层.
     * fallback 顺序 (P1 cwd bug 修正): ALS → NEOX_WORKDIR (agentBridge.setWorkspace 会更新) → process.cwd().
     * process.cwd() 是 server 启动目录 (通常是开发者跑 bun run dev 的 Neox 根), 用户切到别的 workspace
     * 后如果 ALS 因 workspacePath 未透传而空, 走 process.cwd() 就会跑错项目 — 用 NEOX_WORKDIR 兜住. */
    const workspaceRoot = getWorkspaceRootFromContext() ?? process.env.NEOX_WORKDIR ?? process.cwd();
    const spawnCwd = args?.cwd ?? workspaceRoot;
    const waitMs = Math.max(1, args?.wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000;
    const portHint = args?.port_hint;

    /* Step 1: 复用判定 — 同命令的 background 进程已在跑就直接用 */
    const normalized = command.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '');
    const existing = services.processManager.getBackgroundRunning()
      .find(p => p.command.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '') === normalized);

    if (existing) {
      /* 端口可能 pm 已经探过(setPort), 也可能没探 — 缺就现场再探一次 */
      let port = (existing as any).port as number | undefined;
      if (!port) port = await probeListeningPort(existing.pid).catch(() => undefined);
      if (!port && portHint) port = portHint;
      const url = port ? buildUrl(port) : undefined;
      const status: RunDevServerResult['status'] = url ? 'reused' : 'port_pending';
      const result: RunDevServerResult = {
        status,
        pid: existing.pid,
        port,
        url,
        command,
        message: url
          ? `已有同命令进程 pid=${existing.pid} 监听 ${url}, 直接复用 (没有重新 spawn).`
          : `已有同命令进程 pid=${existing.pid} 在跑, 但没探到 TCP 监听端口.`,
        next: nextHint(url, status),
      };
      return JSON.stringify(result);
    }

    /* Step 2: spawn — 走标准 backgroundShellExecution, 让所有 bg 进程治理 (notifier / RunConfig
     * auto-bind / preamble) 都套上, 跟 execute_shell(background=true) 完全等价 */
    let startResult: string;
    try {
      startResult = await runBackgroundShellCommand({
        command,
        workspaceRoot,
        cwd: spawnCwd,
        shellOption: process.platform === 'win32' ? true : '/bin/bash',
        signal: context?.signal,
        services,
        logger,
        getBackgroundTaskCallback: () => getBackgroundTaskCallback(),
      });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      return JSON.stringify({
        status: 'error',
        command,
        message: `spawn 失败: ${message}`,
        next: nextHint(undefined, 'error'),
      } as RunDevServerResult);
    }

    /* runBackgroundShellCommand 返回的是给 LLM 看的文本, 不是结构化 — 我们要自己从 pm 找新增 pid.
     * 时间窗口里只可能多出 1 个 pid (我们 spawn 的), 拿最新加入的就行. */
    const allBg = services.processManager.getBackgroundRunning()
      .slice()
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
    const justSpawned = allBg.find(p => p.command.trim().replace(/\s+/g, ' ').replace(/\s*&\s*$/, '') === normalized);

    /* 没找到 pid → 大概率是秒退 (EADDRINUSE / 配置错), startResult 文本里有 stdout */
    if (!justSpawned) {
      return JSON.stringify({
        status: 'exited',
        command,
        message: '进程启动后立即退出, 详细 stdout/stderr 见 recentOutput.',
        recentOutput: startResult,
        next: nextHint(undefined, 'exited', startResult),
      } as RunDevServerResult);
    }

    const pid = justSpawned.pid;

    /* Step 3: 轮询探端口, 直到拿到 / 进程死 / 超时 */
    const deadline = Date.now() + waitMs;
    let port: number | undefined;
    let exited = false;
    while (Date.now() < deadline) {
      const tracked = services.processManager.get(pid);
      if (!tracked || tracked.status !== 'running') { exited = true; break; }
      /* pm 的 setPort 是异步 2s 后被 backgroundShellExecution 触发的, 这里再主动探一次,
       * 拿到就立刻退出循环, 不傻等. 探不到不是错误, 继续下一轮. */
      try {
        const p = await probeListeningPort(pid);
        if (p) { port = p; services.processManager.setPort(pid, p); break; }
      } catch { /* probe 失败照旧 retry */ }
      await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS));
    }

    if (exited) {
      const tracked = services.processManager.get(pid);
      const buf = tracked?.outputBuffer;
      const outputTail = (Array.isArray(buf) ? buf.join('') : buf ?? '').slice(-2000) || startResult;
      return JSON.stringify({
        status: 'exited',
        pid,
        command,
        message: '进程在端口探测期间退出. 见 recentOutput 找根因.',
        exitCode: tracked?.exitCode,
        recentOutput: outputTail,
        next: nextHint(undefined, 'exited', outputTail),
      } as RunDevServerResult);
    }

    /* 仍未探到端口时, 用 port_hint 兜底 — 部分 dev server (next dev) 启动初期端口绑定异步,
     * 但端口本身是固定的, 给 hint 就让 agent 至少能尝试 browser_navigate */
    if (!port && portHint) port = portHint;

    const url = port ? buildUrl(port) : undefined;
    const status: RunDevServerResult['status'] = url ? 'started' : 'port_pending';
    return JSON.stringify({
      status,
      pid,
      port,
      url,
      command,
      message: url
        ? `dev server 启动成功 pid=${pid}, 监听 ${url}.`
        : `dev server pid=${pid} 在跑, 但 ${args?.wait_seconds ?? DEFAULT_WAIT_SECONDS}s 内没探到 TCP 监听端口.`,
      next: nextHint(url, status),
    } as RunDevServerResult);
  },
};
