
import catAvatar from './assets/mascots/cat-idle.webp';
import corgiAvatar from './assets/mascots/corgi-idle.webp';

interface PilotCall {
  id: string;
  pilotName: string;
  avatar: 'cat' | 'corgi';
  reason: string;
  direction: 'incoming' | 'outgoing';
  phase: 'ringing' | 'active' | 'ended';
  ringingAt: number;
  answeredAt?: number;
  ringSeconds: number;
  muted: boolean;
  lang?: 'zh' | 'en';
}

interface LiveReport {
  callId: string;
  voice: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'paused' | 'error';
  caption?: string;
  level?: number;
}

interface CallBridge {
  onState(cb: (s: PilotCall | null) => void): () => void;
  onLive(cb: (r: LiveReport) => void): () => void;
  hello(): void;
  action(name: 'accept' | 'decline' | 'snooze' | 'hangup' | 'mute' | 'unmute'): void;
}

const bridge = (window as unknown as { callBridge?: CallBridge }).callBridge;
/* 跟 Neox 的界面语言走 (主进程随通话快照带过来), 不看系统语言 —— 英文系统上的中文用户一样要中文 */
const t = (a: string, b: string) => (call?.lang === 'en' ? b : a);

const ICON = {
  phone: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  hang: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.47a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15.1 15.1 0 0 0 12 9z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.6 5.3M19 11c0 .7-.1 1.4-.3 2M12 18v3M3 3l18 18"/></svg>',
  later: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

const style = document.createElement('style');
style.textContent = `
  :root { color-scheme: dark; }
  /* 四周留出阴影的位置 (跟 pilotCallWindow.ts 的 CALL_CARD_PAD 一致)。原来只留 6px,
   * 30px 模糊 + 10px 下偏移的阴影被窗口边界切掉, 看上去是卡片外一圈方角灰边、底部最重。 */
  .card {
    position: absolute; inset: 14px 26px 36px;
    border-radius: 22px;
    background: rgba(38, 38, 42, 0.94);
    backdrop-filter: blur(24px) saturate(1.4);
    box-shadow: 0 10px 24px rgba(0,0,0,.34), 0 1px 4px rgba(0,0,0,.2), inset 0 0 0 1px rgba(255,255,255,.07);
    color: #f5f5f7;
    -webkit-app-region: drag;
    overflow: hidden;
    animation: enter .32s cubic-bezier(.2,.9,.3,1.2);
  }
  @keyframes enter { from { transform: translateY(-14px) scale(.96); opacity: 0; } }
  button { -webkit-app-region: no-drag; font: inherit; border: 0; cursor: pointer; color: inherit; }

  /* ── 响铃 ── */
  /* 卡片的高由 .card 的 inset 决定 —— 这里不能再写 height:100%, 否则撑满整个窗口,
   * 底下留给阴影的那 36px 被卡片自己盖掉, 看上去底边被窗口吃了一截 (用户实拍) */
  .ring { display: grid; grid-template-rows: auto 1fr; padding: 14px 14px 12px; box-sizing: border-box; gap: 10px; }
  .who { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .avatar { position: relative; width: 48px; height: 48px; flex: none; }
  .avatar img { width: 100%; height: 100%; object-fit: contain; position: relative; z-index: 1; }
  .avatar::before {
    content: ''; position: absolute; inset: -4px; border-radius: 50%;
    background: radial-gradient(circle, rgba(94,234,160,.35), rgba(94,234,160,0) 70%);
    animation: halo 1.6s ease-in-out infinite;
  }
  @keyframes halo { 0%,100% { transform: scale(.85); opacity: .5; } 50% { transform: scale(1.15); opacity: 1; } }
  .names { min-width: 0; }
  .name { font-size: 17px; font-weight: 600; letter-spacing: .2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .reason { font-size: 13px; color: rgba(245,245,247,.62); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: grid; grid-template-columns: 44px 1fr 1fr; gap: 8px; align-items: center; }
  .pill { height: 44px; border-radius: 22px; display: flex; align-items: center; justify-content: center; transition: filter .15s, transform .1s; }
  .pill:hover { filter: brightness(1.12); }
  .pill:active { transform: scale(.97); }
  .later { background: rgba(255,255,255,.08); color: rgba(245,245,247,.8); }
  .decline { background: #d8433a; }
  .accept { background: #34c759; }
  .accept svg { animation: wiggle 1.2s ease-in-out infinite; }
  @keyframes wiggle { 0%,60%,100% { transform: rotate(0); } 10%,30%,50% { transform: rotate(-14deg); } 20%,40% { transform: rotate(14deg); } }

  /* ── 通话 ── */
  .live { display: grid; grid-template-columns: 40px 1fr auto; grid-template-rows: auto auto; column-gap: 10px; row-gap: 4px;
    align-content: center; align-items: center; padding: 10px 12px; box-sizing: border-box; }
  .live .avatar { width: 40px; height: 40px; grid-row: 1 / span 2; }
  .live .avatar::before { animation: none; transform: scale(var(--lv, .85)); opacity: var(--lo, .35); transition: transform .08s linear, opacity .08s linear; }
  .line1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .line1 .name { font-size: 14px; }
  .timer { font-size: 12px; color: rgba(245,245,247,.55); font-variant-numeric: tabular-nums; }
  .status { font-size: 12px; color: rgba(245,245,247,.55); }
  .caption { grid-column: 2 / span 2; font-size: 12.5px; line-height: 1.35; color: rgba(245,245,247,.85);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 17px; }
  .btns { display: flex; gap: 8px; grid-row: 1; grid-column: 3; }
  .round { width: 34px; height: 34px; border-radius: 17px; display: flex; align-items: center; justify-content: center; }
  .round.mute { background: rgba(255,255,255,.1); }
  .round.mute.on { background: #f5f5f7; color: #1c1c1e; }
  .round.hang { background: #d8433a; }
  .round.hang svg { width: 20px; height: 20px; }
`;
document.head.appendChild(style);

const root = document.getElementById('call-root')!;
let call: PilotCall | null = null;
let live: LiveReport | null = null;
let timerHandle: number | null = null;

// ───────────── 铃声: 两个柔和的拨弦音, 每 2 秒一组, 不用音频文件 ─────────────
let audio: AudioContext | null = null;
let ringHandle: number | null = null;
function pluck(ctx: AudioContext, freq: number, at: number): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.22, at + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + 0.55);
}
function startRingtone(): void {
  if (ringHandle !== null) return;
  try {
    audio = audio ?? new AudioContext();
    const play = () => {
      if (!audio) return;
      const now = audio.currentTime + 0.02;
      pluck(audio, 659.25, now);        // E5
      pluck(audio, 783.99, now + 0.18); // G5
      pluck(audio, 987.77, now + 0.36); // B5
    };
    play();
    ringHandle = window.setInterval(play, 2000);
  } catch { /* 没声卡也要能接 */ }
}
function stopRingtone(): void {
  if (ringHandle !== null) { window.clearInterval(ringHandle); ringHandle = null; }
}

// ───────────── 渲染 ─────────────
const avatarSrc = (c: PilotCall) => (c.avatar === 'corgi' ? corgiAvatar : catAvatar);
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function voiceLabel(v: LiveReport['voice'] | undefined): string {
  switch (v) {
    case 'listening': return t('在听', 'Listening');
    case 'thinking': return t('在想', 'Thinking');
    case 'speaking': return t('在说', 'Speaking');
    case 'paused': return t('已暂停', 'Paused');
    case 'error': return t('出错了', 'Error');
    default: return t('接通中', 'Connecting');
  }
}

function renderRinging(c: PilotCall): void {
  root.innerHTML = `
    <div class="card ring" role="dialog" aria-label="${esc(t('来电', 'Incoming call'))}">
      <div class="who">
        <div class="avatar"><img src="${avatarSrc(c)}" alt=""></div>
        <div class="names">
          <div class="name">${esc(c.pilotName)}</div>
          <div class="reason">${esc(c.reason || t('来电…', 'Calling…'))}</div>
        </div>
      </div>
      <div class="actions">
        <button class="pill later" data-a="snooze" title="${esc(t('10 分钟后再打', 'Call back in 10 min'))}">${ICON.later}</button>
        <button class="pill decline" data-a="decline" title="${esc(t('挂断', 'Decline'))}">${ICON.hang}</button>
        <button class="pill accept" data-a="accept" title="${esc(t('接听', 'Answer'))}">${ICON.phone}</button>
      </div>
    </div>`;
  startRingtone();
}

function renderActive(c: PilotCall): void {
  stopRingtone();
  root.innerHTML = `
    <div class="card live">
      <div class="avatar"><img src="${avatarSrc(c)}" alt=""></div>
      <div class="line1">
        <span class="name">${esc(c.pilotName)}</span>
        <span class="timer" data-timer>0:00</span>
        <span class="status" data-status>${esc(voiceLabel(live?.voice))}</span>
      </div>
      <div class="btns">
        <button class="round mute${c.muted ? ' on' : ''}" data-a="${c.muted ? 'unmute' : 'mute'}" title="${esc(c.muted ? t('取消静音', 'Unmute') : t('静音', 'Mute'))}">${c.muted ? ICON.micOff : ICON.mic}</button>
        <button class="round hang" data-a="hangup" title="${esc(t('挂断', 'Hang up'))}">${ICON.hang}</button>
      </div>
      <div class="caption" data-caption>${esc(live?.caption ?? '')}</div>
    </div>`;
  tickTimer();
}

function tickTimer(): void {
  if (timerHandle !== null) window.clearInterval(timerHandle);
  const update = () => {
    const el = root.querySelector<HTMLElement>('[data-timer]');
    if (el && call?.answeredAt) el.textContent = fmtDuration(Date.now() - call.answeredAt);
  };
  update();
  timerHandle = window.setInterval(update, 500);
}

function render(): void {
  if (!call || call.phase === 'ended') {
    stopRingtone();
    root.innerHTML = '';
    return;
  }
  if (call.phase === 'ringing') renderRinging(call);
  else renderActive(call);
}

root.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-a]');
  if (!btn) return;
  const a = btn.dataset.a as Parameters<CallBridge['action']>[0];
  if (a === 'accept' || a === 'decline' || a === 'snooze') stopRingtone();
  bridge?.action(a);
});

bridge?.onState((s) => {
  const phaseChanged = s?.phase !== call?.phase || s?.id !== call?.id || s?.muted !== call?.muted;
  call = s;
  if (!s) live = null;
  if (phaseChanged) render();
});

bridge?.onLive((r) => {
  if (!call || r.callId !== call.id) return;
  live = r;
  const status = root.querySelector<HTMLElement>('[data-status]');
  if (status) status.textContent = voiceLabel(r.voice);
  const cap = root.querySelector<HTMLElement>('[data-caption]');
  if (cap && r.caption !== undefined) cap.textContent = r.caption;
  const av = root.querySelector<HTMLElement>('.live .avatar');
  if (av) {
    const lv = Math.max(0, Math.min(1, r.level ?? 0));
    av.style.setProperty('--lv', String(0.85 + lv * 0.5));
    av.style.setProperty('--lo', String(0.3 + lv * 0.7));
  }
});

bridge?.hello();
