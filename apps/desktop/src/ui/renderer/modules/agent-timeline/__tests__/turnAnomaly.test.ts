import { describe, it, expect } from 'vitest';
import { isAnomalyEntry, isToolGuidanceEntry, pickCurrentTurnAnomalies, INTERRUPTED_NOTICE_ID_PREFIX } from '../turnAnomaly';

const e = (over: any) => ({ id: 'x', type: 'log', timestamp: 1, ...over }) as any;

describe('isAnomalyEntry', () => {
  it('runner_error 是异常态 (这一轮没跑成 / 超时 / 没收到回复 都是它)', () => {
    expect(isAnomalyEntry(e({ id: 'timeline-error-msg-u1-RUNTIME_ERROR', type: 'runner_error' }))).toBe(true);
  });

  it('「已停止」notice 是异常态', () => {
    expect(isAnomalyEntry(e({ id: `${INTERRUPTED_NOTICE_ID_PREFIX}msg-u1`, type: 'log' }))).toBe(true);
  });

  it('tool_error 不是 —— 某个工具真失败了是这一轮发生过的事实, 模型也看见了', () => {
    expect(isAnomalyEntry(e({ id: 't1', type: 'tool_error' }))).toBe(false);
  });

  it('正文一律不是 (误判会把用户的对话吞掉)', () => {
    for (const type of ['user_message', 'assistant_message', 'tool_call', 'edit_file', 'context_compaction']) {
      expect(isAnomalyEntry(e({ id: 'a', type }))).toBe(false);
    }
    expect(isAnomalyEntry(e({ id: 'plain-log', type: 'log' }))).toBe(false);
    expect(isAnomalyEntry(null)).toBe(false);
    expect(isAnomalyEntry(undefined)).toBe(false);
  });
});

describe('pickCurrentTurnAnomalies', () => {
  it('只取最后一条用户消息之后的 —— 上一轮的异常跟"现在"无关', () => {
    const tl = [
      e({ id: 'msg-u1', type: 'user_message' }),
      e({ id: 'timeline-error-msg-u1-NETWORK', type: 'runner_error' }),
      e({ id: 'msg-u2', type: 'user_message' }),
      e({ id: 'timeline-error-msg-u2-RUNTIME_ERROR', type: 'runner_error' }),
      e({ id: `${INTERRUPTED_NOTICE_ID_PREFIX}msg-u2`, type: 'log' }),
    ];
    expect(pickCurrentTurnAnomalies(tl).map((x) => x.id))
      .toEqual(['timeline-error-msg-u2-RUNTIME_ERROR', `${INTERRUPTED_NOTICE_ID_PREFIX}msg-u2`]);
  });

  it('不合并不折叠: 同一轮几条就是几条, 保持原序', () => {
    const tl = [
      e({ id: 'msg-u1', type: 'user_message' }),
      e({ id: 'timeline-error-a-A', type: 'runner_error' }),
      e({ id: 'assist', type: 'assistant_message' }),
      e({ id: 'timeline-error-a-B', type: 'runner_error' }),
    ];
    expect(pickCurrentTurnAnomalies(tl).map((x) => x.id)).toEqual(['timeline-error-a-A', 'timeline-error-a-B']);
  });

  it('本轮没异常 → 空数组 (异常区整条不渲染)', () => {
    expect(pickCurrentTurnAnomalies([
      e({ id: 'msg-u1', type: 'user_message' }),
      e({ id: 'assist', type: 'assistant_message' }),
    ])).toEqual([]);
  });

  it('没有用户消息锚点时扫全量 (历史回放/极早期)', () => {
    expect(pickCurrentTurnAnomalies([e({ id: 'timeline-error-x-A', type: 'runner_error' })]).length).toBe(1);
  });

  it('空输入安全', () => {
    expect(pickCurrentTurnAnomalies([])).toEqual([]);
  });
});

describe('只读探查的"没找到"不是异常', () => {
  const toolErr = (toolName: string, errorMessage: string) => ({
    id: `t-${toolName}`, type: 'tool_error', toolName, errorMessage, timestamp: 1,
  } as unknown as Parameters<typeof pickCurrentTurnAnomalies>[0][number]);

  const pick = (...es: Parameters<typeof pickCurrentTurnAnomalies>[0]) =>
    pickCurrentTurnAnomalies(es).map((e) => (e as { toolName?: string }).toolName);

  it('list_directory 的 ENOENT 不进异常区 (用户实拍那一条)', () => {
    expect(pick(toolErr('list_directory',
      "ENOENT: no such file or directory, scandir 'e:\\workspace\\ordersys\\order-ui\\src\\assets\\svg'"))).toEqual([]);
  });

  it('read_file / stat / ls 的"不存在"同理', () => {
    expect(pick(toolErr('read_file', 'ENOENT: no such file or directory'))).toEqual([]);
    expect(pick(toolErr('stat', 'file does not exist'))).toEqual([]);
    expect(pick(toolErr('ls', 'ENOTDIR: not a directory'))).toEqual([]);
  });

  it('原有的搜索类豁免不能被改坏', () => {
    expect(pick(toolErr('grep', 'no matches'))).toEqual([]);
    expect(pick(toolErr('search_files', '未找到'))).toEqual([]);
  });

  it('⚠️ 变更类工具失败仍然要报 —— 用户明确要过「写入失败应该有一张错误卡」', () => {
    expect(pick(toolErr('write_file', "ENOENT: no such file or directory, open 'x/y.ts'"))).toEqual(['write_file']);
    expect(pick(toolErr('edit_file', 'EACCES: permission denied'))).toEqual(['edit_file']);
  });

  it('只读工具的**非**"没找到"错误仍然要报 (权限 / 磁盘等真故障)', () => {
    expect(pick(toolErr('list_directory', 'EACCES: permission denied'))).toEqual(['list_directory']);
  });
});

describe('isToolGuidanceEntry —— 闸不是故障', () => {
  const envelope = (over: Record<string, unknown> = {}) => JSON.stringify({
    type: 'contextual', status: 'error', tool: 'team_roster',
    summary: '编制 1 人 —— 必须 2-20 人', content: '编制 1 人 —— 必须 2-20 人 (少于 2 不叫团队)',
    code: 'ROSTER_SIZE', guidance: true, ...over,
  });
  const err = (msg: string) => e({ id: 'te1', type: 'tool_error', toolName: 'team_roster', errorMessage: msg });

  it('带 guidance:true 的信封不进异常区', () => {
    expect(isToolGuidanceEntry(err(envelope()))).toBe(true);
    expect(pickCurrentTurnAnomalies([err(envelope())])).toEqual([]);
  });

  it('同一个工具的**真**故障 (没有 guidance 标记) 照旧要报', () => {
    const raw = envelope({ guidance: undefined });
    expect(isToolGuidanceEntry(err(raw))).toBe(false);
    expect(pickCurrentTurnAnomalies([err(raw)])).toHaveLength(1);
  });

  it('不是 JSON / 被截断且前缀里没有标记的信封当普通失败处理', () => {
    expect(isToolGuidanceEntry(err('{"type":"ephemeral","status":"error","summary":"write fa'))).toBe(false);
    expect(isToolGuidanceEntry(err('write failed'))).toBe(false);
  });

  it('被截成前缀的信封: 顶层标记还在就认 (createEphemeralResult 把标记排在最前, 2026-09-16)', () => {
    const truncated = '{"type":"ephemeral","status":"error","tool":"edit","summary":"String to replace not found in a.ts","final":false,"guidance":true,"file_path":"/w/a.ts","verify_hint":"照下面';
    expect(isToolGuidanceEntry(err(truncated))).toBe(true);
    /* verify_hint 正文里被转义的字样不算顶层标记 */
    const quoted = '{"type":"ephemeral","status":"error","tool":"edit","summary":"s","verify_hint":"说明: \\"guidance\\":true 是';
    expect(isToolGuidanceEntry(err(quoted))).toBe(false);
  });

  it('入账时认出的 toolGuidance 字段 —— errorMessage 只剩人话也不弹卡', () => {
    const entry = e({ id: 'te9', type: 'tool_error', toolName: 'edit_file', errorMessage: 'String to replace not found in a.ts', toolGuidance: true } as any);
    expect(pickCurrentTurnAnomalies([entry])).toEqual([]);
  });

  it('guidance 是布尔真才算 —— 字符串 "true" 不算 (别让上游随手塞的字段静音故障)', () => {
    expect(isToolGuidanceEntry(err(envelope({ guidance: 'true' })))).toBe(false);
  });

  it('edit_file 没读过文件 / 多处匹配 → 不进异常区 (2026-09-13 用户:「这种报错没必要显示吧, 都不影响」)', () => {
    const editErr = (code: string, summary: string) => e({
      id: `te-${code}`, type: 'tool_error', toolName: 'edit_file',
      errorMessage: JSON.stringify({
        type: 'ephemeral', status: 'error', tool: 'edit', summary, final: false,
        file_path: '/w/lib/essay_models.dart', error: code, verify_hint: '照下面摊出来的真实原文写 old_string',
        metadata: { coherence: 'unread' }, guidance: true,
      }),
    });
    expect(pickCurrentTurnAnomalies([
      editErr('file_not_read', "Cannot edit essay_models.dart: you haven't read this file yet"),
      editErr('ambiguous_match', 'Found 2 matches of old_string in essay_models.dart, but replace_all is false'),
    ])).toEqual([]);
  });
});

describe('isToolGuidanceEntry —— 前置条件不是故障', () => {
  const env = (tool: string, over: Record<string, unknown>) => JSON.stringify({
    type: 'contextual', status: 'error', tool, summary: 's', ...over,
  });
  const err = (tool: string, msg: string) =>
    e({ id: `te-${tool}`, type: 'tool_error', toolName: tool, errorMessage: msg });

  it('git_commit 在非 git 工作区 → 不弹卡', () => {
    expect(pickCurrentTurnAnomalies([
      err('git_commit', env('git_commit', { error: 'not_a_git_repo', precondition: true })),
    ])).toEqual([]);
  });

  it('没装解释器 / 没有图片模型 / 渠道没有联网搜索 —— 同一类', () => {
    for (const [tool, code] of [
      ['execute_javascript', 'runtime_not_installed'],
      ['edit_image', 'no_image_model_configured'],
      ['web_search', 'web_search_unsupported_on_this_provider'],
      ['run_tests', 'pytest not found on PATH'],
    ] as const) {
      expect(pickCurrentTurnAnomalies([err(tool, env(tool, { error: code, precondition: true }))])).toEqual([]);
    }
  });

  it('⚠️ 同一批工具的**真**故障照旧要报 —— 别把 precondition 变成万能静音开关', () => {
    expect(pickCurrentTurnAnomalies([
      err('git_commit', env('git_commit', { error: 'git commit failed: hook rejected' })),
    ])).toHaveLength(1);
    expect(pickCurrentTurnAnomalies([
      err('web_search', env('web_search', { error: 'upstream 500' })),
    ])).toHaveLength(1);
  });

  it('precondition 只认布尔真', () => {
    expect(isToolGuidanceEntry(err('x', env('x', { precondition: 'true' })))).toBe(false);
    expect(isToolGuidanceEntry(err('x', env('x', { precondition: 1 })))).toBe(false);
  });
});

describe('失败之后 agent 接着干了 = 已消化, 不进异常区', () => {
  const user = e({ id: 'u', type: 'user_message' });
  const failed = e({ id: 'f', type: 'tool_error', toolName: 'write_file', errorMessage: 'Path is outside workspace，已拒绝' });

  it('失败后还有别的工具调用 / 回复 → 不报', () => {
    expect(pickCurrentTurnAnomalies([user, failed, e({ id: 't', type: 'tool_call', toolName: 'execute_shell' })])).toEqual([]);
    expect(pickCurrentTurnAnomalies([user, failed, e({ id: 'a', type: 'assistant_message', detail: '写好了' })])).toEqual([]);
  });

  it('失败就是这一轮的尾巴 (后面只有思考 / 日志 / 别的失败) → 照报', () => {
    expect(pickCurrentTurnAnomalies([user, failed])).toHaveLength(1);
    expect(pickCurrentTurnAnomalies([user, failed, e({ id: 'th', type: 'thinking' }), e({ id: 'l', type: 'log' })])).toHaveLength(1);
    const failed2 = e({ id: 'f2', type: 'tool_error', toolName: 'edit', errorMessage: 'boom' });
    expect(pickCurrentTurnAnomalies([user, failed, failed2]).map((x: any) => x.id)).toEqual(['f', 'f2']);
  });

  it('runner_error 等兜底状态不受影响 —— 它们本来就是"现在没好"', () => {
    const runner = e({ id: 'r', type: 'runner_error' });
    expect(pickCurrentTurnAnomalies([user, runner, e({ id: 'a', type: 'assistant_message' })])).toHaveLength(1);
  });
});

describe('重连条目: 连上了就从异常区消失 (2026-09-22 实拍「连接已恢复 · 1.2s 后再试」挂到本轮结束)', () => {
  const user = e({ id: 'u', type: 'user_message' });
  const reconnect = (over: any) => e({ id: 'rc', level: 'warning', reconnectAttempt: 1, reconnectDelayMs: 1200, ...over });
  it('还在重连 → 显示', () => {
    expect(pickCurrentTurnAnomalies([user, reconnect({ pending: true })])).toHaveLength(1);
  });
  it('已恢复 / 本轮结束 → 不显示', () => {
    expect(pickCurrentTurnAnomalies([user, reconnect({ pending: false, title: '连接已恢复' })])).toHaveLength(0);
  });
  it('重试用尽 (level:error) → 仍然显示', () => {
    expect(pickCurrentTurnAnomalies([user, reconnect({ pending: false, level: 'error' })])).toHaveLength(1);
  });
});
