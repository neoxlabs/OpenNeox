import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSmartWorkspaceWatchRoots,
  isEventInWatchScope,
  shouldPreferSmartWorkspaceWatchRoots,
} from '../watch/WatchCoordinator.js';

function makeTempWorkspace(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

describe('WatchCoordinator smart roots', () => {
  it('includes broad top-level project roots and skips ignored ones', () => {
    const workspace = makeTempWorkspace('watch-roots');
    try {
      fs.mkdirSync(path.join(workspace, 'src'));
      fs.mkdirSync(path.join(workspace, 'backend'));
      fs.mkdirSync(path.join(workspace, 'custom-zone'));
      fs.mkdirSync(path.join(workspace, 'node_modules'));
      fs.mkdirSync(path.join(workspace, '.git'));
      fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
      fs.writeFileSync(path.join(workspace, 'README.md'), '# demo');

      const roots = computeSmartWorkspaceWatchRoots(workspace).map((entry) => path.relative(workspace, entry));

      expect(roots).toContain('src');
      expect(roots).toContain('backend');
      expect(roots).toContain('custom-zone');
      expect(roots).toContain('package.json');
      expect(roots).not.toContain('node_modules');
      expect(roots).not.toContain('.git');
      expect(roots).not.toContain('');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('caps smart watch roots under budget and keeps priority paths', () => {
    const workspace = makeTempWorkspace('watch-budget');
    try {
      fs.mkdirSync(path.join(workspace, 'src'));
      fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
      for (let index = 0; index < 40; index += 1) {
        fs.mkdirSync(path.join(workspace, `feature-${index}`));
      }

      const roots = computeSmartWorkspaceWatchRoots(workspace).map((entry) => path.relative(workspace, entry));
      const pressuredRoots = computeSmartWorkspaceWatchRoots(workspace, { budget: 8, customBudget: 2 })
        .map((entry) => path.relative(workspace, entry));

      expect(roots.length).toBeLessThanOrEqual(24);
      expect(roots).toContain('src');
      expect(roots).toContain('package.json');
      expect(pressuredRoots.length).toBeLessThanOrEqual(8);
      expect(pressuredRoots).toContain('src');
      expect(pressuredRoots).toContain('package.json');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('only enables proactive smart mode for larger workspaces', () => {
    const smallWorkspace = makeTempWorkspace('watch-small');
    const largeWorkspace = makeTempWorkspace('watch-large');
    try {
      fs.mkdirSync(path.join(smallWorkspace, 'src'));
      fs.writeFileSync(path.join(smallWorkspace, 'package.json'), '{}');

      for (const dir of ['src', 'app', 'lib', 'packages', 'docs', 'scripts', 'backend', 'frontend']) {
        fs.mkdirSync(path.join(largeWorkspace, dir));
      }

      expect(shouldPreferSmartWorkspaceWatchRoots(smallWorkspace)).toBe(false);
      expect(shouldPreferSmartWorkspaceWatchRoots(largeWorkspace)).toBe(true);
    } finally {
      fs.rmSync(smallWorkspace, { recursive: true, force: true });
      fs.rmSync(largeWorkspace, { recursive: true, force: true });
    }
  });
});

/* 监听范围包含根目录的直接子项，使新建文件可以在重启前进入索引。
 * computeSmartWorkspaceWatchRoots 给出顶层目录和初始化时已存在的顶层文件，
 * 因此根目录直接子项也必须通过作用域判断。 */
describe('WatchCoordinator 监听范围', () => {
  const ROOT = '/ws';
  /* roots 包含顶层目录和初始化时存在的顶层文件。 */
  const ROOTS = ['/ws/src', '/ws/surfaces', '/ws/calc.js', '/ws/package.json'];

  it('bootstrap 时就存在的顶层文件, 改动能收到', () => {
    expect(isEventInWatchScope('/ws/calc.js', ROOTS, ROOT)).toBe(true);
  });

  it('监听目录下的文件 (含新建) 能收到', () => {
    expect(isEventInWatchScope('/ws/surfaces/inside.js', ROOTS, ROOT)).toBe(true);
    expect(isEventInWatchScope('/ws/src/a/b/deep.ts', ROOTS, ROOT)).toBe(true);
  });

  it('**根目录新建的文件也要收到** —— 这条是本次修的洞', () => {
    expect(isEventInWatchScope('/ws/brand.js', ROOTS, ROOT)).toBe(true);
    expect(isEventInWatchScope('/ws/App.tsx', ROOTS, ROOT)).toBe(true);
    expect(isEventInWatchScope('/ws/main.py', ROOTS, ROOT)).toBe(true);
  });

  it('放行只到直接子项这一层: 被忽略目录里的东西仍然挡住', () => {
    expect(isEventInWatchScope('/ws/node_modules/foo/index.js', ROOTS, ROOT)).toBe(false);
    expect(isEventInWatchScope('/ws/.git/objects/ab/cd', ROOTS, ROOT)).toBe(false);
    expect(isEventInWatchScope('/ws/dist/bundle.js', ROOTS, ROOT)).toBe(false);
  });

  it('工作区之外的路径不收', () => {
    expect(isEventInWatchScope('/other/x.js', ROOTS, ROOT)).toBe(false);
    /* 前缀相同但不是同一个目录 (/wsx) 不许误判 */
    expect(isEventInWatchScope('/wsx/x.js', ROOTS, ROOT)).toBe(false);
  });

  it('没有 rootDir 时退回纯 roots 判据, 不放行任何多余的', () => {
    expect(isEventInWatchScope('/ws/brand.js', ROOTS, null)).toBe(false);
    expect(isEventInWatchScope('/ws/calc.js', ROOTS, null)).toBe(true);
  });
});
