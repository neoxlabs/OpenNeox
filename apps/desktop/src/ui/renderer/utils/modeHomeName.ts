
const MODE_HOME_LABEL: Record<string, { zh: string; en: string }> = {
  Work: { zh: '工作', en: 'Work' },
  工作: { zh: '工作', en: 'Work' },
  Code: { zh: '编码', en: 'Code' },
  编码: { zh: '编码', en: 'Code' },
  Pilot: { zh: '领航', en: 'Pilot' },
  领航: { zh: '领航', en: 'Pilot' },
};

export function displayWorkspaceName(path: string, name: string | null | undefined, isZh: boolean): string {
  const segs = (path || '').split(/[\\/]/).filter(Boolean);
  const base = segs[segs.length - 1] || path || '';
  const shown = (name || '').trim() || base;
  /* 父目录叫 Neox 才认 —— 同时覆盖新根 ~/Neox 和老根 ~/Documents/Neox,
   * 不误伤 ~/projects/Neox/Something 这类同名嵌套 */
  const isModeHome = segs.length >= 2 && segs[segs.length - 2] === 'Neox';
  const label = isModeHome && shown === base ? MODE_HOME_LABEL[base] : undefined;
  return label ? (isZh ? label.zh : label.en) : shown;
}
