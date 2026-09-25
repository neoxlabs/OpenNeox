
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { profileCheckpoint } from '@neoxlabs/platform/utils/startup/profiler.js';
import { stopCapturingEarlyInput } from './earlyInputCapture.js';
import { getCliEdition } from '../edition/index.js';
import { NEOX_HOME_DIRNAME } from '@neoxlabs/kernel/platform/neoxHome.js';

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
  /** turn 硬超时秒数 (--timeout <seconds>), 默认 300 — in-process 与 daemon 两分支同用 */
  timeoutSeconds?: number;
  continueRequested?: string;
}

/**
 * 检测是否应进入 print 模式
 */
export function shouldUsePrintMode(args: string[]): boolean {
  return args.includes('-p') || args.includes('--print');
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
    } else if (arg === '--stream') {
      options.stream = true;
    } else if (arg === '--yolo' || arg === '--dangerously-skip-permissions') {
      options.yolo = true;
    } else if (arg === '--timeout' && rawArgs[i + 1]) {
      const secs = Number(rawArgs[++i]);
      if (Number.isFinite(secs) && secs > 0) options.timeoutSeconds = secs;
    } else if ((arg === '--workdir' || arg === '--dir' || arg === '-d') && rawArgs[i + 1]) {
      options.workDir = rawArgs[++i];
    } else if (arg === '-c' || arg === '--continue' || arg === '-r' || arg === '--resume') {
      options.continueRequested = arg;
      if ((arg === '-r' || arg === '--resume') && rawArgs[i + 1] && !rawArgs[i + 1].startsWith('-')) {
        i++;
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
    process.stderr.write(
      `Error: print mode (-p) does not support session continuation "${options.continueRequested}".\n` +
      `  print 模式每次都是独立会话, 不携带历史上下文。\n` +
      `  要多轮对话: 用交互模式 (neox -c / neox -r <id>), 或把需要的上文直接拼进本次 prompt。\n`,
    );
    return 2;
  }

  profileCheckpoint('print_mode_prompt_ready');

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

    /* ask_user 自动应答: 每题选第一个选项 (非交互的合理默认), 取不到就空 — best-effort, 不卡。 */
    const buildAutoAnswers = (questions: any[]): Record<string, string> => {
      const answers: Record<string, string> = {};
      for (const q of (questions ?? [])) {
        const key = q?.question ?? q?.header ?? q?.id ?? '';
        const first = q?.options?.[0];
        if (key) answers[key] = first?.value ?? first?.label ?? '';
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
          else process.stdout.write(chunk);
          streamedAny = true;
        }
      } else if (type === 'run_result') {
        finalOutput = d.output ?? d.currentTurnText ?? '';
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

    const timeoutSeconds = options.timeoutSeconds ?? 300;
    const timedOutMessage = `Error: print mode timed out after ${timeoutSeconds}s (use --timeout to raise)\n`;

    const account = getCliEdition().account;
    if (account) await account.prepareRouting();

    if (process.env.NEOX_USE_DAEMON !== '1' && !config.remoteServer?.url) {
      const deviceFp = account?.deviceFp() ?? '';
      const { LocalRuntimeAdapter } = await import('@neoxlabs/core/sdk/localRuntimeAdapter.js');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const adapter = new LocalRuntimeAdapter(workDir, join(homedir(), NEOX_HOME_DIRNAME), deviceFp, { oneShot: true });
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
      const timer = setTimeout(() => abort.abort(), timeoutSeconds * 1000);
      const chatPromise = adapter.chat({ sessionId, prompt, mode: 'agentic', providerId: options.provider, modelName: options.model } as any);
      try {
        await Promise.race([
          chatPromise,
          new Promise<never>((_, reject) => {
            abort.signal.addEventListener('abort', () => reject(new Error('print mode timeout')), { once: true });
          }),
        ]);
      } catch (err) {
        if (abort.signal.aborted) {
          chatPromise.catch(() => { /* 已超时放弃的 turn, 晚到的 rejection 不能变 unhandled */ });
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
      }
    } else {
      /* daemon 路径 (NEOX_USE_DAEMON=1 / remoteServer) —— 原 SSE 行为。 */
      const { NeoxClient } = await import('@neoxlabs/core/sdk/client.js');
      const { ensureServer } = await import('@neoxlabs/core/server/processManager.js');
      const connection = await ensureServer(workDir);
      profileCheckpoint('print_mode_server_ready');
      const client = new NeoxClient({
        baseUrl: `http://127.0.0.1:${connection.port}`,
        token: connection.authToken || config.remote?.token,
      });
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
          process.stderr.write(`[neox] 设置会话审批模式失败 (${err?.message ?? err}) — 继续以拒绝审批的方式保持只读\n`);
        }
      }
      await client.chat(sessionId, prompt, { modelName: options.model, providerId: options.provider });
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; done = true; ac.abort(); }, timeoutSeconds * 1000);
      while (!done) { await new Promise(r => setTimeout(r, 100)); }
      clearTimeout(timeout);
      sub.close();
      if (timedOut) {
        process.stderr.write(timedOutMessage);
        return 1;
      }
    }

    if (serverError) {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ result: bufferedText || null, error: serverError }) + '\n');
      }
      process.stderr.write(`Error: ${serverError}\n`);
      cliLogger.error('PRINT', `server error: ${serverError}`);
      return 1;
    }

    if (jsonMode) {
      const result = bufferedText || finalOutput || '';
      process.stdout.write(JSON.stringify({ result, error: null }) + '\n');
      profileCheckpoint('print_mode_done');
      return 0;
    }

    /* 流式没出过任何 text (例如纯 reasoning 模型最后一把吐, 或事件形态不一致) → 补印最终文本 */
    if (process.env.NEOX_PRINT_TRACE === '1') {
      process.stderr.write(`[TRACE] end streamedAny=${streamedAny} finalOutputLen=${(finalOutput ?? '').length}\n`);
    }
    if (!streamedAny && finalOutput) {
      process.stdout.write(finalOutput);
    }

    process.stdout.write('\n');

    profileCheckpoint('print_mode_done');
    return 0;
  } catch (error: any) {
    if (options.json === true) {
      process.stdout.write(JSON.stringify({ result: null, error: error.message }) + '\n');
    }
    process.stderr.write(`Error: ${error.message}\n`);
    cliLogger.error('PRINT', error.message, { stack: error.stack });
    return 1;
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
