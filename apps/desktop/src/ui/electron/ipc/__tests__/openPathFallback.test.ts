import { describe, it, expect } from 'vitest';
import { windowsOpenFallback, windowsRevealFallback } from '../openPathFallback.js';

describe('Windows 打开兜底命令', () => {
  it('目录用资源管理器本体 (不查关联)', () => {
    expect(windowsOpenFallback('C:\\Users\\a\\Documents\\Neox\\工作\\2026-10-20 任务', true))
      .toEqual({ cmd: 'explorer.exe', args: ['C:\\Users\\a\\Documents\\Neox\\工作\\2026-10-20 任务'] });
  });

  it('文件用系统的默认程序处理器 (同样绕开 .mp4/.docx 关联)', () => {
    expect(windowsOpenFallback('C:\\Users\\a\\视频.mp4', false))
      .toEqual({ cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'C:\\Users\\a\\视频.mp4'] });
  });

  it('定位用 explorer /select, —— 是资源管理器自己的开关, 跟文件关联无关', () => {
    expect(windowsRevealFallback('C:\\Users\\a\\视频.mp4'))
      .toEqual({ cmd: 'explorer.exe', args: ['/select,', 'C:\\Users\\a\\视频.mp4'] });
  });

  it('路径原样作为独立参数传递, 不拼进命令行字符串 (& 和引号不会变成命令)', () => {
    const tricky = 'C:\\a & calc.exe\\b"c.pptx';
    const { args } = windowsOpenFallback(tricky, false);
    expect(args).toEqual(['url.dll,FileProtocolHandler', tricky]);
    expect(args.join(' ')).not.toMatch(/^cmd/);
  });
});
