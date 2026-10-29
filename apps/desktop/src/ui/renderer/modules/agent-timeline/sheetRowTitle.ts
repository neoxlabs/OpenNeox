/** A1 列名 ↔ 列号 (表格改动卡 buildOfficeContent 也用) */
export function colToNum(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n: number): string {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function sheetRowTitle(toolKey: string, name: string, a: Record<string, unknown> | undefined, zh: boolean): string | undefined {
  if (!/^sheet_/.test(toolKey)) return undefined;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const base = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p;
  if (toolKey === 'sheet_new_workbook' && s(a?.name)) return `${name} · ${s(a?.name)}`;
  if (toolKey === 'sheet_write_range' && s(a?.range)) {
    const rows = Array.isArray(a?.data) ? (a!.data as unknown[]) : Array.isArray(a?.items) ? (a!.items as unknown[]) : [];
    const n = rows.reduce<number>((acc, r) => acc + (Array.isArray(r) ? r.length : 1), 0);
    return `${name} · ${s(a?.range)}${n ? (zh ? ` · ${n} 格` : ` · ${n} cells`) : ''}`;
  }
  if (toolKey === 'sheet_set_cells' && Array.isArray(a?.cells)) {
    const n = (a!.cells as unknown[]).length;
    const f = s(a?.file_path);
    return `${name} · ${f ? `${base(f)} · ` : ''}${zh ? `${n} 格` : `${n} cells`}`;
  }
  if (toolKey === 'sheet_get_range' && s(a?.range)) return `${name} · ${s(a?.range)}`;
  const out = s(a?.save_path) || s(a?.file_path);
  return out ? `${name} · ${base(out)}` : undefined;
}
