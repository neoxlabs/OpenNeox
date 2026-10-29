import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recoverRenamedTaskPath } from '../recoverRenamedTaskPath';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function setup(): string {
  root = mkdtempSync(path.join(tmpdir(), 'neox-recover-'));
  const work = path.join(root, '工作');
  mkdirSync(path.join(work, '2026-10-19 制作安徽手机维修连锁商务PPT', 'deck'), { recursive: true });
  writeFileSync(path.join(work, '2026-10-19 制作安徽手机维修连锁商务PPT', 'deck', '品牌 · 介绍.pptx'), 'x');
  mkdirSync(path.join(work, '2026-10-19 另一个任务'), { recursive: true });
  return work;
}

describe('recoverRenamedTaskPath', () => {
  it('存在的路径原样返回', () => {
    const work = setup();
    const p = path.join(work, '2026-10-19 制作安徽手机维修连锁商务PPT', 'deck', '品牌 · 介绍.pptx');
    expect(recoverRenamedTaskPath(p)).toBe(p);
  });

  it('任务文件夹被改名后, 按同日期前缀 + 相对路径找回', () => {
    const work = setup();
    const old = path.join(work, '2026-10-19 做一份6页PPT：介绍安徽一家手机维修连 (2)', 'deck', '品牌 · 介绍.pptx');
    expect(recoverRenamedTaskPath(old)).toBe(path.join(work, '2026-10-19 制作安徽手机维修连锁商务PPT', 'deck', '品牌 · 介绍.pptx'));
  });

  it('找不到就返回 null (不乱指)', () => {
    const work = setup();
    expect(recoverRenamedTaskPath(path.join(work, '2026-10-18 旧任务', 'a.pptx'))).toBeNull();
  });
});
