
export interface ListingShot { src: string; alt?: string }
export interface ListingFeature { title: string; detail?: string }
export interface PluginListing {
  icon?: string;
  screenshots: ListingShot[];
  examples: string[];
  features: ListingFeature[];
}

const isHttps = (v: unknown): v is string => typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 按界面语言取: 中文界面优先 xxxZh / zh, 取不到退回英文 */
export function readListing(manifest: unknown, isZh: boolean): PluginListing {
  const raw = (manifest && typeof manifest === 'object' ? (manifest as any).listing : undefined) ?? {};
  const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

  const screenshots = arr(raw.screenshots)
    .map((s): ListingShot | null => {
      const src = isZh && isHttps(s?.srcZh) ? s.srcZh : s?.src;
      if (!isHttps(src)) return null;
      return { src, alt: str(isZh ? s?.altZh ?? s?.alt : s?.alt) };
    })
    .filter((s): s is ListingShot => s !== null)
    .slice(0, 8);

  const examples = arr(raw.examples)
    .map((e) => (typeof e === 'string' ? str(e) : str(isZh ? e?.zh ?? e?.en : e?.en ?? e?.zh)))
    .filter((e): e is string => Boolean(e))
    .slice(0, 6);

  const features = arr(raw.features)
    .map((f): ListingFeature | null => {
      const title = str(isZh ? f?.titleZh ?? f?.title : f?.title);
      if (!title) return null;
      return { title, detail: str(isZh ? f?.detailZh ?? f?.detail : f?.detail) };
    })
    .filter((f): f is ListingFeature => f !== null)
    .slice(0, 12);

  return { icon: isHttps(raw.icon) ? raw.icon : undefined, screenshots, examples, features };
}

/** 卡片 / 详情页的图标地址: 市场记录顶层 icon (后端从 listing.icon 提出来) 或清单里的 listing.icon */
export function remoteIconUrl(plugin: { icon?: unknown; manifest?: unknown } | null | undefined): string | undefined {
  if (!plugin) return undefined;
  if (isHttps(plugin.icon)) return plugin.icon;
  const li = (plugin.manifest as any)?.listing?.icon;
  return isHttps(li) ? li : undefined;
}

/** 用户配置项 (manifest.userConfig) —— 设置表单的 schema */
export interface ConfigField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  description: string;
  default?: string | number | boolean;
  options?: string[];
  sensitive?: boolean;
}

/** 中文界面优先 descriptionZh (清单可选字段), 没有就用 description */
export function readConfigFields(manifest: unknown, isZh: boolean): ConfigField[] {
  const uc = manifest && typeof manifest === 'object' ? (manifest as any).userConfig : undefined;
  if (!uc || typeof uc !== 'object') return [];
  return Object.entries(uc as Record<string, any>)
    .filter(([, f]) => f && typeof f === 'object')
    .map(([key, f]) => ({
      key,
      type: (['string', 'number', 'boolean', 'select'].includes(f.type) ? f.type : 'string') as ConfigField['type'],
      description: String((isZh && str(f.descriptionZh)) || f.description || key),
      default: f.default,
      options: Array.isArray(f.options) ? f.options.map(String) : undefined,
      sensitive: f.sensitive === true,
    }));
}
