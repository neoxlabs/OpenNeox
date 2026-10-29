import React, { useMemo } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { useTimelineFeed } from '../../../state/timelineFeedStore';
import { dropPilotPatrolNoise } from '../../agent-timeline/pilotPatrolFilter';
import * as S from '../../shell/shellIcons';

export type StageIconName = Icon;
type Icon = 'alarm' | 'phone' | 'sms' | 'user' | 'calendar' | 'pin' | 'app' | 'bell' | 'search' | 'globe' | 'screen' | 'cloud' | 'term' | 'file' | 'clock' | 'mail' | 'gear' | 'eye' | 'wrench';

interface FeedEntry {
  id?: string;
  type?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  output?: unknown;
  success?: boolean;
  isBatch?: boolean;
  pending?: boolean;
  errorMessage?: string;
}

export interface StageCard {
  id: string;
  icon: Icon;
  title: string;
  sub: string;
  status: 'running' | 'ok' | 'error';
  tool: string;
  args: Record<string, unknown>;
  output: string;
}

/** 准备动作: 不是「替你办的事」, 不上台 */
const BACKSTAGE = new Set([
  'tool_search', 'list_directory', 'browser_list_surfaces', 'update_plan', 'update_todos', 'read_file',
  'search', 'smart_tree', 'show_tree', 'context_status', 'use_skill', 'list_pending_tasks', 'memory', 'cron_list',
]);

const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const pad2 = (n: unknown) => String(n ?? 0).padStart(2, '0');
const host = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };

/** 工具结果多半是 JSON 壳 ({success, result} / {summary, content} ...), 取人话那一段 */
function plainOutput(raw: unknown): string {
  const text = s(raw).trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return text;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const k of ['result', 'summary', 'message', 'content', 'error', 'text']) {
      if (typeof j[k] === 'string' && j[k]) return j[k] as string;
    }
    return JSON.stringify(j, null, 2);
  } catch {
    return text;
  }
}

const PHONE: Record<string, { icon: Icon; zh: string; en: string }> = {
  set_alarm: { icon: 'alarm', zh: '手机闹钟', en: 'Phone alarm' },
  phone_call: { icon: 'phone', zh: '打电话', en: 'Calling' },
  send_sms: { icon: 'sms', zh: '发短信', en: 'Text message' },
  read_sms: { icon: 'sms', zh: '看短信', en: 'Reading texts' },
  contacts_search: { icon: 'user', zh: '找联系人', en: 'Contacts' },
  phone_calendar: { icon: 'calendar', zh: '手机日历', en: 'Phone calendar' },
  get_location: { icon: 'pin', zh: '你在哪', en: 'Location' },
  open_app: { icon: 'app', zh: '打开 App', en: 'Open app' },
  read_notifications: { icon: 'bell', zh: '手机通知', en: 'Notifications' },
  sensors: { icon: 'cloud', zh: '感受环境', en: 'Surroundings' },
  camera: { icon: 'eye', zh: '拍一张看看', en: 'Phone camera' },
  phone_ui: { icon: 'app', zh: '在手机上操作', en: 'Using the phone' },
};
const UI_OP: Record<string, [string, string]> = {
  snapshot: ['看屏幕', 'Looking'], tap: ['点', 'Tap'], tap_at: ['点', 'Tap'], type: ['输入', 'Type'],
  scroll: ['滑动', 'Scroll'], back: ['返回', 'Back'], home: ['回桌面', 'Home'], screenshot: ['截屏', 'Screenshot'],
};

function describe(tool: string, a: Record<string, unknown>, zh: boolean): { icon: Icon; title: string; sub: string } {
  const t = (z: string, e: string) => (zh ? z : e);
  if (tool === 'phone') {
    const action = s(a.action);
    const x = (a.args ?? {}) as Record<string, unknown>;
    const m = PHONE[action] ?? { icon: 'phone' as Icon, zh: '手机', en: 'Phone' };
    let sub = '';
    if (action === 'set_alarm') sub = x.op === 'timer' ? t(`倒计时 ${s(x.seconds)} 秒`, `Timer ${s(x.seconds)}s`) : `${pad2(x.hour)}:${pad2(x.minute)}${x.label ? ` · ${s(x.label)}` : ''}`;
    else if (action === 'phone_call' || action === 'send_sms') sub = s(x.number || x.to || x.name);
    else if (action === 'open_app') sub = s(x.package || x.query || x.uri);
    else if (action === 'sensors') sub = t('光线 · 气压 · 温湿度 · 电量', 'Light · pressure · temp · battery');
    else if (action === 'phone_ui') {
      const op = UI_OP[s(x.op)] ?? [s(x.op), s(x.op)];
      sub = [zh ? op[0] : op[1], s(x.text) || (x.target != null ? `#${s(x.target)}` : '')].filter(Boolean).join(' ');
    } else if (action === 'camera') sub =x.facing === 'front' ? t('前摄', 'Front') : t('后摄', 'Back');
    else sub = s(x.query || x.op);
    return { icon: m.icon, title: zh ? m.zh : m.en, sub };
  }
  switch (tool) {
    case 'report_to_user': return { icon: a.status === 'blocked' ? 'bell' : 'file', title: t('汇报', 'Report'), sub: s(a.title) };
    case 'cron_create': return { icon: 'clock', title: t('定时去做', 'Scheduled job'), sub: s(a.prompt).split('\n')[0] };
    case 'cron_delete': return { icon: 'clock', title: t('取消定时', 'Cancel job'), sub: s(a.id) };
    case 'schedule_reminder': return { icon: 'clock', title: t('提醒', 'Reminder'), sub: s(a.title) || s(a.when) };
    case 'call_user': return { icon: 'phone', title: t('打给你', 'Calling you'), sub: s(a.reason) };
    case 'get_weather': return { icon: 'cloud', title: t('天气', 'Weather'), sub: s(a.city || a.location) };
    case 'web_search': return { icon: 'search', title: t('搜索', 'Search'), sub: s(a.query) };
    case 'web_fetch': return { icon: 'globe', title: t('看网页', 'Reading page'), sub: host(s(a.url)) };
    case 'browser_run': {
      const steps = Array.isArray(a.steps) ? (a.steps as Array<{ args?: { url?: string } }>) : [];
      const url = steps.map((x) => x?.args?.url).find(Boolean);
      return { icon: 'globe', title: t('浏览器', 'Browser'), sub: url ? host(url) : t(`${steps.length} 步`, `${steps.length} steps`) };
    }
    case 'execute_shell': return { icon: 'term', title: t('命令', 'Command'), sub: s(a.command).split('\n')[0] };
    case 'write_file': case 'edit_file': case 'edit': return { icon: 'file', title: t('改文件', 'Editing'), sub: s(a.path || a.file_path).split('/').pop() ?? '' };
    case 'send_imessage': return { icon: 'sms', title: 'iMessage', sub: s(a.to) };
    case 'contacts_search': return { icon: 'user', title: t('联系人', 'Contacts'), sub: s(a.query) };
    case 'apple_reminders': return { icon: 'clock', title: t('提醒事项', 'Reminders'), sub: s(a.title || a.op) };
  }
  if (/^(calendar|gcal)_/.test(tool)) return { icon: 'calendar', title: t('日历', 'Calendar'), sub: s(a.title || a.calendarId) };
  if (/^(gmail|mail|email)_/.test(tool)) return { icon: 'mail', title: t('邮件', 'Mail'), sub: s(a.query || a.subject || a.to) };
  if (/^computer_/.test(tool)) return { icon: 'screen', title: t('操作电脑', 'Using the computer'), sub: s(a.app) };
  if (/^browser_/.test(tool)) return { icon: 'globe', title: t('浏览器', 'Browser'), sub: host(s(a.url)) };
  return { icon: 'gear', title: tool.replace(/_/g, ' '), sub: '' };
}

/** 这一轮 (最后一句你说的话之后) 它动过的手 */
export function useStageCards(): StageCard[] {
  const { isZh } = useI18n();
  const feed = useTimelineFeed() as unknown as FeedEntry[];
  return useMemo(() => {
    const visible = new Set(dropPilotPatrolNoise(feed));
    let from = 0;
    let end = feed.length;
    for (let i = feed.length - 1; i >= 0; i--) {
      if (feed[i].type !== 'user_message') continue;
      if (visible.has(feed[i]) || feed.slice(i + 1, end).some((x) => visible.has(x))) { from = i + 1; break; }
      end = i;
    }
    const byCall = new Map<string, StageCard>();
    for (const e of feed.slice(from, end).filter((x) => visible.has(x))) {
      if (!/^tool_(call|result|error)$/.test(e.type ?? '') || e.isBatch) continue;
      let tool = e.toolName ?? '';
      let args = (e.toolArgs ?? {}) as Record<string, unknown>;
      /* 会话中途解锁的工具经 call_tool 转一手: 台上显示真正被调的那个 */
      if (tool === 'call_tool') {
        tool = s(args.name || args.tool);
        args = (args.args ?? args.arguments ?? {}) as Record<string, unknown>;
      }
      if (!tool || BACKSTAGE.has(tool)) continue;
      const id = e.toolCallId || e.id || `${tool}-${byCall.size}`;
      /* 很多工具失败时不抛错, 只回 {"error": ...} 或 {"success": false} —— 都算没成, 不能打勾 */
      const head = s(e.output).slice(0, 120);
      const failed = e.type === 'tool_error' || e.success === false || /"success"\s*:\s*false|^\s*\{\s*"error"\s*:/.test(head);
      const done = e.type !== 'tool_call' || (e.output != null && e.pending !== true);
      const d = describe(tool, args, isZh);
      const out = plainOutput(e.errorMessage || e.output);
      const did = tool === 'phone' ? /^(?:点了|填了)「[^」]+」/.exec(out)?.[0] : undefined;
      if (did) d.sub = did;
      byCall.set(id, {
        id,
        ...d,
        sub: d.sub || out.split('\n')[0],
        status: failed ? 'error' : done ? 'ok' : 'running',
        tool,
        args,
        output: out,
      });
    }
    return [...byCall.values()];
  }, [feed, isZh]);
}

// ───────────────────────── 图标 ─────────────────────────

/* 用全站那套 (shellIcons: 线宽按尺寸做光学补偿), 不在这里另画 */
const ICONS: Record<Icon, React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  alarm: S.IconAlarm,
  phone: S.IconHandset,
  sms: S.IconMessage,
  user: S.IconUserCircle,
  calendar: S.IconCalendar,
  pin: S.IconMapPin,
  app: S.IconPhone,
  bell: S.IconBell,
  search: S.IconSearch,
  globe: S.IconWeb,
  screen: S.IconDisplay,
  cloud: S.IconCloud,
  term: S.IconTerminal,
  file: S.IconFile,
  clock: S.IconClock,
  mail: S.IconMail,
  gear: S.IconCog,
  eye: S.IconEye,
  wrench: S.IconWrench,
};

export const StageIcon: React.FC<{ name: Icon; size?: number }> = ({ name, size = 18 }) => {
  const C = ICONS[name];
  return <C size={size} aria-hidden />;
};

