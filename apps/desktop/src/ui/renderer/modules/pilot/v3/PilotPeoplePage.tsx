import React, { useMemo, useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { dispatchHint, dispatchOpFailed } from '../../../components/notifyEvents';
import { boardApi } from '../board/boardKit';
import { usePilotOverview, type RoomsSummary } from './pilotData';
import { useInsightRunner } from './useInsightRunner';
import p1 from '../../../media/pilot/person-1.webp';
import p2 from '../../../media/pilot/person-2.webp';
import p3 from '../../../media/pilot/person-3.webp';
import p4 from '../../../media/pilot/person-4.webp';
import p5 from '../../../media/pilot/person-5.webp';
import p6 from '../../../media/pilot/person-6.webp';
import p7 from '../../../media/pilot/person-7.webp';
import p8 from '../../../media/pilot/person-8.webp';

type Person = NonNullable<RoomsSummary['people']>['list'][number];
/* 1 白发奶奶 · 2 短发女 · 3 眼镜男 · 4 马尾女 · 5 帽子男 · 6 长发女 · 7 短发男 · 8 丸子头女 */
const FACES = [p1, p2, p3, p4, p5, p6, p7, p8];

/** 头像: 长辈 / 伴侣按关系挑, 其余按名字哈希 (同一个人每次都是同一张) */
function faceOf(p: Person): string {
  const r = `${p.relation ?? ''}${p.name}`;
  if (/妈|母|奶奶|外婆|姥姥/.test(r)) return p1;
  if (/爸|父|爷爷|外公|姥爷|老公|丈夫|男朋友/.test(r)) return p7;
  if (/老婆|妻|女朋友/.test(r)) return p2;
  let h = 0;
  for (const ch of p.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  /* 称呼里看得出男女就在那一组里挑 (张姐不该是眼镜大叔) */
  if (/姐|妹|姨|姑|婶|嫂|女|闺蜜|太太|小姐/.test(r)) return [p2, p4, p6, p8][h % 4];
  if (/哥|弟|叔|伯|舅|先生|兄/.test(r)) return [p3, p5, p7][h % 3];
  return FACES[1 + (h % 7)];
}

/** '10-14' / '1990-10-14' → 10月14日 */
function birthdayText(b: string, zh: boolean): string {
  const m = /(\d{1,2})-(\d{1,2})$/.exec(b);
  if (!m) return b;
  return zh ? `${Number(m[1])}月${Number(m[2])}日` : `${Number(m[1])}/${Number(m[2])}`;
}
function birthdayIn(days: number, zh: boolean): string {
  if (days === 0) return zh ? '就是今天' : 'today';
  if (days === 1) return zh ? '明天' : 'tomorrow';
  return zh ? `还有 ${days} 天` : `in ${days} days`;
}

const S = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const I = {
  gift: <svg {...S}><rect x="4" y="9" width="16" height="11" rx="1.5" /><path d="M3 9h18v-3H3zM12 6v14M12 6C10 3 7 3.5 7.5 6M12 6c2-3 5-2.5 4.5 0" /></svg>,
  phone: <svg {...S}><rect x="7" y="3" width="10" height="18" rx="2.5" /><path d="M11 17.5h2" /></svg>,
  cal: <svg {...S}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 9.5h16M8.5 3v4M15.5 3v4" /></svg>,
  heart: <svg {...S}><path d="M12 19.5s-7.5-4.3-7.5-10A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7.5 2.5c0 5.7-7.5 10-7.5 10Z" /></svg>,
  call: <svg {...S}><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" /></svg>,
};

function contactText(days: number | null, zh: boolean): string {
  if (days == null) return zh ? '还没记到联系' : 'No contact logged';
  if (days === 0) return zh ? '今天联系过' : 'Talked today';
  if (days < 60) return zh ? `上次联系 ${days} 天前` : `Last contact ${days}d ago`;
  return zh ? `${Math.round(days / 30)} 个月没联系了` : `${Math.round(days / 30)} months ago`;
}

/** 今晚 20:00 (已过就明天) */
function tonight8(): number {
  const d = new Date();
  d.setHours(20, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

interface Props {
  sessionId: string | null;
  onGoChat: () => void;
}

export const PilotPeoplePage: React.FC<Props> = ({ sessionId, onGoChat }) => {
  const { isZh } = useI18n();
  const { data } = usePilotOverview();
  const { run, ask, done } = useInsightRunner(sessionId, onGoChat);
  const list = useMemo(() => [...(data?.rooms.people?.list ?? [])].sort((a, b) =>
    (a.birthdayInDays ?? 999) - (b.birthdayInDays ?? 999) || (a.lastContactDays ?? 999) - (b.lastContactDays ?? 999)), [data]);
  const [picked, setPicked] = useState<string | null>(null);
  const cur = list.find((p) => p.name === picked) ?? list[0];
  /* 人相关的洞察: social 那一类, 加上标题里点了这里某个人名的 (生日那条归在 day 下) */
  const soon = (data?.insights ?? [])
    .filter((i) => i.action && !done[i.id] && (i.domain === 'social' || list.some((p) => i.title.includes(p.name))))
    .slice(0, 2);

  const remindCall = async (p: Person) => {
    try {
      if (!sessionId) throw new Error(isZh ? '先建一个分身' : 'Create a Pilot first');
      const r = await boardApi().pilotAddReminder?.(sessionId, { title: isZh ? `给${p.name}打个电话` : `Call ${p.name}`, at: tonight8(), ring: true });
      if (r && !r.ok) throw new Error(r.error || 'failed');
      dispatchHint(isZh ? '好，晚上 8 点叫你' : "OK, I'll remind you at 8pm", 'success');
    } catch (e) {
      dispatchOpFailed({ op: isZh ? '提醒' : 'Remind', message: (e as Error).message });
    }
  };

  return (
    <div className="pv3-room pv3-people" data-loading={data ? undefined : ''}>
      <div className="pv3-people__main">
        <header className="pv3-people__head">
          <h1 className="pv3-pagehead">{isZh ? '关系' : 'People'}</h1>
          {list.length > 0 && <span className="pv3-pagesub">{isZh ? `它记得 ${list.length} 个人` : `${list.length} people remembered`}</span>}
        </header>

        {soon.length > 0 && (
          <>
            <h2 className="pv3-section">{isZh ? '快到了' : 'Coming up'}</h2>
            <div className="pv3-soon">
              {soon.map((i) => (
                <div key={i.id} className="pv3-box pv3-soon__card">
                  <span className="pv3-soon__ic">{/生日|礼物|birthday/i.test(i.title) ? I.gift : I.phone}</span>
                  <div className="pv3-soon__body">
                    <b>{i.title}</b>
                    <button type="button" className={`pv3-pill${/生日|birthday/i.test(i.title) ? '' : ' pv3-pill--soft'}`} onClick={() => void run(i, i.action!)}>{i.action!.label}</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {list.length === 0 ? (
          <p className="pv3-box pv3-box__empty pv3-people__empty">{isZh ? '跟它聊起谁、或者在手机上导入通讯录，它就会记下来' : 'Mention people in chat or import contacts on your phone'}</p>
        ) : (
          <div className="pv3-people__grid">
            {list.map((p) => (
              <button key={p.name} type="button" className={`pv3-person${cur?.name === p.name ? ' is-on' : ''}`} onClick={() => setPicked(p.name)}>
                <img src={faceOf(p)} alt="" draggable={false} />
                <b>{p.name}</b>
                <span>{p.relation ?? (isZh ? '朋友' : 'Friend')}</span>
                <small>{contactText(p.lastContactDays, isZh)}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {cur && (
        <aside className="pv3-box pv3-profile">
          <img className="pv3-profile__face" src={faceOf(cur)} alt="" draggable={false} />
          <h2>{cur.name}</h2>
          <ul>
            {cur.birthday && (
              <li>
                {I.cal}
                <span><small>{isZh ? '生日' : 'Birthday'}</small>
                  {birthdayText(cur.birthday, isZh)}{cur.birthdayInDays != null ? ` · ${birthdayIn(cur.birthdayInDays, isZh)}` : ''}</span>
              </li>
            )}
            {cur.likes && <li>{I.heart}<span><small>{isZh ? '喜欢' : 'Likes'}</small>{cur.likes}</span></li>}
            <li>
              {I.call}
              <span><small>{isZh ? '上次联系' : 'Last contact'}</small>
                {cur.lastContactDays == null ? (isZh ? '还没记到' : 'Not logged')
                  : cur.lastContactDays === 0 ? (isZh ? '今天' : 'Today')
                  : isZh ? `${cur.lastContactDays} 天前` : `${cur.lastContactDays} days ago`}</span>
            </li>
          </ul>
          <div className="pv3-profile__acts">
            <button
              type="button"
              className="pv3-drawer__save"
              onClick={() => void ask(isZh
                ? `帮我想想送${cur.name}什么好${cur.likes ? `，ta 喜欢${cur.likes}` : ''}${cur.relation ? `（${cur.relation}）` : ''}，给三个具体的，带价钱`
                : `Gift ideas for ${cur.name}${cur.likes ? ` who likes ${cur.likes}` : ''} — three specific ones with prices`)}
            >
              {isZh ? '送点什么' : 'Gift ideas'}
            </button>
            <button type="button" className="pv3-wide" onClick={() => void remindCall(cur)}>{isZh ? '今晚 8 点提醒我打电话' : 'Remind me to call at 8pm'}</button>
          </div>
        </aside>
      )}
    </div>
  );
};

export default PilotPeoplePage;
