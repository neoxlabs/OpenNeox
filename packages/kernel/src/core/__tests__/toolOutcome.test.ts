/**
 * 工具返回失败语义但不抛异常时, 时间线不许标记为成功。
 *
 *   同时保留成功命令的成功状态；例如搜索无匹配的退出码不代表工具执行失败。
 */
import { describe, expect, it } from 'vitest';
import { readToolSelfReportedOutcome as read } from '../toolOutcome.js';
import {
  createEphemeralResult,
  createContextualResult,
  markToolFailure,
  TOOL_FAILURE_TAG,
} from '../types/toolResult.js';

describe('工具自报的成败', () => {
  /* 命令的成败不等同于工具的成败。
   *   execute_shell 把命令跑起来、输出拿回来、退出码如实带回, 它就是成功的。
   *   测试挂了 / tsc 报错 / 构建失败是**命令内容**的事, 模型从输出里看得见 (还带
   *   semantics + hint), 不该翻译成时间线上的红叉 —— 那会让"跑测试发现 3 个失败"
   *   这种完全正常的一步长期挂红。
   *   工具状态依据工具执行是否完成及其语义字段判定，不能仅由命令退出码推导。 */
  it('shell 退出码一律不算工具失败 —— 那是命令的结果不是工具的结果', () => {
    expect(read('FAILED tests/x.py\n[exit 1 / test_failed / FAILURE]')).toBe(null);
    expect(read('boom\n[exit 127]')).toBe(null);
    expect(read('foo\n[exit 1 / no_match / SUCCESS]')).toBe(null);
    expect(read('ok\n[exit 0 / empty_output / SUCCESS]')).toBe(null);
    /* 真正的工具层失败 (spawn 不起来 / cwd 不存在) 会抛异常, 由 invokeTool 的 catch 兜 */
  });

  it('对象结果带 success / isError', () => {
    expect(read({ success: false, error: 'nope' })).toBe(false);
    expect(read({ success: true })).toBe(true);
    expect(read({ isError: true })).toBe(false);
    expect(read({ data: 1 })).toBe(null);          /* 没表态 → 交给默认 */
  });

  /* ── 写: 结构化 ToolResult 被 stringify 成字符串再返回 (write_file / edit / …) ── */
  it('JSON 字符串形态的 ToolResult: status 说了算', () => {
    const failed = JSON.stringify(createEphemeralResult('write_file', 'error', 'Failed to write file: EACCES'));
    const ok = JSON.stringify(createEphemeralResult('write_file', 'success', 'File written'));
    const idempotent = JSON.stringify(createEphemeralResult('write_file', 'already_done', '内容相同, 跳过'));
    expect(read(failed)).toBe(false);
    expect(read(ok)).toBe(true);
    /* already_done 是幂等成功, 不是失败 —— 判成失败就等于告诉用户"没写成" */
    expect(read(idempotent)).toBe(true);
    /* 对象直接返回 (没被 stringify) 的那条路也要认 */
    expect(read(createContextualResult('read_document', 'error', '解析失败'))).toBe(false);
  });

  it('不是我们的形状就不认: 光有 status 不够', () => {
    /* 工具完全可能把上游 API 的 JSON 原样返回, 那里的 status 跟成败无关 */
    expect(read('{"status":"error"}')).toBe(null);
    expect(read('{"status":"error","code":500}')).toBe(null);
    expect(read('{"status":"active","tool":"x"}')).toBe(null);
    expect(read('这不是 JSON {"status":"error","tool":"x"}')).toBe(null);
  });

  /* ── 读: 纯文本工具自己贴的失败尾标 ── */
  it('纯文本失败尾标: 必须是最后一个非空行整行', () => {
    expect(read(markToolFailure('✗ 读取失败: ENOENT'))).toBe(false);
    expect(read(`✗ 路径不存在\n${TOOL_FAILURE_TAG}\n\n`)).toBe(false);
    /* 读到一个**记录过这行**的日志文件 —— 尾标不在最后一行, 不算失败 */
    expect(read(`日志里出现过 ${TOOL_FAILURE_TAG} 这一行\n后面还有正文`)).toBe(null);
    /* 行内出现也不算 —— 必须整行 */
    expect(read(`grep 命中: foo ${TOOL_FAILURE_TAG} bar`)).toBe(null);
  });

  it('尾标只给判读器看, 界面那份要摘掉', async () => {
    const { stripToolFailureTag } = await import('../types/toolResult.js');
    expect(stripToolFailureTag(markToolFailure('✗ 读取失败: ENOENT'))).toBe('✗ 读取失败: ENOENT');
    /* 正文里出现的同样字样不许动 —— 跟判读器同一口径, 只摘最后那一整行 */
    const body = `日志里出现过 ${TOOL_FAILURE_TAG} 这一行\n后面还有正文`;
    expect(stripToolFailureTag(body)).toBe(body);
    /* 没贴过的原样返回 */
    expect(stripToolFailureTag('普通输出')).toBe('普通输出');
  });

  it('markToolFailure 幂等, 不重复贴', () => {
    const once = markToolFailure('✗ 读取失败');
    expect(markToolFailure(once)).toBe(once);
    expect(once.split(TOOL_FAILURE_TAG).length - 1).toBe(1);
  });

  /* 这条是防"启发式"回潮的。曾经想过按"输出以 Error: 开头"判失败 ——
   * 那会把"读一个日志文件"、"grep 出一堆报错行"这种**成功的读取**判成失败。 */
  it('不猜: 没有我们自己的标记就一律返回 null, 不看内容长什么样', () => {
    expect(read('Error: something looks bad in this log')).toBe(null);
    expect(read('failed to connect (这是文件内容, 不是工具结论)')).toBe(null);
    /* ✗ /  开头也不许猜 —— readfile 读到一个以 ✗ 开头的文件就会长这样。
     * 失败要算数, 得由工具自己贴尾标 (markToolFailure)。 */
    expect(read('✗ 这一行是文件内容里的')).toBe(null);
    expect(read('❌ 用例 3 失败 (这是被读取的报告正文)')).toBe(null);
    expect(read('')).toBe(null);
    expect(read(undefined)).toBe(null);
    expect(read(null)).toBe(null);
  });
});
