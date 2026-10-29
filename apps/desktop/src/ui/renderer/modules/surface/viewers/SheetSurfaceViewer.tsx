/**
 * SheetSurfaceViewer — Univer 只读 viewer (S1 Phase 1).
 *
 *   渲染 .xlsx / .csv / .tsv 文件, 用户能浏览/滚动/筛选/复制单元格.
 *   只读模式 — 用户不能改单元格 (改文件走 agent 工具 sheet_set_* 或下次升级到编辑模式).
 *
 *   source 协议:
 *     · `{type: 'file', path: '/path/to/x.xlsx'}` — 读盘 + SheetJS 解析 → Univer workbook
 *     · `{type: 'inline', content: '<IWorkbookData JSON>'}` — agent 直接给 workbook 数据
 *
 *   懒加载: Univer 包重 (~250KB css + ~600KB js), 跟 mermaid 一样首次开 sheet surface 时才 import.
 *
 *   主题: 复用 data-theme attribute (light/dark), Univer 内部支持 darkMode 配置.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Surface } from '../../../state/surfaceStore';
import { useNeoxRuntime } from '../../../app/NeoxRuntimeContext';
import { useSurfaceFileLock } from '../../../hooks/useSurfaceFileLock';
import { useI18n } from '../../../hooks/useI18n';
import { KindHomeView } from './KindHomeView';
import {
  EXCEL_SAFETY_LIMITS,
  SAFE_XLSX_READ_OPTIONS,
  safeSheetNames,
  safeSheetTitle,
  sheetRows,
} from '../../../services/documentParsers/xlsxSafety';

/* Univer 全靠这套 CSS 撑 flex/grid 布局, 不 import 就会底栏按钮塌成纵向 1 列、
 * 表格主体根本不渲染. 跟 ServicesSurfaceViewer 的 xterm.css 同范式顶层 import. */
import '@univerjs/preset-sheets-core/lib/index.css';
import { kbd } from '../../../utils/keymap';
import { snapshotUniverCells, diffUniverCells, isStructuralCommand, type CellGrid } from './sheetSurfaceDiff';
import { retryLabel, retryOrReload } from './staleModule';
import { PreviewSkeleton } from './previewPerf/PreviewSkeleton';
import { PreviewErrorState } from './previewPerf/PreviewErrorState';
import { base64Mentions } from './previewPerf/base64Probe';
import { dispatchHint } from '../../../components/notifyEvents';

interface Props {
  surface: Surface;
}

/* lazy import — 跟 mermaid / monaco 同范式. 首次 open sheet surface 才下载 Univer 包. */
let univerModulesPromise: Promise<{
  createUniver: any;
  UniverSheetsCorePreset: any;
  LocaleType: any;
  defaultTheme: any;
  zhCN: any;
  enUS: any;
}> | null = null;

const loadUniverModules = async () => {
  if (!univerModulesPromise) {
    univerModulesPromise = (async () => {
      const [presets, presetCore, presetLocaleZh, presetLocaleEn] = await Promise.all([
        import('@univerjs/presets'),
        import('@univerjs/preset-sheets-core'),
        import('@univerjs/preset-sheets-core/locales/zh-CN'),
        import('@univerjs/preset-sheets-core/locales/en-US'),
      ]);
      return {
        createUniver: (presets as any).createUniver,
        LocaleType: (presets as any).LocaleType,
        defaultTheme: (presets as any).defaultTheme,
        UniverSheetsCorePreset: (presetCore as any).UniverSheetsCorePreset,
        zhCN: (presetLocaleZh as any).default,
        enUS: (presetLocaleEn as any).default,
      };
    })();
  }
  return univerModulesPromise;
};


const NEOX_NEUTRAL_GRAY = {
  50: '#FAFAFA',
  100: '#F0F0F0',
  200: '#E4E4E4',
  300: '#ADADAD',
  400: '#868686',
  500: '#565656',
  600: '#3A3A3A',
  700: '#2E2E2E',
  800: '#262626',
  900: '#1F1F1F',
} as const;

function buildNeoxUniverTheme(base: any, isDark: boolean): any {
  if (!base || typeof base !== 'object') return base;
  const next: any = { ...base, gray: { ...(base.gray ?? {}), ...NEOX_NEUTRAL_GRAY } };
  if (isDark) {
    /* 仅影响 Univer CSS chrome (--univer-black), **管不到** canvas 行号/列头。
     * 行号列真正的近黑来自 DEFAULT_ROW_STYLE rgb(248,249,250) 被 darkMode invert
     * 成 ~(5,6,7) —— 见 applyNeoxSheetHeaderChrome。 */
    next.black = '#1A1A1A';
  }
  return next;
}

/**
 * 暗色下把 canvas 行号列 / 列头条 / 左上角从"纯黑边"抬到跟单元格同水位 (#1F1F1F)。
 *
 * Univer engine-render 在 darkMode 下会对所有 canvas fillStyle 做 invertColorByMatrix。
 * 默认头底 rgb(248,249,250) → invert ≈ (5,6,7), 改 theme.black 无效。
 * 必须传**浅色预像** rgb(224,224,224), invert 后才是 #1F1F1F。
 *
 * 左上角 `__SpreadsheetLeftTopPlaceholder__` 是个带描边的 Rect (不是功能图标)。
 * 默认 stroke rgb(217,217,217) 若不 invert 会在交汇处画出「一横一竖」亮条 —
 * 直接 strokeWidth:0 关掉。
 */
async function applyNeoxSheetHeaderChrome(univerAPI: any, isDark: boolean): Promise<boolean> {
  if (!univerAPI || !isDark) return false;
  /* invert 后 ≈ #1F1F1F (底) / #2E2E2E (分割线) */
  const bg = 'rgb(224,224,224)';
  const border = 'rgb(209,209,209)';
  const cfg = { headerStyle: { backgroundColor: bg, borderColor: border } };
  try {
    const wb = univerAPI.getActiveWorkbook?.();
    const unitId = wb?.getId?.();
    const sheetId = wb?.getActiveSheet?.()?.getSheetId?.();
    const injector = univerAPI._injector;
    if (!unitId || !injector) return false;
    const { IRenderManagerService } = await import('@univerjs/engine-render');
    const render = injector.get(IRenderManagerService)?.getRenderById?.(unitId);
    if (!render?.components) return false;
    const rowHeader = render.components.get('__SpreadsheetRowHeader__');
    const colHeader = render.components.get('__SpreadsheetColumnHeader__');
    const leftTop = render.components.get('__SpreadsheetLeftTopPlaceholder__');
    if (!rowHeader?.setCustomHeader && !colHeader?.setCustomHeader) return false;

    rowHeader?.setCustomHeader?.(cfg);
    colHeader?.setCustomHeader?.(cfg);
    if (sheetId) {
      rowHeader?.setCustomHeader?.(cfg, sheetId);
      colHeader?.setCustomHeader?.(cfg, sheetId);
    }
    /* 交汇格: 只铺底色, 描边关掉 —— 那「一横一竖」就是这道 stroke */
    leftTop?.setProps?.({
      fill: bg,
      stroke: 'rgba(0,0,0,0)',
      strokeWidth: 0,
    });
    leftTop?.makeDirty?.(true);
    rowHeader?.makeDirty?.(true);
    colHeader?.makeDirty?.(true);
    wb?.getActiveSheet?.()?.refreshCanvas?.();
    return true;
  } catch (err) {
    console.warn('[SheetSurfaceViewer] header chrome failed', err);
    return false;
  }
}

/** 重试刷 header chrome: Univer 首帧会重建骨架, 单次 setProps 容易被冲掉 */
async function hideSheetFreezeHandles(univerAPI: any): Promise<void> {
  try {
    const unitId = univerAPI?.getActiveWorkbook?.()?.getId?.();
    const injector = univerAPI?._injector;
    if (!unitId || !injector) return;
    const { IRenderManagerService } = await import('@univerjs/engine-render');
    const scene = injector.get(IRenderManagerService)?.getRenderById?.(unitId)?.scene;
    for (const key of ['__SpreadsheetFreezeRowHeaderName__', '__SpreadsheetFreezeColumnHeaderName__']) {
      scene?.getObject?.(key)?.hide?.();
    }
  } catch { /* 拖柄还没建出来 —— 下一轮重试会补上 */ }
}

function scheduleNeoxSheetHeaderChrome(
  univerAPI: any,
  isDark: boolean,
  isCancelled: () => boolean,
): void {
  const delays = [0, 50, 120, 300, 600, 1200];
  for (const ms of delays) {
    window.setTimeout(() => {
      if (isCancelled()) return;
      void applyNeoxSheetHeaderChrome(univerAPI, isDark);
      void hideSheetFreezeHandles(univerAPI);
    }, ms);
  }
}

/* xlsx 解析也懒加载 — 复用 F7+N4 v2 已用的 SheetJS */
let xlsxPromise: Promise<any> | null = null;
const loadXlsx = async () => {
  if (!xlsxPromise) {
    xlsxPromise = import('xlsx').then((m: any) => m.default ?? m);
  }
  return xlsxPromise;
};

function detectIsDark(): boolean {
  const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
  if (t === 'light') return false;
  if (t === 'dark') return true;
  if (typeof matchMedia !== 'undefined') return matchMedia('(prefers-color-scheme: dark)').matches;
  return true;
}

/**
 * Univer IWorkbookData → SheetJS workbook — 反向转换的**公共部分**。
 * 拆出来是因为 auto-save 要按源格式写回: xlsx 走 base64, csv/tsv 走文本,
 * 两条路只有最后一步 XLSX.write 的参数不同, 前面构造 workbook 完全一样。
 *
 * Univer IWorkbookData → xlsx base64 — 反向转换 (auto-save 用).
 *   遍历 sheetOrder 取每个 sheet 的 cellData → 拼 2D 数组 → SheetJS aoa_to_sheet → book → write base64.
 *   注: 保留原 sheet 名 (从 sheets[id].name 取), 不用 sheet id 当文件 sheet 名 (id 是 "sheet-0" 这种内部码).
 */
function univerDataToXlsxWorkbook(XLSX: any, data: any): any {
  const wb = XLSX.utils.book_new();
  const sheetOrder: string[] = Array.isArray(data?.sheetOrder) ? data.sheetOrder : Object.keys(data?.sheets ?? {});
  for (const sheetId of sheetOrder) {
    const sheet = data?.sheets?.[sheetId];
    if (!sheet) continue;
    const sheetName = String(sheet.name ?? sheetId);
    const cellData = sheet.cellData ?? {};
    /* cellData 形如 { rowIndex: { colIndex: { v: any, ... } } }; 拼成 max(row+1) × max(col+1) 矩阵 */
    let maxRow = -1, maxCol = -1;
    for (const rKey of Object.keys(cellData)) {
      const r = Number(rKey);
      if (Number.isNaN(r)) continue;
      if (r > maxRow) maxRow = r;
      for (const cKey of Object.keys(cellData[rKey] ?? {})) {
        const c = Number(cKey);
        if (Number.isNaN(c)) continue;
        if (c > maxCol) maxCol = c;
      }
    }
    const rows: any[][] = [];
    for (let r = 0; r <= maxRow; r++) {
      const row: any[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const cell = cellData[r]?.[c];
        /* 优先 v (value), p (rich text fallback 取 p.body 第一段 text) */
        let v: any = cell?.v;
        if (v == null && cell?.p?.body?.dataStream) v = cell.p.body.dataStream.replace(/\r$/, '');
        row.push(v ?? '');
      }
      rows.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [[]]);
    /* sheet 名 SheetJS 限 31 字符 + 不允许 :\\/?*[] — 简单清一下 */
    const safeName = sheetName.replace(/[\\/:?*[\]]/g, '_').slice(0, 31) || 'Sheet1';
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }
  return wb;
}

function univerDataToXlsxBase64(XLSX: any, data: any): string {
  return XLSX.write(univerDataToXlsxWorkbook(XLSX, data), { type: 'base64', bookType: 'xlsx' });
}

/**
 * 把 SheetJS workbook 转 Univer IWorkbookData.
 *   只搞最小有效字段: id / name / sheetOrder / sheets[name].{id, name, cellData}.
 *   cellData 是 row x col 二维 map, value 用 SheetJS 单元格的 .v (formatted value).
 */
function xlsxToUniverWorkbookData(XLSX: any, wb: any, displayName: string): any {
  const sheets: Record<string, any> = {};
  const sheetOrder: string[] = [];
  let idx = 0;
  for (const sheetName of safeSheetNames(wb)) {
    const ws = wb.Sheets[sheetName];
    const sheetId = `sheet-${idx++}`;
    sheetOrder.push(sheetId);

    /* 用 sheet_to_json 抽 2D 数组, header:1 表示返原始矩阵不当 obj */
    const rows = sheetRows(XLSX, ws, {
      maxRows: EXCEL_SAFETY_LIMITS.maxPreviewRows,
      maxColumns: EXCEL_SAFETY_LIMITS.maxColumns,
    });
    const cellData: Record<number, Record<number, { v?: any; f?: string; s?: any }>> = {};
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const rowMap: Record<number, { v?: any; f?: string; s?: any }> = {};
      let any = false;
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (v !== '' && v != null) {
          rowMap[c] = { v };
          any = true;
        }
      }
      if (any) cellData[r] = rowMap;
    }
    for (const addr of Object.keys(ws ?? {})) {
      if (addr.startsWith('!')) continue;
      const cell = ws[addr];
      if (!cell) continue;
      if (cell.t === 'n' && !cell.f) {
        const { r: nr, c: nc } = XLSX.utils.decode_cell(addr);
        const cur = cellData[nr]?.[nc] as ({ v?: any; t?: number; s?: any } | undefined);
        if (cur && typeof cell.v === 'number' && Number.isFinite(cell.v)) {
          cur.v = cell.v;
          cur.t = 2;
          cur.s = typeof cell.z === 'string' && cell.z && cell.z !== 'General'
            ? { n: { pattern: cell.z }, ht: 3 }
            : { ht: 3 };
        } else if (cur) {
          cur.s = { ht: 3 };
        }
      }
      if (typeof cell.f !== 'string' || !cell.f) continue;
      const { r, c } = XLSX.utils.decode_cell(addr);
      if (r >= EXCEL_SAFETY_LIMITS.maxPreviewRows || c >= EXCEL_SAFETY_LIMITS.maxColumns) continue;
      const rowMap = (cellData[r] ??= {});
      const f = cell.f.startsWith('=') ? cell.f : `=${cell.f}`;
      /* t:'z' = 文件里只有公式没有缓存值的"桩格", SheetJS 给它补的 v:0 是假的, 不能带过去 */
      rowMap[c] = cell.t === 'z' ? { f } : { ...(rowMap[c] ?? {}), f };
      /* 公式格由 Univer 现场算, 算出来是原始小数 —— 文件里的数字格式 (0.0% / #,##0) 要一起交过去,
       * 不然占比显示成 0.4812…、合计占比显示 "1" (10-15 QA)。普通数字格的值本来就是格式化文本, 不用管 */
      if (typeof cell.z === 'string' && cell.z && cell.z !== 'General') {
        rowMap[c].s = { ...(rowMap[c].s ?? {}), n: { pattern: cell.z }, ht: 3 };
      }
    }

    sheets[sheetId] = {
      id: sheetId,
      name: safeSheetTitle(sheetName),
      cellData,
      rowCount: Math.max(rows.length + 5, 100),
      columnCount: Math.max(...rows.map(r => r?.length ?? 0), 26),
    };
  }

  return {
    id: `sheet-${Date.now()}`,
    name: displayName,
    appVersion: '0.22.1',
    locale: 'zhCN',
    sheets,
    sheetOrder,
  };
}

/** save 状态机 — 给右上角小角标用 */
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_DEBOUNCE_MS = 300;       /* 用户连续打字时合并写盘, < 1 帧也无感 */
const SAVED_BADGE_LINGER_MS = 1500; /* "saved" 角标淡出前停留时长 */

/* Univer 命令分类: 只接 mutation (真正改数据的), 不接 UI operation (光标/选区/滚动).
 * 简单按 id 子串过滤就够 — false-positive 顶多多写一次, 无害. */
function isMutationCommand(commandId: string | undefined): boolean {
  if (!commandId) return false;
  return commandId.includes('.mutation.') || commandId.includes('.command.set-range-values')
    || commandId.includes('.command.clear-selection') || commandId.includes('.command.delete-range')
    || commandId.includes('.command.paste') || commandId.includes('.command.insert-')
    || commandId.includes('.command.remove-') || commandId.includes('.command.move-');
}

/** 单文件 viewer — 一个 Univer 实例 + 一套 save 链路, key 由外层 host 用 tab.url 给, 切 tab 自然 unmount 重建. */
const SingleSheetView: React.FC<Props> = ({ surface }) => {
  const { isZh } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const univerRef = useRef<any>(null);  /* { univer, univerAPI } — dispose on unmount */
  /* Wave 13: 跨 Surface 文件锁 — 同一文件被两个 surface 同时编辑时, 后开的显示
   *  "已被另一会话编辑" banner 让用户主动接管. file 模式才参与锁, inline 不锁. */
  const lockPath = surface.source.type === 'file' ? surface.source.path : null;
  const sourceKey = surface.source.type === 'file'
    ? `file:${surface.source.path}`
    : surface.source.type === 'inline'
      ? `inline:${surface.source.content}`
      : `other:${JSON.stringify(surface.source)}`;
  const fileLock = useSurfaceFileLock(lockPath, surface.id);

  const openExternal = useCallback(async () => {
    if (!lockPath) return;
    setExternalError(null);
    try {
      const r = await (window as any).neox?.surfaceOpenExternal?.(lockPath);
      if (r?.success === false) setExternalError(r.error || (isZh ? '打开失败' : 'failed to open'));
    } catch (err: any) {
      setExternalError(err?.message || String(err));
    }
  }, [lockPath, isZh]);
  /* save 链路相关 refs — 用 ref 避免 effect 重跑, 也避免 stale closure */
  const debounceTimerRef = useRef<number | null>(null);
  const savedBadgeTimerRef = useRef<number | null>(null);
  const isSavingRef = useRef(false);        /* 防止并发 save (前一次还没回, 新一次又触发) */
  const pendingAfterSaveRef = useRef(false); /* save 进行中又来变更, 完成后再 save 一次 */
  const initialLoadDoneRef = useRef(false); /* createUniverSheet 注入数据本身会触发 mutation, 首次不当作用户编辑 */
  const xlsxModuleRef = useRef<any>(null);  /* save 时复用 lazy xlsx module 句柄 */
  const sourceFormatRef = useRef<'xlsx' | 'csv' | 'tsv'>('xlsx');
  const dirtyRef = useRef(false);
  const structuralRef = useRef(false);
  const baselineRef = useRef<{ cells: CellGrid; names: Record<string, string> } | null>(null);

  /* ─────────────────────── auto-save 核心 ───────────────────────
   * 用户编辑 cell → onCommandExecuted (mutation) → scheduleSave
   *   → 300ms debounce → flushSave: getWorkbook.save() → 转 xlsx base64 → 写盘
   * onBlur (窗口/编辑器失焦) 立即 flushSave 不等 debounce.
   * inline source 没文件路径 — 编辑只在内存, 不接 save 链路.
   */
  const flushSaveRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    flushSaveRef.current = async () => {
      if (surface.source.type !== 'file') return; /* inline 不写盘 */
      if (!initialLoadDoneRef.current) return;    /* 还没初始化完 */
      if (!univerRef.current?.univerAPI) return;
      if (!dirtyRef.current) return;              /* 没改过就不写 —— 失焦 / ⌘S / 卸载都走这里 */

      /* 取消等待中的 debounce timer — 我们正在 flush */
      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      /* 已在 save 中 — 标记 pending, 完成后 flushSave 自己会再触发一次 */
      if (isSavingRef.current) {
        pendingAfterSaveRef.current = true;
        return;
      }

      isSavingRef.current = true;
      setSaveState('saving');
      setSaveErrorMsg(null);
      try {
        const fWorkbook = univerRef.current.univerAPI.getActiveWorkbook?.();
        if (!fWorkbook?.save) throw new Error(isZh ? '无法获取 workbook 数据 (getActiveWorkbook 不可用)' : 'Cannot get workbook data (getActiveWorkbook unavailable)');
        const wbData = fWorkbook.save();
        const XLSX = xlsxModuleRef.current ?? (await loadXlsx());
        xlsxModuleRef.current = XLSX;
        const api = (window as any).neox;
        const writer = api?.surfaceWriteFile;
        if (!writer) throw new Error(isZh ? 'surfaceWriteFile bridge 不可用 (preload 未暴露)' : 'surfaceWriteFile bridge unavailable (not exposed by preload)');
        const filePath = (surface.source as any).path;

        /* **按源格式写回** —— 文本源(csv/tsv)存成文本, 别把人家的 CSV 换成 xlsx 二进制。
           (见 sourceFormatRef 上方那段事故说明。) */
        let result;
        const fmt = sourceFormatRef.current;
        /* 先清脏标记: 写的过程中又有编辑进来会重新置位, 由 pendingAfterSave 再存一次 */
        dirtyRef.current = false;
        if (fmt === 'csv' || fmt === 'tsv') {
          /* 纯文本格式没有公式/样式可丢, 整份写回没问题 (但同样只在改过之后) */
          const outWb = univerDataToXlsxWorkbook(XLSX, wbData);
          const text = XLSX.write(outWb, { bookType: fmt, type: 'string', FS: fmt === 'tsv' ? '\t' : ',' });
          result = await writer(filePath, text, { encoding: 'utf8' });
        } else {
          if (structuralRef.current) {
            throw new Error(isZh
              ? '插入/删除/移动行列没法原地存回 .xlsx (会弄乱公式和格式), 这次没保存。结构调整请在 Excel/WPS 里做; 只改格子内容的话, 关掉这张表重开再改。'
              : 'Inserting/deleting/moving rows or columns cannot be saved back into the .xlsx in place (it would corrupt formulas and formatting), so nothing was saved. Do structural changes in Excel/WPS; to edit cell contents, reopen this sheet.');
          }
          const base = baselineRef.current;
          const patch = api?.surfacePatchXlsx;
          if (!base || !patch) throw new Error(isZh ? '保存通道不可用 (surfacePatchXlsx)' : 'Save bridge unavailable (surfacePatchXlsx)');
          let groups;
          try {
            groups = diffUniverCells(base.cells, wbData, base.names);
          } catch (err: any) {
            if (err?.message === 'NEW_SHEET') {
              throw new Error(isZh ? '在这里新建的工作表没法存回原文件, 这次没保存。请在 Excel/WPS 里加表。' : 'Sheets created here cannot be saved into the original file; nothing was saved. Add sheets in Excel/WPS.');
            }
            throw err;
          }
          for (const g of groups) {
            result = await patch(filePath, g.sheet, g.edits);
            if (result?.success === false) break;
          }
          if (result?.success !== false) baselineRef.current = { cells: snapshotUniverCells(wbData), names: base.names };
        }
        if (result?.success === false) {
          dirtyRef.current = true;
          throw new Error(result.error || (isZh ? '写盘失败' : 'write failed'));
        }

        setSaveState('saved');
        /* 1.5s 后角标淡出回 idle, 除非期间又有新变更进了 'saving' */
        if (savedBadgeTimerRef.current != null) clearTimeout(savedBadgeTimerRef.current);
        savedBadgeTimerRef.current = window.setTimeout(() => {
          setSaveState(prev => (prev === 'saved' ? 'idle' : prev));
        }, SAVED_BADGE_LINGER_MS);
      } catch (e: any) {
        setSaveErrorMsg(e?.message || String(e));
        setSaveState('error');
      } finally {
        isSavingRef.current = false;
        /* 期间又有变更进来 — 再 schedule 一次 (用 setTimeout 0 让 state 先 flush) */
        if (pendingAfterSaveRef.current) {
          pendingAfterSaveRef.current = false;
          window.setTimeout(() => { void flushSaveRef.current(); }, 0);
        }
      }
    };
  }, [surface.source, retryNonce]);

  const scheduleSave = () => {
    if (surface.source.type !== 'file') return;
    if (!initialLoadDoneRef.current) return;
    if (debounceTimerRef.current != null) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void flushSaveRef.current();
    }, SAVE_DEBOUNCE_MS);
  };

  /* 窗口/tab 失焦时立即 flush — cell 编辑结束的明确信号 */
  useEffect(() => {
    const onBlur = () => { void flushSaveRef.current(); };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  /* Ctrl/Cmd+S 强制 flush — 给用户"我刚保存了"的明确反馈 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void flushSaveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 主题切换要跟着走 —— detectIsDark() 只在 Univer init 那一刻读了一次,
   * 之后用户在设置里切明暗, 已经打开的表格会**一直停在旧主题**:
   * 深色界面里嵌着一张白表, 或反过来。
   *
   * 这是 render 期读 DOM 属性的通病 (data-theme 变了不会触发 React 重渲染,
   * 而这里连 render 都不经过 —— 值是烤进 Univer 实例里的)。同一个文件里
   * Markdown.tsx / IdeRightCardPanel.tsx 都配了 MutationObserver, 这里漏了。
   *
   * Univer 有现成的运行时开关 univerAPI.toggleDarkMode(boolean), 直接调它;
   * header chrome 是我们自己画的, 一并跟着刷。 */
  useEffect(() => {
    const root = document.documentElement;
    let last = detectIsDark();
    const apply = () => {
      const now = detectIsDark();
      if (now === last) return;
      last = now;
      const api = univerRef.current?.univerAPI;
      if (!api) return;
      try { api.toggleDarkMode?.(now); } catch { /* Univer 版本没有这个 API 就算了, 不能因此崩掉表格 */ }
      try { scheduleNeoxSheetHeaderChrome(api, now, () => false); } catch { /* 同上 */ }
    };
    const mo = new MutationObserver(apply);
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-theme-preset'] });
    /* 跟随系统的用户 (没显式选过明暗) 不会改 data-theme, 只会变 prefers-color-scheme */
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', apply);
    return () => { mo.disconnect(); mq?.removeEventListener?.('change', apply); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    /* 重新挂载时重置 save 状态 */
    initialLoadDoneRef.current = false;
    dirtyRef.current = false;
    structuralRef.current = false;
    baselineRef.current = null;
    setSaveState('idle');
    setSaveErrorMsg(null);

    const init = async () => {
      try {
        /* Step 1: 读源数据 */
        let workbookData: any;
        if (surface.source.type === 'inline') {
          /* agent 直接给 IWorkbookData JSON */
          try {
            workbookData = JSON.parse(surface.source.content);
          } catch {
            setError(isZh ? 'inline content 不是有效 IWorkbookData JSON' : 'Inline content is not valid IWorkbookData JSON');
            setLoading(false);
            return;
          }
        } else if (surface.source.type === 'file') {
          const path = surface.source.path;
          const api = (window as any).neox;
          const reader = api?.surfaceReadFile ?? api?.readFile;
          /* 必须读 raw bytes — Univer/SheetJS 解析 .xlsx 二进制. surfaceReadFile 默认返
           * 文本; 给 encoding='binary'/'base64' 参数让它返字节 (跟现有 image / pdf surface 同范式). */
          const result = await reader?.(path, { encoding: 'base64' });
          if (cancelled) return;
          if (result?.success === false) {
            setError(result.error || 'read failed');
            setLoading(false);
            return;
          }
          const base64 = typeof result === 'string' ? result : (result?.content ?? result?.data ?? '');
          if (!base64) {
            setError(isZh ? '文件为空或读取失败' : 'File is empty or could not be read');
            setLoading(false);
            return;
          }
          const approxBytes = Math.floor((base64.length * 3) / 4);
          if (approxBytes > EXCEL_SAFETY_LIMITS.maxBytes) {
            setError(isZh
              ? `文件过大: ${approxBytes} > ${EXCEL_SAFETY_LIMITS.maxBytes} bytes`
              : `File too large: ${approxBytes} > ${EXCEL_SAFETY_LIMITS.maxBytes} bytes`);
            setLoading(false);
            return;
          }
          const XLSX = await loadXlsx();
          if (cancelled) return;
          /* 让骨架先上屏: 下面 XLSX.read 是同步大活, 不先让出一拍, 用户只会看到一片空白。
           * 用 setTimeout(0) 而不是 rAF —— 窗口不可见/后台时 rAF 会被节流到几秒一次。 */
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (cancelled) return;
          xlsxModuleRef.current = XLSX;
          const head = atob(base64.slice(0, 8));
          const isZipBinary = head.charCodeAt(0) === 0x50 && head.charCodeAt(1) === 0x4b;
          let wb;
          if (isZipBinary) {
            sourceFormatRef.current = 'xlsx';
            /* cellNF: 带上每格的数字格式 (cell.z), 公式格算出来按它显示 (见 xlsxToUniverWorkbookData) */
            wb = XLSX.read(base64, { ...SAFE_XLSX_READ_OPTIONS, type: 'base64', cellFormula: true, sheetStubs: true, cellNF: true });
            /* 图表 SheetJS 读不出来, 预览画不了: 文件里有 (zip 目录里出现 xl/charts/) 就明说, 别让人以为图表丢了。
             * 只做 base64 子串探测, 不把整份文件 atob 回二进制 (S-05: 大表格首屏不再为查一个字符串付全量解码)。 */
            try {
              if (base64Mentions(base64, 'xl/charts/chart')) {
                dispatchHint(isZh ? '这个表格里有图表，预览暂不显示，用 Excel 打开可以看到' : 'This workbook has charts — open it in Excel to see them', 'info');
              }
            } catch { /* 探测失败不影响预览 */ }
          } else {
            sourceFormatRef.current = /\.tsv$/i.test(path) ? 'tsv' : 'csv';
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            let text = new TextDecoder('utf-8').decode(bytes);
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
            wb = XLSX.read(text, { ...SAFE_XLSX_READ_OPTIONS, type: 'string' });
          }
          const fileName = path.split(/[/\\]/).pop() ?? 'workbook';
          workbookData = xlsxToUniverWorkbookData(XLSX, wb, fileName);
          /* 存盘差量的基准: 加载那一刻的格子 + sheetId → 原 sheet 名 (xlsxToUniverWorkbookData 按同一顺序编 id) */
          const names: Record<string, string> = {};
          safeSheetNames(wb).forEach((n: string, i: number) => { names[`sheet-${i}`] = n; });
          baselineRef.current = { cells: snapshotUniverCells(workbookData), names };
        } else {
          setError(isZh ? 'sheet surface 仅支持 file 或 inline source' : 'Sheet surfaces only support file or inline sources');
          setLoading(false);
          return;
        }

        /* Step 2: 懒加载 Univer 并初始化 */
        const { createUniver, UniverSheetsCorePreset, LocaleType, defaultTheme, zhCN, enUS } = await loadUniverModules();
        if (cancelled) return;
        if (!containerRef.current) return;

        /* Univer 内部 locale 跟随 UI 语言 (useI18n), 不再读 document.lang */
        const { univer, univerAPI } = createUniver({
          locale: isZh ? LocaleType.ZH_CN : LocaleType.EN_US,
          locales: { [LocaleType.ZH_CN]: zhCN, [LocaleType.EN_US]: enUS },
          darkMode: detectIsDark(),
          theme: buildNeoxUniverTheme(defaultTheme, detectIsDark()),
          presets: [
            UniverSheetsCorePreset({
              container: containerRef.current,
              /* B-MVP: 允许 cell 编辑, 通过 onCommandExecuted + auto-save 写回磁盘.
               * 顶部菜单/ribbon/公式栏仍然隐藏 — Phase 1 保持轻量, 只暴露 cell-level 编辑. */
              header: false,
              toolbar: false,
              footer: true,
              formulaBar: false,
              /* 滚动条悬浮: 默认 track 是 rgba(255,255,255,0.5), 暗色 invert 后变黑底条.
               * 轨透明只留 thumb, 视觉上浮在表格上. */
              scrollConfig: {
                trackBackgroundColor: 'rgba(0,0,0,0)',
                trackBorderColor: 'rgba(0,0,0,0)',
                barBorder: 0,
                barSize: 8,
                thumbMargin: 2,
                thumbBackgroundColor: 'rgba(24, 28, 42, 0.35)',
                thumbHoverBackgroundColor: 'rgba(24, 28, 42, 0.5)',
                thumbActiveBackgroundColor: 'rgba(24, 28, 42, 0.65)',
              },
            }),
          ],
        });

        univerRef.current = { univer, univerAPI };

        /* Step 3: 注入数据 */
        univerAPI.createUniverSheet(workbookData);

        /* Step 3b: 暗色 header chrome + 关掉左上角亮描边 (多次重试防被骨架重建冲掉) */
        scheduleNeoxSheetHeaderChrome(univerAPI, detectIsDark(), () => cancelled);
        if (cancelled) return;

        /* Step 4: 接 cell change 监听 — 文件 source 才接, inline 编辑只在内存
         * createUniverSheet 注入数据本身会 fire 一堆 mutation, 用 initialLoadDoneRef 屏蔽这第一波,
         * 否则一打开就会触发一次"无意义 save" (内容跟磁盘一模一样, 但浪费一次 IO). */
        if (surface.source.type === 'file') {
          const fWorkbook = univerAPI.getActiveWorkbook?.();
          if (fWorkbook?.onCommandExecuted) {
            fWorkbook.onCommandExecuted((command: any) => {
              if (!initialLoadDoneRef.current) return;
              if (!isMutationCommand(command?.id)) return;
              if (isStructuralCommand(command?.id)) structuralRef.current = true;
              dirtyRef.current = true;
              scheduleSave();
            });
          }
          /* 给 createUniverSheet 一帧时间把首批 mutation 走完, 之后再开闸接用户编辑 */
          window.setTimeout(() => { initialLoadDoneRef.current = true; }, 100);
        } else {
          initialLoadDoneRef.current = true; /* inline 不接 save, 但状态机要正常 */
        }

        setLoading(false);
        setError(null);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || String(err));
          setLoading(false);
        }
      }
    };

    void init();

    return () => {
      cancelled = true;
      /* 卸载前 flush 一次未 save 的变更 — 等不到完成, 但至少不丢编辑 */
      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        void flushSaveRef.current();
      }
      if (savedBadgeTimerRef.current != null) {
        clearTimeout(savedBadgeTimerRef.current);
        savedBadgeTimerRef.current = null;
      }
      const dying = univerRef.current?.univer;
      univerRef.current = null;
      if (dying) {
        setTimeout(() => { try { dying.dispose(); } catch { /* ignore */ } }, 0);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  /* 右上角 save 角标 — file source 才显示, inline 不写盘没有 save 状态 */
  const showSaveBadge = surface.source.type === 'file' && saveState !== 'idle';
  const saveBadgeText: string =
    saveState === 'saving' ? (isZh ? '保存中…' : 'Saving…')
    : saveState === 'saved' ? (isZh ? '已保存' : 'Saved')
    : saveState === 'error' ? (isZh ? '保存失败' : 'Save failed')
    : '';
  const saveBadgeColor: string =
    saveState === 'saving' ? 'rgba(99, 102, 241, 0.18)'   /* indigo */
    : saveState === 'saved' ? 'rgba(34, 197, 94, 0.20)'   /* green */
    : saveState === 'error' ? 'rgba(239, 68, 68, 0.22)'   /* red */
    : 'transparent';

  /* Wave 12 (5.2): Undo / Redo — 走 Univer Facade 已有的 fWorkbook.undo()/.redo()
   *  (内部 syncExecuteCommand UndoCommand.id / RedoCommand.id). 焦点在 sheet 时 ⌘Z/⌘⇧Z
   *  由 Univer 内部 keyboard service 处理; 这里只补外部按钮入口给鼠标用户. */
  const handleUndo = useCallback(() => {
    try { univerRef.current?.univerAPI?.getActiveWorkbook?.()?.undo?.(); }
    catch (err) { console.warn('[SheetSurfaceViewer] undo failed:', err); }
  }, []);
  const handleRedo = useCallback(() => {
    try { univerRef.current?.univerAPI?.getActiveWorkbook?.()?.redo?.(); }
    catch (err) { console.warn('[SheetSurfaceViewer] redo failed:', err); }
  }, []);

  return (
    <div className="sfc-sheet" style={{ position: 'relative', width: '100%', height: '100%', minHeight: 400 }}>
      {/* Wave 13: 跨 surface 文件锁冲突 banner — 仅警告不阻断, 用户主动接管才换持有者 */}
      {!fileLock.owned && fileLock.conflictWith && (
        <div className="sfc-lock-banner">
          <span>{isZh
            ? `⚠ 已被另一会话编辑 (surface: ${fileLock.conflictWith.slice(0, 8)}…), 你的修改可能被覆盖`
            : `⚠ Being edited in another session (surface: ${fileLock.conflictWith.slice(0, 8)}…) — your changes may be overwritten`}</span>
          <button type="button" onClick={fileLock.takeOver}>{isZh ? '强制接管' : 'Take over'}</button>
        </div>
      )}
      {loading && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 2, display: 'flex' }}>
          <PreviewSkeleton kind="sheet" label={isZh ? '正在加载表格…' : 'Loading sheet…'} />
        </div>
      )}
      {error && (
        <PreviewErrorState
          rawError={error}
          isZh={isZh}
          onRetry={() => retryOrReload(error, () => setRetryNonce((n) => n + 1))}
          onOpenExternal={lockPath ? () => { void openExternal(); } : undefined}
          externalError={externalError}
          retryLabel={retryLabel(error, isZh)}
        />
      )}
      {/* inline source: 编辑只在内存不落盘 — 明确提示, 避免用户以为改动已保存 */}
      {!loading && !error && surface.source.type === 'inline' && (
        <div
          className="sfc-sheet__inline-note"
          title={isZh
            ? '这是 Agent 直接生成的内存表格, 没有对应文件。在这里的编辑不会保存 — 需要留存请让 Agent 导出为 .xlsx。'
            : 'This sheet was generated in memory by the agent — there is no file behind it. Edits here are not saved; ask the agent to export an .xlsx to keep it.'}
        >
          {isZh ? '内存预览 · 编辑不落盘' : 'In-memory preview · edits not saved'}
        </div>
      )}
      {showSaveBadge && (
        <div
          title={saveErrorMsg ?? saveBadgeText}
          style={{
            /* saving badge 单独浮在 viewer 内左上角 — 外部打开/导出已挪到 host 的 tabbar toolbar.
             * 左上角不挡 cell A1 (Univer 标尺 + 编号已经占位); 不跟 tab 行重叠 (tab 在 host 层外). */
            position: 'absolute',
            top: 10,
            left: 12,
            zIndex: 5,
            padding: '4px 10px',
            fontSize: 12,
            lineHeight: 1.4,
            borderRadius: 999,
            background: saveBadgeColor,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            color: 'var(--neox-text-primary, #ddd)',
            border: '1px solid rgba(255,255,255,0.08)',
            pointerEvents: saveState === 'error' ? 'auto' : 'none',
            transition: 'opacity 200ms ease',
          }}
        >
          {saveBadgeText}
        </div>
      )}
      <div
        ref={containerRef}
        className="sfc-sheet__univer"
        style={{ width: '100%', height: '100%', minHeight: 400, display: error ? 'none' : 'block' }}
      />
      {!loading && !error && (
        <div className="sfc-sheet__history">
          <button
            type="button"
            className="sfc-sheet__history-btn"
            onClick={handleUndo}
            title={isZh ? `撤销 (${kbd('mod+z')})` : `Undo (${kbd('mod+z')})`}
            aria-label={isZh ? '撤销' : 'Undo'}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5.5 3.5 2.5 6.5l3 3" /><path d="M2.5 6.5h7a4 4 0 0 1 0 8H7" />
            </svg>
          </button>
          <button
            type="button"
            className="sfc-sheet__history-btn"
            onClick={handleRedo}
            title={isZh ? `重做 (${kbd('mod+shift+z')})` : `Redo (${kbd('mod+shift+z')})`}
            aria-label={isZh ? '重做' : 'Redo'}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m10.5 3.5 3 3-3 3" /><path d="M13.5 6.5h-7a4 4 0 0 0 0 8H9" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

/** Sheet host — 多 tab 模式, 但 chrome 全部由 SurfacePanel 接管.
 *   这里只根据 metadata.tabs/activeTabId 决定:
 *     · 空 tabs → KindHomeView (新建 / 打开 引导)
 *     · 有 tab → SingleSheetView (key=tab.url 切 tab 自然 unmount/dispose Univer) */
export const SheetSurfaceViewer: React.FC<Props> = ({ surface }) => {
  const { activeSession, workspacePath } = useNeoxRuntime();
  const sessionId = activeSession?.id ?? '';

  const tabs = useMemo(() => {
    const raw = (surface.metadata?.tabs as Array<{ id: string; url: string; title?: string }> | undefined);
    /* 过滤 inline placeholder (旧 home 请求误存的 stale tab, 挡 home view) */
    const cleaned = (raw ?? []).filter(t => !String(t.url ?? '').startsWith('inline-'));
    if (cleaned.length > 0) return cleaned;
    if (surface.source.type === 'file') {
      return [{ id: surface.id, url: surface.source.path, title: surface.title }];
    }
    if (surface.source.type === 'inline' && surface.source.content) {
      return [{ id: surface.id, url: `inline-${surface.id}`, title: surface.title || 'inline' }];
    }
    return [];
  }, [surface.metadata, surface.source, surface.id, surface.title]);

  const activeTabId = (surface.metadata?.activeTabId as string | undefined) ?? tabs[0]?.id;
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  if (!activeTab) {
    return <KindHomeView kind="sheet" sessionId={sessionId} surfaceId={surface.id} workspacePath={workspacePath} />;
  }

  const isInline = activeTab.url.startsWith('inline-');
  const fakeSurface: Surface = {
    ...surface,
    id: activeTab.id,
    title: activeTab.title || activeTab.url.split(/[/\\]/).pop() || '',
    source: isInline
      ? (surface.source.type === 'inline' ? surface.source : { type: 'file', path: activeTab.url })
      : { type: 'file', path: activeTab.url },
  };

  return <SingleSheetView key={activeTab.url} surface={fakeSurface} />;
};

export default SheetSurfaceViewer;
