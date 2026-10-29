/**
 * PluginSurfaceViewer — 插件贡献的面板 (manifest.views) 挂在右侧 Surface 里。
 *
 * surface.metadata = { pluginName, viewId }; 面板本体是 PluginViewHost 里的 iframe
 * (neox-plugin:// 协议, sandbox=allow-scripts), 通过 postMessage 走宿主接口
 * (invokeTool / readPluginData …), 权限按插件清单校验。
 *
 * 主题和语言用地址参数带过去 (?theme=dark&lang=zh): 切主题时 iframe 重新加载,
 * 这种事很少发生, 比在面板里再做一套同步简单可靠。
 */

import React from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { usePluginViews } from '../../pluginViews/usePluginViews';
import { PluginViewHost } from '../../pluginViews/PluginViewHost';
import { useNeoxEditorTheme } from '../../editor/engine/theme';
import { useI18n } from '../../../hooks/useI18n';

export const PluginSurfaceViewer: React.FC<{ surface: Surface }> = ({ surface }) => {
  const views = usePluginViews();
  const { isDark } = useNeoxEditorTheme();
  const { language } = useI18n();
  const isZh = language === 'zh';
  const meta = (surface.metadata ?? {}) as { pluginName?: string; viewId?: string };
  const view = views.find((v) => v.pluginName === meta.pluginName && v.id === meta.viewId);

  if (!view) {
    /* 插件被停用 / 卸载后, 已经开着的 tab 还在 —— 说清楚, 不留一块白 */
    return (
      <div className="sfc-empty">
        {isZh
          ? `「${meta.pluginName ?? '插件'}」的面板已不可用 —— 插件可能被停用或卸载了。`
          : `This panel from "${meta.pluginName ?? 'a plugin'}" is no longer available — the plugin may be disabled or uninstalled.`}
      </div>
    );
  }

  return (
    <div className="sfc-plugin">
      <PluginViewHost view={view} query={{ theme: isDark ? 'dark' : 'light', lang: isZh ? 'zh' : 'en' }} />
    </div>
  );
};
