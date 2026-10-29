/**
 * SeenImagesView — 模型看过的图 (读图片 / PDF 页 / 浏览器截图)。
 *
 * 这是客户端比 CLI 强的地方: agent 自己截图验证时, 用户要跟它看到同一张图, 而不是只看它
 * 转述「按钮是紫色的」。所以图直接摆出来 —— 一张就大图, 几张就一排缩略图, 点开是灯箱
 * (带复制 / 保存)。图在 ~/.neox/run/seen/, 宿主落的 (core seenImages.ts)。
 */
import React, { useState } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { assetUrl } from './ImageResultView';
import { Lightbox } from './attachments';

export interface SeenImage { path: string; label?: string }

export const SeenImagesView: React.FC<{ images: SeenImage[]; compact?: boolean }> = ({ images, compact }) => {
  const { isZh } = useI18n();
  const [open, setOpen] = useState<SeenImage | null>(null);
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const single = images.length === 1 && !compact;
  return (
    <div className={`atl-seen${single ? ' is-single' : ''}${compact ? ' is-compact' : ''}`}>
      {images.map((img, i) => {
        const name = img.label || img.path.split(/[\\/]/).pop() || '';
        if (missing[img.path]) {
          return (
            <div key={`${img.path}-${i}`} className="atl-seen__miss" title={img.path}>
              {isZh ? '这台电脑上看不到这张图' : 'Image not available on this computer'}{name ? ` · ${name}` : ''}
            </div>
          );
        }
        return (
          <button
            key={`${img.path}-${i}`}
            type="button"
            className="atl-seen__item"
            title={name}
            onClick={(e) => { e.stopPropagation(); setOpen(img); }}
          >
            <img
              src={assetUrl(img.path)}
              alt={name}
              loading="lazy"
              draggable={false}
              onError={() => setMissing((s) => ({ ...s, [img.path]: true }))}
            />
            {!compact && name && <span className="atl-seen__label">{name}</span>}
          </button>
        );
      })}
      {open && <Lightbox src={assetUrl(open.path)} name={open.label} onClose={() => setOpen(null)} />}
    </div>
  );
};
