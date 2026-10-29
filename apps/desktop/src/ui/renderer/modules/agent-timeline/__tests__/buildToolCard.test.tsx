/**
 * 工具卡数据解析 —— 每条用 packages/core/src/tools 里真实的返回形状喂进去。
 * 也锁住两条规矩: 解不出就不出卡 (落回原来的展示), Work 模式不出代码类卡。
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, test, expect } from 'vitest';
import { buildToolCardContent, __testing } from '../toolCards/buildToolCard';
import { ToolCardView } from '../toolCards/ToolCardView';
import type { ToolCard } from '../toolCards/toolCardTypes';

const entry = (toolName: string, toolArgs: Record<string, unknown>, output: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'x', type: 'tool_result', toolName, toolArgs, output, success: true, ...extra }) as never;

const card = (e: never, mode?: string): ToolCard | undefined => {
  const c = buildToolCardContent(e, mode);
  return c && c.type === 'tool_card' ? c.card : undefined;
};

describe('buildToolCardContent', () => {
  test('share_page → 链接卡', () => {
    const c = card(entry('share_page', { title: '季度复盘' }, JSON.stringify({ ok: true, url: 'https://neox.ai/s/k3P9xq', files: 3, bytes: 1000 })));
    expect(c).toMatchObject({ kind: 'link', url: 'https://neox.ai/s/k3P9xq' });
  });

  test('render_video → 视频卡, 时长 m:ss', () => {
    const c = card(entry('render_video', {}, JSON.stringify({ status: 'success', output: '/w/产品介绍.mp4', duration: 42, width: 1920, height: 1080 })));
    expect(c).toMatchObject({ kind: 'video', path: '/w/产品介绍.mp4', duration: '0:42', resolution: '1080p' });
  });

  test('edit_image → 原图 → 结果; 没有原图路径就不出卡', () => {
    const out = JSON.stringify({ success: true, paths: ['/w/out.png'], count: 1 });
    expect(card(entry('edit_image', { image_path: '/w/in.png', prompt: '去掉背景' }, out))).toMatchObject({ kind: 'image_edit', before: '/w/in.png', after: ['/w/out.png'] });
    expect(card(entry('edit_image', { prompt: 'x' }, out))).toBeUndefined();
  });

  test('deck_begin 大纲 → 演示稿缩略', () => {
    const c = card(entry('deck_begin', { title: 'Q3', outline: [{ title: 'Q3 复盘', template: 'cover' }, { title: '收入', template: 'chart' }, { title: '下季度' }] }, '{"ok":true}'));
    expect(c).toMatchObject({ kind: 'slides', total: 3 });
    expect((c as Extract<ToolCard, { kind: 'slides' }>).slides.map((s) => s.title)).toEqual(['Q3 复盘', '收入', '下季度']);
  });

  test('pptx_read 文本头 → 读文档一行', () => {
    const c = card(entry('pptx_read', { file_path: '/w/a.pptx' }, 'file=/w/a.pptx · 12 slides · showing 1-4\n\n# ...'));
    expect(c).toMatchObject({ kind: 'read_doc', file: '/w/a.pptx', totalPages: 12, pages: '1-4' });
  });

  test('sheet_describe → 几列 × 几行', () => {
    const c = card(entry('sheet_describe', { file_path: '/w/销售.xlsx' }, JSON.stringify({ sheets: [{ name: 'Sheet1', used_range: 'A1:C48', rows: 48, cols: 3 }], total_sheets: 1 })));
    expect(c).toMatchObject({ kind: 'read_doc', sheet: 'Sheet1', rows: 48, cols: 3 });
  });

  test('calendar_add → 日程卡, 结束时间按时长推', () => {
    const c = card(entry('calendar_add', { title: '时间线改版评审', start: '2026-10-16T14:00:00', duration_minutes: 60, location: '会议室 3' }, JSON.stringify({ ok: true })));
    expect(c).toMatchObject({ kind: 'calendar', title: '时间线改版评审', location: '会议室 3' });
    expect((c as Extract<ToolCard, { kind: 'calendar' }>).end).toBeTruthy();
  });

  test('send_imessage → 蓝气泡; 没发成不出卡', () => {
    expect(card(entry('send_imessage', { to: '王经理', message: '评审改到周四' }, JSON.stringify({ ok: true, message: 'iMessage sent to 王经理.' })))).toMatchObject({ kind: 'message', text: '评审改到周四' });
    expect(card(entry('send_imessage', { to: 'x', message: 'y' }, JSON.stringify({ error: 'denied' })))).toBeUndefined();
  });

  test('exit_plan_mode → 编号步骤 + 等你点头', () => {
    const c = card(entry('exit_plan_mode', { plan: '## 方案\n1. 抽出行组件 `ToolRow.tsx`\n2. 每种工具一个卡片渲染器\n3. 结尾改动卡合并\n' }, '{"message":"ok"}'));
    expect(c).toMatchObject({ kind: 'plan', awaiting: true });
    expect((c as Extract<ToolCard, { kind: 'plan' }>).steps).toHaveLength(3);
  });

  test('knowledge_search 文本 → 命中片段', () => {
    const out = '命中 2 条 (用 readfile 读完整内容):\n\n### 售后规范 v3\npath: kb/售后规范 v3.docx\n超过 7 天的退款需要主管审批\n\n### 客服手册\npath: kb/客服手册.pdf\n原路退款一般 3-5 个工作日到账';
    const c = card(entry('knowledge_search', { query: '退款 流程' }, out));
    expect(c).toMatchObject({ kind: 'knowledge', query: '退款 流程' });
    expect((c as Extract<ToolCard, { kind: 'knowledge' }>).hits).toHaveLength(2);
  });

  test('memory write → 记住了一行', () => {
    expect(card(entry('memory', { action: 'write', content: '这个仓库测试用 vitest' }, '✓ 已保存到 memory/coding-conventions.md: 这个仓库测试用 vitest'))).toMatchObject({ kind: 'memory', op: 'save' });
  });

  test('git_status (-sb) → 分支 + 文件', () => {
    const out = JSON.stringify({ type: 'contextual', status: 'success', tool: 'git_status', summary: 'git status ok', content: '## main...origin/main [ahead 2]\n M src/a.ts\n?? new.ts' });
    const c = card(entry('git_status', {}, out));
    expect(c).toMatchObject({ kind: 'git_status', branch: 'main', ahead: 2 });
    expect((c as Extract<ToolCard, { kind: 'git_status' }>).files).toEqual([{ status: 'M', path: 'src/a.ts' }, { status: '??', path: 'new.ts' }]);
  });

  test('read_lints → 问题列表', () => {
    const c = card(entry('read_lints', {}, JSON.stringify({ count: 1, diagnostics: [{ path: '/w/a.ts', line: 3, column: 1, severity: 'error', message: 'x is not defined', source: 'ts', code: '2304' }] })));
    expect(c).toMatchObject({ kind: 'diagnostics' });
  });

  test('Work 模式不出代码类卡, 成品卡照出', () => {
    const git = entry('git_status', {}, JSON.stringify({ type: 'contextual', status: 'success', tool: 'git_status', summary: 'ok', content: '## main\n M a.ts' }));
    expect(card(git, 'work')).toBeUndefined();
    expect(card(git, 'code')).toBeDefined();
    expect(card(entry('share_page', {}, JSON.stringify({ ok: true, url: 'https://x.y/s/1' })), 'work')).toBeDefined();
  });

  test('失败 / 还在跑 / 不认识的工具 → 不出卡', () => {
    expect(card(entry('share_page', {}, JSON.stringify({ ok: true, url: 'https://x' }), { success: false }))).toBeUndefined();
    expect(card(entry('share_page', {}, JSON.stringify({ ok: true, url: 'https://x' }), { pending: true }))).toBeUndefined();
    expect(card(entry('some_unknown_tool', {}, '{"a":1}'))).toBeUndefined();
  });

  test('mcp__server__tool → 参数 / 结果按键值', () => {
    const c = card(entry('mcp__linear__get_issue', { id: 'NEO-12' }, JSON.stringify({ title: 'Fix', state: 'Done' })));
    expect(c).toMatchObject({ kind: 'mcp', server: 'linear', tool: 'get_issue' });
  });
});

describe('测试汇总行', () => {
  const { parseTestSummary, parseTestFailures } = __testing;
  test('vitest', () => expect(parseTestSummary('Tests  2 failed | 911 passed | 4 skipped (917)')).toEqual({ failed: 2, passed: 911, skipped: 4 }));
  test('jest', () => expect(parseTestSummary('Tests:       1 failed, 12 passed, 13 total')).toMatchObject({ failed: 1, passed: 12 }));
  test('pytest', () => expect(parseTestSummary('==== 3 failed, 10 passed in 1.2s ====')).toMatchObject({ failed: 3, passed: 10 }));
  test('失败用例的期望 / 实际', () => {
    const f = parseTestFailures(' FAIL  src/a.test.ts > sums\nAssertionError: expected 3 to be 4\nExpected: 4\nReceived: 3\n');
    expect(f[0]).toMatchObject({ name: 'src/a.test.ts > sums', expected: '4', actual: '3' });
  });
});

describe('ToolCardView 每种卡都画得出来', () => {
  const samples: ToolCard[] = [
    { kind: 'slides', file: '/w/a.pptx', total: 3, slides: [{ title: 'A' }, { title: 'B', layout: 'chart' }] },
    { kind: 'read_doc', file: '/w/a.pdf', pages: '1-4', totalPages: 12 },
    { kind: 'link', url: 'https://neox.ai/s/x' },
    { kind: 'video', path: '/w/a.mp4', duration: '0:42' },
    { kind: 'image_edit', before: '/w/a.png', after: ['/w/b.png'] },
    { kind: 'team', members: [{ name: '前端', action: '编辑 ToolRow.tsx', state: 'running' }, { name: '审查', state: 'done' }] },
    { kind: 'team_message', to: '前端', text: '图标列再往左 2px' },
    { kind: 'calendar', title: '评审', start: '2026-10-16T14:00:00', end: '2026-10-16T15:00:00', location: '会议室 3', invitees: 2 },
    { kind: 'message', to: '王经理', text: '改到周四', status: '已送达', at: '10:21' },
    { kind: 'plan', steps: ['a', 'b'], files: 6, awaiting: true },
    { kind: 'knowledge', query: '退款', hits: [{ title: '售后规范', snippet: '退款需要审批' }] },
    { kind: 'memory', op: 'recall', text: '发版前先跑 e2e', count: 3 },
    { kind: 'tests', passed: 10, failed: 1, failures: [{ name: 't', expected: '4', actual: '3' }] },
    { kind: 'git_status', branch: 'main', files: [{ status: 'M', path: 'a.ts' }] },
    { kind: 'git_log', items: [{ hash: 'abcdef123', title: 'fix' }] },
    { kind: 'refs', symbol: 'X', items: [{ file: '/w/a.ts', line: 3, tag: 'def' }] },
    { kind: 'diagnostics', items: [{ file: '/w/a.ts', line: 3, severity: 'error', message: 'bad' }] },
    { kind: 'service', name: 'npm run dev', url: 'http://localhost:5173', pid: 12, status: 'running' },
    { kind: 'python', code: 'print(1)', stdout: '1' },
    { kind: 'schedule', what: '跑进价核对', when: '0 9 * * *' },
    { kind: 'route', from: '家', to: '公司', minutes: 32, summary: '地铁 2 号线' },
    { kind: 'tool_search', tools: ['a_tool', 'b_tool'] },
    { kind: 'mcp', tool: 'get', params: [{ k: 'id', v: '1' }], result: [{ k: 'ok', v: 'true' }], raw: '{}' },
  ];
  test.each(samples.map((s) => [s.kind, s] as const))('%s', (_k, s) => {
    expect(renderToStaticMarkup(<ToolCardView card={s} />).length).toBeGreaterThan(20);
  });
});
