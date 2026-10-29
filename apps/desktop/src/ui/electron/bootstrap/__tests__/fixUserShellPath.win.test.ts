import { describe, it, expect } from 'vitest';
import { expandWinVars, mergeWinPath } from '../fixUserShellPath';

describe('expandWinVars', () => {
  it('展开存在的变量', () => {
    const env = { NVM_SYMLINK: 'D:\\nvm4w\\nodejs' } as NodeJS.ProcessEnv;
    expect(expandWinVars('C:\\a;%NVM_SYMLINK%;C:\\b', env)).toBe('C:\\a;D:\\nvm4w\\nodejs;C:\\b');
  });

  it('大小写不敏感 —— Windows 变量名本来就不区分大小写', () => {
    const env = { nvm_symlink: 'D:\\nvm4w\\nodejs' } as NodeJS.ProcessEnv;
    expect(expandWinVars('%NVM_SYMLINK%', env)).toBe('D:\\nvm4w\\nodejs');
  });

  it('展不开的原样留着, 不删', () => {
    /* 删掉等于凭空少一段路径 —— 而那一段可能是用户唯一能找到某个工具的地方 */
    expect(expandWinVars('C:\\a;%NOT_SET%;C:\\b', {} as NodeJS.ProcessEnv))
      .toBe('C:\\a;%NOT_SET%;C:\\b');
  });

  it('空值变量按"展不开"处理', () => {
    const env = { EMPTY: '' } as NodeJS.ProcessEnv;
    expect(expandWinVars('%EMPTY%', env)).toBe('%EMPTY%');
  });
});

describe('mergeWinPath — 只增不减', () => {
  const env = { NVM_SYMLINK: 'D:\\nvm4w\\nodejs' } as NodeJS.ProcessEnv;

  it('把注册表里的新路径并进来 (用户实测场景)', () => {
    const out = mergeWinPath('C:\\Windows\\system32', 'C:\\Windows\\system32;%NVM_SYMLINK%', env);
    expect(out.split(';')).toContain('D:\\nvm4w\\nodejs');
  });

  it('注册表读空时, 结果仍包含原 PATH 全部条目', () => {
    const current = 'C:\\a;C:\\b;C:\\c';
    const out = mergeWinPath(current, '', env);
    for (const e of current.split(';')) expect(out.split(';')).toContain(e);
  });

  it('注册表内容是垃圾时也不丢原有条目', () => {
    const current = 'C:\\a;C:\\b';
    const out = mergeWinPath(current, '%%%;;;   ;%NOPE%', env);
    for (const e of current.split(';')) expect(out.split(';')).toContain(e);
  });

  it('去重且保序 —— 原 PATH 的顺序不能被打乱', () => {
    const out = mergeWinPath('C:\\a;C:\\b', 'C:\\b;C:\\z', env).split(';');
    expect(out).toEqual(['C:\\a', 'C:\\b', 'C:\\z']);
  });

  it('去重忽略大小写与尾部反斜杠', () => {
    const out = mergeWinPath('C:\\A\\', 'c:\\a', env).split(';');
    expect(out).toHaveLength(1);
  });

  it('原 PATH 里没展开的 %VAR% 也会被展开 (继承自更早进程的情况)', () => {
    const out = mergeWinPath('%NVM_SYMLINK%', '', env);
    expect(out).toBe('D:\\nvm4w\\nodejs');
  });
});
