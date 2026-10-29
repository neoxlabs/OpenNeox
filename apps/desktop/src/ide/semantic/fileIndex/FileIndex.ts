/**
 * FileIndex —— 工程内所有"可索引文件"的清单。
 *
 * 作用
 * ----
 * 1. **Cmd+P 文件搜索的数据源**：Command Palette 的 FileContributor 直接查它
 * 2. **全量索引的工作队列**：bootstrap 时扫盘得到列表，逐个丢给 parser
 * 3. **增量的"认识这个文件"判断**：chokidar 报一个文件变动时，先过一下这里
 *    看是不是应该被索引
 *
 * 跟 SymbolStore 的关系
 * --------------------
 * - FileIndex 是 *内存* 索引，只是一份"路径清单"
 * - SymbolStore 是 *持久化* 索引，包含符号数据
 * - 启动时 FileIndex 从磁盘扫描建立，*不* 依赖 SymbolStore
 * - 两者通过文件 path 关联，没有直接代码依赖
 *
 * 为什么不放进 SymbolStore？
 * -------------------------
 * 性能：Cmd+P 是最常用的操作，要求 <10ms 响应。走 SQLite 虽然也快，
 * 但内存里的数组 + fuzzy matcher 是零开销的。
 *
 * 容量：一个 10 万文件的 monorepo，内存占用也就 10~20MB，完全可接受。
 */

export interface FileEntry {
  /** 绝对路径或 workspace 相对路径 —— 调用方统一用哪种就用哪种 */
  path: string;
  /** 文件名（basename），搜索时优先匹配它 */
  basename: string;
  /** 语言 id */
  language: string;
  /** 文件大小（字节），可选 */
  size?: number;
  /** mtime（epoch ms），可选 */
  mtime?: number;
}

export class FileIndex {
  private readonly entries: Map<string, FileEntry> = new Map();
  /**
   * basename → path 集合的反向索引。
   * 用于"我想找一个叫 foo.ts 的文件"的快速前缀查询 —— 不用遍历所有 entries。
   */
  private readonly basenameIndex: Map<string, Set<string>> = new Map();

  // --------------------------------------------------------------------------
  // Mutations
  // --------------------------------------------------------------------------

  /** 添加或更新一个文件 */
  upsert(entry: FileEntry): void {
    const existing = this.entries.get(entry.path);
    if (existing) {
      // basename 变了 → 更新反向索引
      if (existing.basename !== entry.basename) {
        this.removeFromBasenameIndex(existing.basename, existing.path);
      }
    }
    this.entries.set(entry.path, entry);
    this.addToBasenameIndex(entry.basename, entry.path);
  }

  /** 删除一个文件 */
  remove(path: string): boolean {
    const existing = this.entries.get(path);
    if (!existing) return false;
    this.removeFromBasenameIndex(existing.basename, path);
    this.entries.delete(path);
    return true;
  }

  /** 清空整个索引（workspace 切换时调用） */
  clear(): void {
    this.entries.clear();
    this.basenameIndex.clear();
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  has(path: string): boolean {
    return this.entries.has(path);
  }

  get(path: string): FileEntry | undefined {
    return this.entries.get(path);
  }

  /** 返回所有文件条目（供 fuzzy 搜索遍历） */
  all(): FileEntry[] {
    return Array.from(this.entries.values());
  }

  /** 数量 */
  size(): number {
    return this.entries.size;
  }

  /** 按 basename 的"等值"查询 —— 跳转到已知文件名时快得飞起 */
  findByBasename(basename: string): FileEntry[] {
    const paths = this.basenameIndex.get(basename);
    if (!paths) return [];
    const result: FileEntry[] = [];
    for (const p of paths) {
      const e = this.entries.get(p);
      if (e) result.push(e);
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // 私有
  // --------------------------------------------------------------------------

  private addToBasenameIndex(basename: string, path: string): void {
    let set = this.basenameIndex.get(basename);
    if (!set) {
      set = new Set();
      this.basenameIndex.set(basename, set);
    }
    set.add(path);
  }

  private removeFromBasenameIndex(basename: string, path: string): void {
    const set = this.basenameIndex.get(basename);
    if (!set) return;
    set.delete(path);
    if (set.size === 0) this.basenameIndex.delete(basename);
  }
}

/** 从 path 里提取 basename（不依赖 node:path，跨平台兼容） */
export function basenameOf(filePath: string): string {
  // 同时处理 / 和 \\
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
}
