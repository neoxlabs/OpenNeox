import { describe, expect, it } from 'vitest';
import { EXTRA_PARSERS } from '../extraParsers';

const entry = (toolName: string) => ({ toolName } as any);
const eph = (tool: string, metadata: Record<string, unknown>, content = '') =>
  JSON.stringify({ type: 'ephemeral', tool, status: 'success', summary: 'ok', content, metadata });

describe('extraParsers', () => {
  it('weather stays on the NeoxCard path (no tool card)', () => {
    expect(EXTRA_PARSERS.get_weather).toBeUndefined();
  });

  it('commit: hash / stats from metadata', () => {
    const c = EXTRA_PARSERS.git_commit!({ message: 'fix: a' }, eph('git_commit', { message: 'fix: a', hash: 'abc1234', branch: 'main', files: 2, insertions: 10, deletions: 3 }), entry('git_commit')) as any;
    expect(c).toMatchObject({ kind: 'commit', hash: 'abc1234', files: 2, insertions: 10, deletions: 3 });
  });

  it('blame: parses default git blame lines', () => {
    const content = [
      'a1b2c3d4 (张三 2026-10-20 19:00:00 +0800  1) const a = 1;',
      'a1b2c3d4 (张三 2026-10-20 19:00:00 +0800  2) const b = 2;',
      '^9f8e7d6 (Li Si 2026-09-01 10:00:00 +0800  3) export {}',
    ].join('\n');
    const c = EXTRA_PARSERS.git_blame!({ file_path: 'src/a.ts' }, eph('git_blame', {}, content), entry('git_blame')) as any;
    expect(c.rows).toHaveLength(3);
    expect(c.rows[2]).toMatchObject({ hash: '9f8e7d6', author: 'Li Si', line: 3, code: 'export {}' });
  });

  it('context: pct from input budget; no snapshot → no card', () => {
    const c = EXTRA_PARSERS.context_status!({}, JSON.stringify({ input: { used_tokens: 50000, budget_tokens: 200000, compression_triggers_at_tokens: 160000 } }), entry('context_status')) as any;
    expect(c).toMatchObject({ kind: 'context', pct: 25, compactAt: 160000 });
    expect(EXTRA_PARSERS.context_status!({}, JSON.stringify({ snapshot_available: false }), entry('context_status'))).toBeUndefined();
  });

  it('monitor: start shows what is watched', () => {
    const c = EXTRA_PARSERS.monitor_start!({}, JSON.stringify({ monitor_id: 'm1', watching: 'npm run dev 输出里出现 error' }), entry('monitor_start')) as any;
    expect(c).toMatchObject({ kind: 'monitor', op: 'start', id: 'm1' });
  });
});
