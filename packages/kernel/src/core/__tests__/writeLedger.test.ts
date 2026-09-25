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
});
