
import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

type SubKind = 'reminder' | 'cron' | 'wakeup' | 'other';
type Status = 'scheduled' | 'fired' | 'done' | 'canceled';

const ClockIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="10" cy="11" r="6.5" />
    <path d="M10 7v4l2.5 1.5" />
    <path d="M7 3.5 5 5M13 3.5l2 1.5" />
  </svg>
);
const CronIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 10a6 6 0 0 1 10.5-4L16 8M16 4v4h-4" />
    <path d="M16 10a6 6 0 0 1-10.5 4L4 12M4 16v-4h4" />
  </svg>
);
const MoonIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15.5 12A6 6 0 0 1 8 4.5 6.5 6.5 0 1 0 15.5 12z" />
  </svg>
);
const CalendarIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="5" width="13" height="11" rx="1.5" />
    <path d="M3.5 8.5h13M7 3v4M13 3v4" />
  </svg>
);

const ICON_BY_SUB: Record<SubKind, React.ComponentType> = {
  reminder: ClockIcon,
  cron: CronIcon,
  wakeup: MoonIcon,
  other: CalendarIcon,
};

const BADGE_ZH: Record<Status, string> = {
  scheduled: '已设',
  fired: '到点了',
  done: '已完成',
  canceled: '已取消',
};
const BADGE_EN: Record<Status, string> = {
  scheduled: 'Set',
  fired: 'Time!',
  done: 'Done',
  canceled: 'Canceled',
};

export const TimerCardView: React.FC<{
  subKind?: SubKind;
  status: Status;
  title: string;
  context?: string;
  atText?: string;
  recurrence?: string;
}> = ({ subKind = 'reminder', status, title, context, atText, recurrence }) => {
  const { isZh } = useI18n();
  const Icon = ICON_BY_SUB[subKind];
  return (
    <div className={`tmr tmr--${status}`}>
      <div className="tmr__inner">
        <div className="tmr__top">
          <span className="tmr__icon" aria-hidden="true"><Icon /></span>
          <span className="tmr__badge">{(isZh ? BADGE_ZH : BADGE_EN)[status]}</span>
          {recurrence && <span className="tmr__recur">{recurrence}</span>}
        </div>
        {atText && <div className="tmr__time">{atText}</div>}
        <div className="tmr__title">{title}</div>
        {context && <div className="tmr__context">{context}</div>}
      </div>
    </div>
  );
};

export default TimerCardView;
