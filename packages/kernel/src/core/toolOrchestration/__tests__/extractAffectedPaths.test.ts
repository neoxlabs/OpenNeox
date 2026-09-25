/**
 * W2 wire 测试: defaultExtractAffectedPaths 增强后, 复杂 args 形态 (hunks/paths
 * array/contents_by_path map/target/dest) 全部被覆盖, 不漏文件冲突检测.
 *
 * Tool.getAffectedResources 接入点由 batch.ts 调用, integration 测试在
 * batch.test 完成. 这里只测 default 提取器自身.
 */

import { describe, it, expect } from 'vitest';

/* defaultExtractAffectedPaths 是 batch.ts 内部 function, 不 export. 通过 batch.ts
 * 暴露的 OrchestratedBatchOptions.extractAffectedPaths 默认值间接验证.
 * 直接 import 内部 fn 需要导出 — 让我用 dynamic import 或 read 出来.
 *
 * 简化: 重新实现一个跟 batch.ts defaultExtractAffectedPaths 等价的本地版供测试.
 * (如果 batch.ts 的内部实现改了, 这里测试也要同步改 — 但只有一处真实逻辑.)
 *
 * 实际上更稳: 把 defaultExtractAffectedPaths export 出来, 然后直接测.
 */

import { defaultExtractAffectedPathsForTesting } from '../batch.js';

const extract = defaultExtractAffectedPathsForTesting;

describe('defaultExtractAffectedPaths — W2 增强', () => {
  it('单字段 file_path 提取', () => {
    expect(extract('edit', { file_path: '/a.ts' })).toEqual(['/a.ts']);
  });

  it('多个单字段同时存在 — 都收集', () => {
    expect(extract('rename_file', { old_path: '/a.ts', new_path: '/b.ts' }))
      .toEqual(['/a.ts', '/b.ts']);
  });

  it('target / dest / destination 字段', () => {
    expect(extract('mv', { target: '/a.ts', dest: '/b.ts' })).toEqual(['/a.ts', '/b.ts']);
    expect(extract('cp', { destination: '/c.ts' })).toEqual(['/c.ts']);
  });

  it('paths array — 字符串数组', () => {
    expect(extract('multi_edit', { paths: ['/a.ts', '/b.ts', '/c.ts'] }))
      .toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('hunks — multi-file edit 批 hunks', () => {
    const args = {
      hunks: [
        { file_path: '/a.ts', start_line: 1, new_string: 'x' },
        { file_path: '/b.ts', start_line: 5, new_string: 'y' },
        { file_path: '/a.ts', start_line: 10, new_string: 'z' },  // 重复
      ],
    };
    const result = extract('edit', args);
    /* 应该有 /a.ts 和 /b.ts, 去重 */
    expect(new Set(result)).toEqual(new Set(['/a.ts', '/b.ts']));
  });

  it('hunks — 兼容 filePath / path 字段名', () => {
    const args = {
      hunks: [
        { filePath: '/a.ts' },
        { path: '/b.ts' },
        { file_path: '/c.ts' },
      ],
    };
    expect(new Set(extract('edit', args))).toEqual(new Set(['/a.ts', '/b.ts', '/c.ts']));
  });

  it('contents_by_path — map 形态', () => {
    const args = {
      contents_by_path: {
        '/a.ts': 'content a',
        '/b.ts': 'content b',
      },
    };
    expect(new Set(extract('write_batch', args))).toEqual(new Set(['/a.ts', '/b.ts']));
  });

  it('files_by_path — alt map 字段名', () => {
    expect(new Set(extract('w', { files_by_path: { '/x.ts': 'c' } }))).toEqual(new Set(['/x.ts']));
  });

  it('files — 第三种 map 字段名', () => {
    expect(new Set(extract('w', { files: { '/y.ts': 'c' } }))).toEqual(new Set(['/y.ts']));
  });

  it('混合形态: 单字段 + hunks + paths + map 全提取 + 去重', () => {
    const args = {
      file_path: '/a.ts',
      hunks: [{ file_path: '/b.ts' }],
      paths: ['/c.ts', '/a.ts'],  // /a.ts 重复
      contents_by_path: { '/d.ts': 'x' },
    };
    expect(new Set(extract('edit', args))).toEqual(new Set(['/a.ts', '/b.ts', '/c.ts', '/d.ts']));
  });

  it('空 args / 没相关字段 → 空数组', () => {
    expect(extract('cmd', {})).toEqual([]);
    expect(extract('cmd', { unrelated: 'x' })).toEqual([]);
  });

  it('字段值非 string → 跳过', () => {
    const args = {
      file_path: 123 as any,
      paths: ['/a.ts', null as any, undefined as any, 456 as any],
      hunks: [{ file_path: null as any }, { file_path: '/b.ts' }],
    };
    expect(new Set(extract('edit', args))).toEqual(new Set(['/a.ts', '/b.ts']));
  });

  it('空字符串路径 → 跳过', () => {
    expect(extract('edit', { file_path: '' })).toEqual([]);
    expect(extract('edit', { paths: ['', '/a.ts'] })).toEqual(['/a.ts']);
  });

  it('hunks 中 hunk 不是 object → 跳过', () => {
    const args = {
      hunks: [null, 'not-an-object', { file_path: '/a.ts' }, 123],
    };
    expect(extract('edit', args as any)).toEqual(['/a.ts']);
  });

  it('map 值不重要, 只取 key 当路径', () => {
    const args = {
      contents_by_path: {
        '/a.ts': null,
        '/b.ts': 12345,
        '/c.ts': { complex: 'object' },
      },
    };
    expect(new Set(extract('w', args as any))).toEqual(new Set(['/a.ts', '/b.ts', '/c.ts']));
  });
});
