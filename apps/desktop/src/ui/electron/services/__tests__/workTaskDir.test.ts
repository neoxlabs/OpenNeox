import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { isInsideDir, pickFreeDir, taskFolderTitle } from '../workTaskDir';

describe('taskFolderTitle', () => {
  it('取首条消息第一行, 最多 20 个字, 截断处不留标点', () => {
    expect(taskFolderTitle('\n  做一份秋季跑步入门的 PPT，给新手看\n第二行')).toBe('做一份秋季跑步入门的 PPT');
    expect(taskFolderTitle('做一份介绍杭州西湖四季风景和周边美食的旅游攻略文档给朋友看')).toBe('做一份介绍杭州西湖四季风景和周边美食的旅');
    expect(taskFolderTitle('写周报。')).toBe('写周报');
    expect(taskFolderTitle('好的，写个周报')).toBe('好的，写个周报');
  });
  it('去掉文件名不认的字符和开头的点', () => {
    expect(taskFolderTitle('..a/b:c*d?"e"<f>|g')).toBe('a b c d e f g');
  });
  it('全是空白/符号时退回「任务」', () => {
    expect(taskFolderTitle('   ')).toBe('任务');
    expect(taskFolderTitle('///')).toBe('任务');
  });
});

describe('pickFreeDir', () => {
  it('重名加 (2) (3)', () => {
    const taken = new Set([path.join('/w', '2026-10-14 周报'), path.join('/w', '2026-10-14 周报 (2)')]);
    expect(pickFreeDir('/w', '2026-10-14 周报', (p) => taken.has(p))).toBe(path.join('/w', '2026-10-14 周报 (3)'));
    expect(pickFreeDir('/w', '新的', (p) => taken.has(p))).toBe(path.join('/w', '新的'));
  });
});

describe('isInsideDir', () => {
  it('只认真正的子目录', () => {
    expect(isInsideDir('/a/工作/2026-10-14 x', '/a/工作')).toBe(true);
    expect(isInsideDir('/a/工作', '/a/工作')).toBe(false);
    expect(isInsideDir('/a/工作区', '/a/工作')).toBe(false);
    expect(isInsideDir('/a', '/a/工作')).toBe(false);
  });
});
