import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { StreamedRunner } from '@neoxlabs/kernel';
import { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import { readToolSelfReportedOutcome } from '@neoxlabs/kernel/core/types/toolResult.js';
import { createRuntimeFileTools } from '../files/runtimeFileTools.js';
import { createSmartReadTools } from '../smart-read/tools.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'neox-tool-failure-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function buildRuntimeFileTools(workspaceDir: string) {
  return createRuntimeFileTools({
    formatDisplayPath: (absPath: string) => path.relative(workspaceDir, absPath),
    getWorkspaceRoot: () => workspaceDir,    resolveWorkspacePath: (requestedPath?: string) => path.resolve(workspaceDir, requestedPath || ''),
  });
}

function readfileTool(workspaceDir: string) {
  const tool = createSmartReadTools(workspaceDir).find(t => t.name === 'readfile');
  if (!tool) throw new Error('readfile tool not found');
  return tool;
}

describe('真工具失败时的自报结论', () => {
  it('readfile 读不存在的文件 → 判读器读出失败', async () => {
    await withTempDir(async (dir) => {
      const out = await readfileTool(dir).function({ path: path.join(dir, '没这个文件.ts') } as any, {} as any);
      expect(readToolSelfReportedOutcome(out)).toBe(false);
    });
  });

  it('readfile 缺参数 → 失败', async () => {
    await withTempDir(async (dir) => {
      const out = await readfileTool(dir).function({} as any, {} as any);
      expect(readToolSelfReportedOutcome(out)).toBe(false);
    });
  });

  it('readfile 正常读到内容 → **不许**被判成失败 (反向闸)', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'ok.txt');
      /* 内容故意以 ✗ 开头 + 正文里带一行失败尾标的字面量 —— 读日志/读报告的真实形状。
       * 判成失败就是反向假信号, 比漏判更贵。 */
      await fs.writeFile(file, '✗ 这一行是文件内容\n[tool_outcome: FAILURE]\n最后一行是正文\n');
      const out = await readfileTool(dir).function({ path: file } as any, {} as any);
      expect(readToolSelfReportedOutcome(out)).not.toBe(false);
    });
  });

  for (const name of ['get_definitions', 'search_symbol'] as const) {
    it(`${name} 在没建索引的仓库 → precondition 信封, 不是失败红卡`, async () => {
      await withTempDir(async (dir) => {
        const tool = createSmartReadTools(dir).find(t => t.name === name);
        if (!tool) throw new Error(`${name} tool not found`);
        const out = await tool.function({ query: 'foo', symbol: 'foo' } as any, {} as any);
        expect(readToolSelfReportedOutcome(out)).toBe(false);
        const env = JSON.parse(String(out)) as { status?: string; precondition?: unknown; content?: string };
        expect(env.status).toBe('error');
        expect(env.precondition).toBe(true);
        expect(env.content).toContain('build_index()');
      });
    });
  }

  it('write_file 内容为空白 → 失败 (原来这条一直是绿的)', async () => {
    await withTempDir(async (dir) => {
      const tools = buildRuntimeFileTools(dir);
      const out = await tools.writeFile.function(
        { file_path: path.join(dir, 'blank.txt'), content: '   \n' } as any,
        {} as any,
      );
      expect(readToolSelfReportedOutcome(out)).toBe(false);
    });
  });

  it('write_file 正常写 → 成功', async () => {
    await withTempDir(async (dir) => {
      const tools = buildRuntimeFileTools(dir);
      const out = await tools.writeFile.function(
        { file_path: path.join(dir, 'new.txt'), content: 'hello\n' } as any,
        {} as any,
      );
      expect(readToolSelfReportedOutcome(out)).toBe(true);
    });
  });

  it('list_directory 列不存在的目录 → 失败', async () => {
    await withTempDir(async (dir) => {
      const tools = buildRuntimeFileTools(dir);
      const out = await tools.listDirectory.function({ directory: path.join(dir, '不存在的目录') } as any, {} as any);
      expect(readToolSelfReportedOutcome(out)).toBe(false);
    });
  });
});

/* ── 再往下游走一跳: 结论必须出现在**事件**里 ──────────────────────────────
 * 上面那组只证明"工具的返回值读得出失败"。时间线拿到的不是返回值, 是 runner 发的
 * tool_output / tool_call_end 事件上的 success 字段 —— 中间还隔着 invokeTool。
 * 这一段用假的 LLM (直接吐一个 readfile 工具调用) 跑真 runner + 真工具, 断言事件。 */
function makeToolCallingProvider(toolName: string, args: Record<string, unknown>) {
  let turn = 0;
  return {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed() {
      turn++;
      if (turn === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(args) },
              }],
            },
          }],
        };
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
        return;
      }
      yield { choices: [{ delta: { content: '读不到, 我停下来了' } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  } as any;
}

async function runOneToolCall(opts: {
  dir: string; toolName: string; args: Record<string, unknown>; tools: any[];
}): Promise<Array<{ name?: string; success?: boolean }>> {
  const runner = new StreamedRunner({
    llmProvider: makeToolCallingProvider(opts.toolName, opts.args),
    model: 'test-model',
    tools: opts.tools,
    memory: new ShortTermMemory(),
    config: { maxIterations: 3, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId: `tool-failure-event-${opts.toolName}`,
    /* 这两项都是为了让工具**真的跑起来**:
     *   · workspacePath: 不给的话权限层按 cwd 判"路径在工作区外";
     *   · approvalHandler: 裸 runner 没有审批 handler 时是 fail-close 全拒。
     * 第一版两项都没给, 于是每次调用都被拒 —— "失败"用例照样绿, 但绿的是权限拒绝,
     * 跟本条改动一点关系没有 (变异验证时才戳穿: 把 markToolFailure 改成恒等它还是绿)。 */
    workspacePath: opts.dir,
    approvalHandler: async () => true,
    autoCompressEnabled: false,
    disableSystemPrompt: true,
  } as any);

  const toolEvents: Array<{ name?: string; success?: boolean }> = [];
  for await (const ev of runner.run('去干那件事')) {
    const e = ev as any;
    if (e?.type === 'tool_output') toolEvents.push({ name: e.name, success: e.success });
  }
  return toolEvents;
}

describe('失败结论要走到事件上 (时间线读的是事件, 不是返回值)', () => {
  /* 这两个用例刻意挑**不抛异常**的失败 —— 会抛的那种旧代码也判得对 (invokeTool 的
   * catch 兜住了), 拿它当闸是假绿。这两条恰恰是过去一路绿到时间线的那两类。 */

  it('list_directory 列不存在的目录 (纯文本失败, 不抛) → tool_output.success === false', async () => {
    await withTempDir(async (dir) => {
      const t = buildRuntimeFileTools(dir);
      const events = await runOneToolCall({
        dir,
        toolName: 'list_directory',
        args: { directory: path.join(dir, '不存在的目录') },
        tools: [t.listDirectory, t.writeFile],
      });
      const hits = events.filter(e => e.name === 'list_directory');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(e => e.success === false)).toBe(true);
    });
  });

  it('write_file 内容为空白 (JSON status:error, 不抛) → tool_output.success === false', async () => {
    await withTempDir(async (dir) => {
      const t = buildRuntimeFileTools(dir);
      const events = await runOneToolCall({
        dir,
        toolName: 'write_file',
        args: { file_path: path.join(dir, 'blank-e2e.txt'), content: '   \n' },
        tools: [t.writeFile, t.listDirectory],
      });
      const hits = events.filter(e => e.name === 'write_file');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(e => e.success === false)).toBe(true);
    });
  });

  it('反向: list_directory 正常列目录 → success === true (别把整棵时间线刷红)', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'a.txt'), 'x');
      const t = buildRuntimeFileTools(dir);
      const events = await runOneToolCall({
        dir,
        toolName: 'list_directory',
        args: { directory: dir },
        tools: [t.listDirectory, t.writeFile],
      });
      const hits = events.filter(e => e.name === 'list_directory');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every(e => e.success === true)).toBe(true);
    });
  });
});
