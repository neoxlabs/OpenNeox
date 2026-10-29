
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { setImageParam } from '../../state/imageGenParams';
import { useImageTemplatesRaw, deleteImageTemplate, type ImageTemplate } from '../../state/imageTemplates';
import { defaultIsZh } from '../../hooks/useI18n';

/* 模板 → 预设画幅 (隐藏复杂: 点模板自动套该场景的比例, 用户不碰参数).
 *   aspect/res 给 gpt-image 系 (buildRequestParams 算 size); size 给 legacy 模型直用. */
interface Preset { aspect: '1:1' | '2:3' | '3:2'; size: string; }
const V: Preset = { aspect: '2:3', size: '1024x1536' };   // 竖
const H: Preset = { aspect: '3:2', size: '1536x1024' };   // 横
const S: Preset = { aspect: '1:1', size: '1024x1024' };   // 方
const PRESET: Record<string, Preset> = {
  portrait: V, wedding: V, figure: V, idphoto: V, xiaohongshu: V,
  landscape: H, architecture: H,
  explainer: S, tutorial: S, design: S, ecommerce: S, avatar: S, food: S, logo: S,
};

/** 套该模板的预设画幅 + 高质量, 再把结构化 prompt 填进 composer. 发现墙 + 灵感滚动条共用. */
export function fillFromCategory(c: ShowcaseCategory): void {
  const preset = PRESET[c.key];
  if (preset) {
    setImageParam('aspect', preset.aspect);
    setImageParam('resolution', '1K');
    setImageParam('size', preset.size);
  }
  setImageParam('quality', 'high');
  window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: c.prompt, focus: true } }));
}

/** 顶部筛选组. */
type GroupKey = 'all' | 'people' | 'goods' | 'content' | 'design' | 'scene';
const GROUPS: Array<{ key: GroupKey; zh: string; en: string }> = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'people', zh: '人像', en: 'People' },
  { key: 'goods', zh: '商品', en: 'Product' },
  { key: 'content', zh: '内容创作', en: 'Content' },
  { key: 'design', zh: '设计', en: 'Design' },
  { key: 'scene', zh: '风景建筑', en: 'Scene' },
];

export interface ShowcaseCategory {
  key: string;
  labelZh: string;
  labelEn: string;
  emoji: string;
  /** 归属筛选组. */
  group: Exclude<GroupKey, 'all'>;
  /** 结构化英文 prompt 模板 — 点卡片填进输入框. */
  prompt: string;
  /** 渐变占位色 (无真图时). */
  gradient: string;
  /** 风格 tag pills (详情卡美化用). */
  tags: string[];
}

export const CATEGORIES: ShowcaseCategory[] = [
  { key: 'portrait', labelZh: '人物', labelEn: 'Portrait', group: 'people', emoji: '🧑‍🎤', gradient: 'linear-gradient(135deg,#fda085,#f6d365)', tags: ['人像', '电影感', '浅景深', '85mm', '杂志风'], prompt: 'Cinematic portrait of a young woman, soft window light, shallow depth of field, natural skin texture, 85mm, editorial fashion photography' },
  { key: 'idphoto', labelZh: '证件照', labelEn: 'ID Photo', group: 'people', emoji: '🪪', gradient: 'linear-gradient(135deg,#4facfe,#00f2fe)', tags: ['证件照', '白底', '正装', '均匀布光', '免冠'], prompt: 'Professional ID / passport photo, person facing camera with neutral expression, plain solid white background, even soft studio lighting, formal business attire, sharp focus, head and shoulders' },
  { key: 'avatar', labelZh: '头像', labelEn: 'Avatar', group: 'people', emoji: '😎', gradient: 'linear-gradient(135deg,#f6d365,#fda085)', tags: ['头像', '插画风', '纯色底', '居中', '社媒'], prompt: 'Stylized profile avatar illustration, friendly character bust centered, clean solid color background, vibrant flat shading, social media avatar, crisp' },
  { key: 'wedding', labelZh: '婚纱照', labelEn: 'Wedding', group: 'people', emoji: '💍', gradient: 'linear-gradient(135deg,#ffdde1,#ee9ca7)', tags: ['婚纱', '逆光', '胶片感', '浪漫', '暖调'], prompt: 'Romantic wedding photograph, couple in elegant attire, dreamy backlight, soft bokeh garden, film aesthetic, timeless and warm' },
  { key: 'ecommerce', labelZh: '电商主图', labelEn: 'E-commerce', group: 'goods', emoji: '🛍️', gradient: 'linear-gradient(135deg,#e0eafc,#cfdef3)', tags: ['电商', '白底', '主图', '柔光箱', '倒影'], prompt: 'E-commerce product hero shot, the product centered on a clean seamless white background, soft studio softbox lighting, subtle floor reflection, crisp detail, marketplace listing ready' },
  { key: 'food', labelZh: '美食', labelEn: 'Food', group: 'goods', emoji: '🍜', gradient: 'linear-gradient(135deg,#ffecd2,#fcb69f)', tags: ['美食', '侧光', '热气', '浅景深', '杂志'], prompt: 'Appetizing food photography, a delicious dish on a rustic wooden table, natural side light, rising steam, shallow depth of field, top gastronomy magazine style' },
  { key: 'figure', labelZh: '手办', labelEn: 'Figure', group: 'goods', emoji: '🎎', gradient: 'linear-gradient(135deg,#f093fb,#f5576c)', tags: ['手办', 'PVC', '产品图', '高细节', '动态姿势'], prompt: 'Collectible anime figure product shot, glossy PVC, dynamic pose on a display base, studio lighting, high detail, packaging-ready' },
  { key: 'xiaohongshu', labelZh: '小红书封面', labelEn: 'RedNote Cover', group: 'content', emoji: '📔', gradient: 'linear-gradient(135deg,#ff9a9e,#fecfef)', tags: ['小红书', '封面', '平铺', '暖调', '标题区'], prompt: 'Xiaohongshu / RedNote cover image, aesthetic lifestyle flat-lay, warm cozy tones, bold title text area at the top, trendy minimal composition, instagram-worthy' },
  { key: 'explainer', labelZh: '解说', labelEn: 'Explainer', group: 'content', emoji: '📊', gradient: 'linear-gradient(135deg,#84fab0,#8fd3f4)', tags: ['信息图', '扁平矢量', '图解', '科普', '留白'], prompt: 'Clean infographic-style illustration explaining a concept, flat vector, labeled diagram, soft pastel palette, plenty of white space' },
  { key: 'tutorial', labelZh: '教程', labelEn: 'Tutorial', group: 'content', emoji: '📐', gradient: 'linear-gradient(135deg,#a1c4fd,#c2e9fb)', tags: ['教程', '分步', '等距', '说明图', '圆润'], prompt: 'Step-by-step tutorial illustration, numbered panels, isometric objects, friendly rounded style, instructional layout' },
  { key: 'design', labelZh: '海报设计', labelEn: 'Poster', group: 'design', emoji: '🎨', gradient: 'linear-gradient(135deg,#fbc2eb,#a6c1ee)', tags: ['海报', '排版', '几何', '双色调', '获奖级'], prompt: 'Modern brand poster design, bold typography, geometric shapes, vibrant duotone, editorial layout, award-winning graphic design' },
  { key: 'logo', labelZh: '标志', labelEn: 'Logo', group: 'design', emoji: '🔷', gradient: 'linear-gradient(135deg,#c9d6ff,#e2e2e2)', tags: ['Logo', '矢量', '极简', '几何', '品牌'], prompt: 'Minimal vector logo design, simple memorable geometric mark, flat, balanced, on a plain white background, brand identity, professional' },
  { key: 'landscape', labelZh: '风景', labelEn: 'Landscape', group: 'scene', emoji: '🏞️', gradient: 'linear-gradient(135deg,#43cea2,#185a9d)', tags: ['风光', '黄金时刻', '广角', 'HDR', '大气'], prompt: 'Epic mountain landscape at golden hour, dramatic clouds, mist in the valley, ultra-wide, high dynamic range, national geographic style' },
  { key: 'architecture', labelZh: '建筑', labelEn: 'Architecture', group: 'scene', emoji: '🏛️', gradient: 'linear-gradient(135deg,#c9d6ff,#e2e2e2)', tags: ['建筑', '极简', '蓝调时刻', '对称', '玻璃幕墙'], prompt: 'Modern minimalist architecture, concrete and glass, clean lines, blue hour, symmetrical composition, architectural photography' },
];

interface Props { zh?: boolean; }

export const ImageDiscoveryLanding: React.FC<Props> = ({ zh = defaultIsZh() }) => {
  /* 真 showcase 图 (后台预生成, key→fileUrl). 没有就占位. */
  const [showcase, setShowcase] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const api = (window as any).neox;
    if (api?.imageShowcase) {
      void api.imageShowcase().then((m: Record<string, string>) => { if (alive && m) setShowcase(m); }).catch(() => { /* noop */ });
    }
    return () => { alive = false; };
  }, []);

  const [preview, setPreview] = useState<ShowcaseCategory | null>(null);
  const [imgDim, setImgDim] = useState<string>('');
  const [group, setGroup] = useState<GroupKey>('all');
  const userTemplates = useImageTemplatesRaw().filter(t => t.mode === 'generate');
  /* 应用一个用户自建模板: 恢复它的参数 + 把 prompt 填进输入框. */
  const applyTemplate = (t: ImageTemplate) => {
    try {
      for (const [k, v] of Object.entries(t.params || {})) setImageParam(k, v as any);
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('neox:composer-fill', { detail: { text: t.prompt, focus: true } }));
  };
  const pick = (c: ShowcaseCategory) => {
    fillFromCategory(c);
    setPreview(null);
  };
  const visible = group === 'all' ? CATEGORIES : CATEGORIES.filter(c => c.group === group);
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);

  return (
    // 宽度不设上限, 交给外层容器 (图片页统一列宽=输入框宽), 素材卡跟输入框等宽且左右对齐
    <div style={{ width: '100%', margin: '0 auto', padding: '8px 0 24px' }}>
      {/* 我的模板 —— 用户在 composer "存为模板" 存的, 一键复用 (prompt + 参数). */}
      {userTemplates.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--neox-fg-secondary, #9ca3af)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
            {zh ? '我的模板' : 'My templates'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {userTemplates.map(t => (
              <span key={t.id} className="neox-usertpl-chip"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, padding: '6px 8px 6px 12px', borderRadius: 999, cursor: 'pointer', border: '1px solid var(--neox-line, rgba(0,0,0,0.12))', background: 'var(--neox-bg-card, #fff)', color: 'var(--neox-fg-primary)' }}
                title={t.prompt} onClick={() => applyTemplate(t)}>
                {t.name}
                <button type="button" title={zh ? '删除' : 'Delete'}
                  onClick={(e) => { e.stopPropagation(); deleteImageTemplate(t.id); }}
                  style={{ width: 16, height: 16, borderRadius: '50%', border: 'none', cursor: 'pointer', background: 'transparent', color: 'var(--neox-fg-secondary, #9ca3af)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, lineHeight: 1 }}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--neox-fg-secondary, #9ca3af)', marginBottom: 12, textAlign: 'center' }}>
        {zh ? '试试这些方向 · 点一下自动填入描述' : 'Try a direction — click to prefill'}
      </div>
      {/* tag 筛选条 — 按场景组过滤模板. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 7, marginBottom: 16 }}>
        {GROUPS.map(g => {
          const active = group === g.key;
          return (
            <button key={g.key} type="button" onClick={() => setGroup(g.key)}
              style={{
                fontSize: 12.5, fontWeight: active ? 600 : 500, padding: '5px 13px', borderRadius: 999, cursor: 'pointer',
                border: active ? '1px solid transparent' : '1px solid var(--neox-line, rgba(0,0,0,0.1))',
                background: active ? 'linear-gradient(135deg,#3b82f6,#2563eb)' : 'transparent',
                color: active ? '#fff' : 'var(--neox-fg-secondary, #6b7280)',
                boxShadow: active ? '0 2px 8px rgba(37,99,235,0.28)' : 'none', transition: 'all 0.14s ease',
              }}>
              {zh ? g.zh : g.en}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        {visible.map(c => {
          const img = showcase[c.key];
          return (
            <button key={c.key} type="button" onClick={() => setPreview(c)}
              style={{ display: 'flex', flexDirection: 'column', gap: 6, border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
              <div style={{
                position: 'relative', aspectRatio: '3/4', borderRadius: 14, overflow: 'hidden',
                background: img ? '#00000008' : c.gradient,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'transform 0.16s ease',
              }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-3px) scale(1.01)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0) scale(1)'; }}>
                {img ? (
                  <img src={img} alt={c.labelZh} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span style={{ fontSize: 34, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.15))' }}>{c.emoji}</span>
                )}
                {/* 底部渐变 scrim — 让白底标签在任意图上都清晰 (Gemini 式) */}
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '42%', background: 'linear-gradient(to top, rgba(0,0,0,0.5), transparent)', pointerEvents: 'none' }} />
                <span style={{ position: 'absolute', left: 12, bottom: 10, fontSize: 13, fontWeight: 600, color: '#fff', letterSpacing: '0.01em' }}>
                  {zh ? c.labelZh : c.labelEn}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* 预览弹窗 — 左大图 + 右侧详情卡 (提示词 / 模型 / 用这个方向).
       *  z-index 8300: 需盖住宿主"灵感覆盖层"(8200), 但让位给 AppShell 切换幕布(8500). */}
      {preview && createPortal(
        <div onClick={() => setPreview(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 8300, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', maxWidth: '92vw', maxHeight: '82vh', background: 'var(--neox-bg-card, #fff)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.4)' }}>
            {/* 左: 大图 — 面板贴合图片本身尺寸, 无黑边 (竖图窄面板 / 横图宽面板). */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: showcase[preview.key] ? 'var(--neox-bg-subtle, #f4f4f5)' : preview.gradient, flexShrink: 0 }}>
              {showcase[preview.key]
                ? <img src={showcase[preview.key]} alt={preview.labelZh} onLoad={(e) => setImgDim(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} style={{ maxHeight: '82vh', maxWidth: '58vw', width: 'auto', height: 'auto', objectFit: 'contain', display: 'block' }} />
                : <span style={{ fontSize: 72, padding: 80 }}>{preview.emoji}</span>}
            </div>
            {/* 右: 详情卡 */}
            <div style={{ width: 360, flexShrink: 0, padding: 24, display: 'flex', flexDirection: 'column', gap: 18, overflowY: 'auto' }}>
              {/* 标题 + tag pills */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--neox-fg-primary)', letterSpacing: '-0.01em' }}>{zh ? preview.labelZh : preview.labelEn}</div>
                  <div style={{ fontSize: 12, color: 'var(--neox-fg-secondary, #9ca3af)', marginTop: 2 }}>{zh ? '示例方向 · 点下方一键出图' : 'Example direction'}</div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {preview.tags.map(t => (
                    <span key={t} style={{ fontSize: 11.5, fontWeight: 500, padding: '3px 9px', borderRadius: 999, background: 'rgba(37,99,235,0.08)', color: '#2563eb', border: '1px solid rgba(37,99,235,0.16)' }}>{t}</span>
                  ))}
                </div>
              </div>
              {/* 提示词 */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--neox-fg-secondary, #9ca3af)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{zh ? '提示词' : 'Prompt'}</div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--neox-fg-primary)', background: 'var(--neox-bg-subtle, rgba(0,0,0,0.04))', borderRadius: 10, padding: '10px 12px', whiteSpace: 'pre-wrap' }}>{preview.prompt}</div>
              </div>
              {/* 元信息: 模型 / 质量 / 分辨率 */}
              <div className="neox-text-shimmer" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 12, columnGap: 16 }}>
                {[
                  [zh ? '模型' : 'Model', 'openai/gpt-image-2'],
                  [zh ? '质量' : 'Quality', zh ? '高' : 'High'],
                  [zh ? '分辨率' : 'Resolution', imgDim || (zh ? '加载中…' : '…')],
                  [zh ? '格式' : 'Format', 'PNG'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--neox-fg-secondary, #9ca3af)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>{k}</div>
                    <div style={{ fontSize: 13, color: 'var(--neox-fg-primary)', fontWeight: 500 }}>{v}</div>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => pick(preview)}
                style={{ marginTop: 'auto', padding: '12px 16px', borderRadius: 11, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff', fontSize: 14, fontWeight: 600, boxShadow: '0 4px 14px rgba(37,99,235,0.35)' }}>
                {zh ? '用这个方向出图' : 'Use this direction'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default ImageDiscoveryLanding;
