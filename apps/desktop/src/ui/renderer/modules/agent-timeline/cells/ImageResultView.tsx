/**
 * ImageResultView — timeline 上的生图结果卡.
 *
 * 【为什么要它】不做这一条的话, generate_image 的结果落到通用 tool_result,
 * 用户看到的是一行 JSON 路径 —— 而生图这件事的**全部价值就是那张图**,
 * 让用户去文件夹里翻等于把最重要的产物藏起来。
 *
 * 图走 neox-asset:// 协议 (electron/main.ts 的 protocol.handle):
 * 它放行 workspace 各根 + artifacts 目录, 而 generate_image 正是落在 workspace 里。
 * 直接用 file:// 在 Electron 渲染进程里是被挡的 —— 那条路走不通。
 */
import React from 'react';
import { useI18n } from '../../../hooks/useI18n';
import { Lightbox } from './attachments';
import { absoluteToAssetUrl } from '../../../../shared/assetUrlPath';

export interface ImageResultViewProps {
  paths: string[];
  prompt?: string;
  model?: string;
  cached?: boolean;
}

export function assetUrl(absPath: string): string {
  return absoluteToAssetUrl(absPath);
}

export const ImageResultView: React.FC<ImageResultViewProps> = ({ paths, prompt, model, cached }) => {
  const { isZh } = useI18n();
  const [failed, setFailed] = React.useState<Record<string, boolean>>({});
  const [open, setOpen] = React.useState<string | null>(null);

  return (
    <div className="atl-imagegen">
      {(prompt || model || cached) && (
        <div className="atl-imagegen__meta">
          {model && <span className="atl-imagegen__model">{model}</span>}
          {cached && <span className="atl-imagegen__cached">{isZh ? '已复用缓存' : 'From cache'}</span>}
          {prompt && <span className="atl-imagegen__prompt" title={prompt}>{prompt}</span>}
        </div>
      )}
      <div className="atl-imagegen__grid">
        {paths.map((p) => {
          const name = p.split(/[\\/]/).pop() || p;
          return failed[p] ? (
            /* 读不到就说读不到, 别留一个破图标 —— 用户至少知道文件在哪, 能自己去看 */
            <div key={p} className="atl-imagegen__miss" title={p}>
              图片读不出来 · {name}
            </div>
          ) : (
            <figure key={p} className="atl-imagegen__item">
              {/* 缩略图只是索引, 真要看细节得点开 —— 灯箱跟「看过的图」共用一套 */}
              <button
                type="button"
                className="atl-imagegen__open"
                title={isZh ? '点开看大图' : 'Open full size'}
                onClick={(e) => { e.stopPropagation(); setOpen(p); }}
              >
                <img
                  src={assetUrl(p)}
                  alt={prompt || name}
                  loading="lazy"
                  onError={() => setFailed((s) => ({ ...s, [p]: true }))}
                />
              </button>
              <figcaption title={p}>{name}</figcaption>
            </figure>
          );
        })}
      </div>
      {open && (
        <Lightbox
          src={assetUrl(open)}
          name={open.split(/[\\/]/).pop()}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
};
