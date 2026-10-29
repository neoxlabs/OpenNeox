/**
 * WriteLedger 契约测试 — membership 只认声明, 不认 FS 时间窗.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  clearWriteLedger,
  extractWriteDeclarationsFromToolComplete,
  foldWriteDeclarations,
  isBulkWorkspaceMutationCommand,
  recordWriteDeclaration,
  getWriteDeclarations,
  type WriteDeclaration,
} from '@neoxlabs/kernel/core/writeLedger.js';
import { aggregateTurnChanges } from '../aggregateTurnChanges';
import { recoverShellProcDeclarations } from '../shellProcRecovery';
import { noteSessionRunState, resetSessionRunWindows } from '../sessionRunWindows';

const userMsg = (ts: number, id = 'u1') => ({
  id, type: 'user_message', timestamp: ts, content: 'hi', sessionId: 's1',
}) as any;

describe('isBulkWorkspaceMutationCommand', () => {
  test('git pull / npm install 是仓储批量', () => {
    expect(isBulkWorkspaceMutationCommand('git pull origin main')).toBe(true);
    expect(isBulkWorkspaceMutationCommand('npm install')).toBe(true);
    expect(isBulkWorkspaceMutationCommand('pnpm i lodash')).toBe(true);
  });

  test('普通脚本不是', () => {
    expect(isBulkWorkspaceMutationCommand('node deck.mjs')).toBe(false);
    expect(isBulkWorkspaceMutationCommand('python gen.py')).toBe(false);
  });
});

describe('extractWriteDeclarationsFromToolComplete', () => {
  test('write_file 从 uiMeta 声明', () => {
    const decls = extractWriteDeclarationsFromToolComplete({
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'write_file',
      success: true,
      uiMeta: { file_path: '/ws/a.ts', status: 'success' },
    });
    expect(decls).toHaveLength(1);
    expect(decls[0]!.paths).toEqual(['/ws/a.ts']);
    expect(decls[0]!.op).toBe('write');
  });

  test('shell output_files → shell_declared', () => {
    const decls = extractWriteDeclarationsFromToolComplete({
      sessionId: 's1',
      toolCallId: 't2',
      toolName: 'execute_shell',
      success: true,
      args: { command: 'node deck.mjs', output_files: ['out/a.pptx'] },
    });
    expect(decls).toHaveLength(1);
    expect(decls[0]!.evidence).toBe('shell_declared');
    expect(decls[0]!.paths).toEqual(['out/a.pptx']);
  });

  test('shell 无声明 → 空', () => {
    const decls = extractWriteDeclarationsFromToolComplete({
      sessionId: 's1',
      toolCallId: 't3',
      toolName: 'execute_shell',
      success: true,
      args: { command: 'git pull' },
    });
    expect(decls).toHaveLength(0);
  });

  test('create_slides 从 output.path', () => {
    const decls = extractWriteDeclarationsFromToolComplete({
      sessionId: 's1',
      toolCallId: 't4',
      toolName: 'create_slides',
      success: true,
      output: { success: true, path: '/ws/deck.pptx' },
    });
    expect(decls[0]!.paths).toEqual(['/ws/deck.pptx']);
  });

  test('rename 带 from/to', () => {
    const decls = extractWriteDeclarationsFromToolComplete({
      sessionId: 's1',
      toolCallId: 't5',
      toolName: 'rename_file',
      success: true,
      uiMeta: {
        file_path: '/ws/b.ts',
        status: 'success',
        metadata: { from: '/ws/a.ts', to: '/ws/b.ts' },
      },
    });
    expect(decls[0]!.op).toBe('rename');
    expect(decls[0]!.from).toBe('/ws/a.ts');
    expect(decls[0]!.paths).toEqual(['/ws/b.ts']);
  });
});

describe('aggregateTurnChanges ledger membership', () => {
  beforeEach(() => clearWriteLedger());

  test('窗内大量 FS 噪声但无声明 → null', () => {
    const ts = Date.now() - 60_000;
    const summary = aggregateTurnChanges(
      [userMsg(ts), { id: 't', type: 'tool_call', timestamp: ts + 1000, toolName: 'read_file', success: true } as any],
      '/ws',
      /* fsEvents 兼容参数 — 必须被忽略 */ [{ path: '/ws/LICENSE', kind: 'add', ts: ts + 500 }],
    );
    expect(summary).toBeNull();
  });

  test('仅 write_file 声明、无 FS → 有卡且有行数', () => {
    const ts = Date.now() - 10_000;
    const content = 'line1\nline2\nline3';
    const summary = aggregateTurnChanges([
      userMsg(ts),
      {
        id: 'fs1',
        type: 'file_stream',
        timestamp: ts + 1000,
        filePath: '/ws/src/a.ts',
        codeContent: content,
        success: true,
      } as any,
    ], '/ws');
    expect(summary).not.toBeNull();
    expect(summary!.changes).toHaveLength(1);
    expect(summary!.changes[0]!.path).toContain('a.ts');
    expect(summary!.changes[0]!.addCount).toBe(3);
    expect(summary!.changes[0]!.statsUnknown).toBeFalsy();
  });

  test('shell output_files 声明进卡', () => {
    const ts = Date.now() - 10_000;
    const summary = aggregateTurnChanges([
      userMsg(ts),
      {
        id: 'sh1',
        type: 'tool_result',
        timestamp: ts + 2000,
        toolName: 'execute_shell',
        toolCallId: 'tc1',
        success: true,
        toolArgs: { command: 'node deck.mjs', output_files: ['/ws/out/a.pptx'] },
      } as any,
    ], '/ws');
    expect(summary!.changes.map((c) => c.path)).toEqual(expect.arrayContaining([expect.stringContaining('a.pptx')]));
    expect(summary!.changes[0]!.statsUnknown).toBe(true);
  });

  test('shell_proc 经 entry.declaredPaths 进卡', () => {
    const ts = Date.now() - 10_000;
    const summary = aggregateTurnChanges([
      userMsg(ts),
      {
        id: 'sh2',
        type: 'tool_call',
        timestamp: ts + 2000,
        toolName: 'execute_shell',
        toolCallId: 'tc2',
        success: true,
        commandCode: 'node deck.mjs',
        declaredPaths: ['/ws/out/b.pptx'],
        declaredEvidence: 'shell_proc',
      } as any,
    ], '/ws');
    expect(summary!.totalFiles).toBe(1);
    expect(summary!.changes[0]!.path).toContain('b.pptx');
  });

  test('传入 declarations 合并 (live ledger)', () => {
    const ts = Date.now() - 10_000;
    const decls: WriteDeclaration[] = [{
      sessionId: 's1',
      toolCallId: 'x',
      toolName: 'write_file',
      op: 'write',
      paths: ['/ws/extra.md'],
      ts: ts + 500,
      evidence: 'tool_ui_meta',
    }];
    const summary = aggregateTurnChanges([userMsg(ts)], '/ws', undefined, decls);
    expect(summary!.changes[0]!.path).toContain('extra.md');
  });

  test('rename 折叠为一条', () => {
    const ts = Date.now() - 10_000;
    const summary = aggregateTurnChanges([
      userMsg(ts),
      {
        id: 'r1',
        type: 'tool_result',
        timestamp: ts + 1000,
        toolName: 'rename_file',
        success: true,
        targetPath: '/ws/b.ts',
        toolArgs: { source_path: '/ws/a.ts', destination_path: '/ws/b.ts' },
        toolMetadata: { from: '/ws/a.ts', to: '/ws/b.ts' },
      } as any,
    ], '/ws');
    expect(summary!.changes).toHaveLength(1);
    expect(summary!.changes[0]!.op).toBe('rename');
    expect(summary!.changes[0]!.from).toContain('a.ts');
  });
});

describe('recoverShellProcDeclarations', () => {
  test('git pull 关闭回收即使有大量 add', () => {
    const start = 1000;
    const end = 2000;
    const events = Array.from({ length: 50 }, (_, i) => ({
      path: `/ws/pkg/file${i}.txt`,
      kind: 'add' as const,
      ts: start + 10 + i,
    }));
    const decls = recoverShellProcDeclarations({
      sessionId: 's1',
      toolCallId: 't',
      command: 'git pull',
      startTs: start,
      endTs: end,
      workspacePath: '/ws',
      fsEvents: events,
    });
    expect(decls).toHaveLength(0);
  });

  test('普通脚本回收 add, 忽略 change 和他目录', () => {
    const decls = recoverShellProcDeclarations({
      sessionId: 's1',
      toolCallId: 't',
      command: 'node deck.mjs',
      startTs: 1000,
      endTs: 2000,
      workspacePath: '/ws',
      fsEvents: [
        { path: '/ws/out/a.pptx', kind: 'add', ts: 1500 },
        { path: '/ws/README.md', kind: 'change', ts: 1501 },
        { path: '/other/x.txt', kind: 'add', ts: 1502 },
      ],
    });
    expect(decls).toHaveLength(1);
    expect(decls[0]!.evidence).toBe('shell_proc');
    expect(decls[0]!.paths).toEqual(['/ws/out/a.pptx']);
  });

  test('别的会话已声明的路径不收', () => {
    clearWriteLedger();
    recordWriteDeclaration({
      sessionId: 's2', toolCallId: 'x', toolName: 'write_file', op: 'write',
      paths: ['/ws/snapshots/sheet.jpg'], ts: 1500, evidence: 'tool_ui_meta',
    });
    const decls = recoverShellProcDeclarations({
      sessionId: 's1',
      toolCallId: 't',
      command: 'python gen.py',
      startTs: 1000,
      endTs: 2000,
      workspacePath: '/ws',
      concurrent: false,
      fsEvents: [
        { path: '/ws/out/a.png', kind: 'add', ts: 1500 },
        { path: '/ws/snapshots/sheet.jpg', kind: 'add', ts: 1501 },
      ],
    });
    clearWriteLedger();
    expect(decls[0]!.paths).toEqual(['/ws/out/a.png']);
  });

  test('同文件夹有别的会话在跑: 只留命令里点了名的', () => {
    resetSessionRunWindows();
    noteSessionRunState('s2', true, '/ws', 500);
    const decls = recoverShellProcDeclarations({
      sessionId: 's1',
      toolCallId: 't',
      command: 'python gen.py --out out/a.png',
      startTs: 1000,
      endTs: 2000,
      workspacePath: '/ws',
      fsEvents: [
        { path: '/ws/out/a.png', kind: 'add', ts: 1500 },
        { path: '/ws/snapshots/contact-sheet.jpg', kind: 'add', ts: 1501 },
      ],
    });
    expect(decls[0]!.paths).toEqual(['/ws/out/a.png']);
  });

  test('别的会话在另一个文件夹跑 / 已在窗前结束: 照常回收', () => {
    resetSessionRunWindows();
    noteSessionRunState('s2', true, '/other', 500);
    noteSessionRunState('s3', true, '/ws', 100);
    noteSessionRunState('s3', false, '/ws', 400);
    const decls = recoverShellProcDeclarations({
      sessionId: 's1',
      toolCallId: 't',
      command: 'python gen.py',
      startTs: 1000,
      endTs: 2000,
      workspacePath: '/ws',
      fsEvents: [{ path: '/ws/snapshots/contact-sheet.jpg', kind: 'add', ts: 1501 }],
    });
    resetSessionRunWindows();
    expect(decls[0]!.paths).toEqual(['/ws/snapshots/contact-sheet.jpg']);
  });
});

describe('WriteLedger session isolation', () => {
  beforeEach(() => clearWriteLedger());

  test('他会话声明对本会话 get 不可见', () => {
    recordWriteDeclaration({
      sessionId: 'sA',
      toolCallId: '1',
      toolName: 'write_file',
      op: 'write',
      paths: ['/a'],
      ts: 1,
      evidence: 'tool_ui_meta',
    });
    expect(getWriteDeclarations('sB')).toHaveLength(0);
    expect(getWriteDeclarations('sA')).toHaveLength(1);
  });

  test('fold rename 删除 from', () => {
    const map = foldWriteDeclarations([
      {
        sessionId: 's', toolCallId: '1', toolName: 'write_file', op: 'write',
        paths: ['/a'], ts: 1, evidence: 'tool_ui_meta',
      },
      {
        sessionId: 's', toolCallId: '2', toolName: 'rename_file', op: 'rename',
        paths: ['/b'], from: '/a', ts: 2, evidence: 'tool_ui_meta',
      },
    ]);
    expect(map.has('/a')).toBe(false);
    expect(map.get('/b')?.op).toBe('rename');
  });
});

describe('本轮改动计数按逐行配对', () => {
  beforeEach(() => clearWriteLedger());
  test('加一行: +1 −0, 不把上下文行算进去', () => {
    const ts = Date.now() - 10_000;
    const summary = aggregateTurnChanges([
      userMsg(ts),
      {
        id: 'e1', type: 'edit_file', timestamp: ts + 1000, success: true,
        editFilePath: '/ws/src/math.js',
        editHunks: [{ startLine: 2, oldString: 'sub()', newString: 'sub()\nmul()', oldLineCount: 1, newLineCount: 2 }],
      } as any,
    ], '/ws');
    const c = summary!.changes.find((x) => x.path.endsWith('math.js'))!;
    expect([c.addCount, c.delCount]).toEqual([1, 0]);
  });
  test('正文被截过 (声明行数对不上) 仍按声明算', () => {
    const ts = Date.now() - 10_000;
    const summary = aggregateTurnChanges([
      userMsg(ts),
      {
        id: 'e2', type: 'edit_file', timestamp: ts + 1000, success: true,
        editFilePath: '/ws/big.js',
        editHunks: [{ startLine: 1, oldString: 'a', newString: 'a\nb', oldLineCount: 40, newLineCount: 90 }],
      } as any,
    ], '/ws');
    const c = summary!.changes.find((x) => x.path.endsWith('big.js'))!;
    expect([c.addCount, c.delCount]).toEqual([90, 40]);
  });
});
