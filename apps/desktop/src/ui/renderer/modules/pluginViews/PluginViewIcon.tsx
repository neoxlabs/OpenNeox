/**
 * 插件面板图标 + 外面那枚圆片。有 logo 时圆片加 `is-app` (各处 CSS 让 logo 铺满、去掉灰底)。
 * 放成组件而不是函数: 取 logo 是 hook, 得能在列表 map 里用。
 */
import React from 'react';
import { usePluginViewIcon } from './usePluginViewIcon';

/** 只有图, 不带外圈 —— 给已经有自己图标槽的地方 (对话右栏行 / Surface tab) */
export const PluginLogo: React.FC<{
  pluginName: string | undefined;
  emoji?: string;
  fallback: React.ReactNode;
  imgClassName?: string;
}> = ({ pluginName, emoji, fallback, imgClassName }) => {
  const logo = usePluginViewIcon(pluginName);
  if (logo) return <img className={imgClassName} src={logo} alt="" />;
  return emoji ? <span aria-hidden="true">{emoji}</span> : <>{fallback}</>;
};

export const PluginViewIcon: React.FC<{
  pluginName: string | undefined;
  emoji?: string;
  fallback: React.ReactNode;
  className: string;
  imgClassName?: string;
  children?: React.ReactNode;
}> = ({ pluginName, emoji, fallback, className, imgClassName, children }) => {
  const logo = usePluginViewIcon(pluginName);
  return (
    <span className={`${className}${logo ? ' is-app' : ''}`} aria-hidden="true">
      {logo ? <img className={imgClassName} src={logo} alt="" /> : emoji ? <span>{emoji}</span> : fallback}
      {children}
    </span>
  );
};
