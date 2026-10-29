
import { describe, it, expect } from 'vitest';
import { imageDisplayName } from '../modules/image-studio/imageDisplayName';

describe('imageDisplayName', () => {
  it('去掉扩展名和尾部时间戳, 只留那句描述', () => {
    const r = imageDisplayName('出个图-就是关于汽车跑车在高速的公路上然后旁边有一辆极氪和奥迪-1787637580572.png');
    expect(r.title).toBe('出个图-就是关于汽车跑车在高速的公路上然后旁边有一辆极氪和奥迪');
    expect(r.full).toContain('1787637580572.png'); // 完整名仍留着给悬浮提示
  });

  it('时间戳后面还带序号也认', () => {
    expect(imageDisplayName('海报-1787637580572-2.png').title).toBe('海报');
  });

  it('超长名字截断加省略号 —— 不指望 CSS 一个人扛', () => {
    const long = 'a'.repeat(300);
    const r = imageDisplayName(`${long}-1787637580572.png`);
    expect(r.title.length).toBeLessThanOrEqual(64);
    expect(r.title.endsWith('…')).toBe(true);
  });

  it('没有时间戳的普通文件名原样保留 (只脱扩展名)', () => {
    expect(imageDisplayName('logo.png').title).toBe('logo');
  });

  it('全是时间戳时不至于把名字剃成空', () => {
    const r = imageDisplayName('1787637580572.png');
    expect(r.title.length).toBeGreaterThan(0);
  });
});
