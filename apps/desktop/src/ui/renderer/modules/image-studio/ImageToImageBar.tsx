
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { directCutoutImage, emitDirectImageTurn, type DirectGenerateResult } from '../../services/imageDirectClient';
import { listImageTemplates, type ImageTemplate } from '../../state/imageTemplates';
import { runImageTemplate } from '../../services/imageTemplateRunner';
import { useNeoxRuntime } from '../../app/NeoxRuntimeContext';
import { isDefaultSessionName } from '../../hooks/useAgentModeVariant';
import { defaultIsZh } from '../../hooks/useI18n';

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(file); });
}
function loadDims(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((res) => { const img = new Image(); img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight }); img.onerror = () => res(null); img.src = url; });
}
/* 高清放大: 保原比例, 最长边提到 ~3072 (gpt-image-2 上限内), 16 整除. */
async function computeUpscaleSize(url: string): Promise<string> {
  const d = await loadDims(url);
  if (!d || !d.w || !d.h) return '2048x2048';
  const long = 3072; let ow: number, oh: number;
  if (d.w >= d.h) { ow = long; oh = Math.round((long * d.h) / d.w); } else { oh = long; ow = Math.round((long * d.w) / d.h); }
  ow = Math.max(512, Math.round(ow / 16) * 16); oh = Math.max(512, Math.round(oh / 16) * 16);
  return `${ow}x${oh}`;
}

interface Props {
  zh?: boolean;
  /** 当前 composer 里的图片附件 (dataURL 数组, 多图累加). 能力施加在第一张上. */
  images: string[];
  /** 一次操作完成 (刷新图库). */
  onDone?: () => void;
}

const IMG_MODEL_RE = /image|flux|seedream|dall-?e|nano.?banana|kolors|imagen|recraft|ideogram|grok.?image/i;

export const ImageToImageBar: React.FC<Props> = ({ zh = defaultIsZh(), images, onDone }) => {
  const runtime = useNeoxRuntime();
  /* 跟 composer 同口径取当前选中的图片模型 name (localStorage 'neox:image-model-id' → availableModels).
   *   op 必须带上它, 否则 fallback 'gpt-image-1' 可能路由到没这模型的 provider / 出错. */
  const selectedModelName = useMemo(() => {
    const models = ((runtime as { availableModels?: Array<{ id: string; name?: string }> }).availableModels) ?? [];
    let mid: string | null = null;
    try { mid = window.localStorage.getItem('neox:image-model-id'); } catch { /* ignore */ }
    const m = models.find((x) => x.id === mid) ?? models.find((x) => IMG_MODEL_RE.test(`${x.id} ${x.name ?? ''}`));
    return m?.name;
  }, [runtime]);
  /* 能力施加对象 = 第一张图片附件 (dataURL). composer 已把多图渲染成附件缩略, 这里只取主图跑能力. */
  const src = images[0] ?? null;
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const garmentRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const t = window.setTimeout(() => window.addEventListener('click', close), 0);
    return () => { window.clearTimeout(t); window.removeEventListener('click', close); };
  }, [menuOpen]);

  useEffect(() => {
    if (!note) return; const t = window.setTimeout(() => setNote(''), 3200); return () => window.clearTimeout(t);
  }, [note]);

  const ensureSession = useCallback(async () => {
    /* scratch 态 (点了"新建") → 即使当前是图片会话也强制新建, 跟 runDirectImageMode 同口径. */
    const forceNew = typeof window !== 'undefined' && (window as { __neoxImageScratch?: boolean }).__neoxImageScratch === true;
    let s = runtime.activeSession as { id?: string; name?: string; kind?: string } | null;
    if (forceNew || s?.kind !== 'image') {
      try { s = (await runtime.createNewSession({ kind: 'image' })) as typeof s; } catch { s = null; }
      if (forceNew) (window as { __neoxImageScratch?: boolean }).__neoxImageScratch = false;
    }
    return s;
  }, [runtime]);

  const emitTurn = useCallback(async (label: string, res: DirectGenerateResult, refUrl?: string) => {
    if (!res?.ok) return;
    const s = await ensureSession();
    const sid = s?.id || 'image-studio';
    if (s?.id && isDefaultSessionName(s.name)) {
      const t = label.trim(); if (t) void runtime.renameSession(s.id, t.length > 20 ? t.slice(0, 20) + '…' : t).catch(() => { /* 不阻塞 */ });
    }
    emitDirectImageTurn({
      sessionId: sid, turnId: `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      prompt: label, chipLabel: label, createdAt: Date.now(), status: 'ok', result: res,
      refImages: refUrl ? [refUrl] : undefined,
    });
  }, [ensureSession, runtime]);

  /* 通用执行器: 跑一个 op (返回 result) → 出图串进 timeline + 结果成为下一步输入 (环3). */
  const runOp = useCallback(async (label: string, fn: () => Promise<DirectGenerateResult>, refUrl?: string) => {
    if (busy) return;
    setBusy(label); setNote('');
    try {
      const res = await fn();
      if (res.ok && res.paths?.[0]) {
        await emitTurn(label, res, refUrl);
        /* 出图完成 → 刷新图库. 结果卡上有「继续」把它加回 composer 接着改, 这里不自动替换附件 (不越权). */
        onDone?.();
        window.dispatchEvent(new CustomEvent('neox:image-gallery-refresh'));
      } else {
        setNote(res.error || (zh ? `${label}失败` : `${label} failed`));
      }
    } catch (e: any) {
      setNote(e?.message || String(e));
    } finally { setBusy(''); }
  }, [busy, emitTurn, onDone, zh]);

  /* 去背景 = 特殊 (绿幕抠图 → 透明), 不是纯 edit. */
  const runCutout = useCallback(() => {
    if (!src) return;
    void runOp(zh ? '去背景' : 'Remove BG', () => directCutoutImage(src, selectedModelName), src);
  }, [src, zh, runOp, selectedModelName]);

  /* 数据驱动能力 = 统一模板引擎的 edit 类模板 (换装带参考图 · 放大提尺寸). 全 AI 出图, 不合成. */
  const pendingCapRef = useRef<ImageTemplate | null>(null);
  const runCap = useCallback(async (cap: ImageTemplate, garment?: string) => {
    if (!src) return;
    if (cap.needsReference && !garment) { pendingCapRef.current = cap; garmentRef.current?.click(); return; }
    await runOp(cap.name, async () => {
      const size = cap.upscale ? await computeUpscaleSize(src) : undefined;
      return runImageTemplate({ template: cap, input: src, reference: garment, model: selectedModelName, size });
    }, src);
  }, [src, runOp, selectedModelName]);

  const onGarment = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = ''; const cap = pendingCapRef.current; pendingCapRef.current = null;
    if (!f || !cap) return;
    const d = await readFileAsDataUrl(f); void runCap(cap, d);
  }, [runCap]);

  /* 没图 → 不渲染 (composer 没图片附件时魔杖不出现). */
  if (!src) return null;

  /* 裸 logo 魔杖 (无文字/无边框/无底) → 点开向上菜单. 挂在 composer 右侧, 对第一张图片附件施能力. */
  const menuItem: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 11px', borderRadius: 8,
    border: 'none', background: 'transparent', color: 'var(--neox-fg-primary)', fontSize: 13,
    cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1, textAlign: 'left',
  };
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {/* busy / note (魔杖左侧内联, 不另起一行) */}
      {(busy || note) && (
        <span style={{ fontSize: 11.5, color: busy ? 'var(--neox-fg-secondary)' : 'var(--neox-warn, #d97706)', display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: 150 }}>
          {busy && <span className="neox-spin" style={{ width: 10, height: 10, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />}
          <span className={busy ? 'neox-text-shimmer' : undefined} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{busy ? `${zh ? '正在' : ''}${busy}…` : note}</span>
        </span>
      )}
      <button type="button" disabled={!!busy} onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        title={zh ? '能力 (对上传的图片: 去背景 / 去水印 / 放大 / 换装 …)' : 'Tools'}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, borderRadius: 7, border: 'none', background: menuOpen ? 'var(--neox-bg-hover, rgba(0,0,0,0.06))' : 'transparent', cursor: busy ? 'default' : 'pointer', color: menuOpen ? 'var(--neox-primary-500, #3b82f6)' : 'var(--neox-fg-secondary)', opacity: busy ? 0.5 : 1, transition: 'color .15s, background .15s' }}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5" /></svg>
      </button>
      {menuOpen && (
        <div onClick={(e) => e.stopPropagation()}
          style={{ position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, zIndex: 60, minWidth: 176, background: 'var(--neox-bg-card, #fff)', border: '1px solid var(--neox-line, rgba(0,0,0,0.1))', borderRadius: 12, boxShadow: '0 12px 34px rgba(0,0,0,0.2)', padding: 5 }}>
          <button type="button" style={menuItem} disabled={!!busy} onClick={() => { setMenuOpen(false); runCutout(); }} title={zh ? '抠掉背景 → 透明 PNG' : 'Cutout'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v12a3 3 0 003 3h12" /><path d="M18 21V9a3 3 0 00-3-3H3" /></svg>{zh ? '去背景' : 'Cutout'}
          </button>
          {listImageTemplates({ mode: 'edit' }).map((cap) => (
            <button key={cap.id} type="button" style={menuItem} disabled={!!busy} onClick={() => { setMenuOpen(false); void runCap(cap); }} title={cap.desc}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={cap.iconPath ?? 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1'} /></svg>{cap.name}
            </button>
          ))}
        </div>
      )}
      <input ref={garmentRef} type="file" accept="image/*" hidden onChange={onGarment} />
    </div>
  );
};

export default ImageToImageBar;
