import { describe, expect, it, beforeEach } from 'vitest';
import {
  __setInterruptedRunReaderForTesting,
  appendSituationalContext,
  buildSituationalBlock,
  collectOpenLoops,
  excerptPrompt,
  formatDeviceStateBlock,
  formatOpenLoopsBlock,
} from '../situationalContext.js';
import { __resetDevicePresenceForTesting, reportDevicePresence } from '../devicePresence.js';
import { __resetPendingConfirmationsForTesting } from '../pendingConfirmations.js';
import type { InterruptedRunRecord } from '../store/InterruptedRunStore.js';

const T0 = 1_700_000_000_000;

function run(over: Partial<InterruptedRunRecord> = {}): InterruptedRunRecord {
  return {
    sessionId: 's1',
    workspacePath: '/ws',
    mode: 'agentic',
    model: 'm',
    providerId: null,
    prompt: '把会议纪要发到群里',
    metadata: null,
    startedAt: T0,
    lastHeartbeatAt: T0 + 60_000,
    serverPid: 1,
    serverToken: 't',
    iteration: 2,
    status: 'running',
    completedAt: null,
    errorMessage: null,
    ...over,
  };
}

beforeEach(() => {
  __resetDevicePresenceForTesting();
  __resetPendingConfirmationsForTesting();
  __setInterruptedRunReaderForTesting(() => null);
});

describe('formatDeviceStateBlock', () => {
  it('在线设备带电量 / 网络; 离线设备带上次在线多久', () => {
    const block = formatDeviceStateBlock(
      [
        { deviceId: 'p', kind: 'phone', name: 'Pixel', online: true, batteryPct: 62, charging: true, network: 'wifi', lastSeenAt: T0 },
        { deviceId: 'd', kind: 'desktop', online: false, lastSeenAt: T0 - 12 * 60_000 },
      ],
      'zh',
      T0,
    );
    expect(block).toContain('<device-state>');
    expect(block).toContain('手机 Pixel: 在线 · 电量 62%（充电中） · Wi-Fi');
    expect(block).toContain('电脑: 离线, 12 分钟前还连着');
    expect(block).toContain('不在线的设备派不了活');
  });

  it('没有设备 / 空数组 → 空串 (不注入空标签)', () => {
    expect(formatDeviceStateBlock([], 'zh', T0)).toBe('');
  });

  it('最多列 4 台', () => {
    const devices = Array.from({ length: 6 }, (_, i) => ({
      deviceId: `d${i}`, kind: 'phone' as const, online: true, lastSeenAt: T0,
    }));
    expect(formatDeviceStateBlock(devices, 'zh', T0).match(/^- /gm)).toHaveLength(4);
  });

  it('英文界面输出英文', () => {
    const block = formatDeviceStateBlock([{ deviceId: 'p', kind: 'phone', online: true, batteryPct: 20, network: 'cellular', lastSeenAt: T0 }], 'en', T0);
    expect(block).toContain('online');
    expect(block).toContain('battery 20%');
    expect(block).toContain('cellular');
  });
});

describe('formatOpenLoopsBlock', () => {
  it('三种状态都能说清', () => {
    const block = formatOpenLoopsBlock(
      [
        { state: 'running', title: '整理季度报表', detail: '还剩 2 步: 汇总数据 / 导出 PDF' },
        { state: 'waiting', title: '是否允许 bash' },
        { state: 'blocked', title: '等网恢复' },
      ],
      'zh',
    );
    expect(block).toContain('<open-loops>');
    expect(block).toContain('- 进行中: 整理季度报表 (还剩 2 步: 汇总数据 / 导出 PDF)');
    expect(block).toContain('- 等你确认: 是否允许 bash');
    expect(block).toContain('- 卡住了: 等网恢复');
  });

  it('空列表 → 空串', () => {
    expect(formatOpenLoopsBlock([], 'zh')).toBe('');
  });

  it('最多 5 条, 标题过长截断', () => {
    const loops = Array.from({ length: 8 }, (_, i) => ({ state: 'running' as const, title: `任务${i}` }));
    loops[0].title = 'x'.repeat(200);
    const block = formatOpenLoopsBlock(loops, 'zh');
    expect(block.match(/^- /gm)).toHaveLength(5);
    expect(block).toContain('…');
  });
});

describe('buildSituationalBlock', () => {
  it('两块都有时用空行分隔; 全空时整体为空', () => {
    const both = buildSituationalBlock({
      devices: [{ deviceId: 'p', kind: 'phone', online: true, lastSeenAt: T0 }],
      loops: [{ state: 'running', title: '写周报' }],
    }, 'zh', T0);
    expect(both).toContain('</device-state>\n\n<open-loops>');
    expect(buildSituationalBlock({}, 'zh', T0)).toBe('');
  });
});

describe('collectOpenLoops', () => {
  it('计划 + 等待确认 + 上次中断, 按优先级排序', () => {
    const loops = collectOpenLoops('s1', T0 + 120_000, {
      planSteps: ['修复解析逻辑', '补回归测试', '更新文档'],
      pending: [{ id: 'a', kind: 'approval', toolName: 'bash', since: T0 }],
      interrupted: run({ status: 'errored' }),
    });
    expect(loops[0]).toMatchObject({ state: 'running', title: '修复解析逻辑' });
    expect(loops[0].detail).toContain('还剩 3 步');
    expect(loops[1]).toMatchObject({ state: 'waiting', title: '是否允许 bash' });
    expect(loops[2]).toMatchObject({ state: 'running', title: '把会议纪要发到群里' });
    expect(loops[2].detail).toContain('出错');
  });

  it('空的 sessionId / 无任何源 → 空数组', () => {
    expect(collectOpenLoops('', T0, {})).toEqual([]);
    expect(collectOpenLoops('s1', T0, {})).toEqual([]);
  });

  it('中断轮的 prompt 里带注入块时只留用户原话', () => {
    const loops = collectOpenLoops('s1', T0, {
      interrupted: run({
        prompt: '把会议纪要发到群里\n\n<current-time>2026-10-18 周日 12:00</current-time>\n\n<device-state>\n- 手机: 在线\n</device-state>',
      }),
    });
    expect(loops[0].title).toBe('把会议纪要发到群里');
  });
});

describe('excerptPrompt', () => {
  it('只留第一行用户原话, 并去掉注入块', () => {
    expect(excerptPrompt('第一行\n第二行\n\n<open-loops>\n- 进行中: x\n</open-loops>')).toBe('第一行');
    expect(excerptPrompt('<system-reminder>\n很长的提醒\n</system-reminder>\n\n真正的任务')).toBe('真正的任务');
    expect(excerptPrompt('')).toBe('');
  });
});

describe('appendSituationalContext', () => {
  it('有设备状态时追加到用户消息尾部', () => {
    reportDevicePresence({ deviceId: 'p', kind: 'phone', batteryPct: 50, network: 'wifi', at: Date.now() });
    const out = appendSituationalContext('你好', 's1');
    expect(out.startsWith('你好\n\n<device-state>')).toBe(true);
    expect(out).toMatch(/(电量|battery) 50%/);
  });

  it('没有任何状态时原样返回 (不添空行)', () => {
    expect(appendSituationalContext('你好', 's1')).toBe('你好');
  });

  it('读取失败不能把对话拖死', () => {
    __setInterruptedRunReaderForTesting(() => { throw new Error('db locked'); });
    expect(() => appendSituationalContext('你好', 's1')).not.toThrow();
  });
});
