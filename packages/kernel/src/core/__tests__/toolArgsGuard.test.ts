import { describe, it, expect } from 'vitest';
import {
  findMissingRequiredArgs,
  formatToolSchemaForModel,
  buildMissingRequiredArgsMessage,
  findTruncatedToolCallId,
  rejectTruncatedToolCall,
} from '../toolArgsGuard.js';

describe('输出撞 max_tokens 时被截断的工具调用', () => {
  const calls = [{ id: 'a' }, { id: 'b' }];
  it('只有 length 结束才判, 且只判最后一个', () => {
    expect(findTruncatedToolCallId('length', calls)).toBe('b');
    expect(findTruncatedToolCallId('tool_calls', calls)).toBeUndefined();
    expect(findTruncatedToolCallId('stop', calls)).toBeUndefined();
    expect(findTruncatedToolCallId('length', [])).toBeUndefined();
  });
  it('content_filter 同样是被掐断: 最后一个不执行, 回执说的是过滤不是输出上限', () => {
    expect(findTruncatedToolCallId('content_filter', calls)).toBe('b');
    const r = rejectTruncatedToolCall('write_file', 'b', 'content_filter', calls)!;
    expect(r.success).toBe(false);
    expect(r.output).toContain('content filter');
    expect(r.output).not.toContain('max output tokens');
  });
  it('没收到结束原因 (流断了): 只拦参数不是完整 JSON 的最后一个调用', () => {
    const half = [{ id: 'a', function: { arguments: '{"x":1}' } }, { id: 'b', function: { arguments: '{"path":"a.html","content":"<ht' } }];
    const whole = [{ id: 'a', function: { arguments: '{"x":1}' } }, { id: 'b', function: { arguments: '{"y":2}' } }];
    const noArgs = [{ id: 'a', function: { arguments: '' } }];
    expect(findTruncatedToolCallId('', half)).toBe('b');
    expect(findTruncatedToolCallId('', whole)).toBeUndefined();
    expect(findTruncatedToolCallId('', noArgs)).toBeUndefined();
    expect(findTruncatedToolCallId('stop', half)).toBeUndefined();
    const r = rejectTruncatedToolCall('write_file', 'b', '', half)!;
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/connection to the model dropped/);
  });
  it('回执说明没执行、是单次输出上限而不是工具上限; 前面完整的调用照常放行', () => {
    const r = rejectTruncatedToolCall('write_file', 'b', 'length', calls)!;
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/NOT executed/);
    expect(r.output).toMatch(/not a limit of the tool/);
    expect(rejectTruncatedToolCall('readfile', 'a', 'length', calls)).toBeNull();
    expect(rejectTruncatedToolCall('write_file', 'b', 'tool_calls', calls)).toBeNull();
  });
});

const planTool = {
  name: 'update_plan',
  description: 'Updates the task plan.',
  parameters: {
    type: 'object' as const,
    properties: {
      plan: { type: 'array', description: 'The list of steps' },
      explanation: { type: 'string', description: 'Optional explanation' },
    },
    required: ['plan'],
  },
};

describe('findMissingRequiredArgs', () => {
  it('plan 缺失 → 报出来', () => {
    expect(findMissingRequiredArgs(planTool, {})).toEqual(['plan']);
  });

  it('args 是 undefined / null → 全部必填都算缺', () => {
    expect(findMissingRequiredArgs(planTool, undefined)).toEqual(['plan']);
    expect(findMissingRequiredArgs(planTool, null)).toEqual(['plan']);
  });

  it('args 不是对象 (模型传了字符串/数组) → 全部必填都算缺, 而不是崩', () => {
    expect(findMissingRequiredArgs(planTool, 'oops')).toEqual(['plan']);
    expect(findMissingRequiredArgs(planTool, ['oops'])).toEqual(['plan']);
  });

  it('显式 null 算缺, 显式空数组/空串/0/false 不算', () => {
    expect(findMissingRequiredArgs(planTool, { plan: null })).toEqual(['plan']);
    expect(findMissingRequiredArgs(planTool, { plan: [] })).toEqual([]);
    expect(findMissingRequiredArgs(planTool, { plan: '' })).toEqual([]);
    expect(findMissingRequiredArgs(planTool, { plan: 0 })).toEqual([]);
    expect(findMissingRequiredArgs(planTool, { plan: false })).toEqual([]);
  });

  it('没有 required 声明的工具 → 一律不拦', () => {
    const noReq = { ...planTool, parameters: { ...planTool.parameters, required: undefined } };
    expect(findMissingRequiredArgs(noReq, {})).toEqual([]);
  });

  it('多个必填只报缺的那几个', () => {
    const twoReq = { ...planTool, parameters: { ...planTool.parameters, required: ['plan', 'explanation'] } };
    expect(findMissingRequiredArgs(twoReq, { plan: [] })).toEqual(['explanation']);
    expect(findMissingRequiredArgs(twoReq, { plan: [], explanation: 'why' })).toEqual([]);
  });
});

describe('formatToolSchemaForModel', () => {
  it('标注 required 参数并带上参数表', () => {
    const text = formatToolSchemaForModel(planTool);
    expect(text).toContain('update_plan');
    expect(text).toContain('plan: array (required)');
    expect(text).toContain('explanation: string');
  });

  it('没有 properties 也能渲染, 不崩', () => {
    const bare = { name: 'git_status', description: 'x', parameters: { type: 'object' as const, properties: {} } };
    expect(() => formatToolSchemaForModel(bare)).not.toThrow();
    expect(formatToolSchemaForModel(bare)).toContain('(no parameters)');
  });

  it('长描述截断 (schema 进上下文, 不能任它撑爆)', () => {
    const long = { ...planTool, description: 'x'.repeat(500) };
    expect(formatToolSchemaForModel(long).length).toBeLessThan(400);
  });
});

describe('buildMissingRequiredArgsMessage', () => {
  it('说清缺什么 + 附上参数表 —— 模型据此一步补齐', () => {
    const msg = buildMissingRequiredArgsMessage(planTool, ['plan']);
    expect(msg).toContain('missing required argument(s): plan');
    expect(msg).toContain('(required)');
  });
});
