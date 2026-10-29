
import React from 'react';
import type { ScheduledWakeup, MonitorEvent, ScheduledTaskFired, ReminderFired, SessionMessage } from './systemMessageParsers';
import { IconBell, IconClock, IconEye, IconMessage, IconSun } from '../../shell/shellIcons';
import { useI18n } from '../../../hooks/useI18n';

type SystemNoticeProps = { timestamp?: string; /** 同一条消息里连着到的同一件事 (忙的时候攒下的几次触发) */ repeat?: number } & (
  | { subtype: 'wakeup'; wakeup: ScheduledWakeup }
  | { subtype: 'monitor'; monitor: MonitorEvent }
  | { subtype: 'scheduled_task'; task: ScheduledTaskFired }
  | { subtype: 'reminder'; reminder: ReminderFired }
  | { subtype: 'session_message'; message: SessionMessage }
);

export const SystemNoticeCell: React.FC<SystemNoticeProps> = (props) => {
  const { isZh: zh } = useI18n();
  const common = { timestamp: props.timestamp, repeat: props.repeat };
  switch (props.subtype) {
    case 'scheduled_task': {
      const t = props.task;
      return (
        <EventCard
          {...common} kind="scheduled_task" tone="timer" icon={<IconClock size={13} />}
          title={zh ? '定时任务' : 'Scheduled task'}
          meta={humanCron(t.cron, zh)}
          badge={t.lateByMinutes ? lateBadge(t.lateByMinutes, zh) : undefined}
          main={t.prompt}
        />
      );
    }
    case 'reminder': {
      const r = props.reminder;
      return (
        <EventCard
          {...common} kind="reminder" tone="reminder" icon={<IconBell size={13} />}
          title={zh ? '提醒' : 'Reminder'}
          badge={r.lateByMinutes ? lateBadge(r.lateByMinutes, zh) : undefined}
          main={r.title}
          sub={r.context}
        />
      );
    }
    case 'wakeup': {
      const w = props.wakeup;
      return (
        <EventCard
          {...common} kind="wakeup" tone="wakeup" icon={<IconSun size={13} />}
          title={zh ? '定时唤醒' : 'Wakeup'}
          meta={w.elapsedSeconds > 0 ? (zh ? `睡了 ${humanDuration(w.elapsedSeconds, zh)}` : `after ${humanDuration(w.elapsedSeconds, zh)}`) : undefined}
          main={w.reason || w.prompt}
          /* agent 给自己留的「醒来做什么」—— 跟原因不重样才值得多占一行 */
          sub={w.reason && w.prompt && w.prompt !== w.reason ? w.prompt : undefined}
        />
      );
    }
    case 'monitor': {
      const m = props.monitor;
      const outcome = m.outcome === 'timeout' ? 'timeout' : m.outcome === 'stopped' ? 'stopped' : 'fired';
      /* detail 第一行是 "Matched 2 line(s) in …" 这类说明, 命中的内容从第二行起 */
      const hits = outcome === 'fired' ? m.detail.split('\n').slice(1).filter((l) => l.trim()).slice(0, 8) : [];
      const fireCount = /^(\d+)\/(\d+)/.exec(m.fire);
      return (
        <EventCard
          {...common} kind="monitor" tone={outcome === 'fired' ? 'monitor' : 'muted'} icon={<IconEye size={13} />}
          title={outcome === 'timeout' ? (zh ? '监控到期' : 'Monitor expired')
            : outcome === 'stopped' ? (zh ? '监控已停止' : 'Monitor stopped')
            : (zh ? '监控命中' : 'Monitor fired')}
          meta={outcome === 'timeout' ? (zh ? '一直没等到' : 'never happened')
            : fireCount && Number(fireCount[2]) > 1 ? (zh ? `第 ${fireCount[1]}/${fireCount[2]} 次` : `${fireCount[1]}/${fireCount[2]}`) : undefined}
          main={m.label}
          lines={hits}
        />
      );
    }
    case 'session_message': {
      /* 本机别的会话发来的话: 头一行是谁 (哪个会话 · 终端还是桌面 · 哪个目录), 正文是它说的。
       * 跟用户气泡同一个分量 —— 它就是这一轮的起因。正文可能有好几段, 默认收 6 行, 点开看全。 */
      const m = props.message;
      const app = m.fromClient === 'cli' ? (zh ? '终端' : 'CLI') : m.fromClient === 'desktop' ? (zh ? '桌面' : 'Desktop') : '';
      const dir = shortDir(m.fromCwd);
      return (
        <EventCard
          {...common} kind="session_message" tone="peer" icon={<IconMessage size={13} />}
          title={zh ? `来自「${m.fromName || m.fromSessionId.slice(0, 8)}」` : `From “${m.fromName || m.fromSessionId.slice(0, 8)}”`}
          meta={[app, dir].filter(Boolean).join(' · ') || undefined}
          main={m.body}
          expandable
          /* 发件的也是桌面会话: 点名字跳过去看它在干什么 (终端会话桌面里打不开, 不给点) */
          onTitleClick={m.fromClient === 'desktop' && m.fromSessionId
            ? () => window.dispatchEvent(new CustomEvent('neox:select-session', { detail: { sessionId: m.fromSessionId } }))
            : undefined}
          titleHint={zh ? '打开这个会话' : 'Open this session'}
        />
      );
    }
    default:
      return null;
  }
};

/** 工作目录只露最后两段 —— 认得出是哪个项目就够 */
function shortDir(p: string): string {
  const parts = (p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? parts.join('/') : `…/${parts.slice(-2).join('/')}`;
}

/* ── 卡 ─────────────────────────────────────────────── */

interface EventCardProps {
  kind: string;
  tone: 'timer' | 'reminder' | 'wakeup' | 'monitor' | 'peer' | 'muted';
  icon: React.ReactNode;
  title: string;
  meta?: string;
  badge?: string;
  main?: string;
  sub?: string;
  lines?: string[];
  timestamp?: string;
  repeat?: number;
  /** 正文长的时候可以点开看全 (会话消息是一段话, 不是一行回执) */
  expandable?: boolean;
  /** 标题可点 (会话消息: 跳到发件会话) */
  onTitleClick?: () => void;
  titleHint?: string;
}

/** 超过这么多行 / 字就收起来 —— 跟 CSS 里 --peer 的 line-clamp 对上 */
const CLAMP_LINES = 6;
const CLAMP_CHARS = 420;

const EventCard: React.FC<EventCardProps> = ({ kind, tone, icon, title, meta, badge, main, sub, lines = [], timestamp, repeat = 1, expandable = false, onTitleClick, titleHint }) => {
  const [open, setOpen] = React.useState(false);
  const long = expandable && !!main && (main.split('\n').length > CLAMP_LINES || main.length > CLAMP_CHARS);
  return (
    <div className={`atl-evcard atl-evcard--${tone}`} data-content-type={`system-event-${kind}`}>
      <div className="atl-evcard__head">
        <span className="atl-evcard__icon" aria-hidden="true">{icon}</span>
        {onTitleClick
          ? <button type="button" className="atl-evcard__title is-link" onClick={onTitleClick} title={titleHint}>{title}</button>
          : <span className="atl-evcard__title">{title}</span>}
        {meta && <span className="atl-evcard__meta">{meta}</span>}
        {repeat > 1 && <span className="atl-evcard__pill">×{repeat}</span>}
        {badge && <span className="atl-evcard__pill is-warn">{badge}</span>}
        {timestamp && <span className="atl-evcard__time">{timestamp}</span>}
      </div>
      {main && <div className={`atl-evcard__main${open ? ' is-open' : ''}`} title={long ? undefined : main}>{main}</div>}
      {long && (
        <button type="button" className="atl-evcard__more" onClick={() => setOpen((v) => !v)}>
          <EvMoreLabel open={open} />
        </button>
      )}
      {sub && <div className="atl-evcard__sub">{sub}</div>}
      {lines.length > 0 && <pre className="atl-evcard__lines">{lines.join('\n')}</pre>}
    </div>
  );
};

const EvMoreLabel: React.FC<{ open: boolean }> = ({ open }) => {
  const { isZh } = useI18n();
  return <>{open ? (isZh ? '收起' : 'Show less') : (isZh ? '展开全文' : 'Show all')}</>;
};

/* ── 文案 ─────────────────────────────────────────────── */

function lateBadge(minutes: number, zh: boolean): string {
  return zh ? `迟到 ${humanDuration(minutes * 60, zh)}` : `${humanDuration(minutes * 60, zh)} late`;
}

export function humanDuration(seconds: number, zh: boolean): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return zh ? `${s} 秒` : `${s}s`;
  /* 十分钟内带上秒: 90 秒说成「2 分钟」是错的, 用户刚刚才定的就是 90 秒 */
  if (s < 600) {
    const sec = s % 60;
    return zh ? `${Math.floor(s / 60)} 分${sec ? ` ${sec} 秒` : '钟'}` : `${Math.floor(s / 60)}m${sec ? ` ${sec}s` : ''}`;
  }
  const m = Math.round(s / 60);
  if (m < 60) return zh ? `${m} 分钟` : `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return zh ? `${h} 小时${rest ? ` ${rest} 分` : ''}` : `${h}h${rest ? ` ${rest}m` : ''}`;
}

const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 常见的几种 cron 说成人话, 其余原样 (宁可给原文也不猜错) */
export function humanCron(expr: string, zh: boolean): string {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mi, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  const num = (s: string) => /^\d+$/.test(s);
  const hm = () => `${hr.padStart(2, '0')}:${mi.padStart(2, '0')}`;
  if (mi === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return zh ? '每分钟' : 'every minute';
  const every = /^\*\/(\d+)$/.exec(mi);
  if (every && hr === '*' && dom === '*' && mon === '*' && dow === '*') return zh ? `每 ${every[1]} 分钟` : `every ${every[1]} min`;
  if (num(mi) && hr === '*' && dom === '*' && mon === '*' && dow === '*') return zh ? `每小时第 ${mi} 分` : `hourly at :${mi.padStart(2, '0')}`;
  if (!num(mi) || !num(hr) || mon !== '*') return expr;
  if (dom === '*' && dow === '*') return zh ? `每天 ${hm()}` : `daily ${hm()}`;
  if (dom === '*' && dow === '1-5') return zh ? `工作日 ${hm()}` : `weekdays ${hm()}`;
  if (dom === '*' && /^[0-6]$/.test(dow)) return zh ? `每${WEEKDAYS_ZH[Number(dow)]} ${hm()}` : `${WEEKDAYS_EN[Number(dow)]} ${hm()}`;
  if (num(dom) && dow === '*') return zh ? `每月 ${dom} 日 ${hm()}` : `monthly day ${dom} ${hm()}`;
  return expr;
}
