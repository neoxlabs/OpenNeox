import { describe, it, expect } from 'vitest';
import { summarizeComputerRun, describeComputerStep, formatComputerDuration } from '../computerRunSummary';

const CALC = {
  app: 'Calculator',
  steps: [
    { action: 'click', target: 1356, label: 'All Clear' },
    { action: 'click', target: 1370, label: '6' },
    { action: 'click', target: 1371, label: '×' },
    { action: 'click', target: 1372, label: '7' },
    { action: 'click', target: 1360, label: '=' , expectChange: { label: '42' } },
  ],
};

describe('summarizeComputerRun', () => {
  it('把脚本翻成人话, 不留 JSON', () => {
    const { line, app, steps } = summarizeComputerRun(CALC, true);
    expect(app).toBe('Calculator');
    expect(steps).toHaveLength(5);
    expect(line).toContain('点击「All Clear」');
    expect(line).toContain('点击「=」');
    expect(line).not.toMatch(/[{}[\]"]|steps|action|target/);
  });

  it('超过 maxInline 的步数收成一句, 展开层仍给全', () => {
    const many = { app: 'QQ', steps: Array.from({ length: 9 }, (_, i) => ({ action: 'click', label: `按钮${i}` })) };
    const { line, steps } = summarizeComputerRun(many, true);
    expect(steps).toHaveLength(9);
    expect(line).toContain('共 9 步');
    expect(line).not.toContain('按钮8');
  });

  it('英文界面走英文动词', () => {
    expect(summarizeComputerRun(CALC, false).line).toContain('Click "All Clear"');
  });

  it('没有 label 时才退回元素编号 —— 编号对人没意义, 是最后的兜底', () => {
    expect(describeComputerStep({ action: 'click', target: 42 }, true)).toBe('点击第 42 个元素');
    expect(describeComputerStep({ action: 'click', target: 42, label: '发送' }, true)).toBe('点击「发送」');
  });

  it('输入 / 按键 / 启动各有各的说法', () => {
    expect(describeComputerStep({ action: 'type', text: '张三', label: '搜索框' }, true)).toBe('输入到「搜索框」「张三」');
    expect(describeComputerStep({ action: 'key', key: 'return' }, true)).toBe('按键 return');
    expect(describeComputerStep({ action: 'launch', app: 'QQ' }, true)).toBe('启动 QQ');
  });

  it('右键 / 选文本也有人话 —— 新动作不许在卡片上露出英文 action 名', () => {
    expect(describeComputerStep({ action: 'show_menu', label: '文件列表' }, true)).toBe('右键「文件列表」');
    expect(describeComputerStep({ action: 'show_menu', target: 7 }, false)).toBe('Right-click element #7');
    /* 不给 text = 全选。写成"选中"用户看不出选了什么 */
    expect(describeComputerStep({ action: 'select_text', target: 3 }, true)).toBe('全选文本');
    expect(describeComputerStep({ action: 'select_text', text: '苹果' }, true)).toBe('选中「苹果」');
    expect(describeComputerStep({ action: 'select_text', text: '苹果', occurrence: 2 }, true)).toBe('选中第 2 处「苹果」');
    expect(describeComputerStep({ action: 'select_text', text: '苹果', occurrence: 2 }, false)).toBe('Select "苹果" (match 2)');
  });

  it('悬停是人话, 耗时不写 530769ms', () => {
    expect(describeComputerStep({ action: 'hover', label: '设计主题' }, true)).toBe('悬停「设计主题」');
    expect(describeComputerStep({ action: 'hover', dx: 0.2, dy: 0.1 }, false)).toBe('Hover');
    expect(describeComputerStep({ action: 'double_click', label: '文件' }, true)).toBe('双击「文件」');
    expect(describeComputerStep({ action: 'drag' }, true)).toBe('拖动');
    expect(describeComputerStep({ action: 'scroll', dx: 0.5, dy: 0.7 }, true)).toBe('滚动');
    expect(describeComputerStep({ action: 'scroll', dy: -3, target: 4 }, true)).toBe('滚动向上');
    expect(formatComputerDuration(420, true)).toBe('420ms');
    expect(formatComputerDuration(1638, true)).toBe('1.6s');
    expect(formatComputerDuration(530769, true)).toBe('8分51秒');
  });

  it('空参数不炸, 给空串 (卡片会退回旧的 summary 逻辑)', () => {
    expect(summarizeComputerRun(null, true).line).toBe('');
    expect(summarizeComputerRun({ steps: 'not-an-array' }, true).steps).toEqual([]);
  });
});
