/**
 * code:VERIFY-15 —— 「未验证」显式写进回执。
 *
 * 用户默认以为"它说完成了 = 验过了"。提示词要求模型自己写「验证：已跑 / 未跑（原因）」;
 * runner 只在模型漏写时按真实记账补一行 (不拦、不续跑 —— 总控裁决删掉了 VERIFY-01 硬闸)。
 */
import { describe, expect, it } from 'vitest';
import {
  buildVerifyReceiptLine,
  ensureVerifyReceiptLine,
  hasVerifyReceiptLine,
  createVerifyToolTracker,
} from '../verifyReceipt.js';

describe('验证判据 (10-21)', () => {
  it('小标题写法的「验证」也算模型写过', () => {
    expect(hasVerifyReceiptLine('修复\n改了一行\n\n**验证**\n`npm test` → 3 个全过')).toBe(true);
    expect(hasVerifyReceiptLine('### 验证\nnpm test 通过')).toBe(true);
    expect(hasVerifyReceiptLine('我验证过了没问题')).toBe(false);
  });
  it('shell 跑 npm test / pytest 记成已跑, 记命令本身', () => {
    const t = createVerifyToolTracker();
    expect(t.recordTool('execute_shell', JSON.stringify({ args: { command: 'cd x && npm test' } }))).toBe(true);
    expect(t.recordTool('execute_shell', JSON.stringify({ args: { command: 'ls -la' } }))).toBe(false);
    expect(t.recordTool('bash', '{"command":"pytest -q"}')).toBe(true);
    expect([...t.state]).toEqual(['npm test', 'pytest']);
    expect(buildVerifyReceiptLine({ mutationCount: 1, verifyTools: t.state })).toBe('验证：已跑（npm test / pytest）');
  });
});
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import { setKernelConfigProvider } from '../kernelConfigBridge.js';

function makeProvider(finalText: string, tool?: { name: string; args?: Record<string, unknown> }) {
  const state = { calls: 0 };
  const provider = {
    async chat() { throw new Error('chat() not expected'); },
    async *chatStreamed() {
      state.calls++;
      if (tool && state.calls === 1) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) },
              }],
            },
          }],
        };
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
        return;
      }
      yield { choices: [{ delta: { content: finalText } }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    },
  } as any;
  return { provider, state };
}

function makeTool(name: string) {
  return {
    name,
    description: `${name} test tool`,
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, command: { type: 'string' } } },
    function: async () => 'ok',
  } as any;
}

async function runEvents(runner: StreamedRunner) {
  const events: any[] = [];
  for await (const ev of runner.run('改一下再收尾')) events.push(ev);
  return events;
}

function textOf(events: any[]): string {
  return events.filter((e) => e?.type === 'text_delta').map((e) => e.delta).join('');
}

function makeRunner(provider: any, tools: any[]) {
  return new StreamedRunner({
    llmProvider: provider,
    model: 'test-model',
    tools,
    memory: new ShortTermMemory(),
    config: { maxIterations: 6, temperature: 0 } as any,
    instructions: 'test agent',
    sessionId: `verify-receipt-${Math.random().toString(36).slice(2, 8)}`,
    workspacePath: process.cwd(),
    approvalHandler: async () => true,
    autoCompressEnabled: false,
    disableSystemPrompt: true,
  } as any);
}

describe('verifyReceipt (纯函数)', () => {
  it('没改过文件 → 不补 (纯问答不该有验证行噪音)', () => {
    expect(buildVerifyReceiptLine({ mutationCount: 0, verifyTools: [] })).toBeNull();
    expect(ensureVerifyReceiptLine('只是回答问题', { mutationCount: 0, verifyTools: [] })).toBe('只是回答问题');
  });

  it('改过文件且没跑验证 → 未跑 + 原因', () => {
    const line = buildVerifyReceiptLine({ mutationCount: 2, verifyTools: [] });
    expect(line).toBe('验证：未跑（本轮改了 2 处文件，收尾前没有运行任何验证命令）');
  });

  it('跑过验证工具 → 已跑并列出工具 (去重)', () => {
    const line = buildVerifyReceiptLine({ mutationCount: 1, verifyTools: ['run_tests', 'run_tests', 'run_lint'] });
    expect(line).toBe('验证：已跑（run_tests / run_lint）');
  });

  it('英文 UI 用英文行', () => {
    expect(buildVerifyReceiptLine({ mutationCount: 1, verifyTools: [] }, 'en'))
      .toContain('Verification: not run');
    expect(buildVerifyReceiptLine({ mutationCount: 1, verifyTools: ['run_tests'] }, 'en'))
      .toBe('Verification: ran (run_tests)');
  });

  it('模型自己写过验证行 → 不再补一遍 (中英文都认)', () => {
    for (const text of ['改好了。\n验证：未跑（没有测试）', 'done\nVerification: ran (npm test)', '结论\n验证状态：已跑']) {
      expect(hasVerifyReceiptLine(text)).toBe(true);
      expect(ensureVerifyReceiptLine(text, { mutationCount: 3, verifyTools: [] })).toBe(text);
    }
  });

  it('模型没写 → 追加在正文末尾', () => {
    const out = ensureVerifyReceiptLine('改好了。\n', { mutationCount: 1, verifyTools: [] });
    expect(out).toBe('改好了。\n\n验证：未跑（本轮改了 1 处文件，收尾前没有运行任何验证命令）');
  });
});

describe('runner: 收尾回执带上验证状态', () => {
  it('改了文件但没跑验证 → 回执末尾补「验证：未跑（原因）」', async () => {
    const { provider } = makeProvider('改完了，文件已更新。', { name: 'write_file', args: { file_path: 'a.ts' } });
    const events = await runEvents(makeRunner(provider, [makeTool('write_file')]));
    const text = textOf(events);
    expect(text).toContain('改完了，文件已更新。');
    expect(text).toContain('验证：未跑（本轮改了 1 处文件，收尾前没有运行任何验证命令）');
  });

  it('改完跑了 run_tests → 回执补「验证：已跑（run_tests）」', async () => {
    const state = { calls: 0 };
    const provider = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed() {
        state.calls++;
        if (state.calls === 1) {
          yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"file_path":"a.ts"}' } }] } }] };
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        if (state.calls === 2) {
          yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] } }] };
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        yield { choices: [{ delta: { content: '改完并跑了测试。' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      },
    } as any;
    const events = await runEvents(makeRunner(provider, [makeTool('write_file'), makeTool('run_tests')]));
    expect(textOf(events)).toContain('验证：已跑（run_tests）');
  });

  it('模型自己写了验证行 → 原样保留, 不重复补', async () => {
    const finalText = '改完了。\n验证：未跑（只改了注释，不需要跑测试）';
    const { provider } = makeProvider(finalText, { name: 'write_file', args: { file_path: 'a.ts' } });
    const events = await runEvents(makeRunner(provider, [makeTool('write_file')]));
    const text = textOf(events);
    expect(text).toContain('验证：未跑（只改了注释，不需要跑测试）');
    expect(text).not.toContain('收尾前没有运行任何验证命令');
  });

  it('纯问答 (没改文件) → 不补验证行', async () => {
    const { provider } = makeProvider('这是概念解释。');
    const events = await runEvents(makeRunner(provider, []));
    expect(textOf(events)).not.toContain('验证：');
  });

  it('UI 语言为 en → 补英文验证行', async () => {
    setKernelConfigProvider(() => ({ language: 'en' }) as any);
    try {
      const { provider } = makeProvider('Done.', { name: 'write_file', args: { file_path: 'a.ts' } });
      const events = await runEvents(makeRunner(provider, [makeTool('write_file')]));
      expect(textOf(events)).toContain('Verification: not run');
    } finally {
      setKernelConfigProvider(null);
    }
  });
});
