import React, { useEffect, useRef, useState } from 'react';
import SpineMascotCanvas from '../mascot/SpineMascotCanvas';
import type { SpineMascotRuntime } from '../mascot/spineMascot';
import { getTtsOutputLevel, isTtsPlaying } from '../../utils/ttsPlayer';
import catStill from '../../assets/mascots/cat-idle.webp';
import corgiStill from '../../assets/mascots/corgi-idle.webp';
import '../mascot/mascot.css';
import type { PilotAvatarKind } from './pilotStore';

interface Props {
  kind: PilotAvatarKind;
  /** 高度 px, 宽按原画比例 */
  size: number;
  /** 这个 Pilot 此刻是不是说话的那一方 (通话中 / 正在朗读它的回复) */
  speaking?: boolean;
  /** think / type / idle … 跟着它在干嘛 */
  pose?: 'idle' | 'think' | 'type' | 'watch' | 'alert';
}

export const PilotAvatar: React.FC<Props> = ({ kind, size, speaking = false, pose = 'idle' }) => {
  const runtimeRef = useRef<SpineMascotRuntime | null>(null);
  const [spine, setSpine] = useState(false);
  const speakingRef = useRef(speaking);
  speakingRef.current = speaking;

  useEffect(() => {
    runtimeRef.current?.play(pose);
  }, [pose, spine]);

  /* 嘴: rAF 读播放电平, 快开慢合 (张嘴要跟上重音, 合嘴拖一点才不像在咬) */
  useEffect(() => {
    if (!spine) return undefined;
    let raf = 0;
    let smooth = 0;
    let driving = false;
    const loop = () => {
      const rt = runtimeRef.current;
      const live = speakingRef.current && isTtsPlaying();
      if (rt) {
        if (live) {
          const lv = getTtsOutputLevel();
          smooth += (lv - smooth) * (lv > smooth ? 0.55 : 0.18);
          rt.setMouthLevel(smooth);
          driving = true;
        } else if (driving) {
          smooth = 0;
          rt.setMouthLevel(null);
          driving = false;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      runtimeRef.current?.setMouthLevel(null);
    };
  }, [spine]);

  return (
    <div
      className="neox-mascot pilot-avatar"
      data-motion="on"
      style={{ ['--neox-mascot-h' as string]: `${size}px` }}
      aria-hidden
    >
      <div className="neox-mascot__art" data-renderer={spine ? 'spine' : 'static'}>
        <img className="neox-mascot__fallback" src={kind === 'corgi' ? corgiStill : catStill} alt="" draggable={false} />
        <SpineMascotCanvas
          species={kind}
          onReady={(rt) => { runtimeRef.current = rt; setSpine(true); }}
          onUnavailable={() => setSpine(false)}
        />
      </div>
    </div>
  );
};

/** 列表 / 看板里的小头像: 静态图, 不起 WebGL */
export const PilotFace: React.FC<{ kind: PilotAvatarKind; size?: number; ring?: 'live' | 'ringing' | null }> = ({ kind, size = 36, ring = null }) => (
  <span className={`pilot-face${ring ? ` pilot-face--${ring}` : ''}`} style={{ width: size, height: size }}>
    <img src={kind === 'corgi' ? corgiStill : catStill} alt="" draggable={false} />
  </span>
);
