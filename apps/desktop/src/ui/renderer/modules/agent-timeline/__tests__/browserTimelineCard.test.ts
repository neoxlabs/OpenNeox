import { describe, it, expect } from 'vitest';
import {
  browserToolTitle, browserCardContent, describeBrowserStep, shortBrowserError, isBrowserRunTool,
} from '../browserTimelineCard';

const STEPS = [
  { action: 'navigate', args: { url: 'https://github.com/anthropics/claude-code/issues' } },
  { action: 'click', args: { text: '新建 issue' } },
  { action: 'type', args: { selector: '#title', text: '崩溃报告' } },
];

describe('标题', () => {
  it('头一段说清是哪个站 —— 折叠头只取 " · " 之前那段', () => {
    const t = browserToolTitle('browser_run', { steps: STEPS }, true)!;
    expect(t.split(' · ')[0]).toBe('操作 github.com/anthropics/claude-code/issues');
    expect(t).toContain('点击「新建 issue」');
  });

  it('没有 navigate (在当前页继续点) 时给通用说法, 不留空', () => {
    const t = browserToolTitle('browser_run', { steps: [{ action: 'click', args: { text: '下一页' } }] }, true)!;
    expect(t.startsWith('操作网页')).toBe(true);
  });

  it('步骤多时收口, 标题不是文档', () => {
    const many = Array.from({ length: 9 }, () => ({ action: 'click', args: { text: 'x' } }));
    expect(browserToolTitle('browser_run', { steps: many }, true)).toContain('(9 步)');
  });

  it('browser_replay 说清复跑的是哪一份; 不给名字就是"列出来"', () => {
    expect(browserToolTitle('browser_replay', { name: 'daily' }, true)).toBe('复跑录好的操作「daily」');
    expect(browserToolTitle('browser_replay', {}, true)).toBe('列出录好的操作');
  });

  it('别的工具返回 undefined —— 调用方要能继续走自己的分支', () => {
    expect(browserToolTitle('execute_shell', {}, true)).toBeUndefined();
    expect(isBrowserRunTool('execute_shell')).toBe(false);
  });
});

describe('单步文案', () => {
  it('**eval 要把代码露出来** —— 这一步是卡上最该被看见的', () => {
    expect(describeBrowserStep({ action: 'eval', args: { expression: 'document.cookie' } }, true))
      .toContain('document.cookie');
  });

  it('输入类分清"填什么"和"填到哪"', () => {
    expect(describeBrowserStep({ action: 'type', args: { selector: '#title', text: '崩溃报告' } }, true))
      .toBe('输入到「#title」「崩溃报告」');
  });

  it('网址只留域名 + 短路径, 不摊完整 URL', () => {
    expect(describeBrowserStep({ action: 'navigate', args: { url: 'https://a.com/b?q=1&x=2' } }, true))
      .toBe('打开 a.com/b');
  });

  it('英文界面走英文动词', () => {
    expect(describeBrowserStep({ action: 'click', args: { text: 'Submit' } }, false)).toBe('Click "Submit"');
  });
});

describe('结果卡', () => {
  const md = (browser: Record<string, unknown>) => ({ browser });

  it('判据是 metadata.browser 而不是工具名 —— 模型多数经 call_tool 调', () => {
    expect(browserCardContent({}, true)).toBeUndefined();
    expect(browserCardContent(md({ kind: 'run', steps: STEPS.map((s) => ({ ...s, ok: true, ms: 12 })) }), true)?.type)
      .toBe('browser');
  });

  it('自愈过的步骤标出来 —— "页面结构变了"这件事本身值钱', () => {
    const c = browserCardContent(md({
      kind: 'run',
      steps: [{ action: 'click', args: { text: '登录' }, ok: true, ms: 30, healed: '原定位失效, 改用…' }],
    }), true) as any;
    expect(c.steps[0].note).toBe('定位失效, 已自愈');
  });

  it('录下来了就在卡上说一句', () => {
    const c = browserCardContent(md({ kind: 'run', steps: [{ action: 'click', ok: true }], recorded: 'daily' }), true) as any;
    expect(c.note).toContain('daily');
  });

  it('**没步骤也没截图 = 压根没跑起来** → 返回 undefined, 别拿空卡盖掉真正的错误', () => {
    /* 浏览器起不来 / 被站点名单拒了, 那时通用错误卡里那句话才是用户要看的 */
    expect(browserCardContent(md({ kind: 'run', steps: [] }), true)).toBeUndefined();
  });

  it('失败原因只留第一句 —— 完整那段是写给模型的诊断书', () => {
    expect(shortBrowserError('点了没反应: 页面上 12 条稳定文本一条没少。常见真因: …')).toBe('点了没反应: 页面上 12 条稳定文本一条没少');
  });

  it('步骤和站点都带上, 卡上能回答"在哪 / 做了什么"', () => {
    const c = browserCardContent(md({
      kind: 'run', site: 'github.com', url: 'https://github.com/x', totalMs: 540,
      steps: STEPS.map((s, i) => ({ ...s, ok: i !== 2, ms: 10 * (i + 1) })),
    }), true) as any;
    expect(c.site).toBe('github.com');
    expect(c.totalMs).toBe(540);
    expect(c.steps).toHaveLength(3);
    expect(c.steps[2].ok).toBe(false);
  });
});
