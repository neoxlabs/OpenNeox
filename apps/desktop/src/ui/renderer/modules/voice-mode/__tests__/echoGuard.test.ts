import { describe, expect, it } from 'vitest';
import { echoCoverage, isLikelyEcho } from '../echoGuard';

const now = 100_000;
const said = (text: string, ago = 2_000) => ({ text, at: now - ago });

describe('isLikelyEcho', () => {
  it('它刚念过的话被收回来 = 回声 (9/30 日志原句)', () => {
    const recent = [said('我在听着呢, 你是想问刚才说的目录为什么是空的吗?')];
    expect(isLikelyEcho('我在听着呢，你是想问刚才说的目录？为什么是空的？', recent, now)).toBe(true);
  });

  it('识别有错字也算 (同音误识)', () => {
    const recent = [said('确实只有一个空的 .neox 文件夹, 别的一概没有, 而且它不是 git 仓库')];
    expect(isLikelyEcho('确实只有一个空的你要死文件夹，别的一概没有。而且它不是拼仓库', recent, now)).toBe(true);
  });

  it('主人自己的新问题不是回声 (9/30 被声纹锁误吞的原句)', () => {
    const recent = [said('在, 能听见。你是想让我把调研的事往后推推, 还是别的事?')];
    expect(isLikelyEcho('蚌埠明天天气怎么样，冷吗？', recent, now)).toBe(false);
    expect(isLikelyEcho('更具有情绪化的表达，生气、开心。', recent, now)).toBe(false);
  });

  it('接着它的话说 (复述几个字) 不算回声', () => {
    const recent = [said('要不要我挑一个, 用整段话给你演一遍?')];
    expect(isLikelyEcho('好啊你挑一个开心的演一下', recent, now)).toBe(false);
  });

  it('太久以前说的不算; 很短的回答不判', () => {
    expect(isLikelyEcho('我在听着呢你说吧', [said('我在听着呢, 你说吧', 30_000)], now)).toBe(false);
    expect(isLikelyEcho('好的', [said('好的')], now)).toBe(false);
  });

  it('单字重合不计', () => {
    expect(echoCoverage('我的了是', '的了我是')).toBe(0);
  });
});
