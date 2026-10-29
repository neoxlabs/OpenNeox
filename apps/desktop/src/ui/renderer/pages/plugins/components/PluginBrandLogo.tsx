/**
 * PluginBrandLogo — 本地打包的真官方品牌 mark
 *
 *   跟 ProviderBrandLogo 同一套做法 (见那份文件头): 官方 logo 拉到本地
 *   `assets/plugin-logos/{name}.{png|svg}`, vite 编译时 bundle 成 URL。
 *   无 CDN 依赖、离线可用、形态是各家真 mark 而不是我化简的。
 *
 *   为什么按插件名查表而不是读清单里的 icon
 *   -------------------------------------
 *   清单的 `icon` 是**包内相对路径**, 而市场卡片在插件还没下载的时候就要显示 logo ——
 *   那时候包里的文件根本还不存在。所以官方插件走本地资产表, 第三方插件退回
 *   emoji / 首字母 monogram。将来市场支持 logo URL 时再补一条远程分支即可。
 *
 *   兜底顺序: 本地资产 → 市场 logo URL → 清单里的 emoji → 首字母 monogram。
 *   任何一环缺失都不该让卡片开天窗。
 */

import React, { useState } from 'react';
import { pluginLogoUrl } from '../pluginBrandAssets.js';

/** emoji 判定: 清单里的 icon 可能是 emoji 也可能是包内路径, 只有前者能直接渲染 */
function isEmoji(v?: string): boolean {
  if (!v) return false;
  if (v.includes('/') || v.includes('.')) return false;
  return [...v].length <= 3;
}

interface Props {
  /** 插件名, 用来查本地资产 */
  name: string;
  /** 清单里的 icon (emoji 时用作兜底) */
  icon?: string;
  size?: number;
}

export const PluginBrandLogo: React.FC<Props> = ({ name, icon, size = 28 }) => {
  const [broken, setBroken] = useState(false);
  const src = pluginLogoUrl(name) ?? (icon && /^https:\/\//i.test(icon) ? icon : undefined);

  if (src && !broken) {
    return (
      <span className="neox-plugin-logo" style={{ width: size, height: size }}>
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
        />
      </span>
    );
  }

  if (isEmoji(icon)) {
    return (
      <span
        className="neox-plugin-logo is-emoji"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.58) }}
        aria-hidden="true"
      >
        {icon}
      </span>
    );
  }

  return (
    <span
      className="neox-plugin-logo is-monogram"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
};
