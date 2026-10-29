
import { describe, test, expect } from 'vitest';
import type { WriteDeclaration, WriteOp } from '@neoxlabs/kernel/core/writeLedger.js';
import { pickRecentArtifacts } from '../hooks/useRecentArtifacts';
import { extractWriteDeclarationsFromTimelineEntries } from '../turnWriteDeclarations';

const WS = '/ws';

function decl(
  paths: string[],
  ts: number,
  op: WriteOp = 'write',
  from?: string,
): WriteDeclaration {
  return {
    sessionId: 's1',
    toolCallId: `t${ts}${op}`,
    toolName: 'write_file',
    op,
    paths,
    from,
    ts,
    evidence: 'tool_ui_meta',
  };
}

describe('pickRecentArtifacts membership', () => {
  test('没人声明的 .md 不算产物 (WARP.md / CLAUDE.md 那一幕)', () => {
    /* 工作区里确实躺着这两个文件, 但 agent 一次都没写过它们 —— 产物区必须是空的。
     * 判据不是"文件在不在", 是"有没有一条成功的 WriteDeclaration 点名它"。 */
    expect(pickRecentArtifacts([], { workspacePath: WS })).toEqual([]);
  });

  test('agent 真写过的 .md 照常显示 (没有按文件名黑名单排除)', () => {
    const out = pickRecentArtifacts([decl(['/ws/CLAUDE.md'], 1000)], { workspacePath: WS });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe('/ws/CLAUDE.md');
    expect(out[0]!.deleted).toBe(false);
  });

  test('源码 / 噪音目录不算产物', () => {
    const out = pickRecentArtifacts([
      decl(['/ws/src/app.ts'], 1000),
      decl(['/ws/node_modules/pkg/README.md'], 1001),
      decl(['/ws/dist/bundle.html'], 1002),
      decl(['/ws/.neox/project.md'], 1003),
    ], { workspacePath: WS });
    expect(out).toEqual([]);
  });

  test('删除保留但标记 deleted, 否则"东西没了"看不见', () => {
    const out = pickRecentArtifacts([
      decl(['/ws/deliverables/report.md'], 1000),
      decl(['/ws/deliverables/report.md'], 2000, 'delete'),
    ], { workspacePath: WS });
    expect(out).toHaveLength(1);
    expect(out[0]!.deleted).toBe(true);
    expect(out[0]!.ts).toBe(2000);
  });

  test('rename 删 from 留 to', () => {
    const out = pickRecentArtifacts([
      decl(['/ws/deliverables/a.md'], 1000),
      decl(['/ws/deliverables/b.md'], 2000, 'rename', '/ws/deliverables/a.md'),
    ], { workspacePath: WS });
    expect(out.map((a) => a.path)).toEqual(['/ws/deliverables/b.md']);
  });

  test('相对路径按工作区解析, 工作区外的排除', () => {
    const out = pickRecentArtifacts([
      decl(['deliverables/deck.pptx'], 1000),
      decl(['/tmp/scratch.md'], 1001),
      decl(['/Users/someone/Downloads/x.pdf'], 1002),
    ], { workspacePath: WS });
    expect(out.map((a) => a.path)).toEqual(['/ws/deliverables/deck.pptx']);
  });

  test('按时间倒序, 最多 6 条', () => {
    const decls = Array.from({ length: 9 }, (_, i) => decl([`/ws/deliverables/f${i}.md`], 1000 + i));
    const out = pickRecentArtifacts(decls, { workspacePath: WS });
    expect(out).toHaveLength(6);
    expect(out[0]!.path).toBe('/ws/deliverables/f8.md');
    expect(out[5]!.path).toBe('/ws/deliverables/f3.md');
  });
});

describe('产物区 — 从 timeline entries 回放', () => {
  test('write_file 的 entry 回放出产物', () => {
    const ts = Date.now();
    const entries = [{
      id: 'fs1',
      type: 'tool_result',
      timestamp: ts,
      toolName: 'write_file',
      toolCallId: 'c1',
      success: true,
      targetPath: '/ws/deliverables/deck.pptx',
      toolArgs: { file_path: '/ws/deliverables/deck.pptx' },
    }] as any;

    const decls = extractWriteDeclarationsFromTimelineEntries(entries, 's1', WS);
    expect(pickRecentArtifacts(decls, { workspacePath: WS }).map((a) => a.path))
      .toEqual(['/ws/deliverables/deck.pptx']);
  });

  test('只读了一堆文件 (没有写声明) → 产物区空', () => {
    const ts = Date.now();
    const entries = [
      { id: 'r1', type: 'tool_result', timestamp: ts, toolName: 'read_file', success: true, toolArgs: { path: '/ws/WARP.md' } },
      { id: 'r2', type: 'tool_result', timestamp: ts + 1, toolName: 'search', success: true, toolArgs: { pattern: 'CLAUDE.md' } },
    ] as any;

    const decls = extractWriteDeclarationsFromTimelineEntries(entries, 's1', WS);
    expect(pickRecentArtifacts(decls, { workspacePath: WS })).toEqual([]);
  });

  test('shell 声明的产物 (output_files / shell_proc) 也进产物区', () => {
    const ts = Date.now();
    const entries = [
      {
        id: 'sh1',
        type: 'tool_result',
        timestamp: ts,
        toolName: 'execute_shell',
        toolCallId: 'c2',
        success: true,
        toolArgs: { command: 'node deck.mjs', output_files: ['/ws/deliverables/a.pptx'] },
      },
      {
        id: 'sh2',
        type: 'tool_call',
        timestamp: ts + 1,
        toolName: 'execute_shell',
        toolCallId: 'c3',
        success: true,
        declaredPaths: ['/ws/deliverables/b.pdf'],
        declaredEvidence: 'shell_proc',
      },
    ] as any;

    const decls = extractWriteDeclarationsFromTimelineEntries(entries, 's1', WS);
    expect(pickRecentArtifacts(decls, { workspacePath: WS }).map((a) => a.path).sort())
      .toEqual(['/ws/deliverables/a.pptx', '/ws/deliverables/b.pdf']);
  });

  test('3000 条 entries 的回放开销在毫秒级', () => {
    const entries: any[] = [];
    for (let i = 0; i < 3000; i++) {
      entries.push(i % 4 === 0
        ? {
          id: `e${i}`, type: 'tool_result', timestamp: i, toolName: 'write_file',
          toolCallId: `c${i}`, success: true, targetPath: `/ws/deliverables/f${i}.md`,
        }
        : { id: `e${i}`, type: 'assistant_message', timestamp: i, detail: 'x'.repeat(200) });
    }

    const t0 = performance.now();
    const decls = extractWriteDeclarationsFromTimelineEntries(entries, 's1', WS);
    const out = pickRecentArtifacts(decls, { workspacePath: WS });
    const ms = performance.now() - t0;

    expect(out).toHaveLength(6);
    expect(ms).toBeLessThan(50);
  });
});
