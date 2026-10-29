
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyUsagePoint } from './UsageTrendChart';
import { rangeLabel, type UsageRange } from './usageRange';
import brandLockupUrl from '../../../assets/brand/lockup-dark.png';

/**
 * 品牌标要**内联成 data URL** 才能出现在导出的 PNG 里。
 *
 *   导出走的是 "序列化 SVG → data: URL → <img> → canvas"。那个 <img> 加载的是
 *   一段独立文档, 里面的外部引用 (asset URL / blob:) 一律取不到 —— 直接渲染成空白,
 *   而且不报错。所以 logo 必须在序列化之前就已经是 data URL。
 */
function useInlinedBrandLockup(): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(brandLockupUrl as unknown as string);
        const blob = await res.blob();
        const fr = new FileReader();
        fr.onload = () => { if (alive) setDataUrl(String(fr.result)); };
        fr.readAsDataURL(blob);
      } catch { /* 取不到就不画 logo, 不挡分享 */ }
    })();
    return () => { alive = false; };
  }, []);
  return dataUrl;
}

export interface ShareModelStat {
  model: string;
  totalTokens: number;
}

export interface UsageShareData {
  range: UsageRange;
  series: DailyUsagePoint[];
  totalTokens: number;
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  activeDays: number;
  /** 用户配了单价才有 —— 没配就不显示金额, 绝不按一个"默认价"编一个数出来 */
  costUsd: number | null;
  topModel: ShareModelStat | null;
  avgTokensPerSec: number | null;
  cacheHitRate: number | null;
}

const W = 900;
const H = 520;
/** 卡圆角 (与 SVG clip / CSS border-radius 一致); 导出 PNG 也按这个切透明角 */
const CARD_RADIUS = 28;

/** 卡内中文: 楷体优先; 数字仍走系统无衬线以保证 tabular-nums 对齐 */
const FONT_ART = 'KaiTi, STKaiti, "Kaiti SC", "Songti SC", "华文楷体", serif';
const FONT_NUM = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** 模型 id 常常很长 (provider/family-version-date), 卡上只留能认出来的那段。 */
function shortModel(id: string): string {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  return tail.length > 26 ? `${tail.slice(0, 25)}…` : tail;
}

/** 折线 —— 只要形状, 所以自己按比例铺满给定的框, 不带任何坐标轴。 */
function sparkPaths(values: number[], x: number, y: number, w: number, h: number) {
  if (values.length === 0) return { line: '', area: '' };
  const peak = Math.max(1, ...values);
  const at = (i: number) => (values.length <= 1 ? x + w / 2 : x + (i / (values.length - 1)) * w);
  const yAt = (v: number) => y + h - (v / peak) * h;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${at(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  return { line, area: `${line} L${at(values.length - 1).toFixed(1)},${(y + h).toFixed(1)} L${at(0).toFixed(1)},${(y + h).toFixed(1)} Z` };
}

export const UsageShareCard: React.FC<{
  data: UsageShareData;
  zh: boolean;
  onClose: () => void;
}> = ({ data, zh, onClose }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const brandLockup = useInlinedBrandLockup();
  /* 入场动画: 挂载后下一帧翻成 true, 让 CSS 从初态过渡到终态。
     直接给终态类名不会有动画 —— 浏览器不会为"首次渲染就是这个值"的属性做过渡。 */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  /* ESC 只关这张卡, 不能穿透到设置面板把整个设置关掉。
   *
   *   必须用 **capture 阶段** 并 stopPropagation: 设置面板的 ESC 监听挂在
   *   document/window 上, 冒泡阶段再拦已经晚了 —— 它和我们谁先收到取决于挂载顺序,
   *   那是个会随重构漂移的隐式依赖。capture 从根往下走, 我们一定先拿到。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  /* 时间胶囊背板宽度: 按字符粗估即可 (独占右上, 不和主数抢位)。 */
  const periodText = rangeLabel(data.range, zh);
  const periodW = Math.max(96, periodText.length * (zh ? 15 : 7.6) + 28);

  const values = useMemo(() => data.series.map(p => p.totalTokens), [data.series]);
  /* 折线下移: 上方留给「用得最多」, 避免模型名压在峰值上 */
  const spark = useMemo(() => sparkPaths(values, 56, 336, W - 112, 64), [values]);
  const outPct = data.totalTokens > 0 ? (data.outputTokens / data.totalTokens) * 100 : 0;

  /** SVG → PNG。2x 是为了在 Retina 上贴出去不糊。
   *
   *   屏幕上看着圆角, 是因为 CSS `border-radius` —— 序列化 SVG 再画进 canvas 时
   *   CSS 不跟着走, 导出就是直角矩形, 四角还带着不透明底色, 粘到微信/聊天里
   *   底下那一圈直角黑边特别难看。所以这里用 destination-in 把圆角外切成透明。 */
  const toPngBlob = async (): Promise<Blob | null> => {
    const svg = svgRef.current;
    if (!svg) return null;
    const xml = new XMLSerializer().serializeToString(svg);
    /* 必须走 data: URL 而不是 blob: —— blob URL 画进 canvas 会把它标记成 tainted,
       后面 toBlob 直接抛 SecurityError。base64 里有中文要先 encodeURIComponent。 */
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('svg decode failed'));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    /* 切出真正的圆角透明角 —— SVG-as-image 对 clipPath 支持不稳, 不能只靠 SVG 内 clip */
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000';
    pathRoundRect(ctx, 0, 0, canvas.width, canvas.height, CARD_RADIUS * scale);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    return await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
  };

  /** 优先走主进程 nativeImage 写剪贴板 (Windows 上 PNG+DIB 保透明圆角),
   *  没有 IPC 再回退到 ClipboardItem。 */
  const writePngToClipboard = async (blob: Blob) => {
    const copyFn = (window as any).neox?.copyShareCard as ((dataUrl: string) => Promise<{ ok?: boolean; error?: string } | void>) | undefined;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    if (copyFn) {
      const r = await copyFn(dataUrl);
      if (r && typeof r === 'object' && r.ok === false) {
        throw new Error(r.error || 'copyShareCard failed');
      }
      return;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  };

  const copyImage = async () => {
    try {
      const blob = await toPngBlob();
      if (!blob) throw new Error('render failed');
      await writePngToClipboard(blob);
      setToast(zh ? '已复制到剪贴板' : 'Copied to clipboard');
    } catch {
      setToast(zh ? '复制失败, 试试保存为图片' : 'Copy failed — try saving instead');
    }
    window.setTimeout(() => setToast(null), 2200);
  };

  const shareTo = async (target: 'x' | 'reddit') => {
    const tokens = fmtCompact(data.totalTokens);
    const model = data.topModel ? shortModel(data.topModel.model) : null;
    const period = rangeLabel(data.range, false);
    const text = model
      ? `${tokens} tokens through Neox over ${period.toLowerCase()} — mostly ${model}.`
      : `${tokens} tokens through Neox over ${period.toLowerCase()}.`;

    /* 先复制图, 再开页面 —— 顺序不能反: 新窗口一打开焦点就走了,
       某些平台上 clipboard.write 会因为文档失焦被拒。 */
    let copied = false;
    try {
      const blob = await toPngBlob();
      if (blob) {
        await writePngToClipboard(blob);
        copied = true;
      }
    } catch { /* 复制失败不挡分享, 下面的提示会说清楚 */ }

    const url = target === 'x'
      ? `https://x.com/intent/post?text=${encodeURIComponent(text)}`
      : `https://www.reddit.com/submit?title=${encodeURIComponent(text)}`;
    try {
      /* 走主进程 shell.openExternal —— 渲染进程里 window.open 会开一个没有导航栏的
         Electron 窗口, 用户在那里登录第三方账号既别扭又不安全。 */
      const opener = (window as any).neox?.openExternal as ((u: string) => Promise<void>) | undefined;
      if (opener) await opener(url); else window.open(url, '_blank', 'noopener,noreferrer');
    } catch { /* 打不开就只留剪贴板里的图 */ }

    setToast(copied
      ? (zh ? '图片已复制 — 在发帖页按 Cmd/Ctrl+V 粘贴' : 'Image copied — paste it with Cmd/Ctrl+V')
      : (zh ? '已打开发帖页 (图片复制失败, 可先保存 PNG)' : 'Opened composer (image copy failed — save the PNG instead)'));
    window.setTimeout(() => setToast(null), 4200);
  };

  const saveImage = async () => {
    try {
      const blob = await toPngBlob();
      if (!blob) throw new Error('render failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `neox-usage-${data.range.startDay}_${data.range.endDay}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setToast(zh ? '已保存' : 'Saved');
    } catch {
      setToast(zh ? '保存失败' : 'Save failed');
    }
    window.setTimeout(() => setToast(null), 2200);
  };

  return (
    <div className={`usg-share-backdrop ${entered ? 'is-in' : ''}`} role="dialog" aria-modal="true" onClick={onClose}>
      <div className={`usg-share-shell ${entered ? 'is-in' : ''}`} onClick={e => e.stopPropagation()}>
        {/* 平台入口悬浮在卡右上角 —— 不占卡内版面 (卡里每多一个元素, "一张卡"的
            整体感就少一分), 也不塞进底部按钮排 (那排是"对这张图做什么",
            这两个是"发到哪去", 两种意图不该混在一行)。 */}
        <div className="usg-share-social">
          <button type="button" className="usg-share-social__btn" title={zh ? '分享到 X' : 'Share on X'}
            aria-label={zh ? '分享到 X' : 'Share on X'} onClick={() => void shareTo('x')}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </button>
          <button type="button" className="usg-share-social__btn" title={zh ? '分享到 Reddit' : 'Share on Reddit'}
            aria-label={zh ? '分享到 Reddit' : 'Share on Reddit'} onClick={() => void shareTo('reddit')}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
              <path d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-6.993 4.87-3.87 0-7-2.176-7-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12.5c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.688 0-1.249.561-1.249 1.25 0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
            </svg>
          </button>
        </div>
        <svg
          ref={svgRef}
          className="usg-share-svg"
          xmlns="http://www.w3.org/2000/svg"
          width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        >
          <defs>
            <linearGradient id="uc-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#12141c" />
              <stop offset="55%" stopColor="#171a24" />
              <stop offset="100%" stopColor="#0e1016" />
            </linearGradient>
            <radialGradient id="uc-glow-a" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="uc-glow-b" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#7c5cff" stopOpacity="0.34" />
              <stop offset="100%" stopColor="#7c5cff" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="uc-spark" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.30" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="uc-mix" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#6ee7b7" />
              <stop offset="100%" stopColor="#34d399" />
            </linearGradient>
            <filter id="uc-blur" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="42" />
            </filter>
            <clipPath id="uc-clip"><rect x="0" y="0" width={W} height={H} rx={CARD_RADIUS} /></clipPath>
          </defs>

          <g clipPath="url(#uc-clip)">
            {/* 底色本身也带圆角: SVG-as-image 时 clipPath 常失效, 靠这层避免导出直角实底 */}
            <rect x="0" y="0" width={W} height={H} rx={CARD_RADIUS} fill="url(#uc-bg)" />
            <circle cx={W - 130} cy="70" r="190" fill="url(#uc-glow-a)" filter="url(#uc-blur)" />
            <circle cx="110" cy={H - 40} r="210" fill="url(#uc-glow-b)" filter="url(#uc-blur)" />
            <rect x="0" y="0" width={W} height={H} rx={CARD_RADIUS} fill="#ffffff" opacity="0.014" />

            {/* ── 页眉: 真 logo + 字标 ─────────────────── */}
            {brandLockup && <image href={brandLockup} x="54" y="40" width="150" height="26" preserveAspectRatio="xMinYMid meet" />}

            <g>
              <rect x={W - 56 - periodW} y="40" width={periodW} height="27" rx="13.5"
                fill="#ffffff" fillOpacity="0.07" stroke="#ffffff" strokeOpacity="0.10" />
              <text
                x={W - 56 - periodW / 2} y="58" textAnchor="middle"
                fill="#ffffff" fontSize="13.5" opacity="0.78"
                fontFamily={FONT_ART}
              >
                {periodText}
              </text>
            </g>

            {/* ── 主数独占一行; 请求数落在下方, 杜绝并排叠字 ── */}
            <text
              x="56" y="118" fill="#ffffff" fontSize="15" opacity="0.48"
              fontFamily={FONT_ART} letterSpacing="0.08em"
            >
              {zh ? '本期用量' : 'Tokens used'}
            </text>
            <text
              x="56" y="198" fill="#ffffff" fontSize="78" fontWeight="700" letterSpacing="-2"
              fontFamily={FONT_NUM} style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtCompact(data.totalTokens)}
            </text>
            <text
              x="56" y="232" fill="#ffffff" fontSize="16" opacity="0.48"
              fontFamily={FONT_ART} style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtCompact(data.totalRequests)} {zh ? '次请求' : 'requests'}
            </text>

            {data.costUsd != null && (
              <text
                x={W - 56} y="198" textAnchor="end" fill="#6ee7b7" fontSize="48" fontWeight="700"
                fontFamily={FONT_NUM} style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                ${data.costUsd < 10 ? data.costUsd.toFixed(2) : Math.round(data.costUsd).toLocaleString()}
              </text>
            )}
            {data.costUsd != null && (
              <text x={W - 56} y="228" textAnchor="end" fill="#ffffff" fontSize="14" opacity="0.42" fontFamily={FONT_ART}>
                {zh ? '估算成本' : 'Estimated cost'}
              </text>
            )}

            {/* 「用得最多」放在折线上方空档, 不压峰值 */}
            {data.topModel && (
              <g>
                <text x={W - 56} y="262" textAnchor="end" fill="#ffffff" fontSize="13" opacity="0.42" fontFamily={FONT_ART}>
                  {zh ? '用得最多' : 'Most used'}
                </text>
                <text x={W - 56} y="288" textAnchor="end" fill="#ffffff" fontSize="20" fontWeight="600" fontFamily={FONT_NUM}>
                  {shortModel(data.topModel.model)}
                </text>
                <text
                  x={W - 56} y="312" textAnchor="end" fill="#6ee7b7" fontSize="14" opacity="0.9"
                  fontFamily={FONT_NUM} style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtCompact(data.topModel.totalTokens)} tok
                </text>
              </g>
            )}

            {/* ── 折线 (只给形状) —— 整体下移, 给右上模型信息留空 ── */}
            {spark.line && <path d={spark.area} fill="url(#uc-spark)" />}
            {spark.line && (
              <path d={spark.line} fill="none" stroke="#6ee7b7" strokeWidth="2.4"
                strokeLinejoin="round" strokeLinecap="round" opacity="0.95" />
            )}

            <line x1="56" y1="424" x2={W - 56} y2="424" stroke="#ffffff" strokeOpacity="0.085" strokeWidth="1" />

            {/* ── 底部指标行 ─────────────────────────── */}
            {[
              { label: zh ? '请求' : 'Requests', value: fmtCompact(data.totalRequests) },
              { label: zh ? '活跃天数' : 'Active days', value: String(data.activeDays) },
              { label: zh ? '输出占比' : 'Output', value: `${outPct.toFixed(1)}%` },
              ...(data.avgTokensPerSec != null
                ? [{ label: zh ? '生成速度' : 'Speed', value: `${data.avgTokensPerSec.toFixed(0)} tok/s` }] : []),
              ...(data.cacheHitRate != null
                ? [{ label: zh ? '缓存命中' : 'Cache hit', value: `${(data.cacheHitRate * 100).toFixed(0)}%` }] : []),
            ].map((m, i, arr) => {
              const gap = (W - 112) / arr.length;
              const x = 56 + gap * i;
              return (
                <g key={m.label}>
                  <text x={x} y="456" fill="#ffffff" fontSize="13" opacity="0.42" fontFamily={FONT_ART}>{m.label}</text>
                  <text
                    x={x} y="488" fill="#ffffff" fontSize="21" fontWeight="600"
                    fontFamily={FONT_NUM} style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {m.value}
                  </text>
                </g>
              );
            })}

            <rect x="56" y="404" width={W - 112} height="3" rx="1.5" fill="#ffffff" opacity="0.09" />
            <rect x="56" y="404" width={Math.max(2, ((W - 112) * (100 - outPct)) / 100)} height="3" rx="1.5" fill="url(#uc-mix)" />
          </g>
        </svg>

        <div className="usg-share-actions">
          <button className="usg-share-btn usg-share-btn--primary" onClick={() => void copyImage()}>
            {zh ? '复制图片' : 'Copy image'}
          </button>
          <button className="usg-share-btn" onClick={() => void saveImage()}>
            {zh ? '保存为 PNG' : 'Save PNG'}
          </button>
          <button className="usg-share-btn usg-share-btn--ghost" onClick={onClose}>
            {zh ? '关闭' : 'Close'}
          </button>
          {toast && <span className="usg-share-toast">{toast}</span>}
        </div>
      </div>
    </div>
  );
};
