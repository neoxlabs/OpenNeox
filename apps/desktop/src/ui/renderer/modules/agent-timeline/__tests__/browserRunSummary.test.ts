import { describe, it, expect } from 'vitest';
import { summarizeApprovalArgs, approvalSteps } from '../approvalPresentation';

describe('审批条: browser_run 翻成步骤', () => {
  const args = {
    steps: [
      { action: 'navigate', args: { url: 'https://example.com/report?id=1' } },
      { action: 'click', args: { text: '播放' } },
      { action: 'eval', args: { expression: 'document.querySelector("video").play()' } },
    ],
  };

  it('主行是人话, 不含 JSON', () => {
    const line = summarizeApprovalArgs(args, 'browser_run', true);
    expect(line).toBe('打开 example.com/report → 点击「播放」 → 在页面里运行脚本');
    expect(line).not.toContain('{');
  });

  it('展开层逐条步骤', () => {
    expect(approvalSteps('browser_run', args, false)).toEqual(['Open example.com/report', 'Click "播放"', 'Run script in page']);
  });

  it('没有专门翻译的工具也不回落 JSON', () => {
    const line = summarizeApprovalArgs({ name: 'demo', count: 3, nested: { a: 1 } }, 'some_tool', true);
    expect(line).toBe('name demo · count 3');
  });
});
