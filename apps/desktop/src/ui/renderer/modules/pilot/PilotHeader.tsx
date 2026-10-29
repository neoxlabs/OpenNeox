import React from 'react';
import { useI18n } from '../../hooks/useI18n';
import { pilotApi, setPilotStage, type PilotCall, type PilotProfile } from './pilotStore';

interface Props {
  sessionId: string;
  profile: PilotProfile | undefined;
  fallbackName: string;
  call: PilotCall | null;
  /** 对话区在形象模式 */
  stage: boolean;
  onEdit: () => void;
}

export const PilotHeader: React.FC<Props> = ({ sessionId, profile, fallbackName, call, stage, onEdit }) => {
  const { isZh } = useI18n();
  const inThisCall = call?.sessionId === sessionId && call.phase === 'active';
  const ringing = call?.sessionId === sessionId && call.phase === 'ringing';
  const busyElsewhere = !!call && call.sessionId !== sessionId;
  const name = profile?.name || fallbackName || 'Pilot';

  const startCall = async () => {
    const r = await pilotApi().pilotCallStartOutgoing?.(sessionId).catch(() => null);
    if (r?.ok && r.call) {
      window.dispatchEvent(new CustomEvent('neox:pilot-call-connect', { detail: r.call }));
    }
  };

  return (
    <header className={`pilot-header${inThisCall ? ' is-live' : ''}${stage ? ' is-stage' : ''}`}>
      <div className="pilot-header__who">
        <button type="button" className="pilot-header__name" onClick={onEdit} title={isZh ? '改名字 / 形象 / 分工' : 'Edit name, look and role'}>
          {name}
        </button>
        <div className="pilot-header__role">
          {inThisCall ? (isZh ? '通话中' : 'In call')
            : ringing ? (isZh ? '正在呼叫你…' : 'Calling you…')
            : profile?.persona?.split('\n')[0] || (isZh ? '点名字写上它负责什么' : 'Click the name to give it a role')}
        </div>
      </div>
      {!stage && (
        <button type="button" className="pilot-header__back" onClick={() => setPilotStage(true)}>
          {isZh ? '回到形象' : 'Back to character'}
        </button>
      )}
      {!inThisCall && (
        <button
          type="button"
          className="pilot-header__call"
          disabled={busyElsewhere || ringing}
          onClick={() => void startCall()}
          title={busyElsewhere ? (isZh ? '正在跟别的 Pilot 通话' : 'In another call') : (isZh ? '打给它, 连续聊' : 'Call — hands-free')}
          aria-label={isZh ? '通话' : 'Call'}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
            <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" />
          </svg>
        </button>
      )}
    </header>
  );
};
