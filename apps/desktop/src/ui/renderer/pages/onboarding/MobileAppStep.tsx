import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import illusSyncDevices from '../../media/illus/sync-devices.webp';

export const ANDROID_APK_URL = 'https://dl.neox-dev.com/mobile/neox.apk';

/* 插画 880×680; 屏幕四角 (量图): 手机 TL(44,210) TR(180,142) BL(44,536) · Mac TL(488,42) TR(828,228) BL(488,302) */
const PHONE_SCREEN = 'matrix(1.36 -0.68 0 1.4818 44 210)'; /* 局部 100×220 */
const MAC_SCREEN = 'matrix(2.125 1.1625 0 2.6 488 42)'; /* 局部 160×100 */
/* 手机上那条消息的中心 → Mac 上那条消息的中心 (都换算到插画坐标) */
const SYNC_PATH = 'M138 350 Q430 90 760 253';

/* [毫秒, phase]: 1 点发送 · 2 手机出消息 · 3 飞过去 · 4 Mac 出消息 · 5–8 回复逐行打出, 两边同步 */
const TIMELINE: Array<[number, number]> = [
  [500, 1], [850, 2], [1350, 3], [2300, 4], [2750, 5], [3100, 6], [3450, 7], [3800, 8], [6600, 0],
];
const LOOP_MS = 7000;
const FINAL_PHASE = 8;

function useSyncPhase(): number {
  const reduce = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [phase, setPhase] = useState(reduce ? FINAL_PHASE : 0);
  useEffect(() => {
    if (reduce) return;
    let timers: number[] = [];
    const run = () => {
      timers = TIMELINE.map(([ms, p]) => window.setTimeout(() => setPhase(p), ms));
      timers.push(window.setTimeout(run, LOOP_MS));
    };
    run();
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [reduce]);
  return phase;
}

const on = (phase: number, from: number) => `mob-el${phase >= from ? ' is-on' : ''}`;

const SyncIllustration: React.FC = () => {
  const phase = useSyncPhase();
  const motionRef = useRef<SVGAnimateMotionElement | null>(null);
  useEffect(() => {
    if (phase === 3) motionRef.current?.beginElement?.();
  }, [phase]);

  return (
    <div className="mob-sync" aria-hidden="true">
      <img className="mob-sync__art" src={illusSyncDevices} alt="" draggable={false} />
      <svg className="mob-sync__ui" viewBox="0 0 880 680">
        {/* 手机屏幕 */}
        <g transform={PHONE_SCREEN}>
          <rect x="10" y="14" width="26" height="4" rx="2" className="mob-ui-muted" />
          <rect className={on(phase, 2)} x="44" y="116" width="48" height="12" rx="6" fill="#41A0FF" />
          <rect className={`${on(phase, 6)} mob-line`} x="8" y="136" width="70" height="5" rx="2.5" />
          <rect className={`${on(phase, 7)} mob-line`} x="8" y="146" width="56" height="5" rx="2.5" />
          <rect className={`${on(phase, 8)} mob-line`} x="8" y="156" width="62" height="5" rx="2.5" />
          <rect x="8" y="190" width="84" height="14" rx="7" className="mob-ui-input" />
          <circle cx="85" cy="197" r="4.2" fill="#41A0FF" />
          <circle className={`mob-ripple${phase === 1 ? ' is-on' : ''}`} cx="85" cy="197" r="4.2" />
        </g>
        {/* Mac 屏幕 */}
        <g transform={MAC_SCREEN}>
          <rect x="0" y="0" width="30" height="100" className="mob-ui-side" />
          <rect x="5" y="10" width="18" height="3" rx="1.5" className="mob-ui-muted" />
          <rect x="5" y="18" width="14" height="3" rx="1.5" className="mob-ui-muted" />
          <rect x="5" y="26" width="16" height="3" rx="1.5" className="mob-ui-muted" />
          <rect className={on(phase, 4)} x="106" y="18" width="44" height="9" rx="4.5" fill="#41A0FF" />
          <rect className={`${on(phase, 5)} mob-line`} x="40" y="36" width="92" height="4" rx="2" />
          <rect className={`${on(phase, 6)} mob-line`} x="40" y="44" width="78" height="4" rx="2" />
          <rect className={`${on(phase, 7)} mob-line`} x="40" y="52" width="86" height="4" rx="2" />
          <rect className={`${on(phase, 8)} mob-line`} x="40" y="60" width="52" height="4" rx="2" />
          <rect x="40" y="86" width="110" height="8" rx="4" className="mob-ui-input" />
        </g>
        {/* 同步: 一道虚线 + 一颗沿线飞过去的点 */}
        <path className={`mob-trail${phase >= 3 && phase < 5 ? ' is-on' : ''}`} d={SYNC_PATH} />
        <circle className={`mob-packet${phase === 3 ? ' is-on' : ''}`} r="7" fill="#41A0FF">
          <animateMotion ref={motionRef} path={SYNC_PATH} dur="0.9s" begin="indefinite" fill="freeze" calcMode="spline" keySplines="0.4 0 0.2 1" keyTimes="0;1" />
        </circle>
      </svg>
    </div>
  );
};

const AndroidQr: React.FC = () => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    /* 深色主题下也是白底黑码 —— 扫码器认的是明暗对比, 反色码有的手机扫不出来 */
    void QRCode.toCanvas(ref.current, ANDROID_APK_URL, {
      width: 132, margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#1d1d1f', light: '#ffffff' },
    }).catch(() => { /* 画不出来就空着, 下面还有文字 */ });
  }, []);
  return <canvas ref={ref} className="mob-qr__code" width={132} height={132} />;
};

export const MobileAppStep: React.FC<{
  zh: boolean;
  title: React.ReactNode;
  onContinue: () => void;
  /** 引导的最后一步: 主按钮写「开始使用」 */
  isLast?: boolean;
}> = ({ zh, title, onContinue, isLast }) => (
  <div className="onboarding-step mobile-step">
    <div className="step-header step-header--branded">{title}</div>
    <p className="mobile-step__lead">
      {zh ? '手机上发任务，电脑上同步执行，两边随时接着聊。' : 'Send a task from your phone, it runs on your Mac. Pick up on either side.'}
    </p>
    <div className="mobile-step__body">
      <SyncIllustration />
      <div className="mob-qr">
        <AndroidQr />
        <div className="mob-qr__label">{zh ? '扫码下载 Android 版' : 'Scan to get the Android app'}</div>
        <div className="mob-qr__ios">{zh ? 'iPhone 版 · 敬请期待' : 'iPhone · coming soon'}</div>
      </div>
    </div>
    <div className="step-actions mobile-actions">
      <button className="continue-btn" onClick={onContinue}>
        <span>{isLast ? (zh ? '开始使用' : 'Get started') : (zh ? '继续' : 'Continue')}</span>
      </button>
    </div>
  </div>
);
