/**
 * fileSystemService - Renderer 侧文件操作的统一抽象层
 *
 * 设计原则:
 * 1. UI 组件不直接调 window.neox.*,而是调本服务的方法
 * 2. 所有方法返回 typed Result,UI 不需要关心 success/error 字段细节
 * 3. 失败统一通过抛错传播,UI 可以 try/catch + toast.error()
 * 4. 便于以后加 telemetry / mock / batched ops
 *
 * 对应:
 *   - main: src/ui/electron/ipc/fileOpsHandlers.ts
 *   - preload: src/ui/electron/preload.js (window.neox.fs*)
 */

interface NeoxFsBridge {
  fsRename: (oldPath: string, newName: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsCreate: (
    parentDir: string,
    name: string,
    isDirectory: boolean
  ) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsDuplicate: (srcPath: string) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsCopyTo: (srcPath: string, destDir: string, opts?: { external?: boolean }) => Promise<{ success: boolean; newPath?: string; error?: string }>;
  fsMoveTo: (
    srcPath: string,
    destDir: string
  ) => Promise<{ success: boolean; newPath?: string; error?: string; noop?: boolean }>;
  fsTrash: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  fsRevealInFinder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
  fsOpenInTerminal: (dirPath: string) => Promise<{ success: boolean; error?: string }>;
  fsExists: (filePath: string) => Promise<{ success: boolean; exists?: boolean; error?: string }>;
}

function getBridge(): NeoxFsBridge {
  if (typeof window === 'undefined' || !window.neox) {
    throw new Error('Neox bridge not available (preload not loaded?)');
  }
  return window.neox;
}

/** 把 IPC result 解开,失败抛错 */
function unwrap<T extends { success: boolean; error?: string }>(result: T): T {
  if (!result.success) {
    throw new Error(result.error || 'Unknown file system error');
  }
  return result;
}

export const fileSystemService = {
  /**
   * 重命名文件 / 文件夹(只改 basename,不能跨目录)
   * @param oldPath 原绝对路径
   * @param newName 新名字(只是 basename,不含路径分隔符)
   */
  async rename(oldPath: string, newName: string): Promise<string> {
    const result = unwrap(await getBridge().fsRename(oldPath, newName));
    return result.newPath!;
  },

  /**
   * 在指定目录创建新文件 / 新文件夹
   * @param parentDir 父目录绝对路径
   * @param name 新文件 / 文件夹名(basename)
   * @param isDirectory true=新建文件夹,false=新建空文件
   */
  async create(parentDir: string, name: string, isDirectory: boolean): Promise<string> {
    const result = unwrap(await getBridge().fsCreate(parentDir, name, isDirectory));
    return result.newPath!;
  },

  /**
   * 复制文件 / 文件夹到同目录,自动加 " copy" 后缀
   * 跟 IDEA Cmd+D 的 Duplicate 行为一致
   */
  async duplicate(srcPath: string): Promise<string> {
    const result = unwrap(await getBridge().fsDuplicate(srcPath));
    return result.newPath!;
  },

  /**
   * 把文件复制到目标目录 (剪贴板 Copy + Paste + Finder 拖入)
   * @param opts.external true = 从 workspace 外部拷入 (Finder 拖入), src 免 workspace 沙箱校验;
   *                       false/omit = 严格沙箱, src 也必须在 workspace 内 (剪贴板 paste / 内部拖).
   */
  async copyTo(srcPath: string, destDir: string, opts?: { external?: boolean }): Promise<string> {
    const result = unwrap(await getBridge().fsCopyTo(srcPath, destDir, opts));
    return result.newPath!;
  },

  /**
   * 把文件移动到目标目录(剪贴板 Cut + Paste 用)
   */
  async moveTo(srcPath: string, destDir: string): Promise<string> {
    const result = unwrap(await getBridge().fsMoveTo(srcPath, destDir));
    return result.newPath!;
  },

  /**
   * 移到系统回收站(IDEA "Move to Trash" / Safe Delete)
   * 默认删除路径,可恢复
   */
  async trash(filePath: string): Promise<void> {
    unwrap(await getBridge().fsTrash(filePath));
  },

  /**
   * 在系统文件管理器中显示文件(macOS Finder / Windows Explorer / Linux file manager)
   */
  async revealInFinder(filePath: string): Promise<void> {
    unwrap(await getBridge().fsRevealInFinder(filePath));
  },

  /**
   * 在系统终端打开目录(如果传入是文件,打开它的父目录)
   */
  async openInTerminal(dirPath: string): Promise<void> {
    unwrap(await getBridge().fsOpenInTerminal(dirPath));
  },

  /**
   * 检查文件 / 文件夹是否存在(用于 Rename / New File 的前置校验)
   */
  async exists(filePath: string): Promise<boolean> {
    const result = unwrap(await getBridge().fsExists(filePath));
    return result.exists ?? false;
  },

  /**
   * 把绝对路径写入系统剪贴板(IDEA "Copy Path")
   * 不需要 IPC,直接用 Web Clipboard API
   */
  async copyPathToClipboard(filePath: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }
    await navigator.clipboard.writeText(filePath);
  },

  /**
   * 把相对 workspace 的路径写入系统剪贴板(IDEA "Copy Relative Path")
   */
  async copyRelativePathToClipboard(filePath: string, workspacePath: string): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      throw new Error('Clipboard API not available');
    }
    let relative = filePath;
    if (filePath.startsWith(workspacePath)) {
      relative = filePath.slice(workspacePath.length);
      if (relative.startsWith('/') || relative.startsWith('\\')) {
        relative = relative.slice(1);
      }
    }
    await navigator.clipboard.writeText(relative);
  },
};

export type FileSystemService = typeof fileSystemService;
