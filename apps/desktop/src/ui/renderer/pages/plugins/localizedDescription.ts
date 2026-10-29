
export interface LocalizablePlugin {
  description?: string;
  descriptionZh?: string | null;
  i18n?: Record<string, { description?: string; displayName?: string } | undefined>;
}

export function localizedDescription(p: LocalizablePlugin, language: string): string {
  const lang = String(language || '').trim();
  const base = lang.split('-')[0]!.toLowerCase();
  const i18n = p.i18n ?? {};
  const hit = i18n[lang]?.description ?? i18n[base]?.description;
  if (hit) return hit;
  if (base === 'zh' && p.descriptionZh) return p.descriptionZh;
  return p.description ?? '';
}

/** 所有语言的描述 —— 搜索要中英文都能搜到, 不能只搜当前界面语言那一份 */
export function allDescriptions(p: LocalizablePlugin): string[] {
  const out = [p.description, p.descriptionZh ?? undefined, ...Object.values(p.i18n ?? {}).map((v) => v?.description)];
  return out.filter((s): s is string => typeof s === 'string' && s.length > 0);
}
