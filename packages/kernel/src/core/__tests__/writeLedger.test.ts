import { describe, test, expect, beforeEach } from 'vitest';
import {
  clearWriteLedger,
  extractWriteDeclarationsFromToolComplete,
  isBulkWorkspaceMutationCommand,
  recordWriteDeclaration,
  getWriteDeclarations,
} from '../writeLedger.js';

describe('writeLedger (kernel)', () => {
  beforeEach(() => clearWriteLedger());

  test('record + get by session', () => {
    recordWriteDeclaration({
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'write_file',
      op: 'write',
      paths: ['/a'],
      ts: 1,
      evidence: 'tool_ui_meta',
    });
    expect(getWriteDeclarations('s1')).toHaveLength(1);
    expect(getWriteDeclarations('s2')).toHaveLength(0);
  });

  test('bulk command detection', () => {
    expect(isBulkWorkspaceMutationCommand('git checkout main')).toBe(true);
    expect(isBulkWorkspaceMutationCommand('node build.mjs')).toBe(false);
  });

  test('extract edit_file', () => {
    const d = extractWriteDeclarationsFromToolComplete({
      sessionId: 's',
      toolCallId: '1',
      toolName: 'edit_file',
      success: true,
      output: JSON.stringify({ status: 'success', file_path: '/x.ts' }),
    });
    expect(d[0]!.op).toBe('edit');
    expect(d[0]!.paths[0]).toBe('/x.ts');
  });

  test('文档类工具: 结果 JSON 里的 file_path 也算 (word_create 生成的 Word 要进「本轮改动」)', () => {
    const base = { sessionId: 's', toolCallId: 't', success: true, args: { save_path: 'a/纪要.docx' } };
    const d = extractWriteDeclarationsFromToolComplete({ ...base, toolName: 'word_create', output: JSON.stringify({ ok: true, file_path: '/w/a/纪要.docx' }) });
    expect(d.map((x) => [x.op, x.paths[0], x.evidence])).toEqual([['write', '/w/a/纪要.docx', 'tool_result_path']]);
    const deck = extractWriteDeclarationsFromToolComplete({ ...base, toolName: 'deck_export', output: JSON.stringify({ ok: true, path: '/w/课件.pptx' }) });
    expect(deck.map((x) => x.paths[0])).toEqual(['/w/课件.pptx']);
    /* 失败结果 / 读类工具不记 */
    expect(extractWriteDeclarationsFromToolComplete({ ...base, toolName: 'word_create', output: JSON.stringify({ error: '文件已存在' }) })).toEqual([]);
    expect(extractWriteDeclarationsFromToolComplete({ ...base, toolName: 'word_describe', output: JSON.stringify({ ok: true, file_path: '/w/a.docx' }) })).toEqual([]);
  });
});
