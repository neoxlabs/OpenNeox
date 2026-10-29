import { describe, expect, it } from 'vitest';
import { derivePhase, phaseLabel } from './agentPhase';
import type { TimelineEntry } from '../../utils/workspaceUtils';

let seq = 0;
const e = (type: string, extra: Partial<TimelineEntry> = {}): TimelineEntry =>
  ({ id: `e${seq++}`, type, title: '', timestamp: seq, ...extra }) as TimelineEntry;
const base = { streaming: true, approval: false, error: false, justDone: false };
const user = e('user_message');

describe('derivePhase', () => {
  it('不在跑: 空闲 / 完成 / 出错, 审批压过一切', () => {
    expect(derivePhase({ ...base, streaming: false, events: [] }).phase).toBe('idle');
    expect(derivePhase({ ...base, streaming: false, justDone: true, events: [] }).phase).toBe('done');
    expect(derivePhase({ ...base, streaming: false, error: true, events: [] }).phase).toBe('error');
    expect(derivePhase({ ...base, approval: true, events: [] }).phase).toBe('approval');
  });

  it('刚发出去一个字没回 = 连接中; 看门狗报慢 = 连接较慢', () => {
    const old = e('assistant_message', { detail: '上一轮的回答' });
    expect(derivePhase({ ...base, events: [old, user] }).phase).toBe('connecting');
    expect(derivePhase({ ...base, status: '连接较慢, 等待响应中…', events: [user] }).phase).toBe('slow');
  });

  it('推理流在出 = 思考; 正文流在出 = 回复; 正文条目还空着仍算思考', () => {
    expect(derivePhase({ ...base, events: [user, e('thinking', { pending: true })] }).phase).toBe('thinking');
    expect(derivePhase({ ...base, events: [user, e('assistant_message', { pending: true, detail: '好的' })] }).phase).toBe('writing');
    expect(derivePhase({ ...base, events: [user, e('assistant_message', { pending: true, detail: '' })] }).phase).toBe('thinking');
  });

  it('工具按名字分: 计划 / 子 Agent / 询问 / 普通工具', () => {
    const t = (toolName: string) => derivePhase({ ...base, events: [user, e('tool_call', { pending: true, toolName })] }).phase;
    expect(t('update_plan')).toBe('planning');
    expect(t('task_create')).toBe('planning');
    expect(t('agent')).toBe('delegating');
    expect(t('ask_user')).toBe('asking');
    expect(t('read_file')).toBe('tool');
  });

  it('工具跑完、模型还没开口 = 整理结果; 刚更新完计划 = 规划', () => {
    expect(derivePhase({ ...base, events: [user, e('tool_result', { toolName: 'read_file' })] }).phase).toBe('working');
    expect(derivePhase({ ...base, events: [user, e('thinking'), e('plan', { title: '已更新' })] }).phase).toBe('planning');
  });

  it('重试 / 换线路 / 压缩 由状态文案的硬信号判定, 带进度', () => {
    const r = derivePhase({ ...base, status: '响应超时，重试中 (2/3)', events: [user, e('thinking', { pending: true })] });
    expect(r).toMatchObject({ phase: 'retrying', detail: '2/3' });
    expect(derivePhase({ ...base, status: '正在切换到备用 Provider: x', events: [user] }).phase).toBe('failover');
    expect(derivePhase({ ...base, events: [user, e('context_compaction', { pending: true })] }).phase).toBe('compacting');
  });

  it('上一轮的条目不算这一轮', () => {
    const prev = e('thinking', { pending: true });
    expect(derivePhase({ ...base, events: [prev, user] }).phase).toBe('connecting');
  });
});

describe('phaseLabel', () => {
  it('中英文 + 进度', () => {
    expect(phaseLabel('retrying', true, '2/3')).toBe('重试中 2/3');
    expect(phaseLabel('planning', false)).toBe('Planning');
  });
});
