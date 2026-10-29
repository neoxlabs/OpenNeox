/**
 * Pilot 左边那一列 (稿 pilot-day): 线条小图标 + 两个字, 选中的那格浮起一块奶油色卵石。
 * 上面是房间 (今天 / 对话 / 钱 / 身体 / 足迹 / 关系 / 生活), 底下是分身和设置。
 */
import React from 'react';
import { useI18n } from '../../../hooks/useI18n';

/** notes = 它替你记着的 (从「今天」点进去, 不单占一格导航) */
export type PilotPage = 'today' | 'chat' | 'money' | 'body' | 'place' | 'people' | 'life' | 'team' | 'settings' | 'notes' | 'connect' | 'auto';

const S = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const ICON: Record<PilotPage, React.ReactNode> = {
  today: <svg {...S}><path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4z" /></svg>,
  chat: <svg {...S}><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17H11l-4 3v-3H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5Z" /><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" /></svg>,
  money: <svg {...S}><ellipse cx="12" cy="6.5" rx="7" ry="2.5" /><path d="M5 6.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5M5 11.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5" /></svg>,
  body: <svg {...S}><path d="M12 19.5s-7.5-4.3-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.7-7.5 10-7.5 10Z" /></svg>,
  place: <svg {...S}><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.2" /></svg>,
  people: <svg {...S}><circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0M15.5 5.6a3.2 3.2 0 0 1 0 6.1M17.5 14.2a5.5 5.5 0 0 1 3 5.3" /></svg>,
  life: <svg {...S}><path d="M12 20V11M12 11c0-3.5 2.5-6 6.5-6 0 3.8-2.6 6-6.5 6ZM12 13.5c0-3-2.2-5-5.5-5 0 3.2 2.2 5 5.5 5Z" /></svg>,
  team: <svg {...S}><path d="M6 9.5 5 4.5l3.5 2.5h7L19 4.5l-1 5c.9 1.1 1.5 2.5 1.5 4 0 3.6-3.4 6.5-7.5 6.5S4.5 17.1 4.5 13.5c0-1.5.6-2.9 1.5-4Z" /><path d="M9.5 13h.01M14.5 13h.01" /></svg>,
  settings: <svg {...S}><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></svg>,
  notes: <svg {...S}><path d="M6 3.5h9l3 3V20.5H6z" /><path d="M9 10h6M9 13.5h6M9 17h3.5" /></svg>,
  auto: <svg {...S}><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /><path d="M19.5 4.5l-1.8 1.8" /></svg>,
  connect: <svg {...S}><path d="M9 7V3.5M15 7V3.5M7 7h10v4a5 5 0 0 1-10 0z" /><path d="M12 16v4.5" /></svg>,
};
const LABEL: Record<PilotPage, [string, string]> = {
  today: ['今天', 'Today'], chat: ['对话', 'Chat'], money: ['钱', 'Money'], body: ['身体', 'Body'], place: ['足迹', 'Places'],
  people: ['关系', 'People'], life: ['生活', 'Life'], team: ['分身', 'Team'], settings: ['设置', 'Settings'], notes: ['记着的', 'Kept'], connect: ['连接', 'Connect'], auto: ['自动化', 'Autos'],
};

interface Props {
  page: PilotPage;
  /** 上面那组里已经做好的房间 (没做好的不露出来) */
  rooms: PilotPage[];
  bottom: PilotPage[];
  onChange: (p: PilotPage) => void;
}

export const PilotNav: React.FC<Props> = ({ page: rawPage, rooms, bottom, onChange }) => {
  const { isZh } = useI18n();
  /* 「它替你记着的」是今天的下一层: 导航上仍亮「今天」 (稿 pl10) */
  /* 房间 (钱 / 身体 …) 是今天的下一层: 导航上仍亮「今天」 */
  const page: PilotPage = ['money', 'body', 'place', 'people', 'life'].includes(rawPage) ? 'today' : rawPage;
  const item = (p: PilotPage) => (
    <button key={p} type="button" className={`pv3-nav__item${page === p ? ' is-on' : ''}`} aria-current={page === p ? 'page' : undefined} onClick={() => onChange(p)}>
      {ICON[p]}
      <span>{LABEL[p][isZh ? 0 : 1]}</span>
    </button>
  );
  return (
    <nav className="pv3-nav" aria-label="Pilot">
      <div className="pv3-nav__group">{rooms.map(item)}</div>
      <div className="pv3-nav__group">{bottom.map(item)}</div>
    </nav>
  );
};

export default PilotNav;
