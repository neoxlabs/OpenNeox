import { describe, it, expect } from 'vitest';
import { THEME_PACKS, DEFAULT_PACK_ID } from '../packs';

/** 色相饱和度: max-min 越大越"有颜色"。中性灰/墨色应当接近 0。 */
function chroma(hex: string): number {
  const m = hex.replace('#', '').trim();
  if (m.length !== 6) return 0;
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

const pack = (id: string) => {
  const p = THEME_PACKS.find(x => x.id === id);
  if (!p) throw new Error(`找不到主题包 ${id}`);
  return p;
};

describe('默认主题包的强调色是中性的', () => {
  it('默认包就是浅白 liulibasic —— 换默认包这条闸要跟着搬', () => {
    expect(DEFAULT_PACK_ID).toBe('liulibasic');
  });

  it('浅白的 seed.accent 不能是品牌紫 —— 那是 2026-08-23 那批紫色的源头之一', () => {
    const accent = pack('liulibasic').seed?.accent ?? '';
    expect(accent.toLowerCase()).not.toBe('#6e56ff');
    /* 12 是很宽的门槛: 纯灰=0, #24292f=11, 品牌紫 #6e56ff=169。
     * 卡在这里只挡"明显有颜色", 不干涉冷暖微调。 */
    expect(chroma(accent)).toBeLessThan(20);
  });

  it('浅白的 primary600 是墨色, 且跟正文同色 —— "强调"读起来是"更黑"不是"另一种颜色"', () => {
    const t = pack('liulibasic').tokens!;
    expect(t.primary600).toBe('#23211e');
    expect(t.primary600).toBe(t.fgPrimary);
  });

  it('浅色主色阶必须越大越深 (与暗色的越大越亮对称), 否则 hover 会比常态更浅', () => {
    const t = pack('liulibasic').tokens!;
    const lum = (hex: string) => {
      const m = hex.replace('#', '');
      return parseInt(m.slice(0, 2), 16) + parseInt(m.slice(2, 4), 16) + parseInt(m.slice(4, 6), 16);
    };
    const ramp = [t.primary900!, t.primary800!, t.primary700!, t.primary600!, t.primary500!, t.primary400!];
    for (let i = 1; i < ramp.length; i++) {
      expect(lum(ramp[i]), `primary${900 - i * 100} 应当比前一档浅`).toBeGreaterThan(lum(ramp[i - 1]));
    }
  });

  it('暗色保持中性银灰 —— 锁住别被"统一成品牌色"改回去', () => {
    const t = pack('anye').tokens!;
    expect(t.primary600).toBe('#d9d2c6');
    expect(chroma(t.primary600!)).toBeLessThan(20);
  });

  it('两个基础包的主色都不带颜色 —— 明暗两边口径一致', () => {
    for (const id of ['liulibasic', 'anye']) {
      expect(chroma(pack(id).tokens!.primary600!), `${id} 的 primary600 不该有色相`).toBeLessThan(20);
    }
  });
});
