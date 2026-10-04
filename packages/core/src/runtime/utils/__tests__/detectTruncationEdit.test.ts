import { describe, expect, it } from 'vitest';
import { detectTruncation } from '../jsonRepair.js';
import { classifyToolError } from '@neoxlabs/kernel/types/errors.js';

const args = (o: Record<string, unknown>) => JSON.stringify(o);

describe('edit payload shapes', () => {
  it.each([
    ['old_string', { file_path: 'a.dart', old_string: 'x', new_string: 'y' }],
    ['hunks', { file_path: 'a.dart', hunks: [{ old_string: 'x', new_string: 'y' }] }],
    ['insert_before', { file_path: 'a.dart', insert_before: '/// doc', new_string: 'class A {}' }],
    ['insert_after', { file_path: 'a.dart', insert_after: 'import x;', new_string: 'import y;' }],
  ])('%s form is complete', (_name, payload) => {
    expect(detectTruncation('edit', args(payload)).isTruncated).toBe(false);
    expect(classifyToolError('edit', args(payload), new Error('x')).code).not.toBe('TOOL_MISSING_EDIT_PAYLOAD');
  });

  it('really missing new_string is still caught', () => {
    const payload = args({ file_path: 'a.dart', insert_before: '/// doc' });
    expect(detectTruncation('edit', payload).isTruncated).toBe(true);
    expect(classifyToolError('edit', payload, new Error('x')).code).toBe('TOOL_MISSING_EDIT_PAYLOAD');
  });
});
