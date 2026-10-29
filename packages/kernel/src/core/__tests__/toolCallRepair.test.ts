import { describe, it, expect } from 'vitest';
import {
  detectMalformedToolCall,
  repairToolName,
  buildRepairPrompt,
  RepairTracker,
} from '../toolCallRepair.js';

describe('detectMalformedToolCall', () => {
  it('普通文本不报', () => {
    expect(detectMalformedToolCall('hello world')).toEqual({ detected: false, pattern: '', cleanContent: 'hello world' });
    expect(detectMalformedToolCall('')).toMatchObject({ detected: false });
  });

  it('识别并清理 tool_call / arg_value 标签', () => {
    const r = detectMalformedToolCall('<tool_call>{"name":"x"}</tool_call><arg_value>a</arg_value>');
    expect(r.detected).toBe(true);
    expect(r.cleanContent).toBe('{"name":"x"}a');
  });

  it('识别 function_call / tool_use / invoke / parameters / arguments', () => {
    for (const tag of ['function_call', 'tool_use', 'invoke', 'parameters', 'arguments']) {
      expect(detectMalformedToolCall(`<${tag}>x</${tag}>`).detected, tag).toBe(true);
    }
  });

  it('识别自闭合与变体 tool- 标签', () => {
    expect(detectMalformedToolCall('<tool_call/>').detected).toBe(true);
    expect(detectMalformedToolCall('<tool-use>').detected).toBe(true);
    expect(detectMalformedToolCall('<toolxyz>').detected).toBe(true);
  });

  it('识别未闭合的 JSON 工具调用碎片', () => {
    const r = detectMalformedToolCall('{"name": "readfile", "args": {"path": "a"');
    expect(r.detected).toBe(true);
  });

  it('完整 JSON 不误报', () => {
    expect(detectMalformedToolCall('{"name":"readfile"}').detected).toBe(false);
  });
});

describe('repairToolName', () => {
  const names = ['readfile', 'search', 'execute_shell', 'write_file', 'edit', 'list_directory', 'show_tree', 'search_files'];

  it('已存在原名时不修', () => {
    expect(repairToolName('readfile', names)).toEqual({ repaired: false, name: 'readfile' });
  });

  it('大小写修复', () => {
    expect(repairToolName('ReadFile', names)).toEqual({ repaired: true, name: 'readfile' });
    expect(repairToolName('EXECUTE_SHELL', names)).toEqual({ repaired: true, name: 'execute_shell' });
  });

  it('name(args) / name{...} 形态修复', () => {
    expect(repairToolName('readfile({"path":"a"})', names)).toEqual({ repaired: true, name: 'readfile' });
    expect(repairToolName('search{"pattern":"x"}', names)).toEqual({ repaired: true, name: 'search' });
  });

  it('常见别名映射', () => {
    expect(repairToolName('bash', names)).toEqual({ repaired: true, name: 'execute_shell' });
    expect(repairToolName('shell', names)).toEqual({ repaired: true, name: 'execute_shell' });
    expect(repairToolName('read', names)).toEqual({ repaired: true, name: 'readfile' });
    expect(repairToolName('cat', names)).toEqual({ repaired: true, name: 'readfile' });
    expect(repairToolName('grep', names)).toEqual({ repaired: true, name: 'search' });
    expect(repairToolName('ls', names)).toEqual({ repaired: true, name: 'list_directory' });
  });

  it('别名目标不在可用表里时放弃', () => {
    expect(repairToolName('bash', ['readfile'])).toEqual({ repaired: false, name: 'bash' });
  });

  it('无法修复的名字原样返回', () => {
    expect(repairToolName('totally-missing', names)).toEqual({ repaired: false, name: 'totally-missing' });
  });

  it('支持 Map / Set / 数组三种入参', () => {
    expect(repairToolName('Read', new Map([['readfile', {}]])).name).toBe('readfile');
    expect(repairToolName('Read', new Set(['readfile'])).name).toBe('readfile');
    expect(repairToolName('Read', ['readfile']).name).toBe('readfile');
  });
});

describe('buildRepairPrompt', () => {
  it('xml / tool_name / parse_error 各有提示', () => {
    expect(buildRepairPrompt('xml_fragment', 'x')).toContain('残缺的工具调用标签');
    expect(buildRepairPrompt('tool_name', 'nope')).toContain('工具 "nope" 不存在');
    expect(buildRepairPrompt('parse_error', 'x'.repeat(500))).toContain('原始输入');
    expect(buildRepairPrompt('parse_error', 'x'.repeat(500)).length).toBeLessThan(700);
  });

  it('none 返回空串', () => {
    expect(buildRepairPrompt('none', 'x')).toBe('');
  });
});

describe('RepairTracker', () => {
  it('统计总数与分类', () => {
    const t = new RepairTracker();
    t.record(1, 'xml_fragment');
    t.record(2, 'xml_fragment');
    t.record(3, 'parse_error');
    expect(t.getSummary()).toEqual({ total: 3, byType: { xml_fragment: 2, parse_error: 1 } });
  });

  it('同类达到 3 次后放弃', () => {
    const t = new RepairTracker();
    expect(t.shouldGiveUp('xml_fragment')).toBe(false);
    t.record(1, 'xml_fragment');
    t.record(2, 'xml_fragment');
    expect(t.shouldGiveUp('xml_fragment')).toBe(false);
    t.record(3, 'xml_fragment');
    expect(t.shouldGiveUp('xml_fragment')).toBe(true);
    expect(t.shouldGiveUp('parse_error')).toBe(false);
  });
});
