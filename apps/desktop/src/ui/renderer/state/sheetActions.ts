/**
 * sheetActions — Sheet surface 的 UI 动作 (新建 / 打开 / Home).
 *
 *   集中复用点 — SurfacePanel 的 "+ 打开 → 表格" 菜单和 SheetSurfaceViewer 的 home 页都调这两个.
 *   把 OS dialog + SheetJS 生成 + 落盘 + open surface 这条链路收拢到一起,
 *   避免 menu 和 home 页各写一遍跑歪.
 */

import { openSurfaceFromPath } from './openSurfaceFromPath';
import { ingestSurfaceEvent } from './surfaceStore';

/** "新建表格" — 弹 save-as → SheetJS 直接生成空 .xlsx → 写盘 → 自动 open. */
export async function createBlankSheet(opts: { sessionId: string; workspacePath?: string }): Promise<boolean> {
  const { sessionId, workspacePath } = opts;
  if (!sessionId) return false;
  const api = (window as any).neox;
  if (!api?.saveFileDialog || !api?.surfaceWriteFile) return false;

  /* 默认文件名带时间戳防覆盖, 用户可改 */
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const defaultName = `untitled-${ts}.xlsx`;
  const defaultDir = workspacePath ?? '';
  const defaultFull = defaultDir ? `${defaultDir.replace(/\/$/, '')}/${defaultName}` : defaultName;

  const picked = await api.saveFileDialog({
    title: '新建表格 — 选保存位置',
    defaultPath: defaultFull,
    filters: [{ name: 'Excel Spreadsheet', extensions: ['xlsx'] }],
  });
  if (!picked) return false;

  try {
    /* SheetJS 不接受完全空 wb (writeFile 会报 "sheets only"), 至少 1 sheet + 1 空 cell. */
    const xlsxMod: any = await import('xlsx').then(m => (m as any).default ?? m);
    const wb = xlsxMod.utils.book_new();
    const ws = xlsxMod.utils.aoa_to_sheet([['']]);
    xlsxMod.utils.book_append_sheet(wb, ws, 'Sheet1');
    const base64 = xlsxMod.write(wb, { type: 'base64', bookType: 'xlsx' });
    const result = await api.surfaceWriteFile(picked, base64, { encoding: 'base64' });
    if (result?.success === false) {
      // eslint-disable-next-line no-console
      console.error('新建表格写盘失败:', result.error);
      return false;
    }
    openSurfaceFromPath({ sessionId, path: picked, workspacePath });
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('新建表格失败:', e);
    return false;
  }
}

/** "打开表格" — OS 文件选择器 (filter .xlsx/.xls/.csv/.tsv) → 自动 open. */
export async function openExistingSheet(opts: { sessionId: string; workspacePath?: string }): Promise<boolean> {
  const { sessionId, workspacePath } = opts;
  if (!sessionId) return false;
  const api = (window as any).neox;
  if (!api?.openFileDialog) return false;

  const picked = await api.openFileDialog({
    defaultPath: workspacePath,
    filters: [
      { name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv', 'tsv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (!picked) return false;
  /* openSurfaceFromPath EXT_TO_KIND 已经把这些扩展名 route 到 'sheet'. */
  openSurfaceFromPath({ sessionId, path: picked, workspacePath });
  return true;
}

/** "打开表格专题 home" — 菜单 + 打开 → 表格 调.
 *   创建一个空 tabs 的 sheet host surface, 让 SheetSurfaceViewer 渲染 home 引导页
 *   (用户在 home 里点 "新建" 或 "打开" 就会触发上面两个 helper).
 *   如果已经存在 sheet host, 只切到它不重复创建.
 */
export function openSheetHome(opts: { sessionId: string }): void {
  const { sessionId } = opts;
  if (!sessionId) return;
  /* 走标准 ingest 通道 — sheet 分支会找现有 host 复用, 没有就建.
   * inline + content='' + 不传 path → host 第一个 "tab" 是空 placeholder,
   * host 组件渲染时检测 tab.url 为 'inline-<id>' 退化为 home 视图. */
  const id = `sfc-sheet-home-${Date.now()}`;
  ingestSurfaceEvent(sessionId, {
    action: 'open',
    surface: {
      id,
      kind: 'sheet',
      source: { type: 'inline', content: '' },
      title: '表格',
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      /* home placeholder 标记 — SurfacePanel chrome bar 计算 fileTabs 时跳过 isHome,
       *   viewer 看到空 tabs 自己渲染 KindHomeView (新建 / 打开 CTA). */
      metadata: { isHome: true },
    },
  }, { reveal: true });
}
