
import { describe, it, expect } from 'vitest';
import {
  truncateForPreview,
  fileStreamKey,
  normalizePathForMatch,
  pathsMaybeMatch,
  entryMatchesToolId,
  bindToolIdPatch,
  findEntryByToolId,
  initialIdentity,
  estimateOutputTokens,
  formatCompactTokens,
  parseCompactCount,
  summarizeSurfaceOutput,
  normalizeToolName,
  resolveToolCallId,
  normalizeErrorMessage,
  extractStreamText,
  mergeReasoningDelta,
  isLikelyDuplicateError,
  isCompletionLogMessage,
  normalizeToolArgsForUi,
  compactUiText,
  pickToolArgText,
  compactUiUrl,
  formatBrowserToolCallDetail,
  extractRawStdoutFromShellResult,
  extractStreamedArgPreview,
} from '../useStreamHandler';
/* TimelineEntry 的真身在 workspaceUtils, 不在 agent-timeline/types —— 跟被测文件保持同源 */
import type { TimelineEntry } from '../../../../utils/workspaceUtils';

const entry = (o: Partial<TimelineEntry>): TimelineEntry => o as TimelineEntry;

/* ══════════════ 流式文本合并 ══════════════ */

describe('mergeReasoningDelta · 累积式 provider 不能拼成双倍', () => {
  it('空输入不改变已有内容', () => {
    expect(mergeReasoningDelta('abc', '')).toEqual({ content: 'abc', appended: '' });
    expect(mergeReasoningDelta('', 'abc')).toEqual({ content: 'abc', appended: 'abc' });
  });

  it('真 delta: 直接追加', () => {
    expect(mergeReasoningDelta('Hello', ' world')).toEqual({ content: 'Hello world', appended: ' world' });
  });

  it('累积式载荷: 只追加新增部分, 不重复整段', () => {
    /* 有的 provider 每次发全文而不是增量 —— 直接拼会变成 "HelloHello world" */
    expect(mergeReasoningDelta('Hello', 'Hello world'))
      .toEqual({ content: 'Hello world', appended: ' world' });
  });

  it('完全重复的一帧被丢弃', () => {
    expect(mergeReasoningDelta('abc', 'abc')).toEqual({ content: 'abc', appended: '' });
  });

  it('新帧已包含在尾部: 不重复追加', () => {
    expect(mergeReasoningDelta('abcdef', 'def')).toEqual({ content: 'abcdef', appended: '' });
  });

  it('部分重叠: 只接非重叠的尾巴', () => {
    expect(mergeReasoningDelta('abcdef', 'defghi'))
      .toEqual({ content: 'abcdefghi', appended: 'ghi' });
  });

  it('毫无重叠: 整段追加', () => {
    expect(mergeReasoningDelta('abc', 'xyz')).toEqual({ content: 'abcxyz', appended: 'xyz' });
  });

  it('连续累积帧序列最终等于最后一帧', () => {
    let acc = '';
    for (const frame of ['我', '我在', '我在思考', '我在思考这个问题']) {
      acc = mergeReasoningDelta(acc, frame).content;
    }
    expect(acc).toBe('我在思考这个问题');
  });
});

describe('extractStreamText · provider 载荷形状不统一', () => {
  it('直接字符串', () => {
    expect(extractStreamText({ delta: 'hi' }, ['delta'])).toBe('hi');
  });

  it('按 keys 顺序取第一个非空', () => {
    expect(extractStreamText({ a: '', b: 'second' }, ['a', 'b'])).toBe('second');
  });

  it('数组载荷: 拼接各段的 text', () => {
    expect(extractStreamText({ c: [{ text: 'a' }, { text: 'b' }] }, ['c'])).toBe('ab');
  });

  it('数组里混字符串和对象', () => {
    expect(extractStreamText({ c: ['x', { content: 'y' }, { delta: 'z' }] }, ['c'])).toBe('xyz');
  });

  it('对象载荷: 依次试 text/content/delta/message', () => {
    expect(extractStreamText({ c: { content: 'inner' } }, ['c'])).toBe('inner');
    expect(extractStreamText({ c: { message: 'msg' } }, ['c'])).toBe('msg');
  });

  it('取不到返回空串, 不抛', () => {
    expect(extractStreamText({}, ['x'])).toBe('');
    expect(extractStreamText(null, ['x'])).toBe('');
    expect(extractStreamText({ c: { irrelevant: 1 } }, ['c'])).toBe('');
  });
});

/* ══════════════ tool call 身份 ══════════════ */

describe('tool call 身份 · 同一次调用的多个 id 要认成同一个 entry', () => {
  it('primary id 命中', () => {
    expect(entryMatchesToolId(entry({ toolCallId: 't1' }), 't1')).toBe(true);
  });

  it('id 集合命中 (preview 与 final id 不同的情况)', () => {
    expect(entryMatchesToolId(entry({ toolCallId: 't1', toolCallIdSet: ['t1', 't2'] }), 't2')).toBe(true);
  });

  it('空 toolId 一律不命中 —— 否则会误绑到任意 entry', () => {
    expect(entryMatchesToolId(entry({ toolCallId: 't1' }), '')).toBe(false);
  });

  it('不相干 id 不命中', () => {
    expect(entryMatchesToolId(entry({ toolCallId: 't1', toolCallIdSet: ['t1'] }), 'zzz')).toBe(false);
  });

  it('bindToolIdPatch: 新 id 追加进集合并接管 primary', () => {
    expect(bindToolIdPatch(entry({ toolCallId: 't1', toolCallIdSet: ['t1'] }), 't2'))
      .toEqual({ toolCallId: 't2', toolCallIdSet: ['t1', 't2'] });
  });

  it('bindToolIdPatch: 同 id 重发不产生 patch (避免无意义重渲染)', () => {
    expect(bindToolIdPatch(entry({ toolCallId: 't1', toolCallIdSet: ['t1'] }), 't1')).toEqual({});
  });

  it('bindToolIdPatch: 已在集合但非 primary → 只挪 primary, 不动集合', () => {
    expect(bindToolIdPatch(entry({ toolCallId: 't1', toolCallIdSet: ['t1', 't2'] }), 't2'))
      .toEqual({ toolCallId: 't2' });
  });

  it('bindToolIdPatch: entry 没有 set 时按 primary 兜底建集合', () => {
    expect(bindToolIdPatch(entry({ toolCallId: 't1' }), 't2'))
      .toEqual({ toolCallId: 't2', toolCallIdSet: ['t1', 't2'] });
  });

  it('bindToolIdPatch 不修改原对象', () => {
    const e = entry({ toolCallId: 't1', toolCallIdSet: ['t1'] });
    bindToolIdPatch(e, 't2');
    expect(e.toolCallIdSet).toEqual(['t1']);
  });

  it('initialIdentity: 有 id 建集合, 无 id 返回空', () => {
    expect(initialIdentity('t1')).toEqual({ toolCallId: 't1', toolCallIdSet: ['t1'] });
    expect(initialIdentity(undefined)).toEqual({});
  });

  it('findEntryByToolId: 命中第一个匹配项', () => {
    const tl = [entry({ id: 'a', toolCallId: 'x' }), entry({ id: 'b', toolCallId: 't1' })];
    expect(findEntryByToolId(tl, 't1')?.id).toBe('b');
  });

  it('findEntryByToolId: predicate 可过滤类型', () => {
    const tl = [
      entry({ id: 'a', toolCallId: 't1', type: 'tool_call' }),
      entry({ id: 'b', toolCallId: 't1', type: 'tool_result' }),
    ];
    expect(findEntryByToolId(tl, 't1', (e) => e.type === 'tool_result')?.id).toBe('b');
  });

  it('findEntryByToolId: 无 id / 无匹配返回 undefined', () => {
    expect(findEntryByToolId([entry({ toolCallId: 'x' })], undefined)).toBeUndefined();
    expect(findEntryByToolId([entry({ toolCallId: 'x' })], 'nope')).toBeUndefined();
  });
});

/* ══════════════ 路径匹配 ══════════════ */

describe('路径匹配 · 跨平台分隔符与相对/绝对混用', () => {
  it('反斜杠归一成正斜杠', () => {
    expect(normalizePathForMatch('a\\b\\c.ts')).toBe('a/b/c.ts');
  });

  it('非字符串输入返回空串', () => {
    expect(normalizePathForMatch(undefined)).toBe('');
    expect(normalizePathForMatch(123 as any)).toBe('');
  });

  it('完全相同命中', () => {
    expect(pathsMaybeMatch('/a/b/c.ts', '/a/b/c.ts')).toBe(true);
  });

  it('绝对路径 vs 相对后缀命中', () => {
    expect(pathsMaybeMatch('/repo/src/a.ts', 'src/a.ts')).toBe(true);
  });

  it('末两段相同即认为同一文件', () => {
    expect(pathsMaybeMatch('/x/mod/a.ts', '/y/mod/a.ts')).toBe(true);
  });

  it('windows 与 posix 写法互认', () => {
    expect(pathsMaybeMatch('C:\\repo\\src\\a.ts', 'src/a.ts')).toBe(true);
  });

  it('任一为空不命中 —— 空路径不该匹配一切', () => {
    expect(pathsMaybeMatch('', '/a/b.ts')).toBe(false);
    expect(pathsMaybeMatch(undefined, undefined)).toBe(false);
  });

  it('不同文件不命中', () => {
    expect(pathsMaybeMatch('/a/b/c.ts', '/a/b/d.ts')).toBe(false);
  });

  it('fileStreamKey 按 session 隔离', () => {
    expect(fileStreamKey('s1', '/a.ts')).toBe('s1:/a.ts');
    expect(fileStreamKey('s1', '/a.ts')).not.toBe(fileStreamKey('s2', '/a.ts'));
  });
});

/* ══════════════ shell 输出剥壳 ══════════════ */

describe('extractRawStdoutFromShellResult · 剥 marker 保 body', () => {
  it('非字符串 / 空串返回 undefined', () => {
    expect(extractRawStdoutFromShellResult(undefined)).toBeUndefined();
    expect(extractRawStdoutFromShellResult('')).toBeUndefined();
    expect(extractRawStdoutFromShellResult(42)).toBeUndefined();
  });

  it('剥掉后台任务 marker, body 完整保留', () => {
    expect(extractRawStdoutFromShellResult('hello\nworld\n[bg pid=123 running]'))
      .toBe('hello\nworld');
  });

  it('剥掉 services preamble', () => {
    expect(extractRawStdoutFromShellResult('[services:web]\n\nactual output\n[bg exited]'))
      .toBe('actual output');
  });

  it('无包装文本原样返回', () => {
    expect(extractRawStdoutFromShellResult('plain output')).toBe('plain output');
  });

  it('从格式化块里抽 stdout', () => {
    const formatted = '▸ 工作目录: /tmp\n\n◦ 标准输出 (stdout):\nOK\n\n━━━';
    expect(extractRawStdoutFromShellResult(formatted)).toBe('OK');
  });

  it('stdout + stderr 都在时拼起来', () => {
    const formatted = '▸ 工作目录: /tmp\n\n◦ 标准输出 (stdout):\nOUT\n\n◦ 错误输出 (stderr):\nERR\n\n━━━';
    expect(extractRawStdoutFromShellResult(formatted)).toBe('OUT\nERR');
  });
});

/* ══════════════ surface 摘要 ══════════════ */

describe('summarizeSurfaceOutput · 不让 timeline 出裸 JSON', () => {
  const wrap = (o: Record<string, unknown>) => JSON.stringify({ __neox_surface_event__: true, ...o });

  it('非 surface 输出返回 null (走默认渲染)', () => {
    expect(summarizeSurfaceOutput('read', 'plain')).toBeNull();
    expect(summarizeSurfaceOutput('open_surface', undefined)).toBeNull();
  });

  it('坏 JSON 返回 null 而不是抛', () => {
    expect(summarizeSurfaceOutput('open_surface', '{__neox_surface_event__ bad')).toBeNull();
  });

  it('缺 marker 字段返回 null', () => {
    expect(summarizeSurfaceOutput('open_surface', JSON.stringify({ __neox_surface_event__: 'yes' }))).toBeNull();
  });

  it('open 带标题', () => {
    expect(summarizeSurfaceOutput('open_surface', wrap({ action: 'open', surface: { kind: 'code', title: 'a.ts' } })))
      .toBe('打开 code · a.ts');
  });

  it('close', () => {
    expect(summarizeSurfaceOutput('close_surface', wrap({ action: 'close' }))).toBe('关闭 surface');
  });

  it('update 列出 patch 的 key', () => {
    expect(summarizeSurfaceOutput('update_surface', wrap({ action: 'update', patch: { title: 'x', content: 'y' } })))
      .toBe('更新 surface (title, content)');
  });

  it('plan_op 各分支', () => {
    const p = (planOp: Record<string, unknown>) => summarizeSurfaceOutput('edit_plan', wrap({ action: 'plan_op', planOp }));
    expect(p({ kind: 'content', content: '12345' })).toBe('plan · 全量替换 (5 字)');
    expect(p({ kind: 'append', text: 'abc' })).toBe('plan · 追加 (3 字)');
    expect(p({ kind: 'replace_section', heading: '设计' })).toBe('plan · 替换章节「设计」');
    expect(p({ kind: 'set_section_status', heading: '设计', status: 'done' })).toBe('plan · 「设计」→ done');
    expect(p({ kind: 'unknown_future_kind' })).toBe('plan · 更新');
  });

  it('todo_replace 统计各状态', () => {
    const out = summarizeSurfaceOutput('update_todos', wrap({
      action: 'todo_replace',
      todoItems: [{ status: 'done' }, { status: 'in_progress' }, { status: 'pending' }, { status: 'pending' }],
    }));
    expect(out).toBe('todos · 4 项 · 1 完成 · 1 进行 · 2 待办');
  });
});

/* ══════════════ token 估算与格式化 ══════════════ */

describe('token 估算 · 中英文权重不同', () => {
  it('中文字符权重高于英文 (同长度下)', () => {
    /* 单字符会被 Math.ceil 抹平 (0.67 与 0.25 都进位到 1), 要在规模上才看得出权重差 */
    expect(estimateOutputTokens('中'.repeat(10))).toBeGreaterThan(estimateOutputTokens('a'.repeat(10)));
  });

  it('CJK 各区段都按高权重算 (中日韩 + 全角标点)', () => {
    const ascii = estimateOutputTokens('a'.repeat(20));
    for (const s of ['中'.repeat(20), '가'.repeat(20), '、'.repeat(20), 'ａ'.repeat(20)]) {
      expect(estimateOutputTokens(s)).toBeGreaterThan(ascii);
    }
  });

  it('空串为 0', () => {
    expect(estimateOutputTokens('')).toBe(0);
  });

  it('结果单调不减', () => {
    expect(estimateOutputTokens('abcd')).toBeGreaterThanOrEqual(estimateOutputTokens('ab'));
  });

  it('formatCompactTokens: 千位转 k', () => {
    expect(formatCompactTokens(1500)).toBe('1.5k');
    expect(formatCompactTokens(999)).toBe('999');
  });

  it('formatCompactTokens: 非法值归 0', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(-5)).toBe('0');
    expect(formatCompactTokens(NaN)).toBe('0');
    expect(formatCompactTokens(Infinity)).toBe('0');
  });

  it('parseCompactCount 是 formatCompactTokens 的逆 (k 形态)', () => {
    expect(parseCompactCount('1.5k')).toBe(1500);
    expect(parseCompactCount('2K')).toBe(2000);
  });

  it('parseCompactCount: 普通数字与非法输入', () => {
    expect(parseCompactCount('42')).toBe(42);
    expect(parseCompactCount('')).toBe(0);
    expect(parseCompactCount('abc')).toBe(0);
    expect(parseCompactCount('-3')).toBe(0);
  });
});

/* ══════════════ UI 文案格式化 ══════════════ */

describe('UI 文案裁剪', () => {
  it('compactUiText 折叠空白并截断', () => {
    expect(compactUiText('a\n\tb   c')).toBe('a b c');
    expect(compactUiText('x'.repeat(100), 10)).toBe('x'.repeat(9) + '…');
  });

  it('compactUiText 非字符串输入返回空串', () => {
    expect(compactUiText(null)).toBe('');
    expect(compactUiText(123)).toBe('');
  });

  it('truncateForPreview 上限 120', () => {
    expect(truncateForPreview('a b')).toBe('a b');
    const long = truncateForPreview('y'.repeat(200));
    expect(long.length).toBe(119);
    expect(long.endsWith('…')).toBe(true);
  });

  it('pickToolArgText 按 keys 顺序取第一个有值的', () => {
    expect(pickToolArgText({ b: 'B', a: '' }, ['a', 'b'])).toBe('B');
    expect(pickToolArgText({ n: 42 }, ['n'])).toBe('42');
    expect(pickToolArgText({ flag: false }, ['flag'])).toBe('false');
    expect(pickToolArgText(undefined, ['a'])).toBe('');
    expect(pickToolArgText({ a: '   ' }, ['a'])).toBe('');
  });

  it('compactUiUrl 去掉协议与尾斜杠', () => {
    expect(compactUiUrl('https://example.com/a/b/')).toBe('example.com/a/b');
    expect(compactUiUrl('https://example.com/')).toBe('example.com');
  });

  it('compactUiUrl 对非法 URL 降级处理而不是抛', () => {
    expect(compactUiUrl('not a url')).toBe('not a url');
    expect(compactUiUrl('')).toBe('');
  });

  it('formatBrowserToolCallDetail 只认 browser_ 前缀', () => {
    expect(formatBrowserToolCallDetail('read', { url: 'x' })).toBeUndefined();
    expect(typeof formatBrowserToolCallDetail('browser_navigate', { url: 'https://a.com' })).toBe('string');
  });
});

/* ══════════════ 归一化与去重 ══════════════ */

describe('归一化', () => {
  it('normalizeToolName 展开别名', () => {
    expect(normalizeToolName('read')).toBe('readfile');
    expect(normalizeToolName('bash')).toBe('execute_bash');
    expect(normalizeToolName('grep')).toBe('search');
  });

  it('normalizeToolName 未知名原样返回, 空值透传', () => {
    expect(normalizeToolName('my_custom_tool')).toBe('my_custom_tool');
    expect(normalizeToolName(undefined)).toBeUndefined();
  });

  it('resolveToolCallId 从多种字段名取 id', () => {
    expect(typeof resolveToolCallId({ toolId: 't1' })).toBe('string');
    expect(resolveToolCallId({})).toBeUndefined();
  });

  it('normalizeErrorMessage 对空值给空串', () => {
    expect(normalizeErrorMessage(undefined)).toBe('');
  });

  it('normalizeToolArgsForUi 接受对象 / JSON 串 / 垃圾输入', () => {
    expect(normalizeToolArgsForUi({ a: 1 })).toEqual({ a: 1 });
    expect(normalizeToolArgsForUi('{"a":1}')).toEqual({ a: 1 });
    expect(normalizeToolArgsForUi('not json')).toEqual({});
    expect(normalizeToolArgsForUi(null)).toEqual({});
    expect(normalizeToolArgsForUi('"a string"')).toEqual({});
  });

  it('isLikelyDuplicateError: 相同或包含关系判重', () => {
    expect(isLikelyDuplicateError('Bad gateway', 'Bad gateway')).toBe(true);
    expect(isLikelyDuplicateError('Error: Bad gateway', 'Bad gateway')).toBe(true);
    expect(isLikelyDuplicateError('Bad gateway', 'Timeout')).toBe(false);
  });

  it('isLikelyDuplicateError: 空值不判重 —— 否则会吞掉真错误', () => {
    expect(isLikelyDuplicateError(undefined, 'x')).toBe(false);
    expect(isLikelyDuplicateError('', '')).toBe(false);
  });

  it('isCompletionLogMessage 对空值不误判', () => {
    expect(isCompletionLogMessage(undefined)).toBe(false);
    expect(isCompletionLogMessage('')).toBe(false);
  });
});

/* ══════════════ 流式参数预览 ══════════════ */

describe('extractStreamedArgPreview · 残缺 JSON 也要能露出主参数', () => {
  it('完整 JSON 取主参数', () => {
    expect(extractStreamedArgPreview('{"query":"hello world"}')).toBe('hello world');
  });

  it('残缺 JSON (闭引号还没到) 也能抽出', () => {
    expect(extractStreamedArgPreview('{"query":"hello wor')).toContain('hello wor');
  });

  it('按工具语义优先: command 优先于兜底的 name', () => {
    expect(extractStreamedArgPreview('{"name":"x","command":"ls -la"}')).toBe('ls -la');
  });

  it('抽不到有意义内容返回空串, 不抛', () => {
    expect(extractStreamedArgPreview('')).toBe('');
    expect(extractStreamedArgPreview('{')).toBe('');
    expect(extractStreamedArgPreview('{"irrelevant":1}')).toBe('');
  });

  it('超长值被截断', () => {
    const out = extractStreamedArgPreview(`{"query":"${'z'.repeat(500)}"}`);
    expect(out.length).toBeLessThanOrEqual(120);
  });
});
