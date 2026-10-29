
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { processManager } from '@neoxlabs/platform/platform/processManager.js';
import { profileCheckpoint } from '@neoxlabs/platform/utils/startup/profiler.js';
import { waitForPrintSettlement } from './printModeSettle.js';
import { getCapturedInput, isCapturing, stopCapturingEarlyInput } from './earlyInputCapture.js';
import { getCliEdition } from '../edition/index.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';
import { L } from '../i18n/index.js';
import { consumeRunPerf } from '../utils/turnPerf.js';
import {
  forcePlainColors,
  isPlainOutput,
  resolveOutputFormat,
  toPlainText,
  type CliOutputFormat,
} from './plainOutput.js';

export interface PrintModeOptions {
  prompt?: string;
  model?: string;
  provider?: string;
  json?: boolean;
  stream?: boolean;
  workDir?: string;
  /** 允许 mutation 工具 (写文件/执行命令) — 默认 false: print 模式只读, 对齐审计 P0
   *  "非交互自动批准全部审批" 的修复。--yolo / --dangerously-skip-permissions 开启。 */
  yolo?: boolean;
  /** turn 硬超时秒数 (--timeout <seconds>), 默认 1800 — in-process 与 daemon 两分支同用 */
  timeoutSeconds?: number;
  /** 最多跑几轮 (--max-turns <n>, 含首轮和后台通知补起的轮). 不传 = 只受 --timeout 约束;
   *  另外还有一条内部保险丝, 见 printModeSettle.MAX_CONTINUATION_TURNS。 */
  maxTurns?: number;
  continueRequested?: string;
  /** --resume 后面那个"长得像会话 id"的值 —— 只用于报错文案 (print 模式不支持续接) */
  resumeId?: string;
  /** --resume 后面那个**不像**会话 id 的值: 很可能用户把提示写在了 id 的位置, 保留原样给清楚的报错 */
  invalidResumeValue?: string;
  noSession?: boolean;
  /** CLI-11: 输出格式。`text` = 纯文本 (无 ANSI / TUI 控件), `json` = 等价 --json。
   *  不给时按 stdout 是否 TTY 决定: 管道 / 重定向 / CI 一律纯文本。 */
  outputFormat?: CliOutputFormat;
}

/**
 * 检测是否应进入 print 模式
 */
export function shouldUsePrintMode(args: string[]): boolean {
  return args.includes('-p') || args.includes('--print');
}

/**
 * 会话 id 的形状: 由 kernel 的 generateSessionId 生成 `session_YYYYMMDD_HHMMSS_xxxx`,
 * 另外兼容 uuid (旧版 / 桌面端可能直接给 uuid)。
 * @resume 的报错要靠它区分「这是 id」和「这是用户想发的提示」。
 */
const SESSION_ID_RE = /^(session_\d{8}_\d{6}_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function looksLikeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

export interface PipedPromptProbe {
  /** 测试注入用; 默认 process.stdin */
  stdin?: NodeJS.ReadStream;
  /** 测试注入用; 默认读取 early input capture 已收到的字节 */
  peek?: () => Buffer | null;
  /** 等第一个字节的上限 (ms)。echo 的字节几乎立刻就绪, 空管道 (< /dev/null) 不该拖住启动 */
  timeoutMs?: number;
}

export async function hasPipedPrompt(probe: PipedPromptProbe = {}): Promise<boolean> {
  const stdin = probe.stdin ?? process.stdin;
  if (!stdin || stdin.isTTY) return false;
  const peek = probe.peek ?? getCapturedInput;
  /* 真实路径下必须已经在做 early capture; 没在收字节就没法等 (注入 peek 时不受此限) */
  if (!probe.peek && !isCapturing()) return false;

  /* 不能"见到第一个字节就接管": 大一点的 prompt 会分几个 chunk 到, 早一步停手就被截断。
   * 等到数据安静下来 (写端不会再发) 或流结束再返回。 */
  const timeoutMs = probe.timeoutMs ?? 500;
  const quietMs = Math.min(60, timeoutMs);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const hasBytes = (): boolean => Boolean(peek()?.length);
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (deadline) clearTimeout(deadline);
      stdin.off?.('data', onData);
      stdin.off?.('end', onEnd);
      stdin.off?.('close', onEnd);
      resolve(value);
    };
    const check = (): void => finish(hasBytes());
    const armQuiet = (): void => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(check, quietMs);
    };
    const onData = (): void => armQuiet();
    const onEnd = (): void => check();
    deadline = setTimeout(check, timeoutMs);
    stdin.on?.('data', onData);
    stdin.on?.('end', onEnd);
    stdin.on?.('close', onEnd);
    /* 流在我们挂监听前就结束了 (小输入常常一拍里 data+end 连发) */
    if (stdin.readableEnded) check();
    else if (hasBytes()) armQuiet();
  });
}

/**
 * 检测是否为非交互模式（管道/SDK/非 TTY）
 */
export function isNonInteractive(): boolean {
  return (
    !process.stdout.isTTY ||
    !process.stdin.isTTY ||
    process.env.NEOX_NON_INTERACTIVE === '1'
  );
}

/**
 * 从参数中提取 print mode 选项
 */
export function parsePrintArgs(rawArgs: string[]): PrintModeOptions {
  const options: PrintModeOptions = {};
  const remaining: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '-p' || arg === '--print') continue; // skip flag itself
    if ((arg === '--model' || arg === '-m') && rawArgs[i + 1]) {
      options.model = rawArgs[++i];
    } else if ((arg === '--provider') && rawArgs[i + 1]) {
      options.provider = rawArgs[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--output-format' || arg.startsWith('--output-format=')) {
      /* CLI-11: `--output-format text` 强制纯文本 (管道里不留 ANSI), `json` 等价 --json。
       * 也接 `--output-format=text` 这种写法 —— 脚本里更常见。 */
      const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : rawArgs[++i];
      const fmt = resolveOutputFormat(raw);
      if (fmt) {
        options.outputFormat = fmt;
        if (fmt === 'json') options.json = true;
      } else {
        process.stderr.write(`Warning: unknown --output-format "${raw ?? ''}" (expected text|json) ignored\n`);
      }
    } else if (arg === '--stream') {
      options.stream = true;
    } else if (arg === '--yolo' || arg === '--dangerously-skip-permissions') {
      options.yolo = true;
    } else if (arg === '--no-session') {
      options.noSession = true;
    } else if (arg === '--lean') {
      process.env.NEOX_CONTEXT_PROFILE = 'lean';
    } else if (arg === '--timeout' && rawArgs[i + 1]) {
      const secs = Number(rawArgs[++i]);
      if (Number.isFinite(secs) && secs > 0) options.timeoutSeconds = secs;
    } else if (arg === '--max-turns' && rawArgs[i + 1]) {
      const turns = Number(rawArgs[++i]);
      if (Number.isInteger(turns) && turns > 0) options.maxTurns = turns;
    } else if ((arg === '--workdir' || arg === '--dir' || arg === '-d') && rawArgs[i + 1]) {
      options.workDir = rawArgs[++i];
    } else if (arg === '-c' || arg === '--continue' || arg === '-r' || arg === '--resume') {
      options.continueRequested = arg;
      if (arg === '-r' || arg === '--resume') {
        const next = rawArgs[i + 1];
        if (next && !next.startsWith('-')) {
          if (looksLikeSessionId(next)) {
            options.resumeId = next;
            i++;
          } else {
            options.invalidResumeValue = next;
          }
        }
      }
    } else if (!arg.startsWith('-')) {
      remaining.push(arg);
    } else {
      process.stderr.write(`Warning: unknown print-mode flag "${arg}" ignored (see neox --help)\n`);
    }
  }

  // 剩余参数拼接为 prompt
  if (remaining.length > 0) {
    options.prompt = remaining.join(' ');
  }

  return options;
}

/**
 * 执行 print mode — 最小化启动，直接查询
 */
export async function runPrintMode(options: PrintModeOptions): Promise<number> {
  profileCheckpoint('print_mode_start');

  // 读取管道输入（如果有）
  let prompt = options.prompt ?? '';
  const earlyInput = stopCapturingEarlyInput();
  if (earlyInput && earlyInput.length > 0) {
    const pipeText = earlyInput.toString('utf-8').trim();
    if (pipeText) {
      prompt = prompt ? `${prompt}\n\n${pipeText}` : pipeText;
    }
  }

  // 如果仍无 prompt，从 stdin 读取（阻塞）
  if (!prompt && !process.stdin.isTTY) {
    prompt = await readStdin();
  }

  if (!prompt) {
    process.stderr.write('Error: No prompt provided. Usage: neox -p "your question"\n');
    return 1;
  }

  /* print 模式不支持会话续接 (-c/-r): 每次 invocation 都是独立的一次性 session.
   * 明确报错并退出非 0, 而不是静默产出一个"忘了上文"的错误答案 (脚本里静默失败最坑人).
   * 需要多轮上下文: 用交互模式 `neox -c` / `neox -r`, 或把上文拼进同一个 prompt. */
  if (options.continueRequested) {
    /* 最常见的踩坑: 把提示写在 id 的位置 (`-p --resume hello`)。这时 hello 不是 id,
     * 我们不吞它, 但也不能让用户对着 ""No prompt provided"" 猜 —— 直接给正确写法。 */
    if (options.invalidResumeValue) {
      process.stderr.write(
        `Error: "${options.invalidResumeValue}" 不像会话 id —— print 模式续接要写成 ` +
          '`-p --resume <会话id> <提示>`。\n' +
          L(
            `  print 模式每次都是独立会话, 不携带历史上下文; 要多轮对话请用交互模式 (neox -r <id>)。\n`,
            `  Print mode runs each time as a separate session and does not carry over history; ` +
              `use interactive mode (neox -r <id>) for multi-turn chat.\n`,
          ),
      );
      return 2;
    }
    process.stderr.write(
      `Error: print mode (-p) does not support session continuation "${options.continueRequested}".\n` +
      L(
        `  print 模式每次都是独立会话, 不携带历史上下文。\n` +
          `  要多轮对话: 用交互模式 (neox -c / neox -r <id>), 或把需要的上文直接拼进本次 prompt。\n`,
        `  Print mode runs each time as a separate session and does not carry over history.\n` +
          `  For multi-turn chat, use interactive mode (neox -c / neox -r <id>), or put the needed context into this prompt.\n`,
      ),
    );
    return 2;
  }

  profileCheckpoint('print_mode_prompt_ready');

  let signalCleanup: (() => void) | null = null;
  const handlePrintSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    try { signalCleanup?.(); } catch { /* 清理失败也要退 */ }
    try { processManager.killAll(true); } catch { /* ignore */ }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onSigint = (): void => handlePrintSignal('SIGINT');
  const onSigterm = (): void => handlePrintSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  /* CLI-11: 管道 / 重定向 / CI 下 stdout 不是 TTY —— 一律纯文本, 不留 ANSI 与光标控制;
   * `--output-format text` 时哪怕 stdout 是 TTY 也按纯文本走 (给 `| tee` / 复制粘贴用)。
   * forcePlainColors 是为了 `FORCE_COLOR=1` 那类环境 (部分 CI 镜像会设) —— 否则下游
   * 模块用 chalk 拼的串仍会带转义码。
   *
   * 注意定义在 try 外面: 下面 catch 里的错误分支也要用它 (声明在 try 里会 ReferenceError)。 */
  const plainOutput = isPlainOutput(options.outputFormat);
  if (plainOutput) forcePlainColors();
  const writeStdout = (s: string): void => {
    process.stdout.write(plainOutput ? toPlainText(s) : s);
  };
  /* CLI-11: JSON 里也要干净 —— 转义码在 JSON.stringify 之后是 `\u001b` 这种字面量,
   * 写出去再剥已经来不及了 (消费方 JSON.parse 回来又是真 ESC), 所以先剥再序列化。 */
  const jsonSafe = (s: string): string => (plainOutput ? toPlainText(s) : s);

  try {
    // 懒加载：只加载必要模块
    const { loadConfig, setCurrentUserId } = await import('@neoxlabs/platform/utils/config.js');

    try {
      const userId = getCliEdition().account?.currentUserId();
      if (userId) setCurrentUserId(userId);
    } catch { /* 失败走匿名兜底, 后续 fallback 会 throw 清晰错 */ }

    const config = loadConfig();

    profileCheckpoint('print_mode_config_loaded');

    if (!options.provider || !options.model) {
      const { ProviderStore } = await import('@neoxlabs/platform/utils/providerStore.js');
      const store = new ProviderStore(config);
      const defaultProvider = store.getDefaultProvider();
      /* -m provider:模型 / 只给模型名 → 找对 provider (见 modelFlag.ts) */
      if (options.model && !options.provider) {
        const { resolveModelFlag } = await import('./modelFlag.js');
        const cloudModels = defaultProvider?.id === 'neox-cloud'
          ? getCliEdition().account?.managedChatModelIds() ?? []
          : [];
        const resolved = resolveModelFlag(options.model, store.getProviders(), defaultProvider?.id, cloudModels);
        options.model = resolved.model;
        if (resolved.provider) options.provider = resolved.provider;
      }
      if (!options.provider && defaultProvider?.id) {
        options.provider = defaultProvider.id;
      }
      if (!options.model) {
        /* lastSelectedModel 是用户最近 /model 选的, 比 defaultModel 更代表用户当前选择.
         * sentinel 'neox-cloud' 的 defaultModel 在 P3 同步逻辑落地后, lastSelectedModel
         * 也会被同步写到 sentinel.defaultModel. 这里两个都试. */
        const fromConfig = (defaultProvider as any)?.lastSelectedModel
          ?? defaultProvider?.defaultModel
          ?? defaultProvider?.models?.[0]?.name;
        if (fromConfig) {
          options.model = fromConfig;
        }
      }
      /* 严守: 此时如果还没 model → 用户没 setup default, fail-fast 给清晰错 */
      if (!options.model) {
        process.stderr.write('Error: No default model configured. Use --model <name> or run `neox` to set a default.\n');
        /* 新用户最常见的情况是一个 provider 都还没有 —— 直接告诉他怎么加 key */
        if (store.getProviders().length === 0) {
          process.stderr.write('  No API key yet: run `neox provider add`, or set an env var such as ANTHROPIC_API_KEY / OPENAI_API_KEY.\n');
        }
        return 1;
      }
      if (!options.provider) {
        process.stderr.write('Error: No default provider configured. Use --provider <id> or run `neox` to set a default.\n');
        return 1;
      }
      cliLogger.info('PRINT_MODE', `resolved defaults from config: provider=${options.provider} model=${options.model}`);
    }

    const workDir = options.workDir ?? process.cwd();
    const sessionId = `print-${Date.now()}`;

    // 流式输出状态
    let done = false;
    let serverError: string | null = null;
    let streamedAny = false;
    let finalOutput = '';
    const jsonMode = options.json === true;
    let bufferedText = '';
    /** 最后一轮 (可能是后台通知补起的轮) 的正文 — --json 只报它, 不掺中间过程 */
    let lastTurnText = '';

    const allowMutations = options.yolo === true;
    const forceReadOnly = !allowMutations;
    const daemonPath = process.env.NEOX_USE_DAEMON === '1' || !!config.remoteServer?.url;
    if (forceReadOnly && !daemonPath && !process.env.NEOX_FORCE_APPROVAL_MODE) {
      process.env.NEOX_FORCE_APPROVAL_MODE = 'manual';
    }
    let deniedNoticeShown = false;
    const denyNotice = () => {
      if (deniedNoticeShown) return;
      deniedNoticeShown = true;
      process.stderr.write(
        '\n[neox] Tool approval denied: print mode is read-only by default. ' +
        'Pass --yolo to allow file writes / shell commands.\n',
      );
    };
    let approveFn: (requestId: string) => void = () => {};
    let askUserFn: (requestId: string, questions: any[]) => void = () => {};

    const NO_ONE_ANSWERED =
      '(没有人回答: 这是非交互的 neox -p 运行, 用户不在场。不要把这当成同意 —— 删除文件、停掉不是你启动的进程这类要用户拍板的事不要做, 写进最终回复让用户决定; 其余按最稳妥、可撤回的做法继续。)';
    const buildAutoAnswers = (questions: any[]): Record<string, string> => {
      const answers: Record<string, string> = {};
      for (const q of (questions ?? [])) {
        const key = q?.question ?? q?.header ?? q?.id ?? '';
        if (key) answers[key] = NO_ONE_ANSWERED;
      }
      return answers;
    };

    /* 共享事件处理 — in-process (event 即 AgentRuntimeEvent 顶层字段) 与 daemon SSE (event.data)
     * 都归一到 (type, payload) 喂这里。历史 bug: runtime emit 'text'+.delta 而非 stream_delta+.text;
     * error 事件被漏听 → 死等 timeout。这里全兼容。 */
    const handleEvt = (type: string | undefined, d: any) => {
      if (process.env.NEOX_PRINT_TRACE === '1' && (type === 'text' || type === 'stream_delta' || type === 'run_result')) {
        process.stderr.write(`[TRACE] evt=${type} keys=${Object.keys(d ?? {}).join(',')} delta=${JSON.stringify((d?.delta ?? '').slice?.(0,20))} text=${JSON.stringify((d?.text ?? '').slice?.(0,20))} output=${JSON.stringify((d?.output ?? '').slice?.(0,20))}\n`);
      }
      const fromSubAgent = !!d.__subAgentMirror
        || (typeof d.sourceLabel === 'string' && d.sourceLabel !== 'Main')
        || !!d.taskAgentId;

      if ((type === 'text' || type === 'stream_delta') && !fromSubAgent) {
        const chunk = d.delta ?? d.text ?? '';
        if (chunk) {
          /* json 模式: buffer 到结束再输出单个 JSON, 不流式 (管道消费方要完整对象) */
          if (jsonMode) bufferedText += chunk;
          else writeStdout(chunk);
          streamedAny = true;
        }
      } else if (type === 'run_result') {
        /* 首字时间 (code:CLI-02): -p / 管道模式同样进 PERF 日志。子 agent 的 run_result 不是这一轮, 跳过 */
        if (!fromSubAgent) consumeRunPerf(d);
        finalOutput = d.output ?? d.currentTurnText ?? '';
        /* run_result = 这一轮结束。攒下的正文归这一轮, 下一轮从空 buffer 起 ——
         * --json 最终只输出最后一轮的回答。 */
        if (bufferedText) {
          lastTurnText = bufferedText;
          bufferedText = '';
        }
        done = true;
      } else if (type === 'error') {
        serverError = d.message ?? 'unknown server error';
        done = true;
      } else if (type === 'approval_needed') {
        if (d.requestId) approveFn(d.requestId);
      } else if (type === 'ask_user_needed') {
        if (d.requestId) askUserFn(d.requestId, d.questions ?? []);
      }
    };

    profileCheckpoint('print_mode_modules_loaded');

    const timeoutSeconds = options.timeoutSeconds;
    const timedOutMessage = `Error: print mode timed out after ${timeoutSeconds}s (use --timeout to raise)\n`;

    const account = getCliEdition().account;
    if (account) await account.prepareRouting();

    if (process.env.NEOX_USE_DAEMON !== '1' && !config.remoteServer?.url) {
      const deviceFp = account?.deviceFp() ?? '';
      const { LocalRuntimeAdapter } = await import('@neoxlabs/core/sdk/localRuntimeAdapter.js');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const adapter = new LocalRuntimeAdapter(workDir, join(homedir(), NEOX_HOME_DIRNAME), deviceFp, { oneShot: true, noAudioOutput: true });
      await adapter.connect();
      profileCheckpoint('print_mode_server_ready');
      const bridge = adapter.getBridge();
      approveFn = (rid) => {
        try {
          if (!allowMutations) denyNotice();
          bridge?.replyPermission(rid, allowMutations);
        } catch { /* ignore */ }
      };
      askUserFn = (rid, qs) => { try { void bridge?.replyAskUser?.(rid, buildAutoAnswers(qs)); } catch { /* ignore */ } };
      adapter.onEvent((event: any) => handleEvt(event?.type, event ?? {}));
      /* adapter.chat await 完整 turn; 事件期间已流出。完成即返回, 无需轮询。
       * in-process 分支原先无超时 — agent 卡死 = 进程永久挂, 加同款可配硬超时。 */
      const abort = new AbortController();
      const deadlineAt = timeoutSeconds ? Date.now() + timeoutSeconds * 1000 : undefined;
      const timer = timeoutSeconds ? setTimeout(() => abort.abort(), timeoutSeconds * 1000) : undefined;
      /* Ctrl+C / SIGTERM: 先叫停这一轮, 后台进程交给 handlePrintSignal 统一收 */
      signalCleanup = () => { abort.abort(); adapter.abort(sessionId); };
      const chatPromise = adapter.chat({ sessionId, prompt, mode: 'agentic', providerId: options.provider, modelName: options.model } as any);
      try {
        await Promise.race([
          chatPromise,
          new Promise<never>((_, reject) => {
            abort.signal.addEventListener('abort', () => reject(new Error('print mode timeout')), { once: true });
          }),
        ]);

        const settle = await waitForPrintSettlement({
          getState: () => adapter.getSessionWorkState(sessionId),
          signal: abort.signal,
          deadlineAt,
          maxTurns: options.maxTurns,
          onSample: (state) => {
            if (process.env.NEOX_PRINT_TRACE === '1') {
              process.stderr.write(`[TRACE] settle ${JSON.stringify(state)}\n`);
            }
          },
          onLimit: (reason) => {
            process.stderr.write(
              `Warning: print mode stopped waiting for background work (${reason === 'max_turns' ? '--max-turns reached' : 'too many background continuation turns'}); the task may be unfinished.\n`,
            );
          },
        });
        if (settle === 'aborted' || settle === 'timeout') {
          chatPromise.catch(() => { /* 已放弃的 turn, 晚到的 rejection 不能变 unhandled */ });
          adapter.abort(sessionId);
          await Promise.race([chatPromise.catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);
          process.stderr.write(timedOutMessage);
          return 1;
        }
        if (settle === 'turn_limit') return 1;
      } catch (err) {
        if (abort.signal.aborted) {
          chatPromise.catch(() => { /* 已超时放弃的 turn, 晚到的 rejection 不能变 unhandled */ });
          /* 光放弃 race 不够: 模型请求和正在跑的 shell 还在转, --no-session 又会在它活着时删库。
           * 先真叫停这一轮, 给它最多 3s 收尾 (取消请求 / 杀子进程), 再走 finally。 */
          adapter.abort(sessionId);
          await Promise.race([chatPromise.catch(() => {}), new Promise((r) => setTimeout(r, 3000).unref())]);
          process.stderr.write(timedOutMessage);
          return 1;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        /* chat() resolve 不代表事件已送达监听器 —— 转发循环是独立任务。
         * 先排空再 dispose, 否则最后一批 text / run_result 会被丢掉。 */
        await adapter.flushEvents();
        adapter.dispose();
        if (options.noSession) {
          try {
            const { sessionStore } = await import('@neoxlabs/core/platform/sessionStore.js');
            await sessionStore.deleteSessionTree(sessionId);
          } catch (err: any) {
            process.stderr.write(`Warning: --no-session could not remove session ${sessionId}: ${err?.message ?? err}\n`);
          }
        }
      }
    } else {
      /* daemon 路径 (NEOX_USE_DAEMON=1 / remoteServer) —— 原 SSE 行为。 */
      if (options.noSession) {
        process.stderr.write('Warning: --no-session is not supported when connected to a daemon / remote server; this run will be saved.\n');
      }
      const { NeoxClient } = await import('@neoxlabs/core/sdk/client.js');
      const { ensureServer } = await import('@neoxlabs/core/server/processManager.js');
      const connection = await ensureServer(workDir);
      profileCheckpoint('print_mode_server_ready');
      const client = new NeoxClient({
        baseUrl: `http://127.0.0.1:${connection.port}`,
        token: connection.authToken || config.remote?.token,
      });
      /* Ctrl+C / SIGTERM: daemon 里那一轮跑在别的进程, 只能叫它停 */
      signalCleanup = () => { void client.abort(sessionId).catch(() => { /* daemon 已不可达 */ }); };
      approveFn = (rid) => {
        if (!allowMutations) denyNotice();
        void client.replyPermission(rid, allowMutations).catch(() => { /* ignore */ });
      };
      askUserFn = (rid, qs) => { void client.replyAskUser(rid, buildAutoAnswers(qs)).catch(() => { /* ignore */ }); };
      const ac = new AbortController();
      const sub = await client.subscribe(
        (event: any) => {
          handleEvt(event.type, event.data || {});
          if (event.type === 'run_result' || event.type === 'error') ac.abort();
        },
        sessionId,
        ac.signal,
      );
      if (forceReadOnly) {
        try {
          await client.setApprovalMode(sessionId, 'manual', { scope: 'agent', scopeKey: sessionId });
        } catch (err: any) {
          process.stderr.write(`[neox] ${L(
            `设置会话审批模式失败 (${err?.message ?? err}) — 继续以拒绝审批的方式保持只读`,
            `Failed to set the session approval mode (${err?.message ?? err}) — staying read-only by denying approvals`,
          )}\n`);
        }
      }
      await client.chat(sessionId, prompt, { modelName: options.model, providerId: options.provider });
      let timedOut = false;
      const timeout = timeoutSeconds
        ? setTimeout(() => { timedOut = true; done = true; ac.abort(); }, timeoutSeconds * 1000)
        : undefined;
      while (!done) { await new Promise(r => setTimeout(r, 100)); }
      clearTimeout(timeout);
      sub.close();
      if (timedOut) {
        /* 断开 SSE 只是本端不听了; daemon 里那一轮会一直跑下去 (烧 token / 跑工具)。叫停它。 */
        await client.abort(sessionId).catch(() => { /* daemon 已不可达 */ });
        process.stderr.write(timedOutMessage);
        return 1;
      }
    }

    if (serverError) {
      if (jsonMode) {
        writeStdout(JSON.stringify({ result: jsonSafe(bufferedText) || null, error: serverError }) + '\n');
      }
      process.stderr.write(`Error: ${serverError}\n`);
      cliLogger.error('PRINT', `server error: ${serverError}`);
      return 1;
    }

    if (jsonMode) {
      /* 多轮 (后台通知补起的轮) 时只报最后一轮的回答: 中间那些「我先在后台跑…」的
       * 过程文本不该混进最终结果。单轮时 lastTurnText 就是全部正文。 */
      const result = lastTurnText || bufferedText || finalOutput || '';
      writeStdout(JSON.stringify({ result: jsonSafe(result), error: null }) + '\n');
      profileCheckpoint('print_mode_done');
      return 0;
    }

    /* 流式没出过任何 text (例如纯 reasoning 模型最后一把吐, 或事件形态不一致) → 补印最终文本 */
    if (process.env.NEOX_PRINT_TRACE === '1') {
      process.stderr.write(`[TRACE] end streamedAny=${streamedAny} finalOutputLen=${(finalOutput ?? '').length}\n`);
    }
    if (!streamedAny && finalOutput) {
      writeStdout(finalOutput);
    }

    writeStdout('\n');

    profileCheckpoint('print_mode_done');
    return 0;
  } catch (error: any) {
    if (options.json === true) {
      writeStdout(JSON.stringify({ result: null, error: error.message }) + '\n');
    }
    process.stderr.write(`Error: ${error.message}\n`);
    cliLogger.error('PRINT', error.message, { stack: error.stack });
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

/**
 * 从 stdin 读取全部输入
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    });
    // 5s 超时
    setTimeout(() => {
      resolve(Buffer.concat(chunks).toString('utf-8').trim());
    }, 5000);
  });
}
