import { describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendHangLog, installHangMonitor, longFrameToStack, sanitizeLongFrame } from '../hangMonitor';

describe('卡顿记录 (10-22)', () => {
  test('长帧: 脚本 URL 只留文件名, 不露本机路径; 坏数据返回 null', () => {
    const f = sanitizeLongFrame({
      duration: 6123.4,
      route: '#/code?ws=C:/Users/张三/secret',
      scripts: [{ sourceURL: 'file:///C:/Program%20Files/Neox/resources/app.asar/renderer/assets/main-Dx.js', sourceFunctionName: 'renderTimeline', sourceCharPosition: 7522801, duration: 5900 }],
    });
    expect(f?.duration).toBe(6123);
    expect(f?.route).toBe('#/code');
    expect(f?.scripts?.[0].sourceURL).toBe('main-Dx.js');
    expect(sanitizeLongFrame({ duration: 'x' })).toBeNull();
    expect(sanitizeLongFrame(null)).toBeNull();
  });

  test('长帧 → 栈: 按耗时降序', () => {
    const s = longFrameToStack([
      { sourceFunctionName: 'a', sourceURL: 'x.js', sourceCharPosition: 1, duration: 10 },
      { sourceFunctionName: 'b', sourceURL: 'y.js', sourceCharPosition: 2, duration: 900 },
    ]);
    expect(s.split('\n')[0]).toBe('at b (y.js:2) [900ms]');
  });

  test('写单独的日志文件, 一行一条 JSON', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hang-')), 'hang.log');
    appendHangLog({ type: 'main-loop-lag', lagMs: 1500 }, file);
    appendHangLog({ type: 'window-recovered', durationMs: 7000 }, file);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['main-loop-lag', 'window-recovered']);
  });

  test('窗口未响应当下就上报, 长帧 ≥3s 才上报', async () => {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const winHandlers: Record<string, (...a: any[]) => Promise<void> | void> = {};
    const win = {
      on: (ev: string, fn: any) => { winHandlers[ev] = fn; },
      webContents: { on: () => {}, getURL: () => 'file:///x/index.html#/code', mainFrame: { collectJavaScriptCallStack: async () => 'at slowFn (main.js:1:2)' } },
    };
    const reportHang = vi.fn();
    installHangMonitor({
      app: { on: () => {} },
      BrowserWindow: { getAllWindows: () => [win] },
      ipcMain: { on: (ch: string, fn: any) => { handlers[ch] = fn; } },
    }, { reportHang });
    await winHandlers.unresponsive();
    expect(reportHang).toHaveBeenCalledWith(expect.objectContaining({ message: '窗口未响应', stack: 'at slowFn (main.js:1:2)', role: 'renderer' }));
    handlers['hang:long-frame']({}, { duration: 1500, scripts: [] });
    expect(reportHang).toHaveBeenCalledTimes(1);
    handlers['hang:long-frame']({}, { duration: 4200, scripts: [{ sourceFunctionName: 'renderTimeline', duration: 4000 }] });
    expect(reportHang).toHaveBeenLastCalledWith(expect.objectContaining({ message: '界面一帧卡住: renderTimeline', durationMs: 4200 }));
  });
});
