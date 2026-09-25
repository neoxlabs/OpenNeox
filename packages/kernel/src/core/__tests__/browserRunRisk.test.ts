/**
 * browser_run 的权限面 (审计)。
 *
 * 改之前: computer_run 有 high 规则 + 审批卡摘要, browser 一条都没有 —— 整段脚本
 * 含 eval 任意 JS, 在用户**已登录**的站点上默默跑完, auto 档连卡片都不出。
 */
import { describe, it, expect } from 'vitest';
import { evaluateToolRisk } from '../toolRiskEvaluator.js';

/** 只看这两条规则加了什么信号 —— 别的域 (sandbox / path) 不在这份测试的范围里 */
function signals(toolName: string, args: Record<string, unknown>) {
  return evaluateToolRisk({ toolName, args } as never).signals
    .filter((s) => s.code.startsWith('tool:browser'));
}
function levels(toolName: string, args: Record<string, unknown>): string[] {
  return signals(toolName, args).map((s) => s.level);
}

const READ_ONLY = [
  { action: 'navigate', args: { url: 'https://example.com' } },
  { action: 'get_text', args: { selector: 'h1' } },
  { action: 'screenshot', args: {} },
];

describe('browser_run 风险分级', () => {
  it('纯只读脚本不加信号 —— 全 high 会让 auto 每段弹卡, 用户就把闸整条关了', () => {
    expect(levels('browser_run', { steps: READ_ONLY })).toEqual([]);
  });

  it('**eval 是 high** —— 一步就能把 cookie / localStorage 读出来发走', () => {
    const s = signals('browser_run', {
      steps: [...READ_ONLY, { action: 'eval', args: { expression: 'document.cookie' } }],
    });
    expect(s.map((x) => x.level)).toContain('high');
    expect(s[0]!.code).toBe('tool:browser-eval');
    /* 要人看得懂 —— 卡片上不该出现工具名黑话 */
    expect(s[0]!.message).not.toContain('browser_run');
    /* eval 的代码本身要露出来, 那正是要人看的东西 */
    expect(s[0]!.evidence).toContain('document.cookie');
  });

  it('点按/填写是 medium —— auto 放行但证据进卡片, manual 会弹', () => {
    const s = signals('browser_run', {
      steps: [{ action: 'click', args: { text: '确认转账' } }, { action: 'type', args: { selector: '#amt', text: '1000' } }],
    });
    expect(s).toHaveLength(1);
    expect(s[0]!.level).toBe('medium');
    expect(s[0]!.evidence).toContain('确认转账');
  });

  it('eval 优先于点按 —— 同时有的时候按更高的那档报', () => {
    const s = signals('browser_run', {
      steps: [{ action: 'click', args: {} }, { action: 'eval', args: { expression: 'x' } }],
    });
    expect(s).toHaveLength(1);
    expect(s[0]!.level).toBe('high');
  });

  it('步骤摘要超过 8 步会收口, 卡片是回执不是文档', () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({ action: 'click', args: { selector: `#b${i}` } }));
    expect(signals('browser_run', { steps })[0]!.evidence).toContain('还有 4 步');
  });

  it('参数缺 steps 不炸', () => {
    expect(levels('browser_run', {})).toEqual([]);
    expect(levels('browser_run', { steps: 'not-an-array' })).toEqual([]);
  });
});

describe('browser_replay', () => {
  it('步骤在磁盘上看不见 —— 正因为看不见, 不能当没风险', () => {
    const s = signals('browser_replay', { name: 'daily' });
    expect(s[0]!.level).toBe('medium');
    expect(s[0]!.message).toContain('daily');
  });

  it('不给名字 (= 列出录过的) 是只读, 不加信号', () => {
    expect(levels('browser_replay', {})).toEqual([]);
  });
});
