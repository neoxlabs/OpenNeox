/**
 * 外部 Agent 执行器
 *
 *   一次委派的完整生命周期都在这里: 探测 → 隔离 → 起进程 → 流式 → 收尾。
 *   插件只提供命令行映射表, 下面这些一条都不归它管:
 *
 *     · **隔离**   worktree, 默认开。外部 agent 和主 agent 同时改一个仓库 =
 *                  互相覆盖, 靠插件作者自觉是不行的
 *     · **流式**   走 shellUiCallbacks 那条现成的通道, 用户看到的是正常的进度卡,
 *                  不是一坨事后才出现的 shell 输出
 *     · **中断**   context.signal → SIGTERM, 宽限期后 SIGKILL
 *     · **超时**   到点当中断处理, 已产出的内容照样返回
 *     · **环境**   只给点名的变量 + 最小集, 不把整个 process.env 倒过去 ——
 *                  那里面有我们自己的密钥
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/* stdio 固定 ['ignore','pipe','pipe'] —— 我们不给外部 agent 喂 stdin:
 * 一个在等交互输入的子进程会挂到超时, 而 timeline 上什么都看不出来。 */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;
import * as path from 'node:path';
import {
  EXTERNAL_AGENT_DEFAULT_TIMEOUT_MS,
  type PluginExternalAgentDefinition,
} from '@neoxlabs/platform/shared/plugin-external-agent.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { createStreamParser } from './streamParsers.js';
import { buildAgentEnv, probeEndpoint, readDefaultModel, readEndpoint, resolveLaunch } from './launchEnv.js';

export type DelegateOptions = {
  agent: PluginExternalAgentDefinition;
  pluginName: string;
  prompt: string;
  model?: string;
  workspaceRoot: string;
  /** 宿主给的 tool_use_id — 让流式事件的 toolId 跟 timeline 卡片对齐 */
  toolCallId?: string;
  signal?: AbortSignal;
  /** 每有一行进度就回调 (接 timeline) */
  onProgress?: (payload: {
    toolId: string;
    command: string;
    output: string;
    outputDelta?: string;
    elapsed: number;
    isComplete?: boolean;
    exitCode?: number;
  }) => void;
  /**
   * 把子进程登记进宿主的进程管理器 (服务面板 / pid / 停止按钮 / 日志)。
   *
   *   不接这个就会出现一个很怪的结果: 用 execute_shell 跑 codex 反而比用插件
   *   「集成得好」—— shell 那条路本来就登记, 服务面板里有卡、有 pid、能停;
   *   插件自己 spawn 就成了面板里看不见的孤儿进程。
   *
   *   由调用方注入而不是这里直接 import: plugins 层不该依赖 core 的 services 容器。
   */
  processTracker?: {
    register: (info: { pid: number; command: string; cwd: string; workspaceRoot: string; processRef?: unknown }) => void;
    appendOutput: (pid: number, text: string) => void;
    markCompleted: (pid: number, exitCode: number | null) => void;
  };
  /** worktree 钩子, 由调用方注入 (core 的 worktreeIsolation) */
  worktree?: {
    create: (workDir: string, agentId: string) => { path: string; branch: string } | null;
    cleanup: (info: any, workDir: string) => {
      hasChanges: boolean;
      changedFiles: string[];
      branch?: string;
      worktreePath?: string;
    };
  };
  /**
   * 前台等待上限。到点还没跑完就**脱手转后台**: promise 立刻 resolve 一个
   * detached 结果, 子进程继续跑, 完成时走 onFinished。
   *
   *   为什么要有这个: 派一个真活出去动辄十几分钟, 同步等着等于把主对话冻住。
   *   但短任务 (跑个测试、改一个文件) 又该内联返回 —— 让用户为了 20 秒的活
   *   多绕一次「去后台看看」也是坏体验。所以是「先前台等一会, 超时才转后台」,
   *   跟内置 agent 工具的 auto_background_ms 同一套语义。
   */
  autoBackgroundMs?: number;
  /** 转后台之后, 真正结束时回调 (只在 detached 之后触发) */
  onFinished?: (result: DelegateResult) => void;
  /** 便于测试注入 */
  spawnImpl?: typeof spawn;
};

export type DelegateResult = {
  ok: boolean;
  /** true = 前台等待超时已转后台, 这不是最终结果 */
  detached?: boolean;
  /** 外部 agent 的正文输出 */
  text: string;
  exitCode: number | null;
  /** 被中断 / 超时 */
  aborted?: boolean;
  timedOut?: boolean;
  /** 隔离产物 */
  worktree?: { path: string; branch: string; changedFiles: string[] };
  /** 观察到的工具调用统计 */
  toolCounts: Record<string, number>;
  error?: string;
  elapsedMs: number;
};

/** SIGTERM 之后给的收尾时间, 到点 SIGKILL */
const KILL_GRACE_MS = 5_000;
/** 单次委派回给模型的正文上限 — 再多也是噪音, 而且会撑爆上下文 */
const MAX_TEXT_CHARS = 60_000;

/**
 * 探测外部 CLI 装没装。
 *
 *   结果缓存在进程内: 每次委派都 spawn 一次 `--version` 是白白多一次进程启动,
 *   而用户在一次会话里装上/卸掉一个 CLI 的概率极低。
 */
const detectCache = new Map<string, { ok: boolean; version?: string; reason?: string; at: number }>();
const DETECT_TTL_MS = 5 * 60 * 1000;

export async function detectExternalAgent(
  agent: PluginExternalAgentDefinition,
  spawnImpl: typeof spawn = spawn,
): Promise<{ ok: boolean; version?: string; reason?: string }> {
  const cached = detectCache.get(agent.id);
  if (cached && Date.now() - cached.at < DETECT_TTL_MS) {
    return { ok: cached.ok, version: cached.version, reason: cached.reason };
  }

  /* 用跟真跑一样的环境和启动方式探测 —— 否则 dsh 这种「默认 node 太旧」的会被判成没装,
   * 或者反过来: 探测用了新 node 判成装好, 真跑却用旧 node 静默退出 */
  const env = buildAgentEnv(agent);
  const launch = resolveLaunch(agent, env);
  if (!launch.ok) {
    detectCache.set(agent.id, { ok: false, reason: launch.reason, at: Date.now() });
    return { ok: false, reason: launch.reason };
  }

  const result = await new Promise<{ ok: boolean; version?: string }>(resolve => {
    let child: PipedChild;
    try {
      child = spawnImpl(launch.file, [...launch.prefixArgs, ...agent.detect.args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: false,
      }) as unknown as PipedChild;
    } catch {
      resolve({ ok: false });
      return;
    }

    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    child.on('close', code => {
      clearTimeout(timer);
      const version = out.trim().split('\n')[0]?.slice(0, 80);
      resolve({ ok: code === 0 && !!version, version });
    });
  });

  detectCache.set(agent.id, { ...result, at: Date.now() });
  return result;
}

export function __resetDetectCache(): void {
  detectCache.clear();
}

/**
 * 建 argv。
 *
 *   占位符只整串替换 —— 校验器已经保证了这一点, 这里再依赖一次那个前提:
 *   `{{model}}` 没给值时**整条参数被丢掉**, 不是替换成空串。
 *   `--model ""` 在多数 CLI 上是非法值而不是「没传」。
 */
export function buildArgs(
  template: string[],
  scope: { prompt: string; model?: string; workdir: string },
): string[] {
  const out: string[] = [];
  for (const raw of template) {
    const m = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(raw);
    if (!m) { out.push(raw); continue; }

    const key = m[1] as 'prompt' | 'model' | 'workdir';
    const value = scope[key];
    if (value === undefined || value === '') {
      /* 丢掉占位符本身, 同时丢掉紧邻它的前一个 flag ——
       * `['--model', '{{model}}']` 少了值就必须整对消失 */
      const prev = out[out.length - 1];
      if (prev !== undefined && prev.startsWith('-')) out.pop();
      continue;
    }
    out.push(value);
  }
  return out;
}

export async function delegateToExternalAgent(opts: DelegateOptions): Promise<DelegateResult> {
  const {
    agent, pluginName, prompt, model, workspaceRoot,
    toolCallId, signal, onProgress, worktree,
    spawnImpl = spawn,
  } = opts;

  const startedAt = Date.now();
  const toolCounts: Record<string, number> = {};
  const toolId = toolCallId || `extagent_${agent.id}_${startedAt}`;
  const timeoutMs = agent.timeoutMs ?? EXTERNAL_AGENT_DEFAULT_TIMEOUT_MS;

  // ── 1. 探测 ──────────────────────────────────────────────────────────
  const detected = await detectExternalAgent(agent, spawnImpl);
  if (!detected.ok) {
    return {
      ok: false,
      text: '',
      exitCode: null,
      toolCounts,
      elapsedMs: Date.now() - startedAt,
      error: detected.reason
        ?? `未检测到 \`${agent.command}\`。${agent.detect.installHint.zh ?? agent.detect.installHint.en}`,
    };
  }

  /* 起得来吗 / 接口通吗 —— 必须在建 worktree **之前**判, 否则提前返回会留下一个没人清理的 worktree */
  const launch = resolveLaunch(agent, buildAgentEnv(agent));
  if (!launch.ok) {
    return { ok: false, text: '', exitCode: null, toolCounts, elapsedMs: Date.now() - startedAt, error: launch.reason };
  }
  /* 它配置的接口确定连不上就不起进程 (cline 连不上时一行不吐, 62 秒才报错) */
  const endpoint = readEndpoint(agent);
  const unreachable = endpoint ? await probeEndpoint(endpoint, buildAgentEnv(agent)) : null;
  if (unreachable) {
    return {
      ok: false, text: '', exitCode: null, toolCounts, elapsedMs: Date.now() - startedAt,
      error: `${unreachable}。改 ${agent.endpointFrom!.file} 里的地址，或先把那个服务开起来。`,
    };
  }

  // ── 2. 隔离 ──────────────────────────────────────────────────────────
  const wantsWorktree = (agent.isolation ?? 'worktree') === 'worktree';
  let worktreeInfo: any = null;
  let workdir = workspaceRoot;

  if (wantsWorktree && worktree) {
    worktreeInfo = worktree.create(workspaceRoot, `ext-${agent.id}`);
    if (worktreeInfo?.path) {
      workdir = worktreeInfo.path;
    } else {
      /* 不是 git 仓库 —— 说明白, 别让用户以为隔离生效了 */
      cliLogger.warn(
        'EXT_AGENT',
        `[${pluginName}] ${agent.id}: workspace is not a git repo, running without isolation`,
      );
    }
  }

  const env = buildAgentEnv(agent, workdir);
  /* 调用方没点名模型时, 用 CLI 配置里用户自己写的 (droid: 自定义模型不需要登录 Factory) */
  const effectiveModel = model || readDefaultModel(agent);
  const args = buildArgs(agent.argsTemplate, { prompt, model: effectiveModel, workdir });
  const commandLine = `${agent.command} ${args.map(a => (a.length > 60 ? `${a.slice(0, 57)}…` : a)).join(' ')}`;

  cliLogger.info('EXT_AGENT', `[${pluginName}] ${agent.id} → ${path.basename(workdir)} (${args.length} args${launch.note ? `, ${launch.note}` : ''}${effectiveModel && !model ? `, model=${effectiveModel}` : ''})`);

  // ── 3. 跑 ────────────────────────────────────────────────────────────
  const parser = createStreamParser(agent.streamFormat);
  let display = '';
  let text = '';
  let stderrTail = '';
  let aborted = false;
  let timedOut = false;
  /* 被外部信号杀掉 (用户从服务面板点了停止) —— 跟「进程没起来」是两回事,
   * 报错文案不能混, 否则用户自己点的停止会显示成一句莫名其妙的失败 */
  let killedSignal: string | null = null;
  let sawDone = false;
  let streamError: string | undefined;
  let fatalStopped = false;

  const emit = (delta: string, complete?: boolean, exitCode?: number) => {
    onProgress?.({
      toolId,
      command: commandLine,
      output: display,
      outputDelta: delta || undefined,
      elapsed: Math.round((Date.now() - startedAt) / 1000),
      isComplete: complete,
      exitCode,
    });
  };

  const runPromise = new Promise<number | null>(resolve => {
    let child: PipedChild;
    try {
      child = spawnImpl(launch.file, [...launch.prefixArgs, ...args], {
        cwd: workdir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        /* 绝不过 shell —— prompt 里有什么字符都只是内容 */
        shell: false,
      }) as unknown as PipedChild;
    } catch (err: any) {
      streamError = err?.message ?? 'spawn failed';
      resolve(null);
      return;
    }

    /* 登记进服务面板 —— 跟 execute_shell 后台跑的进程同一个货架 */
    if (child.pid) {
      try {
        opts.processTracker?.register({
          pid: child.pid,
          command: commandLine,
          cwd: workdir,
          workspaceRoot,
          processRef: child,
        });
      } catch { /* 面板登记失败不该拖垮真正的委派 */ }
    }

    let settled = false;
    const finish = (code: number | null) => {
      if (child.pid) {
        try { opts.processTracker?.markCompleted(child.pid, code); } catch { /* 同上 */ }
      }
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(code);
    };

    /* SIGTERM 给收尾机会 (外部 agent 通常要落盘/关会话), 到点再 SIGKILL */
    const hardKill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const stop = () => {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(hardKill, KILL_GRACE_MS).unref?.();
    };

    const onAbort = () => { aborted = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const timeoutTimer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timeoutTimer.unref?.();

    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;

        if (child.pid) {
          /* 服务面板的日志要的是原始行, 不是我解析后的摘要 —— 用户点开面板就是想看
           * 外部 agent 到底吐了什么 */
          try { opts.processTracker?.appendOutput(child.pid, `${line}\n`); } catch { /* ignore */ }
        }
        for (const ev of parser.feed(line)) {
          if (ev.toolName) toolCounts[ev.toolName] = (toolCounts[ev.toolName] ?? 0) + 1;
          if (ev.text) text = ev.replacesText ? ev.text : text + ev.text;
          if (ev.done) sawDone = true;
          if (ev.error) streamError = ev.error;
          /* 额度 / 鉴权这类重试不会好的错误: 立刻停, 原因原样交回 (不等它重连满 5 轮) */
          if (ev.fatal && !fatalStopped) {
            fatalStopped = true;
            streamError = ev.error?.replace(/^Reconnecting\.\.\.\s*\d+\/\d+\s*\(?/, '').replace(/\)$/, '') || streamError;
            stop();
          }
          if (ev.line) {
            const delta = `${ev.line}\n`;
            display += delta;
            emit(delta);
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      /* stderr 大多是进度噪音, 只留尾巴用于失败时解释原因 */
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      if (child.pid) {
        try { opts.processTracker?.appendOutput(child.pid, text); } catch { /* ignore */ }
      }
    });

    child.on('error', (err: any) => {
      streamError = err?.message ?? 'process error';
      finish(null);
    });
    child.on('close', (code, signal) => {
      if (signal && !aborted && !timedOut) killedSignal = String(signal);
      finish(code);
    });
  });

  // ── 4. 收尾 ──────────────────────────────────────────────────────────
  const finalize = (exitCode: number | null): DelegateResult => {
    let worktreeResult: DelegateResult['worktree'];
    if (worktreeInfo && worktree) {
      const cleaned = worktree.cleanup(worktreeInfo, workspaceRoot);
      if (cleaned.hasChanges) {
        worktreeResult = {
          path: cleaned.worktreePath ?? worktreeInfo.path,
          branch: cleaned.branch ?? worktreeInfo.branch,
          changedFiles: cleaned.changedFiles,
        };
      }
    }

    /* sawDone: 结构化事件明确说了「完成」。有些 CLI 完成后退出码非 0 (例如带
     * 警告), 有了这个信号就不必把它误判成失败。 */
    const ok = !aborted && !timedOut && !streamError && (exitCode === 0 || sawDone);
    /* 模型是宿主从 CLI 配置里替用户挑的 —— 失败时得说出来, 用户才知道去哪改 */
    if (!ok && streamError && effectiveModel && !model && agent.defaultModelFrom) {
      streamError += `（用的模型 ${effectiveModel} 取自 ${agent.defaultModelFrom.file}；换一个可用的自定义模型，或派活时点名模型）`;
    }
    emit('', true, exitCode ?? undefined);

    let finalText = text;
    if (finalText.length > MAX_TEXT_CHARS) {
      finalText = `${finalText.slice(0, MAX_TEXT_CHARS)}\n…(输出已截断)`;
    }
    /* 结构化事件一条没认出来时, 至少把展示流当正文 —— 总比返回空好 */
    if (!finalText.trim() && display.trim()) finalText = display;

    return {
      ok,
      text: finalText,
      exitCode,
      aborted: aborted || undefined,
      timedOut: timedOut || undefined,
      worktree: worktreeResult,
      toolCounts,
      elapsedMs: Date.now() - startedAt,
      error: ok
        ? undefined
        : streamError
          ?? (timedOut ? `超过 ${Math.round(timeoutMs / 60000)} 分钟上限, 已中止`
            : aborted ? '已被中断'
              : killedSignal ? `已被停止 (${killedSignal}) —— 从服务面板或外部终止`
                : exitCode === null ? '进程未能启动'
                : `退出码 ${exitCode}${stderrTail ? `: ${stderrTail.slice(-400)}` : ''}`),
    };
  };

  /* 前台等一会儿; 到点还没完就脱手转后台 —— 子进程继续跑, 完成时走 onFinished。
   * 见 DelegateOptions.autoBackgroundMs 的说明。 */
  const autoBg = opts.autoBackgroundMs ?? 0;
  if (autoBg > 0) {
    let detached = false;
    const finished = runPromise.then(code => {
      const result = finalize(code);
      if (detached) opts.onFinished?.(result);
      return result;
    });

    const raced = await Promise.race([
      finished,
      new Promise<'timeout'>(r => { setTimeout(() => r('timeout'), autoBg).unref?.(); }),
    ]);

    if (raced !== 'timeout') return raced;

    detached = true;
    cliLogger.info('EXT_AGENT', `[${pluginName}] ${agent.id} 转入后台 (前台等待 ${autoBg}ms 未完成)`);
    return {
      ok: true,
      detached: true,
      text: '',
      exitCode: null,
      toolCounts,
      elapsedMs: Date.now() - startedAt,
    };
  }

  return finalize(await runPromise);

}
