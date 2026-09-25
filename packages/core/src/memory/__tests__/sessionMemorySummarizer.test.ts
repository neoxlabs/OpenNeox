/**
 * SessionMemorySummarizer tests cover structured extraction, markdown formatting,
 * partial message ranges, validation, and persistence helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 私有数据目录指到临时目录 —— 不许往真的 ~/.neox/workspaces 里写 */
const { DATA_ROOT } = vi.hoisted(() => {
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  return { DATA_ROOT: nodePath.join(nodeOs.tmpdir(), `neox-wsdata-test-${process.pid}`) };
});
vi.mock('../../platform/workspaceDataDir.js', () => ({
  workspaceDataDir: (p: string) => path.join(DATA_ROOT, path.basename(p)),
}));

import {
  extractSessionMemory,
  extractAndSaveSessionMemory,
  formatSessionMemoryAsMarkdown,
  getSessionMemoryFilePath,
  loadSessionMemoryMarkdown,
  saveSessionMemoryMarkdown,
  sessionMemoryForPrompt,
  type SessionMemoryLLMProvider,
  type SessionMemorySummary,
} from '../sessionMemorySummarizer.js';

function makeMockProvider(content: string): SessionMemoryLLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({ content }),
  };
}

function makeFailingProvider(err: Error): SessionMemoryLLMProvider {
  return {
    chat: vi.fn().mockRejectedValue(err),
  };
}

function makeSlowProvider(delayMs: number): SessionMemoryLLMProvider {
  return {
    chat: vi.fn().mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ content: '{}' }), delayMs);
    })),
  };
}

const SAMPLE_VALID_JSON = JSON.stringify({
  _analysis: 'scratchpad: 用户要 P0-A+C+PARTIAL. 改了 sessionMemorySummarizer.ts. 没遇到错.',
  state: '进行中, 改 9 段升级',
  task: '给 Neox W4 摘要 prompt 升级到 CC 9 段 + analysis + code snippets',
  filesWithCode: [
    'sessionMemorySummarizer.ts — 升级 9 段 — ```ts\nexport interface SessionMemorySummary { ... }\n```',
  ],
  workflow: [
    '读 CC compaction 现状',
    '改 prompt 加 _analysis + 9 段',
    '加 PARTIAL mode',
  ],
  errorsWithFeedback: [
    '旧测试 result.files 字段被改 → 重写测试 [user said: \"必须保持向后兼容\"]',
  ],
  allUserMessages: [
    '弄完了研究一下压缩方式',
    '都要实现 PARTIAL 模式',
    '我想创新更好',
  ],
  documentation: ['docs/compaction.md'],
  learnings: [
    '<analysis> scratchpad 让 LLM 先 reasoning 再总结, 摘要质量更高',
    '摘要 prompt 必须显式说 "include actual code snippets"',
  ],
  pendingAndNextStep: '[Pending] forkedAgent 摘要 (P0-B). [Next] User said "弄完回答我", 跑测试 + commit 后写创新方向报告.',
});

// ============================================================================
// extractSessionMemory — 主路径
// ============================================================================

describe('extractSessionMemory (9-section upgraded)', () => {
  const sampleMessages = [
    { role: 'user', content: '帮我加 session memory' },
    { role: 'assistant', content: '好, 开始动手' },
    { role: 'user', content: '继续' },
  ];

  it('正常路径: 解析 LLM 返回的 JSON, 输出 9 段 SessionMemorySummary', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    const result = await extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
    });

    expect(result.state).toContain('进行中');
    expect(result.task).toContain('CC 9 段');
    expect(result.filesWithCode).toHaveLength(1);
    expect(result.filesWithCode[0]).toContain('```ts');  // code snippet 标志
    expect(result.workflow).toHaveLength(3);
    expect(result.errorsWithFeedback).toHaveLength(1);
    expect(result.errorsWithFeedback[0]).toContain('[user said:');  // 需求反馈标志
    expect(result.allUserMessages).toHaveLength(3);
    expect(result.allUserMessages[0]).toBe('弄完了研究一下压缩方式');  // verbatim
    expect(result.documentation).toHaveLength(1);
    expect(result.learnings).toHaveLength(2);
    expect(result.pendingAndNextStep).toContain('[Pending]');
    expect(result.pendingAndNextStep).toContain('[Next]');

    expect(result.meta.sourceMessageCount).toBe(3);
    expect(result.meta.summaryModel).toBe('test-model');
    expect(result.meta.mode).toBe('full');
    expect(result.meta.generatedAt).toBeGreaterThan(0);
  });

  it('转录不带 system 段 (agent 的说明书不是对话, 原来占了摘要输入的一大半)', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    await extractSessionMemory({
      messages: [{ role: 'system', content: '你是 Neox, SYSTEM_PROMPT_BODY' }, ...sampleMessages],
      llmProvider: provider,
      model: 'test-model',
    });
    const userTurn = (provider.chat as any).mock.calls[0][0][1].content as string;
    expect(userTurn).not.toContain('SYSTEM_PROMPT_BODY');
    expect(userTurn).not.toContain('[system]');
    expect(userTurn).toContain('帮我加 session memory');
  });

  it('_analysis 字段不持久化 (是 scratchpad)', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    const result = await extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
    });
    /* 不暴露 _analysis 字段 */
    expect((result as any)._analysis).toBeUndefined();
  });

  it('容忍 LLM 把 JSON 包在 ```json``` markdown 块里', async () => {
    const wrapped = '```json\n' + SAMPLE_VALID_JSON + '\n```';
    const provider = makeMockProvider(wrapped);
    const result = await extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
    });
    expect(result.state).toContain('进行中');
  });

  it('空 messages → throw', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    await expect(extractSessionMemory({
      messages: [],
      llmProvider: provider,
      model: 'test-model',
    })).rejects.toThrow('messages is empty');
  });

  it('LLM 调用失败 → throw original error', async () => {
    const provider = makeFailingProvider(new Error('API rate limit'));
    await expect(extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
    })).rejects.toThrow('API rate limit');
  });

  it('LLM 返非 JSON → throw with preview', async () => {
    const provider = makeMockProvider('this is not json at all, just prose');
    await expect(extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
    })).rejects.toThrow('invalid JSON');
  });

  it('LLM 返空对象 → 全空 array + 空字符串', async () => {
    const provider = makeMockProvider('{}');
    const result = await extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
    });
    expect(result.state).toBe('');
    expect(result.task).toBe('');
    expect(result.filesWithCode).toEqual([]);
    expect(result.workflow).toEqual([]);
    expect(result.errorsWithFeedback).toEqual([]);
    expect(result.allUserMessages).toEqual([]);
    expect(result.documentation).toEqual([]);
    expect(result.learnings).toEqual([]);
    expect(result.pendingAndNextStep).toBe('');
  });

  it('字段类型不对 → fallback 空数组 / 空字符串', async () => {
    const provider = makeMockProvider(JSON.stringify({
      state: 'ok', task: 't',
      filesWithCode: 'not array',
      workflow: [123, 'real', null],
      pendingAndNextStep: 42,
    }));
    const result = await extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
    });
    expect(result.filesWithCode).toEqual([]);
    expect(result.workflow).toEqual(['real']);
    expect(result.pendingAndNextStep).toBe('');
  });

  it('超时 throw timeout error', async () => {
    const provider = makeSlowProvider(500);
    await expect(extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
      timeoutMs: 100,
    })).rejects.toThrow('timeout after 0.1s');
  });

  it('maxSummaryWords 被注入 system prompt', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    await extractSessionMemory({
      messages: sampleMessages,
      llmProvider: provider,
      model: 'test-model',
      maxSummaryWords: 999,
    });
    const callArgs = (provider.chat as any).mock.calls[0][0];
    expect(callArgs[0].content).toContain('999 words');
  });
});

// ============================================================================
// Partial mode selects a range by message id or index.
// ============================================================================

describe('PARTIAL mode', () => {
  const messages = [
    { id: 'm1', role: 'user', content: 'msg 1' },
    { id: 'm2', role: 'assistant', content: 'msg 2' },
    { id: 'm3', role: 'user', content: 'msg 3' },
    { id: 'm4', role: 'assistant', content: 'msg 4' },
    { id: 'm5', role: 'user', content: 'msg 5' },
  ];

  it('mode=partial-from + boundary index=2 → 摘 msg 3-5 (含 boundary)', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    const result = await extractSessionMemory({
      messages: messages as any,
      llmProvider: provider,
      model: 'test-model',
      mode: 'partial-from',
      partialBoundary: 2,
    });
    expect(result.meta.sourceMessageCount).toBe(3);  // 3, 4, 5
    expect(result.meta.mode).toBe('partial-from');
    expect(result.meta.partialBoundary).toBe(2);
  });

  it('mode=partial-up-to + boundary index=2 → 摘 msg 1-3 (含 boundary)', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    const result = await extractSessionMemory({
      messages: messages as any,
      llmProvider: provider,
      model: 'test-model',
      mode: 'partial-up-to',
      partialBoundary: 2,
    });
    expect(result.meta.sourceMessageCount).toBe(3);  // 1, 2, 3
    expect(result.meta.mode).toBe('partial-up-to');
  });

  it('mode=partial-from + boundary message-id string → 按 id 找 index', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    const result = await extractSessionMemory({
      messages: messages as any,
      llmProvider: provider,
      model: 'test-model',
      mode: 'partial-from',
      partialBoundary: 'm3',
    });
    expect(result.meta.sourceMessageCount).toBe(3);  // m3, m4, m5
  });

  it('boundary id 不存在 → throw', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    await expect(extractSessionMemory({
      messages: messages as any,
      llmProvider: provider,
      model: 'test-model',
      mode: 'partial-from',
      partialBoundary: 'no-such-id',
    })).rejects.toThrow('not found in messages');
  });

  it('boundary index 越界 → throw', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    await expect(extractSessionMemory({
      messages: messages as any,
      llmProvider: provider,
      model: 'test-model',
      mode: 'partial-from',
      partialBoundary: 999,
    })).rejects.toThrow('out of range');
  });

  it('mode=full + boundary 设了也忽略 (走全量)', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    const result = await extractSessionMemory({
      messages: messages as any,
      llmProvider: provider,
      model: 'test-model',
      mode: 'full',
      partialBoundary: 2,  // 设了但被忽略
    });
    expect(result.meta.sourceMessageCount).toBe(5);  // 全部
  });

  it('PARTIAL prompt 注入 boundary 描述到 system', async () => {
    const provider = makeMockProvider(SAMPLE_VALID_JSON);
    await extractSessionMemory({
      messages: messages as any,
      llmProvider: provider,
      model: 'test-model',
      mode: 'partial-from',
      partialBoundary: 2,
    });
    const callArgs = (provider.chat as any).mock.calls[0][0];
    expect(callArgs[0].content).toContain('RECENT portion');
  });
});

// ============================================================================
// formatSessionMemoryAsMarkdown — 9 段渲染
// ============================================================================

describe('formatSessionMemoryAsMarkdown (9-section)', () => {
  const FULL_SUMMARY: SessionMemorySummary = {
    state: 'in-progress',
    task: 'add memory',
    filesWithCode: ['a.ts — added — ```ts\nconsole.log(1)\n```', 'b.ts — fixed — ```ts\nfix();\n```'],
    workflow: ['step1', 'step2', 'step3'],
    errorsWithFeedback: ['err1 → fixed [user said: \'good\']'],
    allUserMessages: ['hi', 'do X', 'no wait, Y instead'],
    documentation: ['https://example.com'],
    learnings: ['lesson1', 'lesson2'],
    pendingAndNextStep: '[Pending] test. [Next] Run npm test.',
    meta: {
      generatedAt: new Date('2026-06-29').getTime(),
      sourceMessageCount: 10,
      summaryModel: 'glm-5',
      mode: 'full',
    },
  };

  it('包含 9 段 + 标题 + meta', () => {
    const md = formatSessionMemoryAsMarkdown(FULL_SUMMARY);
    expect(md).toContain('# 上次会话摘要');
    expect(md).toContain('## 状态');
    expect(md).toContain('## 任务');
    expect(md).toContain('## 改动的文件 (含代码片段)');
    expect(md).toContain('## 工作流步骤');
    expect(md).toContain('## 错误 + 用户反馈');
    expect(md).toContain('## 用户原话 (verbatim, 按时间序)');
    expect(md).toContain('## 引用文档');
    expect(md).toContain('## 沉淀的决策 / 学到的');
    expect(md).toContain('## 待办 + 下一步');
    expect(md).toContain('glm-5');
    expect(md).toContain('模式: full');
  });

  it('用户原话用 blockquote 渲染', () => {
    const md = formatSessionMemoryAsMarkdown(FULL_SUMMARY);
    expect(md).toContain('> hi');
    expect(md).toContain('> do X');
    expect(md).toContain('> no wait, Y instead');
  });

  it('空段省略', () => {
    const empty: SessionMemorySummary = {
      state: '', task: '',
      filesWithCode: [], workflow: [], errorsWithFeedback: [], allUserMessages: [],
      documentation: [], learnings: [], pendingAndNextStep: '',
      meta: { generatedAt: Date.now(), sourceMessageCount: 0, summaryModel: 'x', mode: 'full' },
    };
    const md = formatSessionMemoryAsMarkdown(empty);
    expect(md).not.toContain('## 状态');
    expect(md).not.toContain('## 任务');
    expect(md).not.toContain('## 用户原话');
    /* 但顶部 + meta 仍有 */
    expect(md).toContain('# 上次会话摘要');
    expect(md).toContain('---');
  });

  it('PARTIAL 模式 → 标题加 mode 标识', () => {
    const partial: SessionMemorySummary = {
      ...FULL_SUMMARY,
      meta: { ...FULL_SUMMARY.meta, mode: 'partial-from' },
    };
    const md = formatSessionMemoryAsMarkdown(partial);
    expect(md).toContain('partial-from');
  });
});

// ============================================================================
// 持久化 + facade
// ============================================================================

describe('session memory persistence (W4 wire)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-w4-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('getSessionMemoryFilePath 在工作区私有数据目录下, 不在项目里', () => {
    const p = getSessionMemoryFilePath('/x/y');
    expect(p).toBe(path.join(DATA_ROOT, 'y', 'session-memory.md'));
    expect(p.startsWith('/x/y')).toBe(false);
  });

  it('loadSessionMemoryMarkdown 文件不存在 → null', () => {
    expect(loadSessionMemoryMarkdown(tmpDir)).toBeNull();
  });

  it('saveSessionMemoryMarkdown 自动建目录 + 写文件, 项目里什么都不留', () => {
    const p = saveSessionMemoryMarkdown(tmpDir, '# hello\n\nfoo');
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, 'utf-8')).toBe('# hello\n\nfoo');
    expect(fs.existsSync(path.join(tmpDir, '.neox'))).toBe(false);
  });

  it('老位置的摘要搬走并从项目里删掉; .neox 里还有别的就只删这一个文件', () => {
    fs.mkdirSync(path.join(tmpDir, '.neox', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.neox', 'session-memory.md'), '# 老摘要');
    expect(loadSessionMemoryMarkdown(tmpDir)).toBe('# 老摘要');
    expect(fs.existsSync(path.join(tmpDir, '.neox', 'session-memory.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.neox', 'memory'))).toBe(true);
  });

  it('老位置搬走后 .neox 空了连目录一起删', () => {
    fs.mkdirSync(path.join(tmpDir, '.neox'));
    fs.writeFileSync(path.join(tmpDir, '.neox', 'session-memory.md'), '# 老摘要');
    loadSessionMemoryMarkdown(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.neox'))).toBe(false);
  });

  it('save → load round-trip', () => {
    saveSessionMemoryMarkdown(tmpDir, '# 上次会话\n\n- 改了 a.ts');
    expect(loadSessionMemoryMarkdown(tmpDir)).toBe('# 上次会话\n\n- 改了 a.ts');
  });

  it('sessionMemoryForPrompt 删掉「用户原话」「待办 + 下一步」和页脚, 留背景段', () => {
    const md = [
      '# 上次会话摘要 (2026-09-23)', '',
      '## 状态', '已完成', '',
      '## 用户原话 (verbatim, 按时间序)', '1. > 帮我做一个 Excel 表', '',
      '## 沉淀的决策 / 学到的', '- 用户偏好中文', '',
      '## 待办 + 下一步', '[Next] 如用户继续要求…', '',
      '---', '*来源: 19 条消息*',
    ].join('\n');
    const out = sessionMemoryForPrompt(md);
    expect(out).toContain('## 状态');
    expect(out).toContain('- 用户偏好中文');
    expect(out).not.toContain('帮我做一个 Excel 表');
    expect(out).not.toContain('[Next]');
    expect(out).not.toContain('来源');
  });

  it('extractAndSaveSessionMemory facade 串通: LLM → markdown → 写盘', async () => {
    const provider: SessionMemoryLLMProvider = {
      chat: vi.fn().mockResolvedValue({ content: SAMPLE_VALID_JSON }),
    };

    const { filePath, summary } = await extractAndSaveSessionMemory({
      workspaceRoot: tmpDir,
      messages: [{ role: 'user', content: 'hi' }],
      llmProvider: provider,
      model: 'test-model',
    });

    expect(filePath).toBe(getSessionMemoryFilePath(tmpDir));
    expect(summary.state).toContain('进行中');

    const written = fs.readFileSync(filePath, 'utf-8');
    expect(written).toContain('CC 9 段');
    expect(written).toContain('## 用户原话');
  });
});
