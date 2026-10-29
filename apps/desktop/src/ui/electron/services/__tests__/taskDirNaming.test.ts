/**
 * work:Q-12 任务文件夹名由模型生成并异步回填
 * ═══════════════════════════════════════════════════════════════════════
 * 锁三件事:
 *   1. 名字保留日期前缀 (排序不乱), 清洗掉文件名不认的字符;
 *   2. 真改名: 文件夹跟着改, DB 的 task_dir 跟着换, 只做一次;
 *   3. 任何异常 (文件夹被删 / 已经改过 / rename 报错) 都静默保持原名。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  nextTaskDirName, applyTaskDirTitle, queueTaskDirRename, flushTaskDirRenames,
  hasPendingTaskDirRename, resetTaskDirRenameQueue, type TaskDirRenameDeps,
} from '../taskDirNaming';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-taskname-')); resetTaskDirRenameQueue(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** 一个假 DB: 只记 task_dir 和「改过名」标记 */
function deps(overrides: Partial<TaskDirRenameDeps> = {}): TaskDirRenameDeps & { dirs: Map<string, string | null>; named: Set<string>; notified: number } {
  const dirs = new Map<string, string | null>();
  const named = new Set<string>();
  const d = {
    dirs,
    named,
    notified: 0,
    exists: (p: string) => fs.existsSync(p),
    rename: (from: string, to: string) => fs.renameSync(from, to),
    getTaskDir: (id: string) => dirs.get(id) ?? null,
    setTaskDir: (id: string, dir: string | null) => { dirs.set(id, dir); },
    isNamed: (id: string) => named.has(id),
    markNamed: (id: string) => { named.add(id); },
    now: () => new Date('2026-10-18T10:00:00'),
    notify: () => { d.notified += 1; },
    ...overrides,
  };
  return d as any;
}

const mkTaskDir = (name = '2026-10-14 关') => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '周报.docx'), 'x');
  return dir;
};

describe('nextTaskDirName', () => {
  it('保留原日期前缀, 换成模型给的名字, 清洗非法字符', () => {
    expect(nextTaskDirName('/w/2026-10-14 关', '第 41 周周报/咖啡店', new Date()))
      .toBe('2026-10-14 第 41 周周报 咖啡店');
  });
  it('原文件夹没有日期前缀时补今天的', () => {
    expect(nextTaskDirName('/w/关', '季度复盘', new Date('2026-10-18T10:00:00')))
      .toBe('2026-10-18 季度复盘');
  });
  it('名字清洗后为空 (纯标点) → null, 保持原名', () => {
    expect(nextTaskDirName('/w/2026-10-14 关', '///', new Date())).toBeNull();
    expect(nextTaskDirName('/w/2026-10-14 关', '  ', new Date())).toBeNull();
  });
});

describe('applyTaskDirTitle', () => {
  it('真改名: 文件夹换名、内容跟着走、DB 跟着换、只通知一次', () => {
    const dir = mkTaskDir();
    const d = deps();
    d.dirs.set('s1', dir);
    const r = applyTaskDirTitle('s1', '第 41 周周报', d);
    expect(r.renamed).toBe(true);
    const expected = path.join(root, '2026-10-14 第 41 周周报');
    expect(r.dir).toBe(expected);
    expect(fs.existsSync(expected)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(expected, '周报.docx'))).toBe(true);
    expect(d.dirs.get('s1')).toBe(expected);
    expect(d.notified).toBe(1);
  });

  it('只改一次: 已经回填过就不再动', () => {
    const dir = mkTaskDir();
    const d = deps();
    d.dirs.set('s1', dir);
    applyTaskDirTitle('s1', '第一版名字', d);
    const renamed = d.dirs.get('s1')!;
    const again = applyTaskDirTitle('s1', '第二版名字', d);
    expect(again).toEqual({ renamed: false, reason: 'already-named' });
    expect(d.dirs.get('s1')).toBe(renamed);
  });

  it('新名字和现在一样 → 不改名, 但记下已经定过名', () => {
    const dir = mkTaskDir('2026-10-14 周报');
    const d = deps();
    d.dirs.set('s1', dir);
    expect(applyTaskDirTitle('s1', '周报', d)).toEqual({ renamed: false, dir, reason: 'already-named' });
    expect(d.named.has('s1')).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('同名文件夹已存在 → 加 (2), 不覆盖别人的任务', () => {
    const dir = mkTaskDir('2026-10-14 关');
    fs.mkdirSync(path.join(root, '2026-10-14 周报'));
    const d = deps();
    d.dirs.set('s1', dir);
    const r = applyTaskDirTitle('s1', '周报', d);
    expect(r.dir).toBe(path.join(root, '2026-10-14 周报 (2)'));
    expect(fs.existsSync(path.join(root, '2026-10-14 周报'))).toBe(true);
  });

  it('文件夹被用户删了 → 不复活, 保持现状', () => {
    const d = deps();
    d.dirs.set('s1', path.join(root, '2026-10-14 不存在'));
    expect(applyTaskDirTitle('s1', '周报', d)).toEqual({ renamed: false, reason: 'missing' });
  });

  it('不是 Work 任务 (没有 task_dir / 只定了项目) → 不动', () => {
    const d = deps();
    expect(applyTaskDirTitle('s1', '周报', d)).toEqual({ renamed: false, reason: 'no-task-dir' });
    d.dirs.set('s2', path.join(root, '咖啡店运营') + path.sep);
    expect(applyTaskDirTitle('s2', '周报', d)).toEqual({ renamed: false, reason: 'no-task-dir' });
  });

  it('rename 报错 → 静默失败, DB 还是旧路径', () => {
    const dir = mkTaskDir();
    const d = deps({ rename: () => { throw new Error('EPERM'); } });
    d.dirs.set('s1', dir);
    expect(applyTaskDirTitle('s1', '周报', d)).toEqual({ renamed: false, reason: 'failed' });
    expect(d.dirs.get('s1')).toBe(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('排队与落盘', () => {
  it('标题到了先排队, 落盘时改名', () => {
    const dir = mkTaskDir();
    const d = deps();
    d.dirs.set('s1', dir);
    queueTaskDirRename('s1', '第 41 周周报');
    expect(hasPendingTaskDirRename('s1')).toBe(true);
    expect(flushTaskDirRenames('s1', d).renamed).toBe(true);
    expect(hasPendingTaskDirRename('s1')).toBe(false);
  });

  it('没有排队的名字 → 什么也不做', () => {
    const d = deps();
    expect(flushTaskDirRenames('s1', d)).toEqual({ renamed: false, reason: 'empty-title' });
  });

  it('后到的标题覆盖前一个 (取最新的模型判断)', () => {
    const dir = mkTaskDir();
    const d = deps();
    d.dirs.set('s1', dir);
    queueTaskDirRename('s1', '旧标题');
    queueTaskDirRename('s1', '第 41 周周报');
    const r = flushTaskDirRenames('s1', d);
    expect(path.basename(r.dir!)).toBe('2026-10-14 第 41 周周报');
  });

  it('空标题 / 空会话 id 不进队列', () => {
    queueTaskDirRename('s1', '   ');
    queueTaskDirRename('', '周报');
    expect(hasPendingTaskDirRename('s1')).toBe(false);
  });
});
