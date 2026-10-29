import { describe, it, expect } from 'vitest';

/** 跟 mapTimeline.ts 里那段保持一致 —— 这里是它的可测镜像 */
function stripDirective(text: string): string {
  return text
    .replace(/<neox-directive>[\s\S]*?<\/neox-directive>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

describe('<neox-directive> 剥壳', () => {
  it('气泡里只剩用户原话', () => {
    const sent = '给我设计开发一个宠物管理系统\n\n<neox-directive>先调 team_run({ goal }) 进入团队规划态…</neox-directive>';
    expect(stripDirective(sent)).toBe('给我设计开发一个宠物管理系统');
  });

  it('指令里的换行 / 括号 / 函数名不会漏出来', () => {
    const sent = '做个记事本\n\n<neox-directive>递归拆需求树\n→ 定编制\n→ team_execute({confirm:true})</neox-directive>';
    const shown = stripDirective(sent);
    expect(shown).toBe('做个记事本');
    for (const leak of ['team_execute', 'team_run', 'plan_target', 'confirm', '递归拆']) {
      expect(shown).not.toContain(leak);
    }
  });

  it('没有指令的普通消息原样不动', () => {
    expect(stripDirective('就是一句普通的话')).toBe('就是一句普通的话');
  });

  it('多段指令都剥掉', () => {
    const sent = 'A\n\n<neox-directive>x</neox-directive>\n\nB\n\n<neox-directive>y</neox-directive>';
    expect(stripDirective(sent)).toBe('A\n\nB');
  });

  it('只有指令时剩空 —— 调用方不该这么用, 但不能炸', () => {
    expect(stripDirective('<neox-directive>only</neox-directive>')).toBe('');
  });
});
