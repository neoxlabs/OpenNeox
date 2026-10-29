/**
 * LOOP-17 · 压缩摘要固定含改动清单。
 *
 * 清单是**确定性**从 mutation 工具调用里扫出来的，不依赖摘要模型是否照做；
 * 滚动压缩时上一轮的清单会被携带并合并。
 */
import { describe, it, expect } from 'vitest';
import {
  collectChangedFiles,
  extractChangedFileLines,
  renderChangedFilesSection,
} from '../changedFilesDigest.js';
import type { Message } from '../../../types/index.js';

function assistant(calls: Array<[string, Record<string, any>]>): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: calls.map(([name, args], i) => ({
      id: `c${i}`,
      type: 'function' as const,
      function: { name, arguments: JSON.stringify(args) },
    })),
  } as any;
}

describe('collectChangedFiles', () => {
  it('同一文件多次 edit 合并成一条，hunk 数累加', () => {
    const entries = collectChangedFiles([
      assistant([['edit_file', { file_path: 'src/a.ts', hunks: [{}, {}] }]]),
      assistant([['edit', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }]]),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: 'src/a.ts', kind: 'edit', size: 3, count: 2 });
  });

  it('write 之后又 edit：保留 write 语义，只累计次数', () => {
    const entries = collectChangedFiles([
      assistant([['write_file', { file_path: 'src/b.ts', content: 'abc' }]]),
      assistant([['edit_file', { file_path: 'src/b.ts', hunks: [{}] }]]),
    ]);
    expect(entries[0]).toMatchObject({ path: 'src/b.ts', kind: 'write', size: 3, count: 2 });
  });

  it('delete 覆盖之前的状态', () => {
    const entries = collectChangedFiles([
      assistant([['edit_file', { file_path: 'src/c.ts', hunks: [{}] }]]),
      assistant([['delete_file', { path: 'src/c.ts' }]]),
    ]);
    expect(entries[0]).toMatchObject({ path: 'src/c.ts', kind: 'delete', count: 2 });
  });

  it('rename 记录目标路径', () => {
    const entries = collectChangedFiles([
      assistant([['rename_file', { old_path: 'src/old.ts', new_path: 'src/new.ts' }]]),
    ]);
    expect(entries[0]).toMatchObject({ path: 'src/old.ts', kind: 'rename', target: 'src/new.ts' });
  });

  it('call_tool 动态派发也能识别真工具名和真参数', () => {
    const entries = collectChangedFiles([
      assistant([['call_tool', { tool: 'edit_file', args: { file_path: 'src/d.ts', hunks: [{}, {}, {}] } }]]),
    ]);
    expect(entries[0]).toMatchObject({ path: 'src/d.ts', kind: 'edit', size: 3 });
  });

  it('只读工具 / 无路径参数不进清单', () => {
    const entries = collectChangedFiles([
      assistant([['readfile', { path: 'src/e.ts' }]]),
      assistant([['edit_file', { old_string: 'a', new_string: 'b' }]]),
    ]);
    expect(entries).toEqual([]);
  });
});

describe('renderChangedFilesSection', () => {
  it('每个文件一行，带动作和规模', () => {
    const section = renderChangedFilesSection(collectChangedFiles([
      assistant([['edit_file', { file_path: 'src/a.ts', hunks: [{}, {}] }]]),
      assistant([['write_file', { file_path: 'src/b.ts', content: 'hello' }]]),
      assistant([['delete_file', { path: 'src/c.ts' }]]),
    ]));
    expect(section).toContain('### Changed Files');
    expect(section).toContain('- `src/a.ts` — 修改 2 处（1 次编辑）');
    expect(section).toContain('- `src/b.ts` — 写入 1 次（最后一次 5 字符）');
    expect(section).toContain('- `src/c.ts` — 已删除');
  });

  it('没有改动也固定带这一节', () => {
    const section = renderChangedFilesSection([]);
    expect(section).toContain('### Changed Files');
    expect(section).toContain('还没有改动文件');
  });

  it('上一轮的清单被携带，同路径以新记录为准', () => {
    const prior = [
      '- `src/old.ts` — 修改 1 处（1 次编辑）',
      '- `src/a.ts` — 修改 9 处（9 次编辑）',
    ];
    const section = renderChangedFilesSection(
      collectChangedFiles([assistant([['edit_file', { file_path: 'src/a.ts', hunks: [{}, {}] }]])]),
      prior,
    );
    expect(section).toContain('`src/old.ts`');
    expect(section).toContain('- `src/a.ts` — 修改 2 处（1 次编辑）');
    expect(section).not.toContain('修改 9 处');
  });
});

describe('extractChangedFileLines', () => {
  it('只取 Changed Files 那一节，不跨到下一节', () => {
    const summary = {
      role: 'system',
      content: '[Compressed Work Record — x]\n\n### Conversation\n- 目标\n\n### Changed Files\n- `src/a.ts` — 已删除\n\n### Files\n- other',
    } as Message;
    expect(extractChangedFileLines([summary])).toEqual(['- `src/a.ts` — 已删除']);
  });
});
