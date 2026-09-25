/**
 * Workspace history excludes missing directories so usable projects remain visible in /workspace.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkspaceHistory } from './workspaceHistory.js';

const HOME = '/Users/tester';
let root = '';
let live1 = '';
let live2 = '';
let dead = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'neox-wsh-'));
  live1 = join(root, 'alive-a');
  live2 = join(root, 'alive-b');
  dead = join(root, 'was-here-yesterday');
  mkdirSync(live1);
  mkdirSync(live2);
  /* dead 故意不创建 —— 模拟"当时打开过, 现在目录没了" */
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('getWorkspaceHistory', () => {
  it('把已经不存在的目录剔掉', () => {
    const out = getWorkspaceHistory(live1, [dead, live2], HOME);
    expect(out).toContain(live2);
    expect(out).not.toContain(dead);
  });

  it('当前工作区永远在第一位, 即便 stat 不到也保留 (否则列表里没有"我在哪")', () => {
    const ghostCwd = join(root, 'ghost-cwd');
    const out = getWorkspaceHistory(ghostCwd, [live1], HOME);
    expect(out[0]).toBe(ghostCwd);
    expect(out).toContain(live1);
  });

  it('去重: 同一路径重复出现只留一条', () => {
    const out = getWorkspaceHistory(live1, [live2, live2, live1], HOME);
    expect(out.filter((p) => p === live2)).toHaveLength(1);
    expect(out.filter((p) => p === live1)).toHaveLength(1);
  });

  it('全是死路径时只剩当前工作区', () => {
    const out = getWorkspaceHistory(live1, [dead, join(root, 'nope-2')], HOME);
    expect(out).toEqual([live1]);
  });
});
