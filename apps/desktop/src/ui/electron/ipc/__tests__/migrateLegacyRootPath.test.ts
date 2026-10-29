import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home };
});

beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'neox-legacyroot-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/* 老根搬家是商业版的历史包袱, 产物根按商业版 (~/Neox) 钉住 —— 公开树里 DISTRIBUTION 是开源版身份 */
async function load() {
  vi.resetModules();
  vi.doMock('@neoxlabs/kernel/platform/distribution.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@neoxlabs/kernel/platform/distribution.js')>();
    return { DISTRIBUTION: { ...actual.DISTRIBUTION, userRootDirname: 'Neox' } };
  });
  return import('../recoverRenamedTaskPath');
}

/** 造一个「数据已经在 ~/Neox/Work」的环境 */
function setupMoved(): string {
  const task = path.join(home, 'Neox', 'Work', '2026-10-19 某任务');
  mkdirSync(task, { recursive: true });
  writeFileSync(path.join(task, 'a.pptx'), 'x');
  return task;
}

describe('migrateLegacyRootPath (老根 → 新根)', () => {
  it('~/Documents/Neox/工作/… 改写成 ~/Neox/Work/…', async () => {
    setupMoved();
    const { migrateLegacyRootPath } = await load();
    const old = path.join(home, 'Documents', 'Neox', '工作', '2026-10-19 某任务', 'a.pptx');
    expect(migrateLegacyRootPath(old)).toBe(path.join(home, 'Neox', 'Work', '2026-10-19 某任务', 'a.pptx'));
  });

  it('编码 → Code, 领航 → Pilot', async () => {
    mkdirSync(path.join(home, 'Neox', 'Code', 'proj'), { recursive: true });
    mkdirSync(path.join(home, 'Neox', 'Pilot', 'room'), { recursive: true });
    const { migrateLegacyRootPath } = await load();
    expect(migrateLegacyRootPath(path.join(home, 'Documents', 'Neox', '编码', 'proj')))
      .toBe(path.join(home, 'Neox', 'Code', 'proj'));
    expect(migrateLegacyRootPath(path.join(home, 'Documents', 'Neox', '领航', 'room')))
      .toBe(path.join(home, 'Neox', 'Pilot', 'room'));
  });

  it('新位置不存在就不乱指 (返回 null)', async () => {
    const { migrateLegacyRootPath } = await load();
    expect(migrateLegacyRootPath(path.join(home, 'Documents', 'Neox', '工作', '没搬过来的任务'))).toBeNull();
  });

  it('不在老根下的路径不碰', async () => {
    const { migrateLegacyRootPath } = await load();
    expect(migrateLegacyRootPath('/tmp/somewhere/a.pptx')).toBeNull();
  });

  it('老根里非模式目录 (用户自己的) 不碰', async () => {
    mkdirSync(path.join(home, 'Neox', '生活'), { recursive: true });
    const { migrateLegacyRootPath } = await load();
    expect(migrateLegacyRootPath(path.join(home, 'Documents', 'Neox', '生活'))).toBeNull();
  });
});

describe('recoverRenamedTaskPath 先试根搬家', () => {
  it('老路径能通过根搬家找回', async () => {
    setupMoved();
    const { recoverRenamedTaskPath } = await load();
    const old = path.join(home, 'Documents', 'Neox', '工作', '2026-10-19 某任务', 'a.pptx');
    expect(recoverRenamedTaskPath(old)).toBe(path.join(home, 'Neox', 'Work', '2026-10-19 某任务', 'a.pptx'));
  });

  it('已经存在的路径原样返回, 不做多余改写', async () => {
    const task = setupMoved();
    const { recoverRenamedTaskPath } = await load();
    const p = path.join(task, 'a.pptx');
    expect(recoverRenamedTaskPath(p)).toBe(p);
    expect(existsSync(p)).toBe(true);
  });
});
