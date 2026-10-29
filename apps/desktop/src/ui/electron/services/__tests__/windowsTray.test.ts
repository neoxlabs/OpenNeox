import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: { buildFromTemplate: vi.fn() },
  Tray: class {},
}));

import { buildWindowsTrayMenu } from '../windowsTray.js';

type MenuEntry = {
  label?: string;
  submenu?: MenuEntry[];
  click?: () => void;
};

function flattenLabels(items: MenuEntry[]): string[] {
  return items.flatMap((item) => [
    ...(item.label ? [item.label] : []),
    ...(item.submenu ? flattenLabels(item.submenu) : []),
  ]);
}

describe('Windows tray menu', () => {
  it('contains the main workflow, account, settings and exit entries', () => {
    const menu = buildWindowsTrayMenu({
      showWindow: vi.fn(),
      sendAction: vi.fn(),
      quit: vi.fn(),
    });
    const labels = flattenLabels(menu as MenuEntry[]);
    expect(labels).toEqual(expect.arrayContaining([
      '显示 Neox',
      '新建会话',
      '回到主页',
      '账户与登录',
      '设置',
      '打开设置',
      '模型与服务商',
      '远程连接',
      '关于 Neox',
      '退出 Neox',
    ]));
  });

  it('shows the window before dispatching a tray action', () => {
    const order: string[] = [];
    const menu = buildWindowsTrayMenu({
      showWindow: () => order.push('show'),
      sendAction: (action) => order.push(action),
      quit: () => order.push('quit'),
    }) as MenuEntry[];
    const newSession = menu.find((item) => item.label === '新建会话');
    newSession?.click?.();
    expect(order).toEqual(['show', 'menu:new-session']);
  });

  it('routes account and settings shortcuts to their dedicated actions', () => {
    const actions: string[] = [];
    const menu = buildWindowsTrayMenu({
      showWindow: vi.fn(),
      sendAction: (action) => actions.push(action),
      quit: vi.fn(),
    }) as MenuEntry[];
    menu.find((item) => item.label === '账户与登录')?.click?.();
    const settings = menu.find((item) => item.label === '设置')?.submenu ?? [];
    settings.find((item) => item.label === '模型与服务商')?.click?.();
    settings.find((item) => item.label === '远程连接')?.click?.();
    expect(actions).toEqual([
      'menu:open-account',
      'menu:open-settings-providers',
      'menu:open-settings-remote',
    ]);
  });
});
