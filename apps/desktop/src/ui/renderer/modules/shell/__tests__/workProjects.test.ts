import { describe, expect, it } from 'vitest';
import { groupProjects, projectOfTask, tasksByProject, type WorkProject } from '../workProjects';

const P = (name: string, extra: Partial<WorkProject> = {}): WorkProject => ({
  dir: `/u/Documents/Neox/工作/${name}`, name, icon: 'cup', pinned: false, archived: false, createdAt: 0, ...extra,
});

describe('projectOfTask', () => {
  const list = [P('咖啡店运营'), P('期末复习')];
  it('任务文件夹的上一级是项目', () => {
    expect(projectOfTask('/u/Documents/Neox/工作/咖啡店运营/2026-10-14 周报', list)?.name).toBe('咖啡店运营');
  });
  it('还没开工的「<项目>/」就是项目本身', () => {
    expect(projectOfTask('/u/Documents/Neox/工作/期末复习/', list)?.name).toBe('期末复习');
  });
  it('不在项目里的任务 / 没有文件夹的老任务 → 没有项目', () => {
    expect(projectOfTask('/u/Documents/Neox/工作/2026-10-14 写 hello', list)).toBeUndefined();
    expect(projectOfTask(null, list)).toBeUndefined();
  });
});

describe('groupProjects', () => {
  it('置顶 / 最近用过最多 3 个 / 其他按名称; 归档的不出现', () => {
    const list = [P('甲', { pinned: true }), P('乙'), P('丙'), P('丁'), P('戊'), P('己', { archived: true })];
    const used = new Map([[P('乙').dir, 5], [P('丙').dir, 9], [P('丁').dir, 7], [P('戊').dir, 1], [P('己').dir, 99]]);
    const g = groupProjects(list, used);
    expect(g.pinned.map((p) => p.name)).toEqual(['甲']);
    expect(g.recent.map((p) => p.name)).toEqual(['丙', '丁', '乙']);
    expect(g.rest.map((p) => p.name)).toEqual(['戊']);
  });
});

describe('tasksByProject', () => {
  it('按项目归任务, 新的在前', () => {
    const list = [P('咖啡店运营')];
    const m = tasksByProject([
      { id: 'a', taskDir: '/u/Documents/Neox/工作/咖啡店运营/2026-10-01 x', updatedAt: 1 },
      { id: 'b', taskDir: '/u/Documents/Neox/工作/咖啡店运营/', updatedAt: 3 },
      { id: 'c', taskDir: '/u/Documents/Neox/工作/2026-10-02 y', updatedAt: 2 },
    ], list);
    expect(m.get(P('咖啡店运营').dir)?.map((s) => s.id)).toEqual(['b', 'a']);
  });
});
