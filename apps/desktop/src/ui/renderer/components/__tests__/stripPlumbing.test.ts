import { describe, expect, it } from 'vitest';
import { stripPlumbing } from '../notifyEvents';

describe('剥掉管道前缀', () => {
  it('剥 Electron invoke 包装 + NeoxError 类名 (实拍那条)', () => {
    expect(stripPlumbing(
      `Error invoking remote method 'model:add': NeoxError: Model "mimo-v2.5" already exists for provider "opencode".`,
    )).toBe('Model "mimo-v2.5" already exists for provider "opencode".');
  });

  it('套了好几层也要剥干净', () => {
    expect(stripPlumbing(`Error invoking remote method 'a:b': Error: NeoxError: 真正的原因`))
      .toBe('真正的原因');
  });

  it('只有类名前缀时也剥', () => {
    expect(stripPlumbing('NeoxError: 配额不足')).toBe('配额不足');
    expect(stripPlumbing('Error: 网络超时')).toBe('网络超时');
  });
});

describe('⚠️ 不许把正文吃掉', () => {
  it('没有管道前缀的原样返回', () => {
    expect(stripPlumbing('模型 "x" 不存在')).toBe('模型 "x" 不存在');
  });

  it('正文里出现 Error 字样不受影响 (只认开头)', () => {
    expect(stripPlumbing('连接失败: Error while reading stream'))
      .toBe('连接失败: Error while reading stream');
  });

  it('剥完为空时退回原文 —— 宁可露前缀, 不给一个空 toast', () => {
    expect(stripPlumbing('NeoxError:')).toBe('NeoxError:');
    expect(stripPlumbing(`Error invoking remote method 'x:y':`))
      .toBe(`Error invoking remote method 'x:y':`);
  });

  it('空串不炸', () => {
    expect(stripPlumbing('')).toBe('');
  });
});
