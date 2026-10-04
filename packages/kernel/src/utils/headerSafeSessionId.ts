/**
 * 发上游的会话 id 清洗成 URL 安全形状
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── 设计约束 ───────────────────────────────────────────────────────────────
 * 子 agent 的 sessionId 可能包含 `#` 等编号分隔符。它作为 `session_id` / `conversation_id`
 * 头发给上游。
 *
 * `#` 在 HTTP header 里合法, 但被拼进 URL 时会成为 fragment 分隔符。发送前统一替换
 * 非安全字符, 使上游在 header、URL 路由和日志查询中使用同一完整值。
 *
 * ── 为什么替换而不是丢弃 ────────────────────────────────────────────────────
 * 这个 id 同时是 prompt cache 的分区键 (上游按会话复用前缀缓存)。清洗必须是**确定性**的,
 * 以便同一个会话每次得到同一个值。
 * 替换成 `-` 而不是删掉, 也是为了不让 `a#b` 和 `ab` 撞成同一个 id。
 */

/** 安全字符集: 字母数字 + `_ . : -`。这几个在 URL path/query 里都不改变语义。 */
const UNSAFE = /[^A-Za-z0-9_.:-]/g;

/**
 * 把会话 id 清洗成能安全放进 header、且被上游拼进 URL 也不会截断的形状。
 *
 * 确定性: 同样的输入永远得到同样的输出 (prompt cache 分区键靠这个)。
 */
export function headerSafeSessionId(sessionId: string | null | undefined): string {
  return String(sessionId ?? '').replace(UNSAFE, '-');
}
