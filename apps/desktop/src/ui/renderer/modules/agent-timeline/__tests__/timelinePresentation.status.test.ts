
import { describe, it, expect } from 'vitest';
import {
  sanitizeTimelineStatus,
  isBackendWaitingStatus,
  inferTimelineActivity,
  getToolActionText,
  pickTimelinePlaceholderText,
} from '../timelinePresentation';
import type { TimelineRow } from '../types';

const toolRow = (status: string, iconKind = 'terminal'): TimelineRow => ({
  kind: 'single',
  step: { id: `s-${Math.random()}`, status, iconKind, title: 't' },
} as unknown as TimelineRow);

/* 消息行的真实形状是 kind:'cell' + cell.kind ('user' / 'assistant_text'),
 * 不是 kind:'message' —— rowAsToolInfo 靠这个区分工具行和消息行。 */
const msgRow = (role: 'user' | 'assistant'): TimelineRow => ({
  kind: 'cell',
  cell: { kind: role === 'user' ? 'user' : 'assistant_text' },
} as unknown as TimelineRow);

describe('isBackendWaitingStatus · 识别"在等上游"', () => {
  it('中英文等待类原文都认', () => {
    for (const s of ['Waiting for response', 'API responding slowly', 'Long wait',
                     'Stream stalled', '等待响应中', '长时间等待', '连接已恢复', '重连中']) {
      expect(isBackendWaitingStatus(s), s).toBe(true);
    }
  });

  it('带秒数后缀仍然认', () => {
    expect(isBackendWaitingStatus('Waiting for response... 42s')).toBe(true);
  });

  it('空 / undefined / 普通状态不算等待', () => {
    expect(isBackendWaitingStatus(undefined)).toBe(false);
    expect(isBackendWaitingStatus('')).toBe(false);
    expect(isBackendWaitingStatus('   ')).toBe(false);
    expect(isBackendWaitingStatus('Running: npm test')).toBe(false);
  });
});

describe('sanitizeTimelineStatus · 把技术串变成人话', () => {
  it('等待类原文统一收敛成「思考中」', () => {
    for (const s of ['Waiting for response', 'Stream stalled', '等待响应中', '重连中']) {
      expect(sanitizeTimelineStatus(s, true), s).toBe('思考中');
    }
  });

  it('英文环境给 Thinking', () => {
    expect(sanitizeTimelineStatus('Waiting for response', false)).toBe('Thinking');
  });

  it('工具类原文改用 timeline 推断的活动 —— 后端的泛化描述不如实际行更准', () => {
    const items = [toolRow('running', 'edit')];
    expect(sanitizeTimelineStatus('Tool is running', true, items)).toBe('写入文件中');
    expect(sanitizeTimelineStatus('工具链执行中', true, items)).toBe('写入文件中');
  });

  it('剥掉尾部秒数, 正文保留', () => {
    expect(sanitizeTimelineStatus('编译项目... 12s', true)).toBe('编译项目');
    expect(sanitizeTimelineStatus('编译项目 (30s 已过)', true)).toBe('编译项目');
  });

  it('剥完变空时回落到推断, 不给空串', () => {
    const out = sanitizeTimelineStatus('... 12s', true, [msgRow('user')]);
    expect(out).toBeTruthy();
    expect(out).toBe('思考中');
  });

  it('空原文直接走推断', () => {
    expect(sanitizeTimelineStatus('', true, [msgRow('user')])).toBe('思考中');
    expect(sanitizeTimelineStatus('   ', true, [])).toBe('思考中');
  });

  it('普通业务状态原样保留 —— 不能把有信息量的文案也吃掉', () => {
    expect(sanitizeTimelineStatus('正在安装依赖', true)).toBe('正在安装依赖');
  });
});

describe('inferTimelineActivity · 倒序找最近活动', () => {
  it('优先报"正在跑"的那个工具, 即使它不在最后', () => {
    const items = [toolRow('running', 'terminal'), toolRow('done', 'file')];
    expect(inferTimelineActivity(items, true)).toBe('执行命令中');
  });

  it('pending 也算在跑', () => {
    expect(inferTimelineActivity([toolRow('pending', 'search')], true)).toBe('搜索代码中');
  });

  it('全部跑完 → 整理结果中, 而不是继续说在执行', () => {
    expect(inferTimelineActivity([toolRow('done', 'terminal')], true)).toBe('整理结果中');
    expect(inferTimelineActivity([toolRow('failed', 'terminal')], true)).toBe('整理结果中');
  });

  it('只有用户消息 → 思考中', () => {
    expect(inferTimelineActivity([msgRow('user')], true)).toBe('思考中');
  });

  it('最后是助手消息 → 回复中', () => {
    expect(inferTimelineActivity([msgRow('assistant')], true)).toBe('回复中');
  });

  it('空 timeline 有兜底, 不抛也不给空串', () => {
    expect(inferTimelineActivity([], true)).toBe('思考中');
    expect(inferTimelineActivity([], false)).toBe('Thinking');
  });

  it('中英文都不返回空', () => {
    for (const zh of [true, false]) {
      expect(inferTimelineActivity([toolRow('running')], zh)).toBeTruthy();
    }
  });
});

describe('getToolActionText · 图标类型 → 动作文案', () => {
  it('常见类型有中英文', () => {
    expect(getToolActionText('edit', true)).toBe('写入文件');
    expect(getToolActionText('edit', false)).toBe('Writing file');
    expect(getToolActionText('terminal', true)).toBe('执行命令');
    expect(getToolActionText('search', false)).toBe('Searching code');
  });

  it('未知类型有兜底, 不返回 undefined', () => {
    expect(getToolActionText('未来新增的图标', true)).toBeTruthy();
    expect(getToolActionText('', false)).toBeTruthy();
  });
});

describe('pickTimelinePlaceholderText · 后端状态与本地推断的取舍', () => {
  it('不在白名单里的后端状态被丢弃, 改走本地推断', () => {
    expect(pickTimelinePlaceholderText('正在安装依赖', [], true)).toBe('思考中');
    expect(pickTimelinePlaceholderText('Compiling module foo', [], false)).toBe('Thinking');
  });

  it('白名单内的状态才会被采纳 (经 sanitize 归一后)', () => {
    /* 'Waiting for response' 在名单里 → 进 sanitize → 收敛成「思考中」 */
    expect(pickTimelinePlaceholderText('Waiting for response', [], true)).toBe('思考中');
    /* 'Running:' 在名单里 → 进 sanitize 的工具分支 → 用本地推断 */
    expect(pickTimelinePlaceholderText('Running: npm test', [toolRow('running', 'terminal')], true))
      .toBe('执行命令中');
  });

  it('后端状态为空时走本地推断', () => {
    expect(pickTimelinePlaceholderText(undefined, [toolRow('running', 'web')], true)).toBe('浏览网页中');
    expect(pickTimelinePlaceholderText('', [msgRow('user')], true)).toBe('思考中');
  });

  it('后端说探索中但本地已无活跃探索 → 以本地为准 (防状态滞留)', () => {
    const out = pickTimelinePlaceholderText('Explore agents running', [toolRow('done', 'file')], true);
    expect(out).toBe('整理结果中');
  });

  it('任何输入都不返回空串', () => {
    for (const s of [undefined, '', '   ', 'Tool is running', 'Waiting for response... 9s']) {
      expect(pickTimelinePlaceholderText(s, [], true), String(s)).toBeTruthy();
    }
  });
});

describe('思考不能压过真动作', () => {
  it('组里有在跑的工具时, 标题说工具不说思考', () => {
    const rows = [
      toolRow('running', 'terminal'),   /* computer_run */
      toolRow('running', 'thinking'),   /* 思考排在后面 —— 倒着找会先撞到它 */
    ];
    expect(inferTimelineActivity(rows, true)).toBe('执行命令中');
    expect(inferTimelineActivity(rows, false)).toBe('Running command');
  });

  it('思考夹在两个动作中间也一样', () => {
    const rows = [
      toolRow('running', 'thinking'),
      toolRow('running', 'file'),
      toolRow('running', 'thinking'),
    ];
    expect(inferTimelineActivity(rows, true)).toBe('读取文件中');
  });

  it('**只有**思考在跑时才说思考 —— 不能把这条也一起干掉', () => {
    expect(inferTimelineActivity([toolRow('running', 'thinking')], true)).toBe('思考中');
  });

  it('多个真动作时取最后那个 (最近发生的)', () => {
    const rows = [
      toolRow('running', 'file'),
      toolRow('running', 'terminal'),
      toolRow('running', 'thinking'),
    ];
    expect(inferTimelineActivity(rows, true)).toBe('执行命令中');
  });
});
