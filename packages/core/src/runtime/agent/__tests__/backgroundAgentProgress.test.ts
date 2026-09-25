/** 后台 agent 统计 tool_call_start 事件，并将工具计数和最近活动写入进度与完成通知。 */
import { describe, expect, it, beforeEach } from 'vitest';
import { BackgroundAgentManager, buildAgentCompletionXml } from '../backgroundAgent.js';

const SID = 'session-parent';
let mgr: BackgroundAgentManager;
let agentId: string;

beforeEach(() => {
  mgr = new BackgroundAgentManager();
  const task = mgr.register('agent-1', '数 README 行数', 'prompt', SID, 'readme-counter');
  agentId = task.agentId;
});

const progressOf = () => mgr.getProgress(agentId);

describe('工具计数认 runner 真正发出的事件名', () => {
  it('tool_call_start 计数 —— 这就是实拍那个 bug', () => {
    mgr.updateProgress(agentId, { type: 'tool_call_start', name: 'run_shell' });
    mgr.updateProgress(agentId, { type: 'tool_call_start', name: 'readfile' });
    expect(progressOf()?.toolUseCount).toBe(2);
  });

  it('旧名字 tool_call 仍然认 (别的宿主可能发老名字)', () => {
    mgr.updateProgress(agentId, { type: 'tool_call', name: 'run_shell' });
    expect(progressOf()?.toolUseCount).toBe(1);
  });

  it('eventType 形态也认', () => {
    mgr.updateProgress(agentId, { eventType: 'tool_call_start', toolName: 'grep' });
    expect(progressOf()?.toolUseCount).toBe(1);
  });

  it('tool_call_end 不重复计数 —— 一次调用只能算一次', () => {
    mgr.updateProgress(agentId, { type: 'tool_call_start', name: 'run_shell' });
    mgr.updateProgress(agentId, { type: 'tool_call_end', name: 'run_shell', success: true });
    expect(progressOf()?.toolUseCount).toBe(1);
  });

  it('无关事件不计数', () => {
    mgr.updateProgress(agentId, { type: 'text_delta', text: 'hi' });
    mgr.updateProgress(agentId, { type: 'thinking', text: '...' });
    expect(progressOf()?.toolUseCount).toBe(0);
  });
});

describe('最近活动要能答得上"它在干嘛"', () => {
  it('tool_call_start 落进 recentActivities', () => {
    mgr.updateProgress(agentId, { type: 'tool_call_start', name: 'run_shell', description: 'wc -l README.md' });
    const acts = progressOf()?.recentActivities ?? [];
    expect(acts.length).toBe(1);
    expect(acts[0]?.tool).toBe('run_shell');
  });

  it('没有 description 时退到工具名, 不写 undefined', () => {
    mgr.updateProgress(agentId, { type: 'tool_call_start', name: 'readfile' });
    expect(progressOf()?.recentActivities?.[0]?.description).toBe('readfile');
  });
});

describe('零进展判死不能只靠一条腿', () => {
  it('调过工具就不算零进展 (哪怕没有输出 token)', () => {
    mgr.updateProgress(agentId, { type: 'tool_call_start', name: 'run_shell' });
    const p = progressOf()!;
    expect(p.toolUseCount > 0 || p.outputTokens > 0).toBe(true);
  });

  it('真的什么都没干时两项都是 0', () => {
    const p = progressOf()!;
    expect(p.toolUseCount).toBe(0);
    expect(p.outputTokens).toBe(0);
  });
});

describe('中断原因必须如实传回父 agent —— 兜底不许退化成"用户中断"', () => {
  const completionOf = () => {
    /* 通过 getResult 拿到落定的 error/status; XML 由 notifier 组装, 这里验数据源 */
    return mgr.getResult(agentId);
  };

  it('看门狗判死: 原因原样保留, 归属标成 watchdog', () => {
    mgr.abort(agentId, '硬超时终止: 运行超过 5 分钟', false, 'watchdog');
    const r = completionOf();
    expect(r?.status).toBe('aborted');
    expect(r?.error).toContain('硬超时终止');
    expect(r?.error).not.toMatch(/user aborted|用户/i);
  });

  it('用户停止: 说人话, 不留英文内部串', () => {
    mgr.abort(agentId, undefined, false, 'user');
    expect(completionOf()?.error).toBe('用户停止');
  });

  it('没给原因也没给归属: 明说"未记录", 绝不冒充用户中断', () => {
    mgr.abort(agentId);
    const err = completionOf()?.error ?? '';
    expect(err).toContain('未记录');
    expect(err).not.toMatch(/user aborted|用户停止/i);
  });

  it('abort 之后再来的 fail 不许覆盖已记录的原因', () => {
    mgr.abort(agentId, '零进展终止: 5 分钟内一个工具都没调用', false, 'watchdog');
    mgr.fail(agentId, 'AbortError: The operation was aborted');
    const r = completionOf();
    expect(r?.status).toBe('aborted');
    expect(r?.error).toContain('零进展终止');
  });

  it('abort 之后再来的 complete 也不许翻案成成功', () => {
    mgr.abort(agentId, 'Token 熔断终止', false, 'watchdog');
    mgr.complete(agentId, '其实我做完了');
    expect(completionOf()?.status).toBe('aborted');
  });
});

describe('<agent-completion> 里必须写清楚"谁掐的、能不能重派"', () => {
  const xmlAfter = (reason: string | undefined, origin: any) => {
    mgr.abort(agentId, reason, false, origin);
    const task = (mgr as any).tasks.get(agentId);
    return buildAgentCompletionXml(task);
  };

  it('看门狗判死: 明说非用户操作 + 劝阻原样重派', () => {
    const xml = xmlAfter('硬超时终止: 运行超过 5 分钟', 'watchdog');
    expect(xml).toContain('<terminated-by>');
    expect(xml).toContain('非用户操作');
    expect(xml).toContain('原样重派大概率会再撞同一道闸');
  });

  it('用户停止: 明说别自作主张重派', () => {
    const xml = xmlAfter('用户从界面停止了这个子 agent', 'user');
    expect(xml).toContain('用户主动停止');
    expect(xml).toContain('不要自作主张重派');
  });

  it('没人说原因: 明说"未记录", 并提醒不要当成用户中断', () => {
    const xml = xmlAfter(undefined, undefined);
    expect(xml).toContain('未记录');
    expect(xml).toContain('不要据此判断是用户中断');
  });

  it('summary 永远不为空 —— 空了父 agent 会自己脑补', () => {
    mgr.abort(agentId, undefined, false, 'unknown');
    const task = (mgr as any).tasks.get(agentId);
    task.error = '';
    const xml = buildAgentCompletionXml(task);
    expect(xml).toContain('没有留下任何原因文本');
  });

  it('正常完成不加终止块 —— 别给成功的结果配"重派建议"', () => {
    mgr.complete(agentId, '干完了');
    const task = (mgr as any).tasks.get(agentId);
    const xml = buildAgentCompletionXml(task);
    expect(xml).not.toContain('<terminated-by>');
    expect(xml).not.toContain('<retry-advice>');
  });
});

describe('看门狗判死走 fail() 时, 归因不许退化成"系统错误·原因不明"', () => {
  /* 看门狗终止时，summary、terminated-by 和 retry-advice 必须表达同一个超时原因。 */
  const xmlAfterFail = (msg: string, origin: any) => {
    mgr.fail(agentId, msg, origin);
    return buildAgentCompletionXml((mgr as any).tasks.get(agentId));
  };

  it('超时判死标 watchdog: 归因和重派建议跟 summary 一致', () => {
    const xml = xmlAfterFail('timeout (25s): 子 agent 撞到自身运行时上限被停止, 已执行 43 次工具调用。', 'watchdog');
    expect(xml).toContain('非用户操作');
    expect(xml).toContain('原样重派大概率会再撞同一道闸');
    expect(xml).not.toContain('终止原因不明');
  });

  it('真·运行错误仍然标系统错误', () => {
    const xml = xmlAfterFail('Bad gateway', 'system');
    expect(xml).toContain('系统/运行错误');
  });

  it('缺省是 system 而不是 user —— 失败不许被读成用户中断', () => {
    const xml = xmlAfterFail('boom', undefined);
    expect(xml).not.toMatch(/用户主动停止/);
  });
});
