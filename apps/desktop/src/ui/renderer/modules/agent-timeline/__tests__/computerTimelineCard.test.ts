import { describe, it, expect } from 'vitest';
import { computerToolTitle, computerCardContent, shortStepError } from '../computerTimelineCard';

const ARGS = {
  app: 'QQ',
  steps: [
    { action: 'click', target: 12, label: '联系人' },
    { action: 'type', text: '张三', label: '搜索框' },
    { action: 'key', key: 'return' },
  ],
};

describe('computerToolTitle', () => {
  it('标题说出 App 和动作 —— 折叠头取 ` · ` 前那段, 于是显示「操作 QQ」', () => {
    const t = computerToolTitle('computer_run', ARGS, true)!;
    expect(t.split(' · ')[0]).toBe('操作 QQ');
    expect(t).toContain('点击「联系人」');
    /* 折叠头的分类器按关键字猜类别; 标题里不能再出现 run/command 这类词, 否则又被归进 shell */
    expect(t.toLowerCase()).not.toMatch(/computer|run|command/);
  });

  it('没给 app 时也不空', () => {
    expect(computerToolTitle('computer_run', { steps: [] }, true)).toBe('操作电脑');
    expect(computerToolTitle('computer_run', { steps: [] }, false)).toBe('Drive computer');
  });

  it('感知 / 授权检查各有各的说法', () => {
    expect(computerToolTitle('computer_snapshot', { app: '微信' }, true)).toBe('看一眼 微信 的界面');
    expect(computerToolTitle('computer_snapshot', {}, true)).toBe('看一眼屏幕');
    expect(computerToolTitle('computer_check_access', {}, true)).toBe('检查电脑操作权限');
  });

  it('不是 computer 工具就返回 undefined, 让调用方继续走自己的分支', () => {
    expect(computerToolTitle('execute_shell', { command: 'ls' }, true)).toBeUndefined();
  });
});

describe('computerCardContent', () => {
  it('从 metadata.computer 组出卡片: 图标 + 逐步 + 截图', () => {
    const c = computerCardContent({
      computer: {
        kind: 'run',
        app: 'QQ',
        icon: 'data:image/png;base64,AAA',
        screenshot: '/Users/x/.neox/run/shots/shot-1.jpg',
        totalMs: 242,
        steps: [
          { action: 'click', label: '联系人', ok: true, ms: 35 },
          { action: 'click', label: '发送', ok: false, ms: 120, error: '点了没反应' },
        ],
      },
    }, true) as any;
    expect(c.type).toBe('computer');
    expect(c.app).toBe('QQ');
    expect(c.icon).toBe('data:image/png;base64,AAA');
    expect(c.screenshot).toBe('/Users/x/.neox/run/shots/shot-1.jpg');
    expect(c.steps.map((s: any) => s.text)).toEqual(['点击「联系人」', '点击「发送」']);
    expect(c.steps[1]).toMatchObject({ ok: false, ms: 120, error: '点了没反应' });
    /* 有一步失败 → 整张卡是失败的, 卡头要标出来 */
    expect(c.ok).toBe(false);
  });

  it('AX 瞎的 App: 说明为什么只能看图', () => {
    const c = computerCardContent({
      computer: { kind: 'snapshot', app: '微信', axBlind: true, screenshot: '/tmp/a.jpg' },
    }, true) as any;
    expect(c.note).toContain('只能看图操作');
    expect(c.steps).toEqual([]);
  });

  it('没有 metadata (老会话 / 工具报错) 就不出这张卡, 交回通用渲染', () => {
    expect(computerCardContent(undefined, true)).toBeUndefined();
    expect(computerCardContent({ other: 1 }, true)).toBeUndefined();
  });

  it('判据是 metadata 不是工具名 —— call_tool 包一层也要出卡', () => {
    const c = computerCardContent({
      computer: { kind: 'run', app: 'Calculator', steps: [{ action: 'click', label: '6', ok: true, ms: 12 }] },
    }, true) as any;
    expect(c?.type).toBe('computer');
    expect(c.app).toBe('Calculator');
  });
});

describe('跑不起来的调用不出这张卡', () => {
  it('没有步骤也没有画面 = 桥就没起来, 让通用错误卡去说那句 error', () => {
    expect(computerCardContent({ computer: { app: 'QQ', steps: [] } }, true)).toBeUndefined();
    expect(computerCardContent({ computer: { kind: 'snapshot', app: 'QQ' } }, true)).toEqual({ type: 'none' });
  });

  it('只要有画面就出卡 —— axBlind 的 App 全靠这张图', () => {
    const c = computerCardContent({
      computer: { kind: 'snapshot', app: '微信', axBlind: true, screenshot: '/x/a.jpg' },
    }, true);
    expect(c).toBeTruthy();
  });
});

describe('图标走文件路径, 不走 base64', () => {
  it('iconPath 转成 neox-asset:// —— file:// 在渲染层是读不到的', () => {
    const c = computerCardContent({
      computer: { kind: 'run', app: 'QQ', iconPath: '/Users/x/.neox/run/icons/QQ-2.png',
        steps: [{ action: 'click', label: '发送', ok: true }] },
    }, true) as any;
    expect(c.icon).toBe('neox-asset://local/Users/x/.neox/run/icons/QQ-2.png');
  });

  it('老会话里存的 dataURL 仍然认 —— 不能让历史记录变成破图', () => {
    const c = computerCardContent({
      computer: { kind: 'run', app: 'QQ', icon: 'data:image/png;base64,AAA',
        steps: [{ action: 'click', label: '发送', ok: true }] },
    }, true) as any;
    expect(c.icon).toBe('data:image/png;base64,AAA');
  });
});

describe('步骤失败原因只留第一句', () => {
  it('长诊断截成一句, 不摊满整张卡', () => {
    const long = '点了没反应: 界面上 8 条稳定文本一条都没变 (不是"找不到元素")。 常见真因: 界面本来就在目标状态 / 点的是只展开不跳转的菜单组。 先 computer_snapshot 看一眼。';
    expect(shortStepError(long).length).toBeLessThanOrEqual(41);
    expect(shortStepError(long)).not.toContain('computer_snapshot');
  });

  it('本来就短的原样留着', () => {
    expect(shortStepError('stale_handle: 句柄失效')).toBe('stale_handle: 句柄失效');
  });
});
