import { describe, it, expect } from 'vitest';
import { collapseSimilarMemories } from '../actionLogService.js';

const A1 = '上游协议（openai-chat / anthropic / responses）配置在「账号」级别而非模型级别，切换某账号协议会影响该账号下所有模型（如 relay-c-chat 一账号服务 30+ 模型，切换会连累其它家，只能拆账号或停部分路由）';
const A2 = '上游协议是账号级配置而非模型级：一个账号若同时服务多模型家族（如 relay-c-chat 服务 30+ 模型），切协议会连累其它模型，需按协议拆分账号或停用相关路由。';
const B1 = '网关协议策略：Claude 渠道统一用 anthropic-messages 协议，GPT 渠道统一用 openai-responses 协议，国产模型（aliyun-bailian/zhipu/xiaomi/nrelay-a-ds）只支持 openai-chat 协议。';
const B2 = '协议矩阵：Claude 家族用 anthropic-messages、GPT 全部用 openai-responses、国产模型（aliyun-bailian/zhipu/xiaomi/nrelay-a-ds）只支持 chat，需保持 chat';
const C = 'nrelay-a-gpt（7 条路由）与 nrelay-a-gpt2（5 条路由）协议已切到 openai-responses + /v1/responses';
const LONG_DOC = '# apps/mobile — Flutter 客户端 (Android + iOS) 时间轴架构\n' + '时间轴按模式分开渲染, 编码模式折叠工具卡, 对话模式一行过程。'.repeat(20);
const SHORT = '该仓库提交惯例：commit message 带 Co-Authored-By trailer，无 git hook。';

const m = (summary: string) => ({ summary });

describe('collapseSimilarMemories', () => {
  it('同一件事换说法存了几遍 → 只留最新那条, 不同的事都保留', () => {
    const out = collapseSimilarMemories([A1, B1, A2, B2, C].map(m), 'pinned', 6).map(x => x.summary);
    expect(out).toEqual([A1, A2, B2, C]);
  });

  it('长文档和短条目字面上有重合, 但不是同一件事, 不合并', () => {
    const out = collapseSimilarMemories([LONG_DOC, SHORT].map(m), 'standard', 6);
    expect(out).toHaveLength(2);
  });

  it('只留最新的 keep 条, 顺序保持旧→新', () => {
    const out = collapseSimilarMemories(['一', '二二二二', '三三三三三', '四四四四'].map(m), 'lesson', 2).map(x => x.summary);
    expect(out).toEqual(['三三三三三', '四四四四']);
  });
});
