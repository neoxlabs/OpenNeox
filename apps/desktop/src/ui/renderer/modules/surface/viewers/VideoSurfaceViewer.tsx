import React, { useCallback, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useAutoReloadOnFsChange } from './useAutoReloadOnFsChange';
import { OpenInExternalAppButton } from './OpenInExternalAppButton';
import { dispatchHint } from '../../../components/notifyEvents';
import { useI18n } from '../../../hooks/useI18n';
import { absoluteToAssetUrl } from '../../../../shared/assetUrlPath';

export const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

const fileToAssetUrl = absoluteToAssetUrl;

export const VideoSurfaceViewer: React.FC<{ surface: Surface }> = ({ surface }) => {
  const { isZh } = useI18n();
  const filePath = surface.source.type === 'file' ? surface.source.path : null;
  const [nonce, setNonce] = useState(0);
  const [downloading, setDownloading] = useState(false);
  /* 重新导出覆盖了同名文件 → 自动换成新的 */
  useAutoReloadOnFsChange(filePath, useCallback(() => setNonce((n) => n + 1), []));

  const download = useCallback(async () => {
    if (!filePath || downloading) return;
    const api = (window as any).neox;
    if (!api?.saveFileDialog || !api?.surfaceCopyFile) {
      dispatchHint(isZh ? '下载能力不可用 (bridge 缺失)' : 'Download unavailable (bridge missing)', 'warning');
      return;
    }
    setDownloading(true);
    try {
      const name = filePath.split(/[\\/]/).pop() || 'video.mp4';
      const ext = (name.split('.').pop() || '').toLowerCase();
      const dest = await api.saveFileDialog({
        title: isZh ? '保存视频' : 'Save video',
        defaultPath: name,
        filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined,
      });
      if (!dest) return;   /* 用户取消, 不是错误 */
      const r = await api.surfaceCopyFile(filePath, dest);
      if (r?.success === true) {
        dispatchHint(isZh ? `已保存到 ${dest}` : `Saved to ${dest}`, 'success');
      } else {
        dispatchHint(`${isZh ? '保存失败' : 'Save failed'}${r?.error ? `：${r.error}` : ''}`, 'warning');
      }
    } catch (e: any) {
      dispatchHint(`${isZh ? '保存失败' : 'Save failed'}：${e?.message || e}`, 'warning');
    } finally {
      setDownloading(false);
    }
  }, [filePath, downloading, isZh]);

  if (!filePath) return null;
  const src = `${fileToAssetUrl(filePath)}${nonce ? `?v=${nonce}` : ''}`;
  return (
    <div className="sfc-video">
      <video key={src} className="sfc-video__player" src={src} controls preload="metadata" />
      <div className="sfc-video__bar">
        <span className="sfc-video__name" title={filePath}>{filePath.split(/[\\/]/).pop()}</span>
        <button type="button" className="sfc-video__download" onClick={() => void download()} disabled={downloading}>
          {downloading ? (isZh ? '保存中…' : 'Saving…') : (isZh ? '下载' : 'Download')}
        </button>
        <OpenInExternalAppButton filePath={filePath} />
      </div>
    </div>
  );
};
