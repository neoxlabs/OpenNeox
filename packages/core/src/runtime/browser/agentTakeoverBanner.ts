/**
 * Takeover look and control dock for the agent's Chrome. Injection alone never claims the
 * page: BrowserSession grants a short, renewable lease while a tool is running.
 * While the agent acts: blue vignette + edge particles, input blocked with a pointer hint.
 * The frosted pill carries the controls (take over / hand back, virtual cursor, collapse).
 */
export const AGENT_TAKEOVER_BANNER_SCRIPT = String.raw`
(function () {
  var isTop = window === window.top;
  if (window.__neoxAgentBannerInstalled) {
    window.__neoxAgentBanner && window.__neoxAgentBanner.__remount();
    return;
  }
  window.__neoxAgentBannerInstalled = true;
  var host, shadow, expiryTimer, hintTimer;
  var pauseUntil = 0, leaseUntil = 0, lastRevision = -1;
  var collapsed = false, cursorEnabled = true, cursorSeen = false, pending = false;
  var cursorX = 0, cursorY = 0, GLIDE_MS = 280, lastKnown = null;
  var state = { active: false, owner: 'agent', busy: false, detail: '', label: '' };
  var icons = {
    pause: '<rect x="5.5" y="4.5" width="3" height="11" rx="1.2"/><rect x="11.5" y="4.5" width="3" height="11" rx="1.2"/>',
    play: '<path d="M7 4.8l8 5.2-8 5.2z"/>',
    down: '<path d="M6 8l4 4 4-4"/>',
    up: '<path d="M6 12l4-4 4 4"/>',
    cursor: '<path d="M5 3l10 7.5-4.8.9-2.6 4.8z"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  }
  /* The takeover look from v2 (2026-09-02, user-approved): a blue vignette that fades out
   * towards the centre, drifting particles in the edge band, a borderless frosted pill with a
   * spinning blue-violet ring, and a hint that follows the pointer. The controls ride inside
   * the same pill instead of a separate panel. */
  var RING = '<svg class="ring" viewBox="0 0 14 14" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#4f8bff"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>' +
    '<circle cx="7" cy="7" r="5.2" fill="none" stroke="url(#g)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="24 9"/></svg>';
  function markup() {
    return '<style>' +
      ':host{color-scheme:light dark}' +
      '*{box-sizing:border-box} [hidden]{display:none!important}' +
      '.wrap,.tip,.cursor{font:500 12px/1.4 -apple-system,"SF Pro Text","PingFang SC","Microsoft YaHei",system-ui,sans-serif;letter-spacing:0}' +
      '.veil{position:fixed;inset:0;pointer-events:none;opacity:0;transition:opacity .35s ease;background:' +
        'radial-gradient(ellipse 68% 68% at 50% 50%,rgba(0,0,0,0) 52%,rgba(64,128,255,.10) 72%,rgba(88,110,255,.24) 88%,rgba(112,92,255,.42) 100%),' +
        'linear-gradient(180deg,rgba(80,120,255,.14),rgba(0,0,0,0) 14%),linear-gradient(0deg,rgba(112,92,255,.16),rgba(0,0,0,0) 14%)}' +
      '.veil.on{opacity:1;animation:neox-veil 3.4s ease-in-out infinite alternate}' +
      '@keyframes neox-veil{from{opacity:.8}to{opacity:1}}' +
      '.pt{position:fixed;width:5px;height:5px;border-radius:50%;pointer-events:none;' +
        'background:radial-gradient(circle,rgba(150,180,255,.95) 0%,rgba(120,140,255,.35) 55%,rgba(0,0,0,0) 72%);box-shadow:0 0 8px 2px rgba(110,140,255,.45);' +
        'animation:neox-float var(--d,7s) ease-in-out var(--dl,0s) infinite alternate,neox-twinkle calc(var(--d,7s)*.61) ease-in-out var(--dl,0s) infinite alternate}' +
      '@keyframes neox-float{from{transform:translate(0,0) scale(1)}to{transform:translate(var(--dx,8px),var(--dy,-26px)) scale(var(--s,1.25))}}' +
      '@keyframes neox-twinkle{from{opacity:.25}to{opacity:.95}}' +
      '.wrap{position:fixed;left:12px;right:12px;bottom:max(14px,env(safe-area-inset-bottom));display:flex;justify-content:center;pointer-events:none}' +
      '.dock{display:inline-flex;align-items:center;gap:10px;max-width:min(680px,100%);padding:5px 5px 5px 14px;border-radius:999px;' +
        'background:rgba(252,252,254,.8);color:rgba(20,20,24,.9);-webkit-backdrop-filter:blur(20px) saturate(170%);backdrop-filter:blur(20px) saturate(170%);' +
        'box-shadow:0 6px 24px rgba(30,50,140,.18);pointer-events:auto;user-select:none;-webkit-user-select:none;animation:neox-in .28s ease both}' +
      '@keyframes neox-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
      '.ring{width:14px;height:14px;flex:none}.busy .ring{animation:neox-spin 2.8s linear infinite}' +
      '@keyframes neox-spin{to{transform:rotate(360deg)}}' +
      '.brand{display:grid;place-items:center;flex:none;color:#5b6cff}.brand svg:not(.ring){width:15px;height:15px;fill:currentColor;stroke:none}' +
      '.copy{display:flex;align-items:center;min-width:0;gap:9px}' +
      '.label{white-space:nowrap}' +
      '.detail{min-width:0;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.62;font-weight:400;padding-left:9px;border-left:1px solid rgba(127,127,127,.35)}' +
      '.detail:empty{display:none}' +
      '.actions{display:flex;gap:2px;align-items:center;flex:none}' +
      'button{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;background:transparent;color:inherit;' +
        'min-width:28px;height:28px;padding:0 6px;border-radius:999px;font:inherit;cursor:pointer;white-space:nowrap;opacity:.72;transition:background .15s ease,opacity .15s ease}' +
      'button:hover{opacity:1;background:rgba(80,100,200,.10)}button:focus-visible{outline:2px solid #6d7bff;outline-offset:1px}button:disabled{opacity:.4;cursor:wait}' +
      'button svg{width:16px;height:16px}' +
      '.switch{opacity:1;padding:0 12px 0 9px;color:#fff;background:linear-gradient(135deg,#4f8bff,#8b5cf6);box-shadow:0 2px 8px rgba(88,92,255,.28)}' +
      '.switch:hover{background:linear-gradient(135deg,#5d95ff,#9768f8)}.switch svg{width:13px;height:13px;fill:currentColor;stroke:none}' +
      '.compact .copy,.compact .cursor-toggle{display:none}.compact{gap:6px;padding-left:10px}' +
      '.cursor-toggle[aria-pressed="false"]{opacity:.38}' +
      '.cursor{position:fixed;left:0;top:0;pointer-events:none;filter:drop-shadow(0 2px 4px rgba(30,40,120,.35));transition:transform 280ms cubic-bezier(.3,.7,.2,1);will-change:transform}' +
      '.cursor svg{width:24px;height:26px;fill:#5b6cff;stroke:#fff;stroke-width:1.4}' +
      '.cursor-label{position:absolute;left:20px;top:21px;padding:2px 8px;border-radius:999px;background:linear-gradient(135deg,#4f8bff,#8b5cf6);color:#fff;font-size:10px;white-space:nowrap}' +
      '.cursor.pressed svg{fill:#8b5cf6;transform:scale(.88);transform-origin:0 0}' +
      '.tip{position:fixed;left:0;top:0;transform:translate(14px,18px);padding:5px 11px;border-radius:8px;background:rgba(26,27,34,.92);color:rgba(240,240,245,.95);' +
        'white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .18s ease;box-shadow:0 4px 16px rgba(0,0,20,.35);will-change:left,top}' +
      '.tip.show{opacity:1}.tip.deny{animation:neox-deny .32s ease}' +
      '@keyframes neox-deny{0%{transform:translate(14px,18px) scale(1)}35%{transform:translate(14px,18px) scale(1.14);background:rgba(64,70,160,.96)}100%{transform:translate(14px,18px) scale(1)}}' +
      '@media(prefers-color-scheme:dark){.dock{background:rgba(26,27,34,.8);color:rgba(240,240,245,.92);box-shadow:0 6px 24px rgba(0,0,20,.45)}' +
        '.brand{color:#9aa6ff}button:hover{background:rgba(160,170,255,.14)}}' +
      '@media(max-width:480px){.detail,.cursor-toggle{display:none}.dock{gap:6px}}' +
      '@media(prefers-reduced-motion:reduce){.cursor{transition:none}.veil.on,.pt,.busy .ring{animation:none}}' +
      '</style>' +
      '<div class="veil" id="veil"></div><div id="pts"></div>' +
      '<div class="wrap" id="wrap" hidden><div class="dock" id="dock" role="toolbar" aria-label="Neox 浏览器控制">' +
      '<span class="brand" id="brand">' + RING + '</span>' +
      '<div class="copy"><span class="label" id="label" role="status" aria-live="polite"></span><span class="detail" id="detail"></span></div>' +
      '<div class="actions"><button class="switch" id="switch" type="button"></button>' +
      '<button class="cursor-toggle" id="cursor-toggle" type="button" title="隐藏虚拟鼠标" aria-label="隐藏虚拟鼠标" aria-pressed="true">' + icon('cursor') + '</button>' +
      '<button id="collapse" type="button" title="收起工具栏" aria-label="收起工具栏" aria-expanded="true">' + icon('down') + '</button></div></div></div>' +
      '<div class="cursor" id="cursor" hidden>' + icon('cursor') + '<span class="cursor-label">Neox</span></div>' +
      '<div class="tip" id="tip" role="status"></div>';
  }
  /* Particles only in the edge band (about 14% on each side); the content in the middle stays clean. */
  function spawnParticles() {
    var box = shadow && shadow.getElementById('pts');
    if (!box || box.childElementCount) return;
    for (var i = 0; i < 18; i++) {
      var p = document.createElement('div');
      p.className = 'pt';
      var edge = i % 4, along = 4 + Math.random() * 92, depth = 1 + Math.random() * 13;
      var pos = edge === 0 ? 'left:' + along + 'vw;top:' + depth + 'vh;'
              : edge === 1 ? 'left:' + along + 'vw;bottom:' + depth + 'vh;'
              : edge === 2 ? 'left:' + depth + 'vw;top:' + along + 'vh;'
              : 'right:' + depth + 'vw;top:' + along + 'vh;';
      p.setAttribute('style', pos + '--d:' + (5 + Math.random() * 6).toFixed(1) + 's;--dl:' + (-Math.random() * 8).toFixed(1) + 's;' +
        '--dx:' + ((Math.random() - .5) * 30).toFixed(0) + 'px;--dy:' + (-(10 + Math.random() * 34)).toFixed(0) + 'px;--s:' + (0.8 + Math.random() * 0.9).toFixed(2) + ';');
      box.appendChild(p);
    }
  }
  function live() { return state.active && Date.now() < leaseUntil; }
  /* The agent holds the page for the whole turn, not only while a tool executes: actions take
   * half a second and the model thinks for many, so a busy-only lock (and vignette) flashed
   * for an instant and was gone. "我来操作" hands it over at any time; while it is yours the
   * page is only locked for the tail of an action already in flight. */
  function locked() { return live() && (state.owner === 'agent' || state.busy); }
  /* The arrow's tip sits at (5,3) in its box; offset so the tip is on the target. */
  function tipX(x) { return Math.max(0, Math.min(x - 5, innerWidth - 28)); }
  function tipY(y) { return Math.max(0, Math.min(y - 3, innerHeight - 30)); }
  /* The cursor is on screen whenever the agent holds the page, like a person's hand resting on
   * the mouse: where the agent last acted (carried across pages by sync), or beside the dock
   * before its first action. Placed without the glide; only real moves glide. */
  function parkCursor() {
    if (!shadow) return;
    var cursor = shadow.getElementById('cursor');
    var x = lastKnown ? tipX(lastKnown.x) : Math.round(innerWidth / 2 + 150);
    var y = lastKnown ? tipY(lastKnown.y) : innerHeight - 70;
    cursor.style.transition = 'none';
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    cursorX = x; cursorY = y;
    void cursor.offsetWidth;
    cursor.style.transition = '';
    cursorSeen = true;
  }
  function hideCursor() {
    cursorSeen = false;
    if (shadow) shadow.getElementById('cursor').hidden = true;
  }
  function release() {
    state.active = false;
    state.busy = false;
    pauseUntil = 0;
    leaseUntil = 0;
    pending = false;
    hideCursor();
    clearTimeout(expiryTimer);
    clearTimeout(hintTimer);
    render();
  }
  var lastBrand = '';
  function render() {
    if (!shadow) return;
    var visible = live(), human = state.owner === 'user';
    shadow.getElementById('wrap').hidden = !visible;
    /* The vignette means "the agent has this page": on while it acts, off once you take over. */
    var agentLocked = locked() && !human;
    shadow.getElementById('veil').className = 'veil' + (agentLocked ? ' on' : '');
    shadow.getElementById('pts').hidden = !agentLocked;
    if (agentLocked) spawnParticles();
    shadow.getElementById('dock').className = 'dock' + (state.busy ? ' busy' : '') + (collapsed ? ' compact' : '');
    shadow.getElementById('label').textContent = human ? (state.busy ? '正在交还控制权' : '你正在操作') : (state.label || 'Neox Agent 接管中');
    var detail = shadow.getElementById('detail');
    detail.textContent = human ? (state.busy ? '等当前动作做完' : 'Agent 已暂停') : (state.busy ? (state.detail || '网页暂不可点击') : '思考下一步');
    detail.title = detail.textContent;
    var button = shadow.getElementById('switch');
    /* Rebuilt only when it changes: the heartbeat syncs every 2s and a fresh innerHTML
     * each time made the button blink. */
    if (button.dataset.owner !== state.owner) {
      button.innerHTML = icon(human ? 'play' : 'pause') + '<span>' + (human ? '交还 Agent' : '我来操作') + '</span>';
      button.dataset.owner = state.owner;
    }
    button.disabled = pending || (human && state.busy);
    button.title = human ? '恢复 Agent 的浏览器操作' : '暂停后续动作并接管浏览器';
    button.setAttribute('aria-label', button.title);
    var brand = human ? 'cursor' : 'ring';
    if (brand !== lastBrand) {
      shadow.getElementById('brand').innerHTML = human ? icon('cursor') : RING;
      lastBrand = brand;
    }
    /* Same rule as the vignette: the cursor rests where the agent last acted for the whole
     * turn. Tied to busy it showed for the half second of a click and vanished. */
    if (agentLocked && cursorEnabled && !cursorSeen) parkCursor();
    shadow.getElementById('cursor').hidden = !visible || human || !cursorEnabled || !cursorSeen;
    if (!locked()) tipEl().classList.remove('show');
  }
  function tipEl() { return shadow.getElementById('tip'); }
  function tipText() { return state.owner === 'user' ? '当前动作完成后即可操作' : 'Agent 掌控中 · 点「我来操作」接管'; }
  /* The hint follows the pointer while the page is locked and fades 1.8s after it stops;
   * a blocked click pulses it once. */
  function moveTip(x, y) {
    if (!shadow) return;
    var tip = tipEl();
    if (!locked() || Date.now() < pauseUntil) { tip.classList.remove('show'); return; }
    tip.textContent = tipText();
    tip.style.left = Math.min(x, innerWidth - 230) + 'px';
    tip.style.top = Math.min(Math.max(4, y), innerHeight - 46) + 'px';
    tip.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { tip.classList.remove('show'); }, 1800);
  }
  function denyPulse() {
    var tip = tipEl();
    tip.classList.remove('deny');
    void tip.offsetWidth;
    tip.classList.add('deny');
  }
  function mount() {
    if (!isTop) return;
    if (!document.documentElement) return;
    if (host && host.isConnected) { render(); return; }
    host = document.createElement('div');
    host.id = '__neox_agent_banner_host__';
    host.setAttribute('style', 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;');
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = markup();
    document.documentElement.appendChild(host);
    shadow.getElementById('switch').addEventListener('click', async function (event) {
      if (!event.isTrusted || pending || !live()) return;
      var owner = state.owner === 'agent' ? 'user' : 'agent';
      pending = true;
      render();
      try {
        if (typeof window.__neoxBrowserControl !== 'function') throw new Error('disconnected');
        await window.__neoxBrowserControl(owner);
      } catch (error) {
        release();
      } finally {
        pending = false;
        render();
      }
    });
    shadow.getElementById('cursor-toggle').addEventListener('click', function () {
      cursorEnabled = !cursorEnabled;
      this.setAttribute('aria-pressed', String(cursorEnabled));
      this.title = cursorEnabled ? '隐藏虚拟鼠标' : '显示虚拟鼠标';
      this.setAttribute('aria-label', this.title);
      render();
    });
    shadow.getElementById('collapse').addEventListener('click', function () {
      collapsed = !collapsed;
      this.innerHTML = icon(collapsed ? 'up' : 'down');
      this.title = collapsed ? '展开工具栏' : '收起工具栏';
      this.setAttribute('aria-label', this.title);
      this.setAttribute('aria-expanded', String(!collapsed));
      render();
    });
    render();
  }
  function guard(event) {
    if (!locked() || Date.now() < pauseUntil) return;
    if (event.composedPath().indexOf(host) >= 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'pointerdown' && shadow) {
      moveTip(event.clientX, event.clientY);
      denyPulse();
    }
  }
  window.addEventListener('pointermove', function (event) {
    if (shadow && event.composedPath().indexOf(host) < 0) moveTip(event.clientX, event.clientY);
  }, { capture: true, passive: true });
  /* Clicks the agent makes from script (el.click() inside an eval step) never pass through the
   * click tool, so the cursor used to sit still while things got clicked. Script clicks are
   * untrusted events; follow them to their target. Registered before the guard, which stops
   * propagation. */
  window.addEventListener('click', function (event) {
    if (event.isTrusted || !shadow || !locked() || state.owner !== 'agent') return;
    if (event.composedPath().indexOf(host) >= 0) return;
    var target = event.target;
    if (!target || typeof target.getBoundingClientRect !== 'function') return;
    var r = target.getBoundingClientRect();
    if (!r.width && !r.height) return;
    window.__neoxAgentBanner.moveCursor(r.left + r.width / 2, r.top + r.height / 2, false);
  }, { capture: true, passive: true });
  /* Scrolling stays allowed: looking around the page while the agent works is harmless. */
  ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','auxclick','contextmenu','keydown','keyup','keypress','beforeinput','touchstart','touchend'].forEach(function (name) {
    window.addEventListener(name, guard, { capture: true, passive: false });
  });
  window.__neoxAgentBanner = {
    sync: function (next) {
      if (next.revision < lastRevision) return;
      lastRevision = next.revision;
      state.active = !!next.active;
      state.owner = next.owner === 'user' ? 'user' : 'agent';
      state.busy = !!next.busy;
      state.detail = String(next.detail || '');
      if (next.cursor && Number.isFinite(next.cursor.x) && Number.isFinite(next.cursor.y)) lastKnown = next.cursor;
      if (!state.active) { release(); return; }
      leaseUntil = Date.now() + 6500;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(release, 6600);
      mount();
    },
    /* Returns how long the glide takes so the caller can let it land before clicking;
     * 0 when nothing visible moved. */
    moveCursor: function (x, y, pressed) {
      if (!locked() || state.owner !== 'agent' || !shadow || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
      var cursor = shadow.getElementById('cursor');
      var tx = tipX(x), ty = tipY(y);
      if (!cursorSeen) parkCursor();
      var dist = Math.hypot(tx - cursorX, ty - cursorY);
      cursorX = tx; cursorY = ty;
      cursor.style.transform = 'translate(' + tx + 'px,' + ty + 'px)';
      cursor.className = 'cursor' + (pressed ? ' pressed' : '');
      cursor.hidden = !cursorEnabled;
      return cursorEnabled && dist > 4 ? GLIDE_MS : 0;
    },
    setDetail: function (value) { state.detail = String(value || ''); render(); },
    setLabel: function (value) { state.label = String(value || ''); render(); },
    // Legacy setters may release a lease, but cannot create one without session authority.
    setActive: function (active) { if (!active) release(); },
    hide: release,
    show: render,
    __remount: mount
  };
  window.__neoxTakeoverGuard = {
    pause: function (ms) {
      if (locked()) pauseUntil = Date.now() + Math.min(10000, Math.max(0, Number(ms) || 0));
    },
    resume: function () { pauseUntil = 0; }
  };
  mount();
  if (isTop && !document.documentElement) document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
`;

export interface BannerSessionState {
  active: boolean;
  owner: 'agent' | 'user';
  busy: boolean;
  detail: string;
  revision: number;
  /** Last agent cursor position (viewport px), so a new page shows it where it was. */
  cursor?: { x: number; y: number };
}

export function bannerSyncExpr(state: BannerSessionState): string {
  return `window.__neoxAgentBanner && window.__neoxAgentBanner.sync(${JSON.stringify(state)})`;
}

export function bannerSetDetailExpr(detail: string): string {
  return `window.__neoxAgentBanner && window.__neoxAgentBanner.setDetail(${JSON.stringify(detail)})`;
}

export function bannerSetActiveExpr(active: boolean): string {
  return `window.__neoxAgentBanner && window.__neoxAgentBanner.setActive(${active})`;
}

export function bannerSetLabelExpr(label: string): string {
  return `window.__neoxAgentBanner && window.__neoxAgentBanner.setLabel(${JSON.stringify(label)})`;
}

export const TAKEOVER_GUARD_PAUSE_EXPR = (ms: number): string =>
  `window.__neoxTakeoverGuard && window.__neoxTakeoverGuard.pause(${Math.max(0, ms | 0)})`;
