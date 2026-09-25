/**
 * 插件的平台声明判定：清单中的 platform 列表限制插件可运行的宿主系统。
 *
 * 判定集中在纯函数中，由服务端、主进程和 renderer 共用，确保安装、加载和展示使用
 * 同一规则。
 *
 * 消费点:
 *   · `pluginManager.installFromPath` —— 拒绝不兼容平台
 *   · `pluginLoader.loadAllPlugins` —— 不加载已安装但不兼容的平台插件
 *   · 插件市场卡片 / 详情页 —— 展示平台不兼容原因
 */

/** 允许出现在清单里的平台值。清单是 Node 平台名 (process.platform)。 */
export const PLUGIN_PLATFORMS = ['darwin', 'win32', 'linux'] as const;

export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

export const PLATFORM_LABELS: Record<string, { en: string; zh: string }> = {
  darwin: { en: 'macOS', zh: 'macOS' },
  win32: { en: 'Windows', zh: 'Windows' },
  linux: { en: 'Linux', zh: 'Linux' },
};

/** 单个平台的展示名。不认识的平台名原样返回 —— 显示 'aix' 也比显示空好。 */
export function platformLabel(platform: string, isZh: boolean): string {
  const hit = PLATFORM_LABELS[platform];
  return hit ? (isZh ? hit.zh : hit.en) : platform;
}

/**
 * 读出插件声明的平台。两种形状都认:
 *   · 清单本身 / 安装记录里的 `manifest`  (platform 在顶层)
 *   · 市场记录 `MarketplacePlugin`        (platform 在 `manifest` 子对象里)
 *
 * 没声明、声明了个空数组、或者值不是字符串 → **null = 全平台**。
 * 绝大多数插件都是这个状态, 不能因为没写就拦人。
 */
export function declaredPlatforms(source: unknown): string[] | null {
  if (!source || typeof source !== 'object') return null;
  const rec = source as Record<string, unknown>;
  const nested = rec.manifest && typeof rec.manifest === 'object'
    ? (rec.manifest as Record<string, unknown>).platform
    : null;
  const raw = Array.isArray(rec.platform) ? rec.platform : nested;
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return list.length > 0 ? list : null;
}

/**
 * 这个插件在当前系统上能不能用。
 *
 * 判不出来就不拦: 未声明 = true, `current` 传空串 (renderer 认不出宿主系统) 也是 true。
 * 平台声明是**作者对可用性的承诺**, 不是安全边界 —— 判错方向要让功能多出来,
 * 不能让能用的插件装不上。
 */
export function isPlatformSupported(platforms: string[] | null, current: string): boolean {
  if (!platforms || platforms.length === 0) return true;
  if (!current) return true;
  return platforms.includes(current);
}

/** 支持平台的展示文案: 'macOS' / 'macOS · Windows'。没声明 → 空串 (调用方据此不显示这一栏)。 */
export function platformsLabel(platforms: string[] | null, isZh: boolean): string {
  if (!platforms || platforms.length === 0) return '';
  return platforms.map((p) => platformLabel(p, isZh)).join(' · ');
}
