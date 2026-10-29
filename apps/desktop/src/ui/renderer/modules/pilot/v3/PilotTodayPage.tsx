import React, { useMemo, useRef } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { PilotVoiceBar } from '../PilotVoiceBar';
import { useAgenda } from '../board/AgendaSection';
import { usePlace, useWeather, weatherWord } from '../board/boardData';
import { usePilotMetricToday, usePilotOverview, yuan, type Insight } from './pilotData';
import { useInsightRunner } from './useInsightRunner';
import { usePilotReports } from '../usePilotReports';
import { PilotBrief } from './PilotBrief';
import sceneDay from '../../../media/pilot/scene-day.webp';
import sceneNight from '../../../media/pilot/scene-night.webp';

const WEEK_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
/* 卡片右上角的线条小图标, 按洞察所在的领域挑 */
const DOMAIN_ICON: Record<string, React.ReactNode> = {
  money: <svg {...S}><rect x="3" y="5.5" width="18" height="13" rx="2.5" /><path d="M3 10h18M7 15h3" /></svg>,
  day: <svg {...S}><rect x="4" y="9" width="16" height="11" rx="1.5" /><path d="M3 9h18v-3H3zM12 6v14M12 6C10 3 7 3.5 7.5 6M12 6c2-3 5-2.5 4.5 0" /></svg>,
  social: <svg {...S}><rect x="4" y="9" width="16" height="11" rx="1.5" /><path d="M3 9h18v-3H3zM12 6v14M12 6C10 3 7 3.5 7.5 6M12 6c2-3 5-2.5 4.5 0" /></svg>,
  body: <svg {...S}><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" /></svg>,
  habit: <svg {...S}><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10Z" /></svg>,
  home: <svg {...S}><path d="M4 11 12 4l8 7M6 9.5V20h12V9.5" /></svg>,
  place: <svg {...S}><path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.2" /></svg>,
  work: <svg {...S}><rect x="3.5" y="7" width="17" height="12" rx="2" /><path d="M9 7V5h6v2" /></svg>,
};
const DEFAULT_ICON = <svg {...S}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 9.5h16M8.5 3v4M15.5 3v4" /></svg>;

/** 卡上那个大数: 洞察 numbers 里第一个像钱的 (amount / due / spent …) */
function bigNumber(i: Insight): string | null {
  const n = i.numbers ?? {};
  for (const k of ['amount', 'due', 'bill', 'spent', 'monthSpent']) {
    const v = n[k];
    if (typeof v === 'number' && Number.isFinite(v)) return yuan(v);
  }
  return null;
}

interface Props {
  sessionId: string | null;
  onGoChat: () => void;
  onOpenNotes?: () => void;
  /** 房间 (钱 / 身体 / 足迹 / 关系 / 生活) 退到今天页的一排入口 */
  onOpenRoom?: (room: 'money' | 'body' | 'place' | 'people' | 'life') => void;
}

const ROOM_LINKS: Array<{ id: 'money' | 'body' | 'place' | 'people' | 'life'; zh: string; en: string }> = [
  { id: 'money', zh: '钱', en: 'Money' }, { id: 'body', zh: '身体', en: 'Body' }, { id: 'place', zh: '足迹', en: 'Places' },
  { id: 'people', zh: '关系', en: 'People' }, { id: 'life', zh: '生活', en: 'Life' },
];

export const PilotTodayPage: React.FC<Props> = ({ sessionId, onGoChat, onOpenNotes, onOpenRoom }) => {
  const { isZh } = useI18n();
  const { run, done, runtime } = useInsightRunner(sessionId, onGoChat);
  const unreadReports = usePilotReports().filter((r) => !r.readAt && (!sessionId || !r.sessionId || r.sessionId === sessionId)).length;
  const now = new Date();
  const hour = now.getHours();
  const night = hour >= 20 || hour < 5;
  const { data } = usePilotOverview();
  const steps = usePilotMetricToday('health.steps');
  const place = usePlace();
  const { weather } = useWeather(place);
  const { rows } = useAgenda(sessionId, 0);
  const fileRef = useRef<HTMLInputElement>(null);

  const pending = useMemo(() => {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    return rows.filter((r) => (r.scheduledAt ?? 0) >= Date.now() - 60_000 && (r.scheduledAt ?? 0) < end).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const name = data?.rooms.me?.facts.find((f) => f.key === 'me.name' || f.key === 'me.nickname')?.value;
  const greet = hour < 5 ? (isZh ? '夜深了' : 'Late night') : hour < 11 ? (isZh ? '早上好' : 'Good morning') : hour < 13 ? (isZh ? '中午好' : 'Good noon') : hour < 18 ? (isZh ? '下午好' : 'Good afternoon') : (isZh ? '晚上好' : 'Good evening');
  const clock = `${String(hour).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateLine = isZh ? `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK_ZH[now.getDay()]}` : now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
  const weatherLine = weather ? `${weatherWord(weather.code, isZh)} ${Math.round(weather.temp)}°` : '';

  const cards = (data?.insights ?? []).filter((i) => !done[i.id]).slice(0, 3);

  /* 相机: 挑一张图交给它看, 然后去对话页看它怎么说 */
  const onPickImage = async (f: File | undefined) => {
    if (!f || !runtime?.sendPrompt) return;
    const data64 = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] ?? '');
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(f);
    });
    await runtime.sendPrompt(isZh ? '看看这张图' : 'Take a look at this', { images: [{ mediaType: f.type || 'image/png', data: data64, name: f.name }] });
    onGoChat();
  };

  const stats: Array<{ v: string; l: string; onClick?: () => void }> = [
    { v: yuan(data?.rooms.money?.spent7 ?? null), l: isZh ? '本周' : 'This week' },
    { v: steps == null ? '—' : Math.round(steps).toLocaleString('en-US'), l: isZh ? '步数' : 'Steps' },
    { v: String(pending), l: isZh ? '待办' : 'To-do', onClick: onGoChat },
  ];

  return (
    <div className={`pv3-today${night ? ' is-night' : ''}`}>
      <section className="pv3-hero" style={{ backgroundImage: `url(${night ? sceneNight : sceneDay})` }}>
        <div className="pv3-hero__band">
          <div className="pv3-hero__hello">
            {night ? (
              <h1>{greet}{name ? `, ${name}` : ''} · {clock}</h1>
            ) : (
              <>
                <h1>{dateLine}</h1>
                <p>{[greet + (name ? `，${name}` : ''), weatherLine].filter(Boolean).join(' · ')}</p>
              </>
            )}
          </div>
          <div className="pv3-hero__stats">
            {stats.map((s) => (
              s.onClick
                ? <button key={s.l} type="button" className="pv3-stat" onClick={s.onClick}><b>{s.v}</b><span>{s.l}</span></button>
                : <div key={s.l} className="pv3-stat"><b>{s.v}</b><span>{s.l}</span></div>
            ))}
          </div>
        </div>
      </section>

      {/* 简报: 等你点头 / 它办了 / 今天安排 (第 3 步, 今天 = 简报) */}
      <PilotBrief sessionId={sessionId} onGoChat={onGoChat} />

      <div className="pv3-today__titlerow">
        <h2 className="pv3-today__title">{night ? (isZh ? '睡前看一眼' : 'Before bed') : (isZh ? '今天替你盯着' : 'Watching for you today')}</h2>
        {/* 汇报 / 它记得 / 它做的文件 在下一层 (稿 pl10); 有没看的汇报挂一颗蓝点 */}
        {onOpenNotes && (
          <button type="button" className="pv3-today__more" onClick={onOpenNotes}>
            {unreadReports > 0 && <i aria-hidden />}
            {isZh ? '它替你记着的' : 'What it keeps'}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
          </button>
        )}
      </div>
      <div className="pv3-watch">
        {cards.map((i) => (
          <div key={i.id} className={`pv3-watch__card is-${i.tone}`}>
            <div className="pv3-watch__top">
              <span className="pv3-watch__dot" aria-hidden="true" />
              <span className="pv3-watch__t">{i.title}</span>
              <span className="pv3-watch__ic">{DOMAIN_ICON[i.domain] ?? DEFAULT_ICON}</span>
            </div>
            {bigNumber(i) && <div className="pv3-watch__num">{bigNumber(i)}</div>}
            <div className="pv3-watch__foot">
              {i.action
                ? <button type="button" className="pv3-pill" onClick={() => void run(i, i.action!)}>{i.action.label}</button>
                : <span className="pv3-watch__detail">{i.detail}</span>}
            </div>
          </div>
        ))}
        {cards.length === 0 && (
          <div className="pv3-watch__empty">{isZh ? '今天没什么要你操心的' : 'Nothing needs you today'}</div>
        )}
      </div>

      {onOpenRoom && (
        <nav className="pv3-roomlinks" aria-label={isZh ? '你的房间' : 'Rooms'}>
          {ROOM_LINKS.map((r) => (
            <button key={r.id} type="button" onClick={() => onOpenRoom(r.id)}>{isZh ? r.zh : r.en}</button>
          ))}
        </nav>
      )}

      <div className="pv3-talk">
        <button type="button" className="pv3-round" onClick={onGoChat} aria-label={isZh ? '打字' : 'Type'} title={isZh ? '打字' : 'Type'}>
          <svg {...S}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8" /></svg>
        </button>
        <PilotVoiceBar onSent={onGoChat} />
        <button type="button" className="pv3-round" onClick={() => fileRef.current?.click()} aria-label={isZh ? '给它看张图' : 'Show it a picture'} title={isZh ? '给它看张图' : 'Show it a picture'}>
          <svg {...S}><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.5-2h5L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" /><circle cx="12" cy="13" r="3.2" /></svg>
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void onPickImage(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      <div className="pv3-talk__hint">{isZh ? '按住说话 · 或直接打字' : 'Hold to talk · or just type'}</div>
    </div>
  );
};

export default PilotTodayPage;
