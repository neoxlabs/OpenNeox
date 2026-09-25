/**
 * 收尾验证闸
 *
 * 采用 兼容格式 的 "跑到绿才停"。 这不是把 删掉的 VERIFY GATE 抄回来 ——
 * 那一版死于**用关键词猜任务意图**, 把只读/分析任务也逼着跑测试, 每次白烧 3 轮。
 *
 * 现在只认硬信号, 一个都不猜:
 *   · runMutationCount > 0  (runner 按成功的 mutation 工具计)
 *   · 项目真的有 testCommand
 *   · 本 run 还没跑过 run_tests / run_lint
 * 连续 2 次不听就 bailout 放行 —— 卡住用户比留个红更糟。
 *
 * 这里直接测 buildRunner 装出来的 gate 行为 (通过一个最小 runner stub 捕获注入的 gate)。
 * 末尾一组测的是 Jev 收尾判定闸 (其余闸都放行时, 拦「说了下一步就停」)。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 捕获 buildRunner 传给 StreamedRunner 的 options —— 不真起 runner */
const captured: { opts?: any } = {};
vi.mock('@neoxlabs/kernel/core/runner.js', () => ({
  StreamedRunner: class {
    constructor(opts: any) { captured.opts = opts; }
  },
}));

/* 所有强制续跑（包括验证闸）受 agentRuntime.autoContinue 控制，默认关闭；
 * 测试显式开启它以验证闸行为，并保留默认值断言。 */
let cfg: any = { agentRuntime: { autoContinue: 'on' } };
vi.mock('@neoxlabs/platform/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadConfig: () => cfg,
}));

/* Jev 不发真请求: 判定结果由用例指定 */
const judge = vi.fn();
vi.mock('../jev/jevTurnCompletion.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  judgeUnfinished: (...args: unknown[]) => judge(...args),
}));

const { buildRunner } = await import('../runtimeBuilder.js');

type GateCtx = {
  reason: 'no_tool_exit';
  iteration: number;
  consecutiveBlocks: number;
  runMutationCount: number;
  ranVerifyTool: boolean;
  task: string;
  finalText: string;
  totalToolCalls: number;
};
type Gate = (c: GateCtx) => Promise<{ shouldContinue: boolean; message?: string; kind?: string }>;

function makeWorkspace(withTests: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-verify-gate-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: withTests ? { test: 'vitest run' } : { build: 'tsc' } }),
  );
  return dir;
}

function gateFor(workspacePath: string | undefined): Gate {
  captured.opts = undefined;
  buildRunner({
    llmProvider: {} as any,
    model: 'test-model',
    tools: [],
    memory: {} as any,
    config: {} as any,
    workspacePath,
  } as any);
  return captured.opts?.loopContinuationGate as Gate;
}

const ctx = (over: Partial<GateCtx> = {}): GateCtx => ({
  reason: 'no_tool_exit',
  iteration: 3,
  consecutiveBlocks: 0,
  runMutationCount: 2,
  ranVerifyTool: false,
  task: '',
  finalText: '',
  totalToolCalls: 0,
  ...over,
});

let wsWithTests: string;
let wsNoTests: string;
beforeEach(() => {
  wsWithTests = makeWorkspace(true);
  wsNoTests = makeWorkspace(false);
});

describe('收尾验证闸', () => {
  it('改过文件 + 项目有测试 + 没跑过 → 拦一次并要求跑测试', async () => {
    const gate = gateFor(wsWithTests);
    const d = await gate(ctx());
    expect(d.shouldContinue).toBe(true);
    expect(d.message).toMatch(/test|测试/i);
  });

  it('纯只读 run (零 mutation) → 绝不拦 (旧 VERIFY GATE 正是死在这)', async () => {
    const gate = gateFor(wsWithTests);
    expect((await gate(ctx({ runMutationCount: 0 }))).shouldContinue).toBe(false);
  });

  it('已经跑过测试 → 不拦', async () => {
    const gate = gateFor(wsWithTests);
    expect((await gate(ctx({ ranVerifyTool: true }))).shouldContinue).toBe(false);
  });

  it('项目没有测试命令 → 不拦 (无从验证)', async () => {
    const gate = gateFor(wsNoTests);
    expect((await gate(ctx())).shouldContinue).toBe(false);
  });

  it('没有 workspacePath → 不拦 (不猜 cwd, 拿错目录比不拦更糟)', async () => {
    const gate = gateFor(undefined);
    expect((await gate(ctx())).shouldContinue).toBe(false);
  });

  it('默认配置 (autoContinue 未开) → 一律不拦, 强制续跑整类行为默认关', async () => {
    const prev = cfg;
    cfg = {};
    try {
      const gate = gateFor(wsWithTests);
      expect((await gate(ctx())).shouldContinue).toBe(false);
    } finally { cfg = prev; }
  });

  it('连提醒 2 次仍不跑 → bailout 放行, 不跟模型死磕', async () => {
    const gate = gateFor(wsWithTests);
    expect((await gate(ctx())).shouldContinue).toBe(true);   // 1
    expect((await gate(ctx())).shouldContinue).toBe(true);   // 2
    expect((await gate(ctx())).shouldContinue).toBe(false);  // bailout
    expect((await gate(ctx())).shouldContinue).toBe(false);
  });
});

describe('Jev 收尾判定闸', () => {
  const jevCfg = { experimental: { jev: { enabled: true, apiKey: 'k' } } };
  const stopped = ctx({ runMutationCount: 0, totalToolCalls: 3, task: '修一下路由', finalText: '接下来我去改 router.ts。' });
  const unfinished = { announced: 0.97, hold: 0.05, ms: 400 };

  beforeEach(() => {
    judge.mockReset();
    cfg = jevCfg;
  });

  it('只宣布了下一步就停 → 拦一次, kind=unfinished; 用户任务一并交给 Jev', async () => {
    judge.mockResolvedValue(unfinished);
    const d = await gateFor(wsNoTests)(stopped);
    expect(d).toMatchObject({ shouldContinue: true, kind: 'unfinished' });
    expect(judge.mock.calls[0].slice(1)).toEqual(['修一下路由', '接下来我去改 router.ts。']);
  });

  it('Jev 判是正常收尾 → 放行', async () => {
    judge.mockResolvedValue({ announced: 0.1, hold: 0.05, ms: 400 });
    expect((await gateFor(wsNoTests)(stopped)).shouldContinue).toBe(false);
  });

  it('用户只要计划 / 让它先停 → 宣布了下一步也放行', async () => {
    judge.mockResolvedValue({ announced: 0.97, hold: 0.9, ms: 400 });
    expect((await gateFor(wsNoTests)(stopped)).shouldContinue).toBe(false);
  });

  it('纯问答 / 长篇结果 / 问用户 / 没开 Jev → 一次都不问', async () => {
    const gate = gateFor(wsNoTests);
    await gate({ ...stopped, totalToolCalls: 0 });
    await gate({ ...stopped, finalText: '结果如下: '.padEnd(500, '啊') });
    await gate({ ...stopped, finalText: '方案 A 还是 B, 你选哪个?' });
    cfg = {};
    await gateFor(wsNoTests)(stopped);
    expect(judge).not.toHaveBeenCalled();
  });

  it('同一次退出已被拦过 (consecutiveBlocks>0) 不再拦; 每个 run 最多两次', async () => {
    judge.mockResolvedValue(unfinished);
    const gate = gateFor(wsNoTests);
    expect((await gate({ ...stopped, consecutiveBlocks: 1 })).shouldContinue).toBe(false);
    expect((await gate(stopped)).shouldContinue).toBe(true);
    expect((await gate(stopped)).shouldContinue).toBe(true);
    expect((await gate(stopped)).shouldContinue).toBe(false);
  });

  it('请求失败 → 放行', async () => {
    judge.mockResolvedValue(null);
    expect((await gateFor(wsNoTests)(stopped)).shouldContinue).toBe(false);
  });
});
