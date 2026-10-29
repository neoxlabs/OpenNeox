import { describe, expect, it } from 'vitest';
import { codeArt, stepRatio } from '../SidebarWorkbench';

const g = (o: Partial<{ activity: string; waiting: { kind: 'ask' | 'approval' | 'question'; text: string } | null; outputs: Array<{ path: string; ext: string }> }>) =>
  ({ waiting: null, activity: '', lastLine: '', lastTs: 0, ...o });

describe('codeArt —— Code 进行中卡片的陶土图按它在干嘛选', () => {
  it('跑测试 / 命令 → 终端; git → 分支; 网页 → 浏览器', () => {
    expect(codeArt('修复登录页', g({ activity: '跑测试 4/7' })).src).toMatch(/sfc-terminal/);
    expect(codeArt('提交并推送到 main', g({})).src).toMatch(/sfc-git/);
    expect(codeArt('打开网页截个图', g({})).src).toMatch(/sfc-web/);
  });
  it('等你批准 → 盾牌; 等你回复 → 对话气泡 (优先于标题关键词)', () => {
    expect(codeArt('跑测试', g({ waiting: { kind: 'approval', text: '' } })).src).toMatch(/set-shield/);
    expect(codeArt('跑测试', g({ waiting: { kind: 'question', text: '' } })).src).toMatch(/set-chat/);
  });
  it('有图片成品直接用本图; 文档成品用文档图', () => {
    const photo = codeArt('x', g({ outputs: [{ path: '/a/b.png', ext: 'png' }] }));
    expect(photo.photo).toBe(true);
    expect(codeArt('x', g({ outputs: [{ path: '/a/b.pdf', ext: 'pdf' }] })).src).toMatch(/sfc-pdf/);
  });
  it('什么都对不上 → 文件夹', () => {
    expect(codeArt('打个招呼', g({})).src).toMatch(/sfc-files/);
  });
});

describe('stepRatio', () => {
  it('「4/7」画进度, 没步数不画', () => {
    expect(stepRatio('跑测试 4/7')).toBeCloseTo(4 / 7);
    expect(stepRatio('正在处理…')).toBeNull();
    expect(stepRatio('9/3')).toBeNull();
  });
});
