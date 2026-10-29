
import type { TimelineEntry } from '../../utils/workspaceUtils';
import type { StepContent } from './types';
import { getGlobalLanguage } from '../../hooks/useI18n';

function parseJson(s: unknown): Record<string, any> | null {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch { /* 输出预览被截短: 从前缀里抠要用的几个字段 */ }
  const out: Record<string, any> = {};
  for (const k of ['status', 'to', 'error']) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(t);
    if (m) { try { out[k] = JSON.parse(`"${m[1]}"`); } catch { out[k] = m[1]; } }
  }
  const count = /^\{"count":(\d+)/.exec(t);
  if (count) out.count = Number(count[1]);
  return out;
}

function preview(s: string, max = 48): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function buildSessionPeerContent(entry: TimelineEntry): StepContent | undefined {
  const tool = (entry.toolName || '').toLowerCase();
  if (tool !== 'send_to_session' && tool !== 'list_sessions') return undefined;
  const zh = getGlobalLanguage() !== 'en';
  const args = (entry.toolArgs ?? {}) as Record<string, unknown>;
  const res = parseJson(entry.output);

  if (tool === 'list_sessions') {
    const n = typeof res?.count === 'number' ? res.count : Array.isArray(res?.sessions) ? res!.sessions.length : undefined;
    return {
      type: 'op_chip',
      icon: 'sessions',
      label: zh ? '查看本机会话' : 'List sessions',
      hint: n === undefined ? undefined : n === 0 ? (zh ? '没有别的会话开着' : 'none open') : (zh ? `${n} 个` : `${n} open`),
      tone: 'plain',
    };
  }

  const message = typeof args.message === 'string' ? args.message : '';
  const to = (typeof res?.to === 'string' && res.to) || (typeof args.to === 'string' ? args.to : '');
  const failed = res?.status === 'error';
  return {
    type: 'op_chip',
    icon: 'send',
    /* 收件人进标签: 分组行里 target 排在 hint 后面, 「发消息给 <正文> · 名字」读不通 */
    label: failed
      ? (zh ? `没发给${to ? `「${to}」` : '对方'}` : `Not sent${to ? ` to “${to}”` : ''}`)
      : (zh ? `发消息给${to ? `「${to}」` : '会话'}` : `Message${to ? ` “${to}”` : ''}`),
    hint: failed ? String(res?.error || '') : message ? preview(message) : undefined,
    tone: failed ? 'err' : 'primary',
  };
}
