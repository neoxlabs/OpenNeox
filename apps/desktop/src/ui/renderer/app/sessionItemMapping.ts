import type { SessionItem } from '../modules/shell/Sidebar';
import type { Session } from '../../shared/ipc';
import { displaySessionName } from '../state/sessionDisplayName';
import { getGlobalLanguage } from '../hooks/useI18n';
import { formatRelativeTime } from '../utils/formatRelativeTime';

export function formatSessionTime(ts: number): string {
  if (!ts) return '';
  /* 未来时间对会话没意义 (只可能是时钟漂移) — 夹到 0 走"刚刚/now" */
  return formatRelativeTime(Math.min(ts, Date.now()));
}
function formatTokens(n: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function buildSubtitle(s: Session): string | undefined {
  const parts: string[] = [];
  const msgCount = s.messageCount ?? s.messages?.length ?? 0;
  if (msgCount > 0) parts.push(`${msgCount} 条消息`);
  const tokens = (s.totalTokens as number | undefined) || 0;
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
export function isOrphanSubAgentPlaceholder(s: { name?: string | null; parentSessionId?: string | null; modelId?: string | null }): boolean {
  return !s.parentSessionId && !s.modelId && String(s.name ?? '').startsWith('子 Agent ');
}
export function isNeverRunCloudShell(c: { title?: string | null; totalActiveSecs?: number | null }): boolean {
  return !(c.title || '').trim() && c.totalActiveSecs === 0;
}

/**
 * mapSessionToItem — Session 行的"纯结构"快照, **不掺 active/streaming 运行时状态**.
 *
 *   旧版接 activeId / streaming 参数 → 每次切 session 或 stream chunk 到达, sessionItems
 *   useMemo 都被迫重算全量 → Sidebar 整列表 reconcile (用户报"切会话全局刷新一波").
 *
 *   现在: status/statusText 由 Sidebar 在 row 渲染时自己算 (拿到 activeSessionId + streaming
 *   独立 prop), SessionItem 只承载 session 本体数据. sessionItems memo 依赖只剩
 *   runtime.sessions + cloudSessions, 切 active / streaming 不再触发重算.
 */
export function mapSessionToItem(s: Session): SessionItem {
  const ts = (s.updatedAt as number | undefined) || (s.createdAt as number | undefined) || Date.now();
  return {
    id: s.id,
    /* 侧栏同样反解技术默认名 —— 不然一列 "New Chat - 10:18:36 PM" 谁也认不出哪条是哪条 */
    title: displaySessionName(s.name, s.createdAt as number | undefined, getGlobalLanguage() === 'zh'),
    subtitle: buildSubtitle(s),
    /* status/statusText 留空 — Sidebar 渲染时用 (id === activeSessionId && streaming) 算 */
    statusText: '',
    timeText: formatSessionTime(ts),
    ts,
    workspacePath: s.workspacePath,
    /* Work 任务文件夹 —— 侧栏据此判断任务属于哪个项目 */
    taskDir: s.taskDir ?? null,
    /* 暴露 messages 长度让 Sidebar 决定 "已完成" / 空状态文案 (slim 列表用 messageCount) */
    messageCount: (s.messageCount ?? s.messages?.length ?? 0),
    /* sub-agent 子 session 透传父 ID — Sidebar 据此把子节点嵌套渲染在父下面 */
    parentSessionId: (s as any).parentSessionId ?? null,
    agentMode: (s as any).agentMode ?? null,
    /* 会话种类 (image 图片会话) — Sidebar 显图标, 点击路由到图片页. */
    kind: (s as any).kind === 'image' ? 'image' : 'chat',
  };
}
