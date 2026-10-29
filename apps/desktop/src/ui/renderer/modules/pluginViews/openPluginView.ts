/**
 * 打开一个插件面板 (右侧 Surface 里的 iframe)。
 *
 * 入口有三个, 都走这一个函数: 对话右栏「插件」一节 / Surface 四宫格菜单的「插件」/ 插件详情页的「打开面板」。
 * 真正干活的是 NeoxShellHost 里的 neox:open-plugin-view: 切回对话页、没会话就建一个、开面板、展开右栏
 * —— 从插件页点的时候这几样都不满足, 直接发 neox:open-surface 会「点了没反应」。
 * 面板的地址就是它的身份 (surfaceStore.sourceIdentity), 再点一次回到同一个 tab。
 */
import type { PluginViewSummary } from '@neoxlabs/platform/shared/ipc/plugin.js';

/** 面板在 Surface 里的地址 = 它的身份; 跟 NeoxShellHost 的 neox:open-plugin-view 拼法必须一致 */
export function pluginViewUrl(v: Pick<PluginViewSummary, 'pluginName' | 'entry'>): string {
  return `neox-plugin://${v.pluginName}/${v.entry.split('/').map(encodeURIComponent).join('/')}`;
}

export function openPluginView(v: PluginViewSummary): void {
  window.dispatchEvent(new CustomEvent('neox:open-plugin-view', { detail: v }));
}
