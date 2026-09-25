/**
 * 大文件处理阈值 —— 借鉴 IntelliJ 的三级策略:
 *
 *  - FileSizeLimit.isTooLargeForIntelligence  (≈ 2.5MB)   → 禁语义
 *  - FileSizeLimit.isTooLargeForContentLoading (≈ 20MB)   → 进 LargeFileEditor (page-loaded)
 *  - 再往上只给 read-only viewer
 *
 * 我们的映射:
 *
 *  LARGE_FILE_BYTES  (2MB)   → Monaco 关 folding / minimap / bracket / codeLens / wordWrap
 *                              (见 CodeEditor.tsx)
 *  HUGE_FILE_BYTES   (20MB)  → 不走 Monaco, 改用 LargeFileViewer (分页虚拟列表)
 *                              只读, 搜索走主进程 ripgrep (当前版本未接, 占位)
 *
 * 值的选取依据:
 *   - Monaco piece-tree 在 2MB 以下 tokenization 基本无感
 *   - 20MB 往上一次性 `setValue(content)` 可能阻塞主线程几百 ms
 *   - 统一在这里, 避免各处漂
 */

export const LARGE_FILE_BYTES = 2 * 1024 * 1024;
export const HUGE_FILE_BYTES = 20 * 1024 * 1024;

/** 分页大小 —— 对齐 IntelliJ 默认 100KB (PropertiesGetter.getPageSize) */
export const LARGE_FILE_PAGE_SIZE = 100 * 1024;

/**
 * 判断文件大小落在哪个档位.
 *
 * 'normal'  → 完整 Monaco
 * 'large'   → Monaco + 禁重特性
 * 'huge'    → 分页 viewer (不走 Monaco)
 */
export type LargeFileTier = 'normal' | 'large' | 'huge';

export function classifyFileSize(bytes: number): LargeFileTier {
  if (bytes > HUGE_FILE_BYTES) return 'huge';
  if (bytes > LARGE_FILE_BYTES) return 'large';
  return 'normal';
}
