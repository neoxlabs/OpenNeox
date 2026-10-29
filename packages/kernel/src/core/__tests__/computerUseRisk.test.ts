import { describe, it, expect } from 'vitest';
import { evaluateToolRisk, isHighRiskLevel } from '../toolRiskEvaluator';

/**
 * computer_run 的审批档位。
 *
 * 鼠标点击不像 shell 命令能静态判风险 —— "点第 7 个按钮"可能是关窗口, 也可能是转账。
 * 分不出就整体按 high 给, 让审批卡把脚本逐条列给人看。
 *
 * 三档的落点 (PermissionManager.resolveEffectivePermission 的判定顺序):
 *   dangerous → 放行 (用户明确要无人托管)
 *   auto      → 弹卡 (auto = "除了危险命令都自动跑", 这条正是危险的那类)
 *   manual    → 弹卡
 */
describe('computer_run 风险评估', () => {
  const script = {
    app: 'QQ',
    steps: [
      { action: 'click', target: 12, label: '打开会话' },
      { action: 'type', text: '这条消息会真的发出去' },
      { action: 'key', key: 'return' },
    ],
  };

  it('一律 high —— 不按内容分级', () => {
    const risk = evaluateToolRisk({ toolName: 'computer_run', args: script });
    expect(risk.level).toBe('high');
    const signal = risk.signals.find((s) => s.code === 'tool:computer-use');
    expect(signal).toBeTruthy();
    expect(signal!.level).toBe('high');
  });

  it('证据里必须摊开每一步 —— 只显示"3 步"等于让人闭眼点同意', () => {
    const risk = evaluateToolRisk({ toolName: 'computer_run', args: script });
    const evidence = risk.signals.find((s) => s.code === 'tool:computer-use')!.evidence!;
    expect(evidence).toContain('打开会话');
    expect(evidence).toContain('这条消息会真的发出去');
    expect(evidence).toContain('key:return');
  });

  it('目标 App 要出现在提示里 —— 人得知道它在操作谁', () => {
    const risk = evaluateToolRisk({ toolName: 'computer_run', args: script });
    expect(risk.signals.find((s) => s.code === 'tool:computer-use')!.message).toContain('QQ');
  });

  it('长脚本截断, 但要说清楚还剩多少步', () => {
    const many = { app: 'Finder', steps: Array.from({ length: 20 }, (_, i) => ({ action: 'click', target: i })) };
    const risk = evaluateToolRisk({ toolName: 'computer_run', args: many });
    const evidence = risk.signals.find((s) => s.code === 'tool:computer-use')!.evidence!;
    expect(evidence).toContain('还有 12 步');
  });

  it('感知类是只读, 不该被评成 high', () => {
    for (const name of ['computer_snapshot', 'computer_check_access']) {
      const risk = evaluateToolRisk({ toolName: name, args: { app: 'QQ' } });
      expect(risk.signals.some((s) => s.code === 'tool:computer-use')).toBe(false);
    }
  });

  it('没有 steps 也不炸 (模型可能漏字段)', () => {
    const risk = evaluateToolRisk({ toolName: 'computer_run', args: {} });
    expect(risk.level).toBe('high');
    expect(risk.signals.find((s) => s.code === 'tool:computer-use')!.message).toContain('前台应用');
  });
});

/* 复刻 resolveEffectivePermission 的判定顺序 (跟 autoModeRiskGate 那条闸同源)。
 * 这里验的是 computer_run 落在三档上的实际结果, 不是评分本身。 */
function decide(scopeMode: 'auto' | 'manual' | 'dangerous', level: string): 'ASK' | 'ALLOW' {
  if (scopeMode === 'dangerous') return 'ALLOW';
  if (isHighRiskLevel(level as never)) return 'ASK';
  if (scopeMode === 'manual') return 'ASK';
  return 'ALLOW';
}

describe('computer_run 在三档上的落点', () => {
  const level = () => evaluateToolRisk({
    toolName: 'computer_run',
    args: { app: 'QQ', steps: [{ action: 'click', target: 1 }] },
  }).level;

  it('dangerous 放行 —— 用户明确要无人托管, high 也不弹', () => {
    expect(decide('dangerous', level())).toBe('ALLOW');
  });

  it('auto **要弹卡** —— auto 的语义是"除了危险命令都自动跑", 操作别人的界面正是危险的那类', () => {
    expect(decide('auto', level())).toBe('ASK');
  });

  it('manual 弹卡', () => {
    expect(decide('manual', level())).toBe('ASK');
  });

  it('computer_snapshot 是只读, 三档都不该拦', () => {
    const readLevel = evaluateToolRisk({ toolName: 'computer_snapshot', args: { app: 'QQ' } }).level;
    expect(isHighRiskLevel(readLevel as never)).toBe(false);
    expect(decide('auto', readLevel)).toBe('ALLOW');
  });
});
