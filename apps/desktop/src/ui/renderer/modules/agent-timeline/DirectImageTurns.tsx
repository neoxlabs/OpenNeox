
import React, { useEffect, useRef, useState } from 'react';
import {
  DIRECT_IMAGE_TURN_EVENT,
  type DirectImageTurnEvent,
} from '../../services/imageDirectClient';
import { ImageCompareGrid, type CompareImage } from '../image-studio/ImageCompareGrid';
import { dispatchOpFailed } from '../../components/notifyEvents';
import { trackImage } from '../../services/imageTelemetry';
import { defaultIsZh } from '../../hooks/useI18n';
import { LiveShimmerText } from './components/LiveShimmerText';
import brandRing from '../../media/clay/brand-ring.webp';

interface Props {
  /** 当前 sessionId. 变了就清空 (换会话不带图). */
  sessionId?: string;
  zh?: boolean;
  studio?: boolean;
}

/* 全局单例 store — key = sessionId, value = 该会话的 turn 列表. */
const store: Record<string, DirectImageTurnEvent[]> = {};
/* 每个 session 槽的订阅者 (挂载中的 DirectImageTurns 实例) — store 变了通知它们重渲染. */
const subscribers: Record<string, Set<() => void>> = {};

function notifySlot(sid: string): void {
  subscribers[sid]?.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
}

function routeTurnToStore(payload: DirectImageTurnEvent): void {
  const sid = payload.sessionId || '__default';
  const paths = payload.status === 'ok' ? (payload.result?.paths ?? []).filter(Boolean) : [];
  /* 同图去重: IPC bridge 与 composer 可能各发一条 — 合并到已有 turn, 不堆双卡. */
  if (paths.length > 0) {
    for (const [otherSid, otherList] of Object.entries(store)) {
      const hit = otherList.findIndex((t) => t.result?.paths?.some((p) => paths.includes(p)));
      if (hit >= 0) {
        const existing = otherList[hit]!;
        const merged: DirectImageTurnEvent = {
          ...existing,
          ...payload,
          turnId: existing.turnId,
          sessionId: otherSid,
          prompt: existing.prompt || payload.prompt,
          chipLabel: existing.chipLabel || payload.chipLabel,
          createdAt: existing.createdAt || payload.createdAt,
        };
        const next = otherList.slice();
        next[hit] = merged;
        store[otherSid] = next;
        notifySlot(otherSid);
        const api = (window as any).neox;
        if (api?.imageSaveTurn) {
          const { refImages: _drop, ...persistable } = merged;
          void api.imageSaveTurn({
            sessionId: otherSid, turnId: merged.turnId,
            payload: JSON.stringify(persistable), createdAt: merged.createdAt || Date.now(),
          }).catch(() => { /* noop */ });
        }
        return;
      }
    }
  }
  const list = (store[sid] ?? []).slice();
  const idx = list.findIndex((t) => t.turnId === payload.turnId);
  if (idx >= 0) list[idx] = payload; else list.push(payload);
  store[sid] = list;
  notifySlot(sid);
  /* 只持久化最终态 (ok/error) — pending 是瞬态, 存了重启会卡"正在生成".
   * refImages 是 base64 dataURL, 单张常几 MB, 落盘撑爆 SQLite → 剥掉再存 (只本次会话内存里显). */
  if (payload.status === 'ok' || payload.status === 'error') {
    const api = (window as any).neox;
    if (api?.imageSaveTurn) {
      const { refImages: _drop, ...persistable } = payload;
      void api.imageSaveTurn({
        sessionId: sid, turnId: payload.turnId,
        payload: JSON.stringify(persistable), createdAt: payload.createdAt || Date.now(),
      }).catch(() => { /* noop */ });
    }
  }
}

/* 全局监听器只装一次 (模块载入即装), 独立于任何组件生命周期 —— 这样出图事件永远有人接. */
let globalTurnListenerInstalled = false;
function ensureGlobalTurnListener(): void {
  if (globalTurnListenerInstalled || typeof window === 'undefined') return;
  globalTurnListenerInstalled = true;
  window.addEventListener(DIRECT_IMAGE_TURN_EVENT, (evt: Event) => {
    const payload = (evt as CustomEvent<DirectImageTurnEvent>).detail;
    if (payload) routeTurnToStore(payload);
  });
  /* IPC 成功落盘广播 → 补 timeline 卡. composer 路径已 emit 同 path 会去重;
   *  裸调 imageDirectGenerate / 竞态丢 turn 时, 用户仍能在图片页看到刚出的图 (不只图库). */
  const api = (window as any).neox;
  if (typeof api?.onImageGenerated === 'function') {
    api.onImageGenerated((data: {
      prompt?: string;
      paths?: string[];
      fileUrls?: string[];
      count?: number;
      mode?: string;
      providerLabel?: string;
      /** 档位 —— 有值就说明是档位选路出来的, 前台显档位名而不是供应商名 */
      tier?: 'standard' | 'advanced';
      model?: string;
      size?: string;
      latencyMs?: number;
      createdAt?: number;
      revisedPrompt?: string;
    }) => {
      const paths = Array.isArray(data?.paths) ? data.paths.filter(Boolean) : [];
      if (paths.length === 0) return;
      for (const list of Object.values(store)) {
        if (list.some((t) => t.result?.paths?.some((p) => paths.includes(p)))) return;
      }
      const sid =
        (window as { __neoxActiveImageSessionId?: string }).__neoxActiveImageSessionId
        || 'image-studio';
      const createdAt = data.createdAt || Date.now();
      /* 走 CustomEvent → 全局 listener → routeTurnToStore (单路径, 顺带驱动 hasContent). */
      window.dispatchEvent(new CustomEvent(DIRECT_IMAGE_TURN_EVENT, {
        detail: {
          sessionId: sid,
          turnId: `img-bridge-${createdAt}-${Math.random().toString(36).slice(2, 7)}`,
          prompt: data.prompt || '',
          chipLabel: '创建图片',
          createdAt,
          status: 'ok',
          result: {
            ok: true,
            paths,
            fileUrls: Array.isArray(data.fileUrls) ? data.fileUrls : [],
            count: data.count ?? paths.length,
            mode: data.mode,
            providerLabel: data.providerLabel,
            tier: data.tier,
            model: data.model,
            size: data.size,
            latencyMs: data.latencyMs,
            createdAt,
            revisedPrompt: data.revisedPrompt,
          },
        } satisfies DirectImageTurnEvent,
      }));
      window.dispatchEvent(new CustomEvent('neox:image-gallery-refresh'));
    });
  }
}
ensureGlobalTurnListener();

/** 供 App 启动时主动安装全局 bridge (不必等 ImageStudio / Timeline 挂载). */
export function installDirectImageTurnBridge(): void {
  ensureGlobalTurnListener();
}

function evictRefImagesExcept(activeSid: string): void {
  for (const [sid, list] of Object.entries(store)) {
    if (sid === activeSid) continue;
    if (!list.some((t) => t.status !== 'pending' && Array.isArray(t.refImages) && t.refImages.length > 0)) continue;
    store[sid] = list.map((t) =>
      t.status !== 'pending' && Array.isArray(t.refImages) && t.refImages.length > 0
        ? { ...t, refImages: undefined }
        : t
    );
  }
}

/** 某会话本轮内存里已有多少出图 turn (给"点图片新建会话但别堆空会话"判据用). */
export function directImageTurnCount(sessionId?: string): number {
  return sessionId ? (store[sessionId]?.length ?? 0) : 0;
}

export function clearDirectImageTurns(sessionId: string): void {
  if (!sessionId) return;
  if (store[sessionId]?.length) {
    store[sessionId] = [];
    notifySlot(sessionId);
  } else {
    store[sessionId] = [];
  }
  const api = (window as unknown as { neox?: { imageDeleteTurns?: (sid: string) => Promise<unknown> } }).neox;
  void api?.imageDeleteTurns?.(sessionId)?.catch?.(() => { /* 清不掉不阻塞开新画布 */ });
}

const fmtTime = (ts: number, zh: boolean) =>
  new Date(ts).toLocaleTimeString(zh ? 'zh-CN' : undefined, { hour: '2-digit', minute: '2-digit' });

/* 统一把上游各种原始报错 → 人话 + 可行动建议. 归成有限几类, 用户友好不露技术栈.
 *   兜底: 认不出的错也砍掉技术前缀, 取 JSON message, 保底给"请重试". */
function cleanError(raw: string | undefined, zh: boolean): { title: string; hint?: string } {
  const R = (raw || '').toLowerCase();
  const has = (...ks: string[]) => ks.some(k => R.includes(k));

  // 成功调用但没解析到图 (返回格式差异 / 空 data)
  if (has('no images', 'returned no image', 'has neither'))
    return zh
      ? { title: '这次没拿到图片', hint: '服务返回格式可能不同,换个图片模型或稍后重试' }
      : { title: 'No image came back', hint: 'Try another image model or retry' };
  // 余额 / 计费
  if (has('402', 'insufficient', 'balance', 'quota', 'exceeded', 'credit'))
    return zh ? { title: '余额或额度不足', hint: '去设置里给该服务充值,或换一个服务' } : { title: 'Insufficient balance', hint: 'Top up or switch provider' };
  // 密钥 / 鉴权
  if (has('401', '403', 'unauthorized', 'invalid api key', 'api key', 'forbidden'))
    return zh ? { title: '密钥无效或无权限', hint: '到设置 · 服务商 检查 API Key' } : { title: 'Invalid key', hint: 'Check API Key in Settings' };
  // 内容安全
  if (has('content policy', 'safety', 'moderation', 'nsfw', 'flagged', 'rejected by'))
    return zh ? { title: '内容被安全策略拦截', hint: '换个说法或去掉敏感元素再试' } : { title: 'Blocked by safety policy', hint: 'Rephrase and retry' };
  // 网络 / 代理 / 超时
  if (has('timeout', 'timed out', 'econn', 'network', 'fetch failed', 'socket', 'enotfound', 'proxy', '下载出图失败'))
    return zh ? { title: '网络连接不稳定', hint: '检查网络或代理后重试' } : { title: 'Network issue', hint: 'Check connection and retry' };
  // 模型 / 参数不支持
  if (has('model_not_found', 'not found', 'unsupported', 'does not exist', 'invalid model'))
    return zh ? { title: '这个模型不可用', hint: '在右下角换一个图片模型' } : { title: 'Model unavailable', hint: 'Pick another image model' };
  // 400 泛化 (prompt/图片格式)
  if (has('400', 'bad request', 'invalid'))
    return zh ? { title: '请求被拒绝', hint: '可能是图片格式或描述有问题,换一张/改说法' } : { title: 'Request rejected', hint: 'Check image format or prompt' };

  // 兜底: 取 JSON message / 砍技术前缀
  const m = (raw || '').match(/"message"\s*:\s*"([^"]+)"/);
  const cleaned = m?.[1] || (raw || '').replace(/^BYOK image \S+ failed:\s*\d*\s*/i, '').trim();
  return { title: cleaned || (zh ? '生成失败,请重试' : 'Generation failed') };
}

export const DirectImageTurns: React.FC<Props> = ({ sessionId = '__default', zh = defaultIsZh(), studio }) => {
  const [turns, setTurns] = useState<DirectImageTurnEvent[]>(store[sessionId] ?? []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /* 抽卡对比挑图 — 正在对比的 turn (多图才有入口). */
  const [comparing, setComparing] = useState<DirectImageTurnEvent | null>(null);

  useEffect(() => {
    ensureGlobalTurnListener();
    evictRefImagesExcept(sessionId);
    let alive = true;
    /* 订阅本 session 槽: store 一变 (含用户切走时全局路由写进来的完成 turn) 就同步到本地 state. */
    const update = () => { if (alive) setTurns((store[sessionId] ?? []).slice()); };
    update();
    (subscribers[sessionId] ??= new Set()).add(update);
    /* Phase A: 从 DB 恢复该 session 已完成的出图 turn (重启/切会话后仍在). 只在内存无缓存时拉,
     * 避免覆盖当前 session 里刚 emit 的 pending. */
    if (!store[sessionId] || store[sessionId].length === 0) {
      const api = (window as any).neox;
      if (api?.imageListTurns) {
        void api.imageListTurns(sessionId).then((rows: Array<{ payload: string }>) => {
          if (!alive || !Array.isArray(rows) || rows.length === 0) return;
          const loaded: DirectImageTurnEvent[] = [];
          for (const r of rows) {
            try { loaded.push(JSON.parse(r.payload)); } catch { /* skip 坏行 */ }
          }
          /* 合并: DB 加载的做基底, 已在内存的 (pending/新事件) 覆盖同 turnId. */
          const byId = new Map(loaded.map(t => [t.turnId, t]));
          for (const t of (store[sessionId] ?? [])) byId.set(t.turnId, t);
          store[sessionId] = Array.from(byId.values()).sort((a, b) => a.createdAt - b.createdAt);
          update();
        }).catch(() => { /* noop */ });
      }
    }
    return () => {
      alive = false;
      subscribers[sessionId]?.delete(update);
    };
  }, [sessionId]);

  /* 新 turn 落地时滚到底 (只在本组件挂载时生效, 纯 UI 便利, 不影响数据). */
  useEffect(() => {
    if (turns.length > 0) requestAnimationFrame(() => scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  }, [turns.length]);

  if (turns.length === 0) return null;

  const handleDownload = async (fileUrl: string, path?: string) => {
    try {
      const resp = await fetch(fileUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = path?.split('/').pop() || `neox-image-${Date.now()}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err: any) {
      dispatchOpFailed({ op: zh ? '下载图片' : 'Download image', message: err?.message || String(err) });
    }
  };

  const handleCopyImage = async (fileUrl: string) => {
    try {
      const resp = await fetch(fileUrl);
      const blob = await resp.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch (err) {
      console.warn('[direct-image] copy failed', err);
    }
  };

  /* 抽卡收敛: 只保留选中那张, 其余删文件 + turn 收窄成单图 (routeTurnToStore 会重新持久化). */
  const compareImages: CompareImage[] = comparing?.result
    ? comparing.result.fileUrls.map((url, i) => ({ url, path: comparing.result!.paths[i] || '' }))
    : [];
  const handleKeepOne = async (keepIdx: number) => {
    const turn = comparing;
    setComparing(null);
    if (!turn?.result) return;
    const r = turn.result;
    const api = (window as any).neox;
    for (let i = 0; i < r.paths.length; i++) {
      if (i === keepIdx || !r.paths[i]) continue;
      try { await api?.imageDeleteFile?.(r.paths[i]); } catch { /* 删不掉也不阻塞收敛 */ }
    }
    routeTurnToStore({
      ...turn,
      result: { ...r, paths: [r.paths[keepIdx]!], fileUrls: [r.fileUrls[keepIdx]!], count: 1 },
    });
    trackImage('compare_keep_one', { total: r.paths.length }, r.mode);
  };
  const handleEditOne = (img: CompareImage) => {
    setComparing(null);
    window.dispatchEvent(new CustomEvent('neox:image-lightbox', { detail: { url: img.url, path: img.path, filename: img.path.split('/').pop() ?? '', mtime: Date.now() } }));
  };

  return (
    <div className={`atl-imgturns${studio ? ' is-studio' : ''}`}>
      {turns.map((turn, ti) => (
        <React.Fragment key={turn.turnId}>
          {studio ? (
            <div className="imgchat-user">
              <div className="imgchat-user__bubble">
                {Array.isArray(turn.refImages) && turn.refImages.length > 0 && (
                  <div className="imgchat-user__refs">
                    {turn.refImages.map((src, i) => <img key={i} src={src} alt={zh ? `参考图 ${i + 1}` : `ref ${i + 1}`} />)}
                  </div>
                )}
                {turn.prompt}
              </div>
            </div>
          ) : (
          /* 用户描述 —— 复用主 timeline 用户消息样式 */
          <div className="atl-msg is-user">
            <span className="atl-msg__rail" aria-hidden="true" />
            <div className="atl-msg__body">
              <div className="atl-msg__meta">
                <span className="atl-msg__role">{zh ? '你' : 'You'}</span>
                {turn.chipLabel && <span className="atl-imgturn__chip">{turn.chipLabel}</span>}
                <span className="atl-msg__time">{fmtTime(turn.createdAt, zh)}</span>
              </div>
              <div className="atl-msg__text atl-msg__text--user"><div>{turn.prompt}</div></div>
              {Array.isArray(turn.refImages) && turn.refImages.length > 0 && (
                <div className="atl-imgturn__refs" title={zh ? `带了 ${turn.refImages.length} 张参考图` : `${turn.refImages.length} reference image(s)`}>
                  {turn.refImages.map((src, i) => (
                    <img key={i} className="atl-imgturn__ref" src={src} alt={zh ? `参考图 ${i + 1}` : `ref ${i + 1}`} />
                  ))}
                </div>
              )}
            </div>
          </div>
          )}

          {/* 出图结果 —— 复用主 timeline assistant 消息样式 */}
          <div className={`atl-msg is-assistant${turn.status === 'pending' ? ' is-streaming' : ''}`}>
            {studio
              ? <img className="imgchat-avatar" src={brandRing} alt="" aria-hidden="true" draggable={false} />
              : <span className="atl-msg__rail" aria-hidden="true" />}
            <div className="atl-msg__body">
              {!studio && (
                <div className="atl-msg__meta">
                  <span className="atl-msg__time">{fmtTime(turn.createdAt, zh)}</span>
                  {turn.status === 'pending' && <span className="atl-msg__dot" aria-label="generating" />}
                </div>
              )}

              {turn.status === 'pending' && (
                <div className="atl-imgturn__skeleton">
                  {turn.partialUrl ? (
                    <img className="atl-imgturn__partial" src={turn.partialUrl} alt={turn.prompt} />
                  ) : (
                    <div className="atl-imgturn__shimmer" />
                  )}
                  <div className="atl-imgturn__badge">
                    <LiveShimmerText
                      live
                      text={turn.partialUrl ? (zh ? '正在成形…' : 'Rendering…') : (zh ? '正在生成…' : 'Generating…')}
                    />
                  </div>
                </div>
              )}

              {turn.status === 'error' && (() => {
                const e = cleanError(turn.result?.error, zh);
                return (
                  <div className="atl-imgturn__error">
                    <svg className="atl-imgturn__error-ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
                    <div className="atl-imgturn__error-body">
                      <span className="atl-imgturn__error-title">{e.title}</span>
                      {e.hint && <span className="atl-imgturn__error-hint">{e.hint}</span>}
                    </div>
                    <button type="button" className="atl-imgturn__error-retry"
                      title={zh ? '重试' : 'Retry'}
                      onClick={() => window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: turn.prompt, send: true } }))}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
                      {zh ? '重试' : 'Retry'}
                    </button>
                  </div>
                );
              })()}

              {turn.status === 'ok' && turn.result && (() => {
                const r = turn.result;
                const n = r.fileUrls.length;
                const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3;
                return (
                  <>
                    <div className="atl-imgturn__grid" style={{ gridTemplateColumns: studio
                      /* 图片页: 一排最多 3 张, 每张 ≤ 300 (设计稿), 单张不再撑到 420 */
                      ? `repeat(${Math.min(n, 3)}, minmax(0, 300px))`
                      : `repeat(${cols}, minmax(0, ${n <= 1 ? 420 : cols === 2 ? 260 : 200}px))` }}>
                      {r.fileUrls.map((url, i) => (
                        <ResultImageCard
                          key={i}
                          url={url}
                          alt={turn.prompt}
                          index={n > 1 && !studio ? i + 1 : undefined}
                          zh={zh}
                          studio={studio}
                          onZoom={() => window.dispatchEvent(new CustomEvent('neox:image-lightbox', { detail: { url, filename: r.paths[i]?.split('/').pop() ?? '', mtime: r.createdAt ?? turn.createdAt } }))}
                          onOpen={() => window.dispatchEvent(new CustomEvent('neox:image-lightbox', { detail: { url, path: r.paths[i], filename: r.paths[i]?.split('/').pop() ?? '', mtime: r.createdAt ?? turn.createdAt } }))}
                          onEdit={() => window.dispatchEvent(new CustomEvent('neox:image-lightbox', { detail: { url, path: r.paths[i], filename: r.paths[i]?.split('/').pop() ?? '', mtime: r.createdAt ?? turn.createdAt } }))}
                          /* 以这张图继续: 加进 composer 图片附件 (累加), 接着去背景/换装/放大… 不进模态编辑器. */
                          onContinue={() => window.dispatchEvent(new CustomEvent('neox:image-attach', { detail: { path: r.paths[i], url, name: r.paths[i]?.split('/').pop() ?? '' } }))}
                          onDownload={() => handleDownload(url, r.paths[i])}
                          onCopy={() => handleCopyImage(url)}
                        />
                      ))}
                    </div>
                    <div className="atl-imgturn__footer">
                      {(() => {
                        const parts: string[] = [];
                        if (studio) {
                          /* 第几版 = 这是第几次出成的图 (第一版不写) */
                          const ver = turns.slice(0, ti + 1).filter((t) => t.status === 'ok').length;
                          if (ver > 1) parts.push(zh ? `第 ${ver} 版` : `v${ver}`);
                        }
                        if (r.model) parts.push(r.model);
                        if (r.size) parts.push(r.size);
                        if (studio && n > 1) parts.push(zh ? `${n} 张` : `${n} images`);
                        if (r.latencyMs !== undefined) parts.push(studio && zh ? `${Math.round(r.latencyMs / 1000)} 秒` : `${(r.latencyMs / 1000).toFixed(1)}s`);
                        const tail = r.tier
                          ? (r.tier === 'advanced' ? (zh ? '高级' : 'Advanced') : (zh ? '普通' : 'Standard'))
                          : (r.mode === 'neoxcloud' ? 'Neox' : null);
                        if (tail) parts.push(tail);
                        return parts.length > 0 ? <span className="atl-imgturn__meta">{parts.join(' · ')}</span> : <span />;
                      })()}
                      {/* 并排挑图 —— 多图 turn 的收敛入口 (选一张, 其余删) */}
                      {n > 1 && (
                        <button type="button" className="atl-imgturn__reroll"
                          onClick={() => setComparing(turn)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="18" rx="1.5" /><rect x="14" y="3" width="7" height="18" rx="1.5" /></svg>
                          {zh ? '并排挑图' : 'Compare'}
                        </button>
                      )}
                      {/* 换一批 —— 同 prompt 重出 (抽卡不满意再摇一版), 走 composer-fill send */}
                      <button type="button" className="atl-imgturn__reroll"
                        onClick={() => window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: turn.prompt, send: true } }))}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
                        {zh ? '换一批' : 'Reroll'}
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        </React.Fragment>
      ))}
      <div ref={scrollRef} />
      <ImageCompareGrid open={!!comparing} images={compareImages} zh={zh}
        onClose={() => setComparing(null)} onKeepOne={(i) => void handleKeepOne(i)} onEditOne={handleEditOne} />
    </div>
  );
};

/* 结果图卡 — hover 显悬浮操作按钮 (改图/下载/复制), 点图开大图预览. */
const ResultImageCard: React.FC<{
  url: string; alt: string; index?: number; zh?: boolean;
  onOpen: () => void; onEdit: () => void; onDownload: () => void; onCopy: () => void; onContinue?: () => void;
  studio?: boolean; onZoom?: () => void;
}> = ({ url, alt, index, zh = defaultIsZh(), onOpen, onEdit, onDownload, onCopy, onContinue, studio, onZoom }) => {
  const [hover, setHover] = useState(false);
  const iconBtn = (title: string, onClick: () => void, node: React.ReactNode): React.ReactNode => (
    <button type="button" className="atl-imgturn__act" title={title} onClick={(e) => { e.stopPropagation(); onClick(); }}>{node}</button>
  );
  if (studio) {
    /* 图片页: 悬停出一排文字按钮 (设计稿), 点图本身 = 改这张 */
    const pill = (label: string, onClick: () => void, cls = '') => (
      <button type="button" className={`imgchat-act${cls}`} onClick={(e) => { e.stopPropagation(); onClick(); }}>{label}</button>
    );
    return (
      <div className="atl-imgturn__card imgchat-card" onClick={onEdit}>
        <img src={url} alt={alt} />
        <div className="imgchat-card__acts">
          {pill(zh ? '改这张' : 'Edit', onEdit)}
          {onZoom && pill(zh ? '放大' : 'Zoom', onZoom)}
          {onContinue && pill(zh ? '当参考图' : 'Use as ref', onContinue)}
          {pill(zh ? '下载' : 'Download', onDownload, ' is-end')}
        </div>
      </div>
    );
  }
  return (
    <div
      className="atl-imgturn__card"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onOpen}
    >
      <img src={url} alt={alt} />
      {index !== undefined && <span className="atl-imgturn__idx">#{index}</span>}
      <div className="atl-imgturn__actions" style={{ opacity: hover ? 1 : 0, pointerEvents: hover ? 'auto' : 'none' }}>
        {onContinue && iconBtn(zh ? '以这张图继续 (去背景/换装/放大…)' : 'Continue from this', onContinue, (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 3v4h4" /></svg>
        ))}
        {iconBtn(zh ? '改图' : 'Edit', onEdit, (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        ))}
        {iconBtn(zh ? '下载' : 'Download', onDownload, (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 21h14" /></svg>
        ))}
        {iconBtn(zh ? '复制' : 'Copy', onCopy, (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
        ))}
      </div>
    </div>
  );
};

export default DirectImageTurns;
