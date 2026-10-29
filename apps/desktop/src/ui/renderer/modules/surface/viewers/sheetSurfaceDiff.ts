
export interface SnapCell { v?: unknown; f?: string }
/** sheetId → row → col → 值 */
export type CellGrid = Record<string, Record<number, Record<number, SnapCell>>>;

export interface SheetEdits {
  sheet: string;
  edits: Array<{ cell: string; value?: string | number | boolean | null; formula?: string }>;
}

/** 插入 / 删除 / 移动行列: 坐标整体平移, 按格对比会把一片格子写错位置 —— 这类改动不能原地存回 */
export function isStructuralCommand(id: string | undefined): boolean {
  if (!id) return false;
  if (/range-values/.test(id)) return false;
  /* insert-row / remove-col / move-range / delete-range-move-up (删格并上移) 都会让坐标平移 */
  return /\.(command|mutation)\.(insert|remove|move|delete)-/.test(id);
}

export function colName(c0: number): string {
  let n = c0 + 1; let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function cellValue(cell: any): unknown {
  if (!cell) return undefined;
  let v = cell.v;
  if ((v === undefined || v === null) && cell.p?.body?.dataStream) v = String(cell.p.body.dataStream).replace(/\r?\n?$/, '');
  return v;
}

function cellFormula(cell: any): string | undefined {
  const f = cell?.f;
  return typeof f === 'string' && f.trim() ? f.trim() : undefined;
}

export function snapshotUniverCells(data: any): CellGrid {
  const out: CellGrid = {};
  for (const [sheetId, sheet] of Object.entries<any>(data?.sheets ?? {})) {
    const grid: Record<number, Record<number, SnapCell>> = {};
    for (const [r, row] of Object.entries<any>(sheet?.cellData ?? {})) {
      const rowOut: Record<number, SnapCell> = {};
      for (const [c, cell] of Object.entries<any>(row ?? {})) {
        rowOut[Number(c)] = { v: cellValue(cell), f: cellFormula(cell) };
      }
      grid[Number(r)] = rowOut;
    }
    out[sheetId] = grid;
  }
  return out;
}

/**
 * 预览里显示的是格式化文本, 用户照着改也常常带着格式打: "20,000.00" / "35%"。
 * 能无歧义还原成数的就写成数 (原单元格的数字格式会继续把它显示成那个样子), 其它当文本。
 */
export function normalizeEditValue(v: unknown): string | number | boolean | null {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v);
  const t = s.trim();
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
  if (/^-?\d+(\.\d+)?%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  return s;
}

function same(a: SnapCell | undefined, b: SnapCell | undefined): boolean {
  /* 公式没变就是没改 —— 值是 Univer 现场算出来的 (加载时公式格往往没有缓存值), 不是用户的编辑 */
  if (a?.f && a.f === b?.f) return true;
  const av = a?.v === '' ? undefined : a?.v; const bv = b?.v === '' ? undefined : b?.v;
  return (a?.f ?? '') === (b?.f ?? '') && (av === bv || (av !== undefined && bv !== undefined && String(av) === String(bv)));
}

/**
 * 对比快照和当前数据, 按原 sheet 名分组出要补的格。
 * 用户在预览里新建的工作表 (names 里没有) 不能原地存 —— 抛错让界面说清楚。
 */
export function diffUniverCells(base: CellGrid, data: any, names: Record<string, string>): SheetEdits[] {
  const now = snapshotUniverCells(data);
  const out: SheetEdits[] = [];
  const sheetIds = new Set([...Object.keys(base), ...Object.keys(now)]);
  for (const sheetId of sheetIds) {
    const b = base[sheetId] ?? {};
    const n = now[sheetId] ?? {};
    const edits: SheetEdits['edits'] = [];
    const rows = new Set([...Object.keys(b), ...Object.keys(n)].map(Number));
    for (const r of [...rows].sort((x, y) => x - y)) {
      const cols = new Set([...Object.keys(b[r] ?? {}), ...Object.keys(n[r] ?? {})].map(Number));
      for (const c of [...cols].sort((x, y) => x - y)) {
        const before = b[r]?.[c]; const after = n[r]?.[c];
        if (same(before, after)) continue;
        const cell = `${colName(c)}${r + 1}`;
        if (after?.f) edits.push({ cell, formula: after.f });
        else edits.push({ cell, value: normalizeEditValue(after?.v) });
      }
    }
    if (edits.length === 0) continue;
    const sheet = names[sheetId];
    if (!sheet) throw new Error('NEW_SHEET');
    out.push({ sheet, edits });
  }
  return out;
}
