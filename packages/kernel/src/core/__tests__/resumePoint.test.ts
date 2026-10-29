/**
 * work E-01 — 断点落盘 (ResumePoint)
 *
 * 验收标准: 每次工具调用后写 `{stepId, completedFiles[], pendingGate?}`; 杀进程后能读回。
 * 这里用「新开一个 recorder 实例读同一个文件」模拟杀进程后的冷读 —— 内存状态全部丢掉,
 * 只剩盘上的 JSONL。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createResumePointRecorder,
  extractPendingGate,
  readResumePoint,
  resumePointFileName,
} from '../resumePoint.js';
import { StreamedRunner } from '../runner.js';
import { ShortTermMemory } from '../../memory/shortterm.js';
import type { Tool } from '../../types/index.js';

let dir: string;
let workspace: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-resume-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-ws-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function touchWorkspaceFile(name: string): string {
  const p = path.join(workspace, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  return p;
}

describe('ResumePoint 落盘 / 读回', () => {
  it('每次工具调用后追加一行, 杀进程后 (新实例) 能读回最后一个断点', () => {
    const fileA = touchWorkspaceFile('out/a.pptx');
    const fileB = touchWorkspaceFile('out/b.pptx');
    const recorder = createResumePointRecorder({ sessionId: 's1', dir, workspacePath: workspace, now: () => 1000 });

    recorder.recordToolResult({
      iteration: 2, index: 0, toolName: 'deck_add_slide', toolCallId: 'c1',
      argsRaw: JSON.stringify({ outputPath: 'out/a.pptx' }), output: '{"ok":true}', success: true,
    });
    const last = recorder.recordToolResult({
      iteration: 3, index: 1, toolName: 'deck_export', toolCallId: 'c2',
      argsRaw: JSON.stringify({ file_path: 'out/b.pptx' }), output: '{"ok":true}', success: true,
    });

    expect(last?.stepId).toBe('3.2');
    expect(last?.completedFiles).toEqual([fileA, fileB].sort());

    /* 冷读: 全新实例, 内存里什么都没有 */
    const afterKill = readResumePoint('s1', dir);
    expect(afterKill).toMatchObject({
      sessionId: 's1',
      stepId: '3.2',
      iteration: 3,
      toolName: 'deck_export',
      completedFiles: [fileA, fileB].sort(),
    });

    /* 文件确实是一行一个快照 (追加, 不是覆盖) */
    const lines = fs.readFileSync(path.join(dir, resumePointFileName('s1')), 'utf8')
      .split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('只把真的写成功的文件算进 completedFiles (失败 / 不存在 / 目录都不算)', () => {
    touchWorkspaceFile('ok.xlsx');
    const recorder = createResumePointRecorder({ sessionId: 's2', dir, workspacePath: workspace });

    recorder.recordToolResult({
      iteration: 1, index: 0, toolName: 'sheet_set_cells', toolCallId: 'c1',
      argsRaw: JSON.stringify({ file_path: 'ok.xlsx' }), output: '{}', success: false,
    });
    const point = recorder.recordToolResult({
      iteration: 1, index: 1, toolName: 'sheet_new_workbook', toolCallId: 'c2',
      argsRaw: JSON.stringify({ file_path: 'missing.xlsx', save_path: 'out' }), output: '{}', success: true,
    });

    expect(point?.completedFiles).toEqual([]);
  });

  it('pendingGate 由最后一次工具结果决定 (闸解除后清空)', () => {
    const recorder = createResumePointRecorder({ sessionId: 's3', dir });
    const gated = recorder.recordToolResult({
      iteration: 1, index: 0, toolName: 'open_surface', toolCallId: 'c1',
      argsRaw: '{}', output: JSON.stringify({ error: 'delivery_gate_blocked', hint: '第 3 页溢出' }),
      success: false,
    });
    expect(gated?.pendingGate?.reason).toBe('第 3 页溢出');

    const cleared = recorder.recordToolResult({
      iteration: 2, index: 0, toolName: 'deck_add_slide', toolCallId: 'c2',
      argsRaw: '{}', output: '{"ok":true}', success: true,
    });
    expect(cleared?.pendingGate).toBeUndefined();
    expect(readResumePoint('s3', dir)?.pendingGate).toBeUndefined();
  });

  it('被 kill 时写坏的半行不影响读回上一条完整快照', () => {
    const recorder = createResumePointRecorder({ sessionId: 's4', dir });
    recorder.recordToolResult({
      iteration: 5, index: 0, toolName: 'word_create', toolCallId: 'c1',
      argsRaw: '{}', output: '{}', success: true,
    });
    const file = path.join(dir, resumePointFileName('s4'));
    fs.appendFileSync(file, '{"version":1,"sessionId":"s4","stepId":"6.');

    expect(readResumePoint('s4', dir)?.stepId).toBe('5.1');
  });

  it('sessionId 里的路径分隔符不能把文件写到目录外', () => {
    const name = resumePointFileName('../../etc/passwd');
    expect(name.includes('/')).toBe(false);
    expect(name.includes('..')).toBe(false);
    expect(name.endsWith('.jsonl')).toBe(true);
  });

  it('文件超过上限时只保留最后一帧', () => {
    const recorder = createResumePointRecorder({ sessionId: 's5', dir, maxBytes: 10 });
    for (let i = 0; i < 5; i++) {
      recorder.recordToolResult({
        iteration: i + 1, index: 0, toolName: 'noop', toolCallId: `c${i}`,
        argsRaw: '{}', output: '{}', success: true,
      });
    }
    const lines = fs.readFileSync(path.join(dir, resumePointFileName('s5')), 'utf8')
      .split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(readResumePoint('s5', dir)?.stepId).toBe('5.1');
  });
});

describe('runner 接线 — 工具调用后真的落盘', () => {
  it('agent 调一次写文件的工具, 断点文件里就有 stepId + completedFiles', async () => {
    const target = path.join(workspace, 'deliverable.md');
    const tool: Tool = {
      name: 'save_report',
      description: 'Save the report',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
      function: async (args: any) => {
        fs.writeFileSync(args.file_path, '# report');
        return JSON.stringify({ ok: true });
      },
    };
    let calls = 0;
    const provider: any = {
      async chat() { throw new Error('chat() not expected'); },
      async *chatStreamed() {
        calls++;
        if (calls === 1) {
          yield {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'save_report', arguments: JSON.stringify({ file_path: target }) },
                }],
              },
            }],
          };
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
          return;
        }
        yield { choices: [{ delta: { content: '写好了' } }] };
        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
      },
    };

    const sessionId = 'runner-e01';
    const runner = new StreamedRunner({
      llmProvider: provider,
      model: 'test-model',
      tools: [tool],
      memory: new ShortTermMemory(),
      config: { maxIterations: 5, temperature: 0 } as any,
      instructions: 'test agent',
      sessionId,
      resumePointRecorder: createResumePointRecorder({ sessionId, dir, workspacePath: workspace }),
      approvalHandler: async () => true,
      autoCompressEnabled: false,
      disableSystemPrompt: true,
    } as any);

    for await (const _ev of runner.run('把报告写出来')) { /* drain */ }

    const point = readResumePoint(sessionId, dir);
    expect(point).toMatchObject({ stepId: '1.1', iteration: 1, toolName: 'save_report' });
    expect(point?.completedFiles).toEqual([target]);
  });
});

describe('extractPendingGate', () => {
  it('认交付闸与审批两种写法', () => {
    expect(extractPendingGate(JSON.stringify({ requiresApproval: { reason: '要发邮件' } }))?.reason)
      .toBe('要发邮件');
    expect(extractPendingGate(JSON.stringify({ pending_gate: '等用户点确认' }))?.reason)
      .toBe('等用户点确认');
  });

  it('普通结果不算闸', () => {
    expect(extractPendingGate('{"ok":true}')).toBeUndefined();
    expect(extractPendingGate('not json')).toBeUndefined();
  });
});
