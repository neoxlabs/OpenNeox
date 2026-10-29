import React, { useState } from 'react';
import * as S from '../../shell/shellIcons';
import { formatSessionTime } from '../../../app/sessionItemMapping';
import type { PilotReport } from '../usePilotReports';
import { SectionHead } from './boardKit';
import { ART } from './art';

const FOLD = 4;

export const ReportsSection: React.FC<{
  reports: PilotReport[];
  isZh: boolean;
  send: ((text: string) => Promise<unknown> | void) | null;
}> = ({ reports, isZh, send }) => {
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [reply, setReply] = useState('');
  if (reports.length === 0) return null;
  const unread = reports.filter((r) => !r.readAt).length;
  const shown = all ? reports : reports.slice(0, FOLD);

  const say = (text: string) => { if (send && text.trim()) void send(text.trim()); };

  return (
    <section className="pb-sec is-reports">
      <SectionHead art={ART.reports} title={t('汇报', 'Reports')} count={unread} accent />
      {shown.map((r) => {
        const isOpen = open === r.id;
        return (
          <div key={r.id} className={`pb-report is-${r.status}${r.readAt ? '' : ' is-unread'}${isOpen ? ' is-open' : ''}`}>
            <button type="button" className="pb-report__row" onClick={() => { setOpen(isOpen ? null : r.id); setReply(''); }} aria-expanded={isOpen}>
              <span className="pb-report__icon" aria-hidden>
                {r.status === 'failed' ? <S.IconAlert size={14} /> : r.status === 'progress' ? <S.IconRefresh size={14} /> : r.status === 'blocked' ? <S.IconHelp size={14} /> : <S.IconCheck size={14} />}
              </span>
              <span className="pb-report__what">{r.title}</span>
              {(r.repeats ?? 0) > 0 && <span className="pb-report__times">×{(r.repeats ?? 0) + 1}</span>}
              <span className="pb-report__meta">{formatSessionTime(r.lastAt ?? r.at)}</span>
            </button>
            {isOpen && (
              <div className="pb-report__body">
                {r.summary && <p>{r.summary}</p>}
                {r.answer && <p className="pb-report__answer">{t('你的答复：', 'You answered: ')}{r.answer}</p>}
                {send && (
                  <>
                    <div className="pb-form__row pb-form__row--start">
                      <button type="button" className="pb-btn" onClick={() => say(t(`「${r.title}」这件事详细说说`, `Tell me more about "${r.title}"`))}>
                        <S.IconHelp size={13} />{t('问问详情', 'Ask for details')}
                      </button>
                      {r.status === 'failed' && (
                        <button type="button" className="pb-btn" onClick={() => say(t(`「${r.title}」再试一次`, `Try "${r.title}" again`))}>
                          <S.IconRefresh size={13} />{t('再试一次', 'Try again')}
                        </button>
                      )}
                    </div>
                    <input
                      className="pb-input"
                      placeholder={t('回它一句，回车发送', 'Reply, Enter to send')}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing && reply.trim()) {
                          say(t(`关于「${r.title}」：${reply}`, `About "${r.title}": ${reply}`));
                          setReply('');
                          setOpen(null);
                        }
                      }}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      {reports.length > FOLD && (
        <button type="button" className="pb-more" onClick={() => setAll((v) => !v)}>
          {all ? t('收起', 'Show less') : t(`全部 ${reports.length} 条`, `All ${reports.length}`)}
        </button>
      )}
    </section>
  );
};
