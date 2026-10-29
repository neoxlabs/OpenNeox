import { describe, expect, it } from 'vitest';
import { displayWorkspaceName } from '../modeHomeName';

describe('displayWorkspaceName', () => {
  it('目录名固定英文后, 中文界面仍显示中文名', () => {
    expect(displayWorkspaceName('/Users/a/Documents/Neox/Code', null, true)).toBe('编码');
    expect(displayWorkspaceName('C:\\Users\\a\\Documents\\Neox\\Work', null, true)).toBe('工作');
  });

  it('英文界面显示英文名', () => {
    expect(displayWorkspaceName('/Users/a/Documents/Neox/Code', null, false)).toBe('Code');
  });

  it('老用户的中文目录照样能显示成本语言', () => {
    expect(displayWorkspaceName('/Users/a/Documents/Neox/编码', null, false)).toBe('Code');
    expect(displayWorkspaceName('/Users/a/Documents/Neox/编码', '编码', false)).toBe('Code');
    expect(displayWorkspaceName('/Users/a/Documents/Neox/工作', null, true)).toBe('工作');
  });

  it('用户自己改过名的不动', () => {
    expect(displayWorkspaceName('/Users/a/Documents/Neox/编码', '我的沙箱', false)).toBe('我的沙箱');
  });

  it('不在 Documents/Neox 下的同名项目不动', () => {
    expect(displayWorkspaceName('/Users/a/projects/Code', null, true)).toBe('Code');
  });
});
