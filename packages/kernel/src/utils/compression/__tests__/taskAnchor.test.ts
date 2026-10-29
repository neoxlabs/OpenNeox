
import { describe, it, expect } from 'vitest';
import { rebuildAfterSummary, rebuildWithSpeculativeSummary } from '../../../core/cachedSummaryCompaction.js';
import { contextCollapse } from '../../../core/contextCollapse.js';
import { LLMSummarizer, COMPACTION_SUMMARY_MARKER } from '../llmSummarizer.js';
import {
  TASK_ANCHOR_MAX_CHARS,
  USER_QUOTES_TOTAL_MAX_CHARS,
  USER_QUOTE_OVERFLOW_HEAD_CHARS,
  capTaskAnchorText,
  findTaskAnchorIndex,
} from '../taskAnchor.js';
import type { Message } from '../../../types/index.js';

/** 任务正文末尾的唯一标记：只要它还在，说明整段原文都在。 */
const TASK_MARKER = '【任务末尾唯一标记·NEEDLE-7777】';
const TASK_CHARS = 4_000;

/** 造一条恰好 chars 个字符、以唯一标记结尾的任务书。 */
function buildTask(chars = TASK_CHARS): string {
  const pad = '这是一段必须原样保留的任务正文，压缩之后模型还要照着它继续干活。'.repeat(
    Math.ceil(chars / 32) + 1,
  );
  return pad.slice(0, chars - TASK_MARKER.length) + TASK_MARKER;
}

/** 一个典型的工具往返：assistant(tool_call) → tool 结果 → 用户催一句。 */
function toolTurn(i: number): Message[] {
  return [
    {
      role: 'assistant',
      content: `第 ${i} 步`,
      tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'readfile', arguments: '{}' } }],
    } as any,
    { role: 'tool', content: `x${i}`.repeat(1_500), tool_call_id: `c${i}`, name: 'readfile' } as any,
    { role: 'user', content: `继续第 ${i} 步` } as any,
  ];
}

/** 长会话：首条 4000 字任务书 + 十几轮工具往返。 */
function longSession(turns = 14): Message[] {
  const msgs: Message[] = [
    { role: 'system', content: 'sys-prompt' } as any,
    { role: 'user', content: buildTask() } as any,
  ];
  for (let i = 0; i < turns; i += 1) msgs.push(...toolTurn(i));
  msgs.push({ role: 'assistant', content: '准备收尾' } as any);
  return msgs;
}

function stringsOf(messages: Message[]): string[] {
  return messages
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean);
}

/** 原文逐字存在（不是摘要里的转述）。 */
function keepsVerbatim(messages: Message[], text: string): boolean {
  return stringsOf(messages).includes(text);
}

describe('keeptask — 首条用户消息压缩后原样保留', () => {
  it('rebuildAfterSummary 把任务正文单独留下，且不重复', () => {
    const session = longSession();
    const task = stringsOf([session[1]!])[0]!;
    const { messages } = rebuildAfterSummary(session, '摘要：读完了 14 个文件。');

    expect(keepsVerbatim(messages, task)).toBe(true);
    expect(stringsOf(messages).filter(s => s === task)).toHaveLength(1);
  });

  it('rebuildWithSpeculativeSummary 在任务消息被摘要覆盖时同样留下原文', () => {
    const session = longSession();
    const task = stringsOf([session[1]!])[0]!;
    const summarizedUpTo = session.length - 5;
    const { messages } = rebuildWithSpeculativeSummary(session, '摘要：进展到一半。', summarizedUpTo);

    expect(keepsVerbatim(messages, task)).toBe(true);
    expect(stringsOf(messages).filter(s => s === task)).toHaveLength(1);
  });

  it('contextCollapse 把任务正文写进那一条折叠摘要, 不新增消息', () => {
    const session = longSession(10).filter(m => m.role !== 'system');
    const task = stringsOf([session[0]!])[0]!;

    const r = contextCollapse(session, 1_000, {
      recentTurns: 3,
      middleTurns: 2,
      semanticScoring: false,
    });

    expect(r.collapsedCount).toBeGreaterThan(0);      // Layer 2 真的折叠了

    const withTask = stringsOf(r.messages).filter(s => s.includes(TASK_MARKER));
    expect(withTask).toHaveLength(1);
    expect(withTask[0]!.startsWith('原始任务 (原话):')).toBe(true);
    expect(withTask[0]!).toContain(task);

    /* 不新增消息、角色顺序不变：折叠前后 user 条数一致，折叠后少掉的条数就是 collapsedCount 的降幅 */
    const usersOf = (msgs: Message[]) => msgs.filter(m => m.role === 'user').length;
    expect(usersOf(r.messages)).toBe(usersOf(session));
    expect(r.messages[0]!.role).toBe('user');                       // 无 system 时首条仍是 user
    expect(keepsVerbatim(r.messages, task)).toBe(false);            // 不是单独插一条消息
  });

  it('任务正文超过 20000 字时折叠摘要里按 capTaskAnchorMessage 截断', () => {
    const huge = buildTask(25_000);
    const session: Message[] = [{ role: 'user', content: huge } as any];
    for (let i = 0; i < 10; i += 1) session.push(...toolTurn(i));

    const r = contextCollapse(session, 1_000, {
      recentTurns: 3,
      middleTurns: 2,
      semanticScoring: false,
    });

    const summary = stringsOf(r.messages).find(s => s.startsWith('原始任务 (原话):'))!;
    expect(summary).toContain(`…(原文共 25000 字, 此处省略`);
    expect(summary).toContain(TASK_MARKER);                         // 尾部标记仍保留
    expect(summary.length).toBeLessThan(huge.length);
  });

  it('partitionMessages 在 protectHeadCount=0 时也把任务消息放进保护区', () => {
    const session = longSession();
    expect(findTaskAnchorIndex(session)).toBe(1);
    const s = new LLMSummarizer({ protectHeadCount: 0, protectRecentCount: 2 });
    const p = (s as any).partitionMessages(session);

    expect(p.compressible.includes(session[1]!)).toBe(false);
    expect(p.headPreserved.map((m: Message) => m.content)).toContain(session[1]!.content);
  });

  it('最近一条用户消息逐字保留（超过旧 8000 字上限也按原样留到 20000）', () => {
    const session = longSession(6);
    const latest = '最新一条要求：' + 'y'.repeat(TASK_CHARS - 7);
    session.push({ role: 'user', content: latest } as any);

    const { messages } = rebuildAfterSummary(session, '摘要：做了一半。');

    expect(latest).toHaveLength(TASK_CHARS);
    expect(stringsOf(messages)).toContain(latest);
  });

  it('被摘要掉的中间用户消息逐条保留原话，不跟首条/最新一条重复', () => {
    const session = longSession(6);
    const { messages } = rebuildAfterSummary(session, '摘要：做了一半。');
    const record = String(
      messages.find(m => String(m.content).startsWith(COMPACTION_SUMMARY_MARKER))!.content,
    );

    expect(record).toContain('## 用户原话');
    expect(record).toContain('继续第 0 步');
    expect(record).toContain('继续第 4 步');      // 最新一条（继续第 5 步）单独保留，不重复列在这里
    expect(record).not.toContain('继续第 5 步');
    expect(record).not.toContain(TASK_MARKER);   // 首条任务不重复堆在摘要里
  });

  it('中间用户原话超过 2000 字才截，并注明本条原文长度', () => {
    const session = longSession(3);
    const longMid = '中'.repeat(2_500);
    session.splice(3, 0, { role: 'user', content: longMid } as any);

    const { messages } = rebuildAfterSummary(session, '摘要。');
    const record = String(
      messages.find(m => String(m.content).startsWith(COMPACTION_SUMMARY_MARKER))!.content,
    );

    expect(record).toContain('本条原文共 2500 字');
  });

  it('手动 force 摘要不把任务正文摘要掉', async () => {
    const seen: string[] = [];
    const provider: any = {
      chat: async (_msgs: any, opts: any) => {
        seen.push(opts.model);
        return { choices: [{ message: { content: 'SUMMARY OK' } }] };
      },
      chatStreamed: () => { throw new Error('不该走流式'); },
    };
    const session = longSession();
    const task = stringsOf([session[1]!])[0]!;

    const s = new LLMSummarizer({ force: true, protectHeadCount: 0, protectRecentCount: 2 });
    const r = await s.summarize(session, 8_000, provider, 'gpt-5.4');

    expect(seen.length).toBeGreaterThan(0);            // 确实烧了摘要
    expect(keepsVerbatim(r.messages, task)).toBe(true);
  });
});

describe('中间用户原话的总量上限', () => {
  function quoteLinesOf(record: string): string[] {
    const section = record.slice(record.indexOf('## 用户原话'));
    return section.split('\n').filter((l) => l.startsWith('- [第 '));
  }

  const bodyOf = (line: string) => line.replace(/^- \[第 \d+ 条\] /, '');

  it('60 条中间用户消息: 逐字原话 ≤ 12000 字, 最早那些降级为 80 字行, 首条与最新一条仍逐字完整', () => {
    const MID = 60;
    const MID_LEN = 300;                       // 60 × 300 = 18000 > 12000
    const task = buildTask();
    const session: Message[] = [
      { role: 'system', content: 'sys-prompt' } as any,
      { role: 'user', content: task } as any,  // 首条：任务正文
    ];
    for (let i = 0; i < MID; i += 1) {
      const prefix = `M${String(i).padStart(2, '0')}:`;
      session.push({ role: 'user', content: prefix + '语'.repeat(MID_LEN - prefix.length) } as any);
    }
    const latest = '最新一条要求：' + 'z'.repeat(100);
    session.push({ role: 'user', content: latest } as any);

    const { messages } = rebuildAfterSummary(session, '摘要：做了很多步。');
    const record = String(
      messages.find(m => String(m.content).startsWith(COMPACTION_SUMMARY_MARKER))!.content,
    );

    // 首条与最新一条逐字完整（不靠摘要转述，也不被降级）
    expect(stringsOf(messages)).toContain(task);
    expect(stringsOf(messages)).toContain(latest);

    const lines = quoteLinesOf(record);
    expect(lines).toHaveLength(MID);

    // 逐字保留的合计 ≤ 12000（预算 12000 / 每条 300 → 40 条）
    const verbatim = lines.filter(l => !bodyOf(l).endsWith('…'));
    const verbatimChars = verbatim.reduce((n, l) => n + bodyOf(l).length, 0);
    expect(verbatimChars).toBeLessThanOrEqual(USER_QUOTES_TOTAL_MAX_CHARS);
    expect(verbatim).toHaveLength(40);
    expect(verbatimChars).toBe(12_000);

    // 更早的（索引 0..19）降级为前 80 字 + 「…」的一行
    const overflow = lines.filter(l => bodyOf(l).endsWith('…'));
    expect(overflow).toHaveLength(MID - 40);
    for (let i = 0; i < MID - 40; i += 1) {
      const body = bodyOf(lines[i]!);
      const expectedHead = `M${String(i).padStart(2, '0')}:` + '语'.repeat(USER_QUOTE_OVERFLOW_HEAD_CHARS - 4);
      expect(body).toBe(`${expectedHead}…`);
    }

    expect(bodyOf(lines[MID - 1]!)).toBe(`M59:` + '语'.repeat(MID_LEN - 4));
  });
});

describe('任务正文的截断口径', () => {
  it('4000 字任务原样返回（同一个字符串引用）', () => {
    const task = buildTask();
    expect(task).toHaveLength(TASK_CHARS);
    expect(capTaskAnchorText(task)).toBe(task);
  });

  it('超过 20000 字才截断，并写明原文长度与省略量', () => {
    const huge = buildTask(25_000);
    const capped = capTaskAnchorText(huge);

    expect(capped.length).toBeLessThan(huge.length);
    expect(capped).toContain(`…(原文共 ${huge.length} 字, 此处省略`);
    expect(capped).toContain(TASK_MARKER);             // 尾部标记仍在
    expect(TASK_ANCHOR_MAX_CHARS).toBe(20_000);
  });
});
