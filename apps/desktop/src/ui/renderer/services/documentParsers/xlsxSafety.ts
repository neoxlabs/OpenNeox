export const EXCEL_SAFETY_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxSheets: 24,
  maxPreviewRows: 5000,
  maxMarkdownRows: 1000,
  maxColumns: 200,
};

export const SAFE_XLSX_READ_OPTIONS = {
  type: 'array',
  cellDates: false,
  cellStyles: false,
  cellHTML: false,
  cellFormula: false,
  bookDeps: false,
  bookVBA: false,
  WTF: false,
} as const;

export function assertExcelBufferSafe(buffer: ArrayBuffer, label = 'Excel file'): void {
  if (buffer.byteLength > EXCEL_SAFETY_LIMITS.maxBytes) {
    throw new Error(`${label} too large: ${buffer.byteLength} > ${EXCEL_SAFETY_LIMITS.maxBytes} bytes`);
  }
}

export function safeSheetNames(workbook: any, maxSheets = EXCEL_SAFETY_LIMITS.maxSheets): string[] {
  const names = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  return names.slice(0, maxSheets).map((name: unknown) => String(name));
}

export function safeSheetTitle(name: unknown): string {
  return String(name ?? 'Sheet')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 120);
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeMarkdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

export function boundedSheetRange(
  XLSX: any,
  ws: any,
  maxRows = EXCEL_SAFETY_LIMITS.maxPreviewRows,
  maxColumns = EXCEL_SAFETY_LIMITS.maxColumns,
): string | undefined {
  const ref = typeof ws?.['!ref'] === 'string' ? ws['!ref'] : '';
  if (!ref) return undefined;
  try {
    const decoded = XLSX.utils.decode_range(ref);
    decoded.e.r = Math.min(decoded.e.r, decoded.s.r + Math.max(1, maxRows) - 1);
    decoded.e.c = Math.min(decoded.e.c, decoded.s.c + Math.max(1, maxColumns) - 1);
    return XLSX.utils.encode_range(decoded);
  } catch {
    return undefined;
  }
}

export function sheetRows(
  XLSX: any,
  ws: any,
  opts?: { maxRows?: number; maxColumns?: number; raw?: boolean },
): any[][] {
  const range = boundedSheetRange(XLSX, ws, opts?.maxRows, opts?.maxColumns);
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: opts?.raw ?? false,
    defval: '',
    ...(range ? { range } : {}),
  });
}

export function sheetHtml(XLSX: any, ws: any): string {
  const range = boundedSheetRange(XLSX, ws, EXCEL_SAFETY_LIMITS.maxMarkdownRows, EXCEL_SAFETY_LIMITS.maxColumns);
  return XLSX.utils.sheet_to_html(ws, {
    editable: false,
    ...(range ? { range } : {}),
  });
}

export function sheetCsv(XLSX: any, ws: any): string {
  const range = boundedSheetRange(XLSX, ws, EXCEL_SAFETY_LIMITS.maxPreviewRows, EXCEL_SAFETY_LIMITS.maxColumns);
  return XLSX.utils.sheet_to_csv(ws, range ? { range } : undefined);
}

const POLLUTING_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function rowsToSafeObjects(rows: any[][]): Array<Record<string, unknown>> {
  if (rows.length === 0) return [];
  const header = rows[0] ?? [];
  const usedKeys = new Set<string>();
  const keys = header.map((value, index) => {
    const raw = String(value ?? '').trim();
    let key = raw && !POLLUTING_KEYS.has(raw) ? raw : `column_${index + 1}`;
    if (POLLUTING_KEYS.has(key)) key = `column_${index + 1}`;
    const base = key;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${base}_${suffix++}`;
    }
    usedKeys.add(key);
    return key;
  });

  return rows.slice(1).map((row) => {
    const item: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < keys.length; i++) {
      item[keys[i]] = row?.[i] ?? null;
    }
    return item;
  });
}
