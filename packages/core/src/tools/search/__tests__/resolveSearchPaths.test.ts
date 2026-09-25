/**
 * resolveSearchPaths Unit Tests
 *
 * 多路径解析覆盖:
 * - paths[] 优先, 没给退到 searchPath 单值, 都没给退到 '.' (cwd)
 * - dedup 同 absPath 输入 (顺序保留首次出现)
 * - aggregateResolvedFrom: 全同 → 该值; 不同 → 'mixed'
 * - 单路径 resolveSearchPath 仍 backwards compat
 *
 * 不测真实 fs (workspace/ancestor 分支需要真目录), 用纯 mock 函数控制 resolveWorkspacePath
 * + tmp dir 给绝对路径分支用.
 */

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { resolveSearchPath, resolveSearchPaths } from '../resolveSearchPath.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neox-search-test-'));
fs.mkdirSync(path.join(tmpDir, 'core'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'cli'), { recursive: true });

const workspaceRoot = tmpDir;
const resolveWorkspacePath = (requestedPath?: string): string => {
  if (!requestedPath || requestedPath === '.') return workspaceRoot;
  if (path.isAbsolute(requestedPath)) return requestedPath;
  return path.resolve(workspaceRoot, requestedPath);
};

describe('resolveSearchPaths', () => {
  it('paths[] 多路径正确解析', () => {
    const result = resolveSearchPaths({
      paths: ['core', 'cli'],
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.resolutions).toHaveLength(2);
    expect(result.resolutions[0].absPath).toBe(path.join(workspaceRoot, 'core'));
    expect(result.resolutions[1].absPath).toBe(path.join(workspaceRoot, 'cli'));
    expect(result.uniqueAbsPaths).toHaveLength(2);
    expect(result.aggregateResolvedFrom).toBe('workspace');
  });

  it('paths[] 空数组退到 searchPath 单值', () => {
    const result = resolveSearchPaths({
      paths: [],
      searchPath: 'core',
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0].absPath).toBe(path.join(workspaceRoot, 'core'));
    expect(result.aggregateResolvedFrom).toBe('workspace');
  });

  it('paths/searchPath 都没给 → 解析到 cwd ".", absPath=workspaceRoot', () => {
    const result = resolveSearchPaths({
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.resolutions).toHaveLength(1);
    expect(result.resolutions[0].absPath).toBe(workspaceRoot);
    expect(result.resolutions[0].resolvedFrom).toBe('workspace');
  });

  it('dedup 重复路径只保留一份', () => {
    const result = resolveSearchPaths({
      paths: ['core', 'core', 'cli'],
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.resolutions).toHaveLength(3); // 解析结果保留三个 (input 顺序)
    expect(result.uniqueAbsPaths).toHaveLength(2); // dedup 后两个
    expect(result.uniqueAbsPaths[0]).toBe(path.join(workspaceRoot, 'core'));
    expect(result.uniqueAbsPaths[1]).toBe(path.join(workspaceRoot, 'cli'));
  });

  it('混合 absolute + workspace → aggregateResolvedFrom=mixed', () => {
    const absPath = path.join(tmpDir, 'cli');
    const result = resolveSearchPaths({
      paths: ['core', absPath],
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.resolutions[0].resolvedFrom).toBe('workspace');
    expect(result.resolutions[1].resolvedFrom).toBe('absolute');
    expect(result.aggregateResolvedFrom).toBe('mixed');
  });

  it('全 absolute → aggregateResolvedFrom=absolute', () => {
    const a = path.join(tmpDir, 'core');
    const b = path.join(tmpDir, 'cli');
    const result = resolveSearchPaths({
      paths: [a, b],
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.aggregateResolvedFrom).toBe('absolute');
  });

  it('paths[] 含路径里的空格 (e.g. "My Docs") 不做拆分', () => {
    fs.mkdirSync(path.join(tmpDir, 'My Docs'), { recursive: true });
    const result = resolveSearchPaths({
      paths: ['My Docs'],
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.resolutions[0].absPath).toBe(path.join(workspaceRoot, 'My Docs'));
  });
});

describe('resolveSearchPath (单路径 backcompat)', () => {
  it('直接调单路径函数仍正常工作', () => {
    const result = resolveSearchPath({
      searchPath: 'core',
      workspaceRoot,
      resolveWorkspacePath,
    });
    expect(result.absPath).toBe(path.join(workspaceRoot, 'core'));
    expect(result.resolvedFrom).toBe('workspace');
  });
});
