/**
 * 「在插件页打开某个插件」—— 从对话里点 neox://plugins/<name> 链接 (agent 用 plugin_store_search
 * 找到商店里有、但用户还没装的插件时给出的链接) 走这里。
 *
 * 插件页可能还没挂载 (用户在对话页), 所以先把名字记下, 再请外壳切到插件页;
 * 插件页挂载时 / 收到事件时取走它并打开详情。
 */

let pending: string | null = null;

export const PLUGIN_STORE_LINK = /^neox:\/\/plugins\/([a-z0-9][a-z0-9._-]{0,63})\/?$/i;

export function openPluginInStore(name: string): void {
  pending = name;
  window.dispatchEvent(new CustomEvent('neox:open-plugin-store', { detail: { name } }));
}

export function takePendingPluginFocus(): string | null {
  const n = pending;
  pending = null;
  return n;
}
