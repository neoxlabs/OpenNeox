/**
 * 输入框运行态推断的回归保护。
 *
 * TimelineComposer.tsx 6818 行, 近半年 157 次提交 (全仓最频繁), **零测试**。
 * 这组函数决定用户看到"在跑什么"以及"能不能发下一条", 判错的后果都是感知级事故 ——
 * 源码注释里就记着两起:
 *
 *   · 「全体卡住、shimmer 都没了」: 工具跑完 + 模型还没吐字 + 看门狗未超时,
 *     三个条件同时不满足就掉进兜底分支, 界面写"等待收尾"且静止 → 被读成卡死。
 *     修法是 streaming 时给"等待模型响应", "等待收尾"只留给真收尾。
 *   · 插话刚注入、模型一字未出的 TTFT 空窗被标成"等待收尾", 用户以为插话没被处理。
 *
 * 所以这里测的重点是**优先级顺序**和**兜底分支的措辞归类**, 不是覆盖率。
 */

import { describe, it, expect } from 'vitest';
import {
  currentTurnEntries,
  hasActiveApproval,
  hasActiveSubagent,
  hasActiveTool,
  hasPendingAssistantText,
  inferComposerRunActivity,
  buildStreamingPlaceholder,
} from '../TimelineComposer';

const e = (o: Record<string, unknown>) => o as any;
const infer = (
  entries: any[],
  opts: { approval?: any; status?: string; idle?: number; streaming?: boolean } = {},
) => inferComposerRunActivity(
  entries, opts.approval ?? null, opts.status, opts.idle ?? 0, true, opts.streaming ?? false,
);

describe('currentTurnEntries · 只取最后一个 user_message 之后', () => {
  it('从最后一条用户消息开始切', () => {
    const tl = [e({ type: 'user_message', id: 'u1' }), e({ type: 'tool_call', id: 't1' }),
                e({ type: 'user_message', id: 'u2' }), e({ type: 'tool_call', id: 't2' })];
    expect(currentTurnEntries(tl).map((x: any) => x.id)).toEqual(['u2', 't2']);
  });

  it('没有 user_message 时返回全部 (不丢事件)', () => {
    const tl = [e({ type: 'tool_call', id: 'a' })];
    expect(currentTurnEntries(tl)).toHaveLength(1);
  });

  it('空 timeline 不抛', () => {
    expect(currentTurnEntries([])).toEqual([]);
  });
});

describe('各活跃判定', () => {
  it('pendingApproval 存在即为待批准', () => {
    expect(hasActiveApproval([], { id: 'x' } as any)).toBe(true);
  });

  it('entry 上的 awaitingApproval / ask_user waiting 都算', () => {
    expect(hasActiveApproval([e({ type: 'tool_call', awaitingApproval: true })], null)).toBe(true);
    expect(hasActiveApproval([e({ type: 'ask_user', askUserStatus: 'waiting' })], null)).toBe(true);
    expect(hasActiveApproval([e({ type: 'ask_user', askUserStatus: 'answered' })], null)).toBe(false);
  });

  it('子 agent: 各种运行中形态都要认', () => {
    expect(hasActiveSubagent([e({ type: 'agent_delegation', delegationStatus: 'running' })])).toBe(true);
    expect(hasActiveSubagent([e({ type: 'explore_status', exploreStatus: 'running' })])).toBe(true);
    expect(hasActiveSubagent([e({ type: 'worker_status', workerStatus: 'running' })])).toBe(true);
    expect(hasActiveSubagent([e({ type: 'dag_execution', dagNodes: [{ status: 'pending' }] })])).toBe(true);
    expect(hasActiveSubagent([e({ type: 'explore_status', exploreGroupMembers: [{ status: 'running' }] })])).toBe(true);
  });

  it('后台委派不算「在跑」—— 否则用户永远发不出下一条', () => {
    expect(hasActiveSubagent([
      e({ type: 'agent_delegation', delegationStatus: 'running', delegationIsBackground: true }),
    ])).toBe(false);
  });

  it('已完成的子 agent 不算活跃', () => {
    expect(hasActiveSubagent([e({ type: 'agent_delegation', delegationStatus: 'done' })])).toBe(false);
  });

  it('工具活跃: 命令运行 / 编辑流 / streaming / pending / 压缩开始', () => {
    expect(hasActiveTool([e({ type: 'tool_call', commandStatus: 'running' })])).toBe(true);
    expect(hasActiveTool([e({ type: 'edit_file', editStreaming: true })])).toBe(true);
    expect(hasActiveTool([e({ type: 'file_stream', streaming: true })])).toBe(true);
    expect(hasActiveTool([e({ type: 'tool_call', pending: true })])).toBe(true);
    expect(hasActiveTool([e({ type: 'context_compaction', compactionStatus: 'started' })])).toBe(true);
  });

  it('助手消息不算工具 —— 否则回复中会被误报成工具执行', () => {
    expect(hasActiveTool([e({ type: 'assistant_message', pending: true })])).toBe(false);
    expect(hasActiveTool([e({ type: 'agent_message', streaming: true })])).toBe(false);
  });

  it('user_message 的 pending 不算工具活跃', () => {
    expect(hasActiveTool([e({ type: 'user_message', pending: true })])).toBe(false);
  });

  it('hasPendingAssistantText 只认助手类', () => {
    expect(hasPendingAssistantText([e({ type: 'assistant_message', pending: true })])).toBe(true);
    expect(hasPendingAssistantText([e({ type: 'tool_call', pending: true })])).toBe(false);
  });
});

describe('inferComposerRunActivity · 优先级顺序', () => {
  it('待批准压过一切', () => {
    const a = infer([
      e({ type: 'user_message' }),
      e({ type: 'tool_call', awaitingApproval: true, commandStatus: 'running' }),
      e({ type: 'agent_delegation', delegationStatus: 'running' }),
    ]);
    expect(a.phase).toBe('approval');
  });

  it('压缩中单独成态, 不被泛化成「工具执行中」', () => {
    const a = infer([
      e({ type: 'user_message' }),
      e({ type: 'context_compaction', compactionStatus: 'compressing' }),
    ]);
    expect(a.phase).toBe('tool');
    expect(a.label).toContain('压缩');
  });

  it('子任务优先于普通工具', () => {
    const a = infer([
      e({ type: 'user_message' }),
      e({ type: 'agent_delegation', delegationStatus: 'running' }),
      e({ type: 'tool_call', commandStatus: 'running' }),
    ]);
    expect(a.phase).toBe('subagent');
  });

  it('助手正在吐字且 token 不空闲 → 回复中', () => {
    const a = infer([e({ type: 'user_message' }), e({ type: 'assistant_message', pending: true })], { idle: 0 });
    expect(a.phase).toBe('speaking');
  });

  it('助手 pending 但 token 长时间空闲 → 等待下一步, 不再谎称「回复中」', () => {
    const a = infer([e({ type: 'user_message' }), e({ type: 'assistant_message', pending: true })], { idle: 9999 });
    expect(a.phase).toBe('waiting_output');
  });
});

describe('inferComposerRunActivity · 两起真实事故的回归', () => {
  it('刚发消息 / 插话注入, 模型一字未出 → 「思考中」而不是「等待收尾」', () => {
    const a = infer([e({ type: 'user_message' })]);
    expect(a.phase).toBe('waiting_output');
    expect(a.label).toContain('思考');
    expect(a.label).not.toContain('收尾');
  });

  it('streaming 中掉进兜底分支 → 「等待模型响应」, 绝不能说「等待收尾」', () => {
    /* 「全体卡住」的准确复现: 工具已结束、助手无 pending、status 未标 waiting */
    const a = infer([e({ type: 'user_message' }), e({ type: 'tool_call', commandStatus: 'done' })],
      { streaming: true });
    expect(a.phase).toBe('waiting_output');
    expect(a.label).not.toContain('收尾');
  });

  it('非 streaming 的兜底才是真「等待收尾」', () => {
    const a = infer([e({ type: 'user_message' }), e({ type: 'tool_call', commandStatus: 'done' })],
      { streaming: false });
    expect(a.phase).toBe('settling');
  });

  it('英文文案同样不含 wrapping up 误导', () => {
    const a = inferComposerRunActivity(
      [e({ type: 'user_message' }), e({ type: 'tool_call', commandStatus: 'done' })],
      null, undefined, 0, false, true,
    );
    expect(a.label.toLowerCase()).not.toContain('wrapping');
  });
});

describe('buildStreamingPlaceholder', () => {
  const act = { phase: 'tool', label: 'x', placeholderLead: '工具执行中' } as any;

  /* 占位符只回答一件事: 这个输入框此刻能不能收下新消息。
   *
   * 操作步骤不归它讲 —— 待发送药丸上有能点的「插入」按钮, 同一件事再在占位符里
   * 复述一遍就是三处说同一句, 用户判定为"不合理"。所以这里钉的是**措辞的边界**:
   * 可插话时给入口, 不可插话时给当前活动, 两边都不解释怎么按键。 */
  it('可插话时给出"还能再说一句"的入口, 不再复述操作步骤', () => {
    const s = buildStreamingPlaceholder(act, true, true);
    expect(s).toBe('补充消息…');
  });

  it('不可插话时退回当前活动的说明, 不给可输入的暗示', () => {
    const s = buildStreamingPlaceholder(act, false, true);
    expect(s).toBe('工具执行中');
    expect(s).not.toContain('补充消息');
  });

  it('两种状态都跟随语言', () => {
    expect(buildStreamingPlaceholder(act, true, false)).toBe('Add a message…');
    expect(buildStreamingPlaceholder(act, false, false)).toBe(act.placeholderLead);
  });
});
