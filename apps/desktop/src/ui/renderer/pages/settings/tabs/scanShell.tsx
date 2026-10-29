
import React from 'react';

/** 扫描时依次报出来的源 —— 必须跟扫描器**实际读的地方**一一对应, 不许编 */
export interface ScanSource {
  zh: string;
  en: string;
}

export const SCAN_STYLES = `
  .nx-scan { display: flex; flex-direction: column; }
  .nx-scan--compact { font-size: 12px; }

  .nx-scan__lede { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
  .nx-scan__lede-title { font-size: 14px; font-weight: 600; color: var(--neox-fg-primary); }
  .nx-scan__lede-desc { font-size: 12px; line-height: 1.6; color: var(--neox-fg-muted, var(--text-muted)); }

  .nx-scan__start { display: flex; justify-content: flex-start; padding: 4px 0 2px; }

  .nx-scan__cta {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 16px; font-size: 13px; font-weight: 600;
    border-radius: 10px; cursor: pointer;
    color: var(--neox-fg-primary);
    background: color-mix(in srgb, var(--neox-primary-500, #2563eb) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--neox-primary-500, #2563eb) 40%, transparent);
    transition: background .14s ease, transform .14s ease;
  }
  .nx-scan__cta:hover:not(:disabled) {
    background: color-mix(in srgb, var(--neox-primary-500, #2563eb) 22%, transparent);
  }
  .nx-scan__cta:active:not(:disabled) { transform: scale(.985); }
  .nx-scan__cta:disabled { opacity: .55; cursor: default; }

  /* 扫描中: 逐条报源, 当前那条走 shimmer */
  .nx-scan__probe { display: flex; flex-direction: column; gap: 9px; padding: 6px 0 2px; }
  .nx-scan__probe-row {
    display: flex; align-items: center; gap: 9px;
    font-size: 12px;
    color: var(--neox-fg-muted, var(--text-muted));
    opacity: .35;
    transition: opacity .2s ease;
  }
  .nx-scan__probe-row[data-state="done"] { opacity: .7; }
  .nx-scan__probe-row[data-state="live"] { opacity: 1; color: var(--neox-fg-primary); }
  .nx-scan__probe-row[data-state="live"] .nx-scan__probe-name {
    background: linear-gradient(90deg,
      var(--neox-fg-muted, #8a8a8a) 0%,
      var(--neox-fg-primary) 45%,
      var(--neox-fg-muted, #8a8a8a) 90%);
    background-size: 220% 100%;
    -webkit-background-clip: text; background-clip: text;
    color: transparent;
    animation: nx-scan-shimmer 1.1s linear infinite;
  }
  @keyframes nx-scan-shimmer {
    0%   { background-position: 120% 0; }
    100% { background-position: -20% 0; }
  }
  .nx-scan__probe-dot { width: 5px; height: 5px; border-radius: 50%; flex: none; background: currentColor; }
  .nx-scan__probe-row[data-state="live"] .nx-scan__probe-dot {
    animation: nx-scan-pulse 1.1s ease-in-out infinite;
  }
  @keyframes nx-scan-pulse {
    0%, 100% { transform: scale(1); opacity: .5; }
    50%      { transform: scale(1.7); opacity: 1; }
  }

  /* 结果: 平铺的行, 只有分隔线 */
  .nx-scan__rows { display: flex; flex-direction: column; }
  .nx-scan__rows--scroll { max-height: 44vh; overflow-y: auto; }
  .nx-scan__row {
    display: flex; align-items: center; gap: 12px;
    padding: 11px 2px;
    min-width: 0;
    border-bottom: 1px solid var(--neox-line-soft, color-mix(in srgb, var(--neox-fg-primary) 8%, transparent));
    animation: nx-scan-in .26s ease both;
  }
  @keyframes nx-scan-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: none; }
  }
  .nx-scan__pick { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; cursor: pointer; }
  .nx-scan__pick input { flex: none; accent-color: var(--neox-primary-600, var(--neox-accent)); }
  .nx-scan__name {
    font-size: 13px; font-weight: 500; color: var(--neox-fg-primary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; max-width: 40%;
  }
  .nx-scan__sub {
    flex: 1 1 auto; min-width: 0;
    font-size: 11.5px; color: var(--neox-fg-muted, var(--text-muted));
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .nx-scan__tag {
    flex: none; font-size: 10.5px;
    color: var(--neox-fg-secondary, var(--text-muted));
    opacity: .8;
  }
  .nx-scan__meta {
    flex: none; display: flex; align-items: baseline; gap: 6px;
    font-family: var(--neox-font-mono, ui-monospace, monospace);
    font-size: 11.5px; color: var(--neox-fg-secondary, var(--text-muted));
  }
  .nx-scan__meta-dim { font-family: inherit; font-size: 10px; opacity: .65; }

  .nx-scan__input {
    flex: none; width: 190px;
    padding: 5px 9px; font-size: 11.5px; border-radius: 7px;
    color: var(--neox-fg-primary);
    background: color-mix(in srgb, var(--neox-fg-primary) 5%, transparent);
    border: 1px solid transparent;
    transition: border-color .12s, background .12s;
  }
  .nx-scan__input::placeholder { color: var(--neox-fg-muted, var(--text-muted)); opacity: .75; }
  .nx-scan__input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--neox-primary-500, #2563eb) 55%, transparent);
    background: transparent;
  }

  .nx-scan__foot {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding-top: 14px;
    font-size: 12px; color: var(--neox-fg-muted, var(--text-muted));
  }
  .nx-scan__foot-actions { display: flex; gap: 8px; align-items: center; }
  .nx-scan__mode { display: flex; gap: 12px; align-items: center; }
  .nx-scan__mode label { display: flex; gap: 4px; align-items: center; cursor: pointer; }
  .nx-scan__mode input { margin: 0; accent-color: var(--neox-primary-600, var(--neox-accent)); }
  .nx-scan__link {
    background: none; border: none; padding: 0;
    font-size: 12px; color: var(--neox-fg-secondary, var(--text-muted));
    cursor: pointer;
  }
  .nx-scan__link:hover { color: var(--neox-fg-primary); }
  .nx-scan__link:disabled { opacity: .5; cursor: default; }

  .nx-scan__empty {
    padding: 22px 2px;
    font-size: 12.5px; line-height: 1.7;
    color: var(--neox-fg-muted, var(--text-muted));
  }

  .nx-scan__search {
    width: 100%;
    margin-bottom: 8px;
    padding: 7px 10px;
    font-size: 12.5px;
    border-radius: 8px;
    color: var(--neox-fg-primary);
    background: color-mix(in srgb, var(--neox-fg-primary) 5%, transparent);
    border: 1px solid transparent;
  }
  .nx-scan__search:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--neox-primary-500, #2563eb) 45%, transparent);
    background: transparent;
  }

  /* ── 2026-10-10 第二版: 源清单常驻 (扫描前 = 会读哪些地方, 扫描中 = 逐条亮, 扫描后 = 各找到几条) ── */
  .nx-scan__sources { display: flex; flex-direction: column; margin: 2px 0 16px; }
  .nx-scan__src {
    display: flex; align-items: center; gap: 10px; padding: 8px 2px;
    font-size: 12.5px; color: var(--neox-fg-secondary, var(--text-secondary));
    border-bottom: 1px solid var(--neox-line-soft, color-mix(in srgb, var(--neox-fg-primary) 7%, transparent));
    transition: color .2s ease, opacity .2s ease;
  }
  .nx-scan__src:last-child { border-bottom: 0; }
  .nx-scan__src-icon { flex: none; width: 18px; height: 18px; display: grid; place-items: center; color: var(--neox-fg-muted, var(--text-muted)); }
  .nx-scan__src-path { flex: 1 1 auto; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nx-scan__src-path.is-path { font-family: var(--neox-font-mono, ui-monospace, monospace); font-size: 12px; }
  .nx-scan__src-count { flex: none; font-size: 12px; color: var(--neox-fg-muted, var(--text-muted)); font-variant-numeric: tabular-nums; }
  .nx-scan__src-count b { font-weight: 600; color: var(--neox-fg-primary); }
  .nx-scan__src[data-state="idle"] { opacity: .5; }
  .nx-scan__src[data-state="live"] { color: var(--neox-fg-primary); }
  .nx-scan__src[data-state="live"] .nx-scan__src-path {
    background: linear-gradient(90deg, var(--neox-fg-muted, #8a8a8a) 0%, var(--neox-fg-primary) 45%, var(--neox-fg-muted, #8a8a8a) 90%);
    background-size: 220% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: nx-scan-shimmer 1.1s linear infinite;
  }
  .nx-scan__src[data-state="live"] .nx-scan__src-icon { color: var(--neox-primary-500, #41a0ff); animation: nx-scan-spin 0.9s linear infinite; }
  .nx-scan__src[data-state="done"] .nx-scan__src-icon { color: var(--color-success, #22a06b); }
  .nx-scan__src[data-state="empty"] { opacity: .55; }
  @keyframes nx-scan-spin { to { transform: rotate(360deg); } }

  /* 反色按钮: 底 = 正文色, 字 = 页面底色 —— 暗色主题下正文色是浅的, 写死 #fff 会白字配白底 */
  .nx-scan__cta--primary {
    color: var(--neox-bg-elevated, #fff); background: var(--neox-fg-primary, #111);
    border-color: transparent;
  }
  .nx-scan__cta--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--neox-fg-primary, #111) 86%, transparent); }

  /* 筛选: 来源小胶囊带数字 + 搜索 */
  .nx-scan__filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  .nx-scan__chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
    font: inherit; font-size: 12px; color: var(--neox-fg-secondary, var(--text-secondary));
    background: color-mix(in srgb, var(--neox-fg-primary) 5%, transparent); border: 1px solid transparent;
  }
  .nx-scan__chip b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--neox-fg-muted, var(--text-muted)); }
  .nx-scan__chip:hover { background: color-mix(in srgb, var(--neox-fg-primary) 9%, transparent); }
  .nx-scan__chip.is-on { color: var(--neox-fg-primary); background: transparent; border-color: color-mix(in srgb, var(--neox-fg-primary) 30%, transparent); }
  .nx-scan__chip.is-on b { color: var(--neox-fg-primary); }
  .nx-scan__filters .nx-scan__search { flex: 1 1 200px; width: auto; margin: 0 0 0 auto; max-width: 280px; padding: 5px 10px; font-size: 12px; }

  /* 结果行 v2: 自绘勾选框 + 两行 (名字 + 说明), 右侧来源/附注 */
  .nx-scan__item {
    display: flex; align-items: flex-start; gap: 12px; padding: 11px 8px; margin: 0 -8px;
    border-radius: 10px; min-width: 0; cursor: pointer;
    animation: nx-scan-in .26s ease both;
  }
  .nx-scan__item + .nx-scan__item { box-shadow: inset 0 1px 0 var(--neox-line-soft, color-mix(in srgb, var(--neox-fg-primary) 7%, transparent)); }
  .nx-scan__item:hover { background: color-mix(in srgb, var(--neox-fg-primary) 3.5%, transparent); }
  .nx-scan__item.is-off .nx-scan__item-main { opacity: .62; }
  .nx-scan__box {
    flex: none; width: 16px; height: 16px; margin-top: 2px; border-radius: 5px; display: grid; place-items: center;
    border: 1.5px solid color-mix(in srgb, var(--neox-fg-primary) 28%, transparent); background: transparent;
    transition: background .12s ease, border-color .12s ease;
  }
  .nx-scan__box svg { opacity: 0; transform: scale(.6); transition: opacity .12s ease, transform .12s ease; }
  .nx-scan__box.is-on { background: var(--neox-fg-primary, #111); border-color: var(--neox-fg-primary, #111); color: var(--neox-bg-primary, #fff); }
  .nx-scan__box.is-on svg { opacity: 1; transform: none; }
  .nx-scan__item-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .nx-scan__item-title { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; font-weight: 500; color: var(--neox-fg-primary); }
  .nx-scan__item-title > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nx-scan__pill {
    flex: none; padding: 0 7px; border-radius: 999px; font-size: 10.5px; font-weight: 500; line-height: 18px;
    color: var(--neox-fg-secondary, var(--text-muted)); background: color-mix(in srgb, var(--neox-fg-primary) 6%, transparent);
  }
  .nx-scan__item-sub {
    font-size: 12px; line-height: 1.55; color: var(--neox-fg-muted, var(--text-muted));
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .nx-scan__item-full {
    margin-top: 6px; padding: 10px 12px; border-radius: 8px; max-height: 260px; overflow: auto;
    font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
    color: var(--neox-fg-secondary, var(--text-secondary));
    background: color-mix(in srgb, var(--neox-fg-primary) 4%, transparent);
    cursor: text; user-select: text;
  }
  .nx-scan__item-path { margin-top: 4px; font-family: var(--neox-font-mono, ui-monospace, monospace); font-size: 10.5px; color: var(--neox-fg-muted, var(--text-muted)); opacity: .8; }
  .nx-scan__expand {
    flex: none; align-self: center; background: none; border: 0; padding: 2px 4px; cursor: pointer;
    font-size: 11.5px; color: var(--neox-fg-muted, var(--text-muted));
  }
  .nx-scan__expand:hover { color: var(--neox-fg-primary); }
  .nx-scan__item-aside { flex: none; align-self: center; display: flex; align-items: center; gap: 8px; }
  .nx-scan__item-aside.nx-scan__meta { font-family: inherit; font-size: 12px; }
  .nx-scan__more { align-self: center; margin: 10px 0 2px; }

  /* 页脚贴底: 列表长的时候按钮一直在手边 */
  /* 设置页滚动容器 (.settings-main) 底部有 40px padding, sticky 会停在 padding 之上 —— 往下压 40px
     贴到真正的底边, 再用同样的 padding 把这 40px 填上底色, 下面的行不会从缝里露出来 */
  .nx-scan--page .nx-scan__foot--sticky {
    position: sticky; bottom: -40px; z-index: 2; margin-top: 8px; padding: 12px 0 52px; margin-bottom: -40px;
    /* 主区底色随主题包变, --neox-bg-elevated 在浅色是 #fefefe、暗色是对应的深底 */
    background: var(--neox-bg-elevated, #fff);
    box-shadow: 0 -1px 0 var(--neox-line-soft, color-mix(in srgb, var(--neox-fg-primary) 7%, transparent));
  }
  .nx-scan__picked { font-variant-numeric: tabular-nums; }
  .nx-scan__envtoggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-size: 12px; color: var(--neox-fg-secondary, var(--text-secondary)); }
  .nx-scan__envtoggle .nx-scan__box { margin-top: 0; }
  .nx-scan__picked b { font-weight: 600; color: var(--neox-fg-primary); }

  /* 导入完成 */
  .nx-scan__done {
    display: flex; align-items: center; gap: 12px; padding: 12px 14px; margin-bottom: 14px; border-radius: 12px;
    font-size: 13px; color: var(--neox-fg-primary);
    background: color-mix(in srgb, var(--color-success, #22a06b) 9%, transparent);
    animation: nx-scan-in .26s ease both;
  }
  .nx-scan__done-icon { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: var(--color-success, #22a06b); }
  .nx-scan__done-text { flex: 1 1 auto; min-width: 0; }
  .nx-scan__done-text em { display: block; font-style: normal; font-size: 12px; color: var(--neox-fg-muted, var(--text-muted)); }
  .nx-scan__done.is-bad { background: color-mix(in srgb, #e5484d 9%, transparent); }
  .nx-scan__done.is-bad .nx-scan__done-icon { background: #e5484d; }
`;

export const ScanStyles: React.FC = () => <style>{SCAN_STYLES}</style>;

/** 起手式: 一段说明 + 一颗按钮, 别的什么都没有 */
export const ScanLede: React.FC<{ title: string; desc?: string }> = ({ title, desc }) => (
  <div className="nx-scan__lede">
    <span className="nx-scan__lede-title">{title}</span>
    {desc && <span className="nx-scan__lede-desc">{desc}</span>}
  </div>
);

/** 扫描中: 把正在读的源逐个报出来 */
export const ScanProbe: React.FC<{ sources: ScanSource[]; at: number; zh: boolean }> = ({ sources, at, zh }) => (
  <div className="nx-scan__probe">
    {sources.map((src, i) => (
      <div
        key={src.en}
        className="nx-scan__probe-row"
        data-state={i < at ? 'done' : i === at ? 'live' : 'idle'}
      >
        <span className="nx-scan__probe-dot" />
        <span className="nx-scan__probe-name">{zh ? src.zh : src.en}</span>
      </div>
    ))}
  </div>
);


const FolderGlyph: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
const SpinGlyph: React.FC = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);
export const CheckGlyph: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/**
 * 源清单。counts 不传 = 还没扫; at = 扫描进行到第几条 (busy 时传)。
 * counts[i] 是第 i 个源找到的条数 —— 调用方按 sourcePath 归类, 归不进去的不算 (不编数)。
 */
export const ScanSources: React.FC<{
  sources: ScanSource[];
  zh: boolean;
  at?: number;
  counts?: number[];
  unit?: { zh: string; en: string };
}> = ({ sources, zh, at, counts, unit }) => (
  <div className="nx-scan__sources">
    {sources.map((src, i) => {
      const n = counts?.[i];
      const state = at !== undefined
        ? (i < at ? 'done' : i === at ? 'live' : 'idle')
        : counts ? (n && n > 0 ? 'done' : 'empty') : 'ready';
      return (
        <div key={src.en} className="nx-scan__src" data-state={state}>
          <span className="nx-scan__src-icon">
            {state === 'live' ? <SpinGlyph /> : state === 'done' && counts ? <CheckGlyph /> : <FolderGlyph />}
          </span>
          {/* 真路径用等宽字, 「Claude Code 这个项目的自动记忆」这种说明用正文字 */}
          <span className={`nx-scan__src-path${/^[~<.]/.test(zh ? src.zh : src.en) ? ' is-path' : ''}`}>{zh ? src.zh : src.en}</span>
          {counts && at === undefined && (
            <span className="nx-scan__src-count">
              {n && n > 0
                ? <><b>{n}</b>{unit ? ` ${zh ? unit.zh : unit.en}` : ''}</>
                : (zh ? '没有' : 'none')}
            </span>
          )}
        </div>
      );
    })}
  </div>
);

/** 自绘勾选框 —— 系统的 checkbox 在深浅主题里都跟这页不搭 */
export const ScanBox: React.FC<{ on: boolean }> = ({ on }) => (
  <span className={`nx-scan__box${on ? ' is-on' : ''}`} aria-hidden="true"><CheckGlyph size={11} /></span>
);

/** 来源筛选胶囊 */
export function ScanChips<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: string; count: number }>;
  onChange: (v: T) => void;
}) {
  return (
    <>
      {options.map((o) => (
        <button key={o.value} type="button" className={`nx-scan__chip${value === o.value ? ' is-on' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}<b>{o.count}</b>
        </button>
      ))}
    </>
  );
}

/** 导入结果条: 成功说导了几条 + 一个去处; 全失败说原因 */
export const ScanDone: React.FC<{ title: string; note?: string; bad?: boolean; action?: React.ReactNode }> = ({ title, note, bad, action }) => (
  <div className={`nx-scan__done${bad ? ' is-bad' : ''}`} role="status">
    <span className="nx-scan__done-icon">{bad ? '!' : <CheckGlyph size={13} />}</span>
    <span className="nx-scan__done-text">{title}{note && <em>{note}</em>}</span>
    {action}
  </div>
);

/**
 * 扫描的节奏控制 —— 保证扫描态**至少活满一轮**动画。
 *
 *   真实扫描只要几十毫秒, 直接跟着它切状态的话动画只闪一帧, 等于没有。
 *   返回的 rest 是"还需要再等多久", 调用方 setTimeout 之后再收工。
 */
export function scanPacing(sources: ScanSource[], startedAt: number, stepMs = 220): number {
  return Math.max(0, sources.length * stepMs - (Date.now() - startedAt));
}
