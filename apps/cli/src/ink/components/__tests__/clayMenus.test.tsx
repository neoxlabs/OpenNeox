import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SelectMenu } from '../SelectMenu.js';
import { registerPastedText, expandPastedText, PASTE_TOKEN_RE } from '../InputLine.js';

describe('陶土审批卡', () => {
  const choices = [
    { label: 'Allow Once', value: 'allow_once', description: 'Allow this tool call only this time' },
    { label: 'Always Allow', value: 'always_allow' },
    { label: 'Deny', value: 'deny', description: 'Reject this tool call' },
  ];

  it('选项横排在一行, 带琥珀竖条, 有数字提示', () => {
    const { lastFrame } = render(<SelectMenu message="允许执行 Bash: npm test?" choices={choices} onSelect={() => {}} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('┃');
    expect(frame).toContain('允许执行 Bash: npm test?');
    const optionLine = frame.split('\n').find(l => /Allow|允许/.test(l) && /Deny|拒绝/.test(l));
    expect(optionLine, '三个选项应该在同一行').toBeTruthy();
  });

});

describe('「问你」卡', () => {
  it('带 header 时左边是竖条, 选项竖排带编号', () => {
    const { lastFrame } = render(
      <SelectMenu header="Ask User" message="你选哪个?" choices={[{ label: '红', value: 'r' }, { label: '蓝', value: 'b' }]} onSelect={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('┃');
    expect(frame).toMatch(/1\.\s+红/);
    expect(frame).toMatch(/2\.\s+蓝/);
  });
});

describe('大段粘贴标签', () => {
  it('标签换回原文, 前后文字保留', () => {
    const text = Array.from({ length: 500 }, (_, i) => `第${i + 1}行`).join('\n');
    const token = registerPastedText(text, 500);
    expect(token).toMatch(PASTE_TOKEN_RE);
    expect(token).toMatch(/500/);
    const sent = expandPastedText(`看看 ${token} 一共几行`);
    expect(sent.startsWith('看看 第1行')).toBe(true);
    expect(sent.endsWith('第500行 一共几行')).toBe(true);
  });

  it('不认识的标签原样留着', () => {
    expect(expandPastedText('[Pasted text #99999 +3 lines]')).toBe('[Pasted text #99999 +3 lines]');
  });
});
