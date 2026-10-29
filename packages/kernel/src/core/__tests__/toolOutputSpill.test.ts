/**
 * LOOP-14 · 超大工具输出「落盘 + 摘要 + 路径」
 *
 * 验收：>30K 字符的输出不再中段挖空，而是完整落盘，回模型摘要 + 路径 + 取法。
 * 读文件工具不落盘（账本按全文登记，模型必须看到真内容）。
 */
import { afterAll, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spillToolOutput, TOOL_OUTPUT_SPILL_THRESHOLD_CHARS } from '../toolOutputSpill.js';
import { prepareToolResultForMemory } from '../runnerToolResultPreparationUtils.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-spill-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function options(overrides: Partial<Parameters<typeof spillToolOutput>[0]> = {}) {
  return {
    toolName: 'execute_shell',
    toolCallId: 'call_1',
    content: 'x'.repeat(TOOL_OUTPUT_SPILL_THRESHOLD_CHARS + 1),
    budgetChars: 12_000,
    dir: tmpDir,
    ...overrides,
  };
}

describe('spillToolOutput', () => {
  it('未超过阈值不落盘', () => {
    expect(spillToolOutput(options({ content: 'short output' }))).toBeNull();
  });

  it('超过阈值：完整内容写盘，摘要带路径 / 总行数 / 取法', () => {
    const content = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
    const spilled = spillToolOutput(options({ content }));
    expect(spilled).not.toBeNull();

    const onDisk = fs.readFileSync(spilled!.filePath, 'utf8');
    expect(onDisk).toBe(content);

    expect(spilled!.summary).toContain('完整结果已落盘');
    expect(spilled!.summary).toContain(spilled!.filePath);
    expect(spilled!.summary).toContain('5,000 行');
    expect(spilled!.summary).toContain('readfile');
    expect(spilled!.summary).toContain('grep -n');
    expect(spilled!.summary.length).toBeLessThanOrEqual(12_000);
    /* 头尾都留了原文 */
    expect(spilled!.summary).toContain('line 0 ');
    expect(spilled!.summary).toContain('line 4999 ');
  });

  it('摘要长度受预算约束（大预算也不超过）', () => {
    const content = 'z'.repeat(200_000);
    const spilled = spillToolOutput(options({ content, budgetChars: 20_000 }));
    expect(spilled).not.toBeNull();
    expect(spilled!.summary.length).toBeLessThanOrEqual(20_000);
  });

  it('预算小到装不下摘要头时退回截断（返回 null）', () => {
    expect(spillToolOutput(options({ budgetChars: 300 }))).toBeNull();
  });

  it('文件名做了字符清洗，工具名 / 调用 id 不会穿透目录', () => {
    const spilled = spillToolOutput(options({
      content: 'q'.repeat(40_000),
      toolName: '../../evil name',
      toolCallId: '../x',
    }));
    expect(spilled).not.toBeNull();
    expect(path.dirname(spilled!.filePath)).toBe(tmpDir);
    expect(path.basename(spilled!.filePath)).not.toContain('/');
  });

  it('落盘文件权限是 0600（输出可能含密钥）', () => {
    const spilled = spillToolOutput(options({ content: 's'.repeat(40_000) }));
    expect(spilled).not.toBeNull();
    if (process.platform !== 'win32') {
      expect(fs.statSync(spilled!.filePath).mode & 0o777).toBe(0o600);
    }
  });
});

// ── 内核接入点 ──────────────────────────────────────────────────────────────

const passthroughPolicy = {
  applyToolResultPolicy: async (input: { result: any; toolCalls: any[]; truncatedResult: string }) => ({
    truncatedResult: input.truncatedResult,
    toolInput: {},
    shouldBreak: false,
    encounteredError: false,
  }),
};

function memoryOptions(output: string, name: string, modelMaxInputTokens?: number) {
  return {
    result: { id: 'r1', name, output, success: true },
    toolCalls: [{ id: 'r1', type: 'function' as const, function: { name, arguments: '{}' } }],
    executableToolCalls: [{ id: 'r1' }],
    parsedArgsByToolId: new Map(),
    autoVerifyPipeline: {
      shouldVerify: () => false,
      verify: async () => null,
      formatToolResult: () => undefined,
    },
    extractVerifyFilePath: () => undefined,
    executionPolicyOrchestrator: passthroughPolicy,
    modelMaxInputTokens,
  };
}

describe('prepareToolResultForMemory 接入 LOOP-14', () => {
  it('execute_shell 的 40K 输出 → 落盘摘要（不再是中段挖空）', async () => {
    const output = Array.from({ length: 800 }, (_, i) => `row ${i} ${'a'.repeat(50)}`).join('\n');
    expect(output.length).toBeGreaterThan(30_000);
    const out = await prepareToolResultForMemory(memoryOptions(output, 'execute_shell', 1_000_000));

    expect(out.truncatedResult).toContain('完整结果已落盘');
    expect(out.truncatedResult).not.toContain('chars truncated in middle');

    const m = out.truncatedResult.match(/file: (\S+)/);
    expect(m).not.toBeNull();
    expect(fs.readFileSync(m![1]!, 'utf8')).toBe(output);
    fs.rmSync(m![1]!, { force: true });
  });

  it('readfile 的输出不落盘 —— 仍走原有截断，模型必须看到真内容', async () => {
    const output = Array.from({ length: 800 }, (_, i) => `row ${i} ${'a'.repeat(50)}`).join('\n');
    const out = await prepareToolResultForMemory(memoryOptions(output, 'readfile', 128_000));
    expect(out.truncatedResult).not.toContain('完整结果已落盘');
    expect(out.truncatedResult.length).toBeLessThanOrEqual(12_400);
  });

  it('未超过 30K 的输出不落盘（行为不变）', async () => {
    const output = 'b'.repeat(20_000);
    const out = await prepareToolResultForMemory(memoryOptions(output, 'execute_shell', 1_000_000));
    expect(out.truncatedResult).not.toContain('完整结果已落盘');
    expect(out.truncatedResult.length).toBeLessThanOrEqual(12_400);
  });
});
