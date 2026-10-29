import { describe, expect, test } from 'vitest';
import { mapTimelineEntries } from '../mapTimeline';
import { digestFileList } from '../timelineRows';
import type { TimelineEntry } from '../../../utils/workspaceUtils';


function titleOf(entry: Partial<TimelineEntry>): string {
  const steps = mapTimelineEntries([{ id: 't1', timestamp: 1, ...entry } as TimelineEntry]);
  const s: any = steps[0];
  return String(s?.title ?? '');
}

describe('工具标题 — 从 toolArgs 提取操作对象', () => {
  test('read_file 只给 file_path (无 targetPath) 也要显示文件名', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'read_file',
      toolArgs: { file_path: '/work/proj/src/App.jsx' },
    });
    expect(title).toContain('App.jsx');
  });

  test('三种参数别名都认 — path / filePath / file', () => {
    for (const args of [
      { path: '/work/proj/src/App.jsx' },
      { filePath: '/work/proj/src/App.jsx' },
      { file: '/work/proj/src/App.jsx' },
    ]) {
      expect(titleOf({ type: 'tool_call', toolName: 'read_file', toolArgs: args })).toContain('App.jsx');
    }
  });

  test('带上行数范围 — offset + limit', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'read_file',
      toolArgs: { file_path: '/w/App.jsx', offset: 20, limit: 100 },
    });
    expect(title).toContain('App.jsx');
    expect(title).toContain('20-119');
  });

  test('带上行数范围 — offset + end_line', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'read_file',
      toolArgs: { file_path: '/w/App.jsx', offset: 5, end_line: 60 },
    });
    expect(title).toContain('5-60');
  });

  test('只有 limit 视为从第 1 行读起', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'read_file',
      toolArgs: { file_path: '/w/App.jsx', limit: 120 },
    });
    expect(title).toContain('1-120');
  });

  test('没有行数参数就不硬凑范围', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'read_file',
      toolArgs: { file_path: '/w/App.jsx' },
    });
    expect(title).toContain('App.jsx');
    expect(title).not.toMatch(/\d+-\d+/);
  });

  test('call_tool 包一层也要透出内层的文件名', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'call_tool',
      toolArgs: { name: 'read_file', args: { file_path: '/w/src/App.jsx' } },
    });
    expect(title).toContain('App.jsx');
  });

  test('兜底: 其他文件类工具没有专属分支时也从 toolArgs 拿对象名', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'format_file',
      toolArgs: { file_path: '/w/src/App.jsx' },
    });
    expect(title).toContain('App.jsx');
  });

  test('entry.targetPath 仍然优先生效 (老链路不回归)', () => {
    const title = titleOf({
      type: 'tool_call',
      toolName: 'read_file',
      targetPath: '/w/from-entry.ts',
      toolArgs: {},
    });
    expect(title).toContain('from-entry.ts');
  });

  test('真没有对象名时不吐出多余的分隔符', () => {
    const title = titleOf({ type: 'tool_call', toolName: 'read_file', toolArgs: {} });
    expect(title.trim().endsWith('·')).toBe(false);
  });
});

describe('批量读取的对象名', () => {
  const batch = (targets: string[], total = targets.length) => ({
    id: 'b1', timestamp: 1, type: 'tool_call', toolName: 'readfile',
    title: `✅ readfile (${total})`, pending: false,
    isBatch: true, batchTotal: total, batchTargets: targets,
  }) as unknown as TimelineEntry;

  test('title 带上 batchTargets 的文件名, 不再只有"读取 3 个文件"', () => {
    const t = titleOf(batch([
      '/w/proj/package.json', '/w/proj/index.html', '/w/proj/vite.config.js',
    ]));
    expect(t).toContain('package.json');
    expect(t).toContain('index.html');
  });

  test('只取 basename, 不把绝对路径糊进摘要', () => {
    const t = titleOf(batch(['/Users/someone/deep/nested/path/data.js']));
    expect(t).toContain('data.js');
    expect(t).not.toContain('/Users/someone');
  });

  test('batchTargets 为空时不硬凑, 留给原有兜底', () => {
    const t = titleOf(batch([]));
    expect(t.trim().endsWith('·')).toBe(false);
  });

  test('汇总 entry 仍然保留渲染 — 它是有信息的, 不该被丢掉', () => {
    const steps = mapTimelineEntries([batch(['/w/a.ts', '/w/b.ts'])]);
    expect(steps).toHaveLength(1);
  });
});

/**
 * digestFileList: total 是步骤数, 不是文件数.
 * 批量读取一步就带 3 个文件, 用 total 算余量会得负数 —— 既不显示"等 N 个",
 * 又把第 3 个文件名默默吞掉.
 */
describe('digestFileList 余量计算', () => {
  test('一步多文件时按真实文件数报总量', () => {
    const out = digestFileList('a.ts、b.ts、c.ts', 1, true);
    expect(out).toContain('a.ts');
    expect(out).toContain('b.ts');
    expect(out).toContain('等 3 个');
  });

  test('多步单文件的老口径不回归', () => {
    const out = digestFileList('README.md', 2, true);
    expect(out).toContain('README.md');
    expect(out).toContain('等 2 个');
  });

  test('文件数不超过展示位时不加"等 N 个"', () => {
    const out = digestFileList('a.ts、b.ts', 2, true);
    expect(out).toBe('a.ts、b.ts');
  });
});

describe('折叠头摘要 — 分类与合并', () => {
  const act = (steps: Array<Partial<TimelineEntry>>) => {
    const entries = steps.map((s, i) => ({ id: `s${i}`, timestamp: i + 1, ...s } as TimelineEntry));
    return mapTimelineEntries(entries);
  };

  test('列目录不该被算成读文件', () => {
    const steps = act([{ type: 'tool_call', toolName: 'list_directory', toolArgs: { path: '.' } }]);
    const title = String((steps[0] as any).title ?? '');
    expect(title).not.toContain('读取');
    expect(title).not.toMatch(/Read/i);
  });

  test('读多个文件时对象名要并起来, 不是越合并越少', () => {
    const out = digestFileList('main.jsx', 1, true);
    expect(out).toContain('main.jsx');
    /* 并起来之后 digestFileList 仍只展示前 2 个 + 总数, 不会撑爆一行 */
    const merged = digestFileList('main.jsx、data.js、TaskCard.jsx', 3, true);
    expect(merged).toContain('main.jsx');
    expect(merged).toContain('data.js');
    expect(merged).toContain('等 3 个');
    expect(merged).not.toContain('TaskCard.jsx');
  });
});
