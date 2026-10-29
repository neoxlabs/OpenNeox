/**
 * Registry for common tool-name variants. Built-in aliases and Tool metadata resolve to one
 * canonical name at runtime.
 */

/** 内置别名映射：别名 → 规范名 */
const BUILTIN_ALIASES: Record<string, string> = {
  // Shell 工具变体
  'bash': 'execute_shell',
  'Bash': 'execute_shell',
  'shell': 'execute_shell',
  'run_command': 'execute_shell',
  'run_shell': 'execute_shell',
  'terminal': 'execute_shell',

  // 文件读取变体
  'read': 'readfile',
  'Read': 'readfile',
  'read_file': 'readfile',
  'cat': 'readfile',
  'smart_read': 'readfile',

  // 文件写入变体
  'Write': 'write_file',
  'create_file': 'write_file',

  // 编辑变体
  'Edit': 'edit',
  'edit_file': 'edit',
  'modify_file': 'edit',
  'patch_file': 'edit',

  // 搜索变体
  'Grep': 'search',
  'grep': 'search',
  'ripgrep': 'search',
  'rg': 'search',
  'find_in_files': 'search',
  'code_search': 'search',

  // Glob 变体
  'Glob': 'search_files',
  'glob': 'search_files',
  'find_files': 'search_files',
  'locate': 'search_files',

  // 目录变体
  'ls': 'list_directory',
  'dir': 'list_directory',
  'list_dir': 'list_directory',

  // Git 变体
  'git_log': 'git_status',  // 部分模型混用

  // 删除变体
  'remove_file': 'delete_file',
  'rm': 'delete_file',

  // 目录创建变体
  'mkdir': 'create_directory',
  'make_directory': 'create_directory',

  // Web 变体
  'WebSearch': 'web_search',
  'WebFetch': 'web_fetch',
  'fetch_url': 'web_fetch',
  'http_get': 'web_fetch',
};

export class ToolAliasRegistry {
  /** 别名 → 规范名 */
  private aliasMap = new Map<string, string>();
  /** 规范名集合（用于快速判断是否是规范名） */
  private canonicalNames = new Set<string>();

  constructor() {
    // 加载内置别名
    for (const [alias, canonical] of Object.entries(BUILTIN_ALIASES)) {
      this.aliasMap.set(alias, canonical);
    }
  }

  /**
   * 从 Tool[] 构建别名表
   * 会读取 Tool.aliases 字段并合并内置别名
   */
  buildFromTools(tools: Array<{ name: string; aliases?: string[] }>): void {
    this.canonicalNames.clear();

    for (const tool of tools) {
      this.canonicalNames.add(tool.name);

      // Tool 接口上声明的别名
      if (tool.aliases) {
        for (const alias of tool.aliases) {
          // 不覆盖已注册的规范名
          if (!this.canonicalNames.has(alias)) {
            this.aliasMap.set(alias, tool.name);
          }
        }
      }
    }

    // 清理冲突：如果某个别名恰好是另一个工具的规范名，移除别名
    for (const [alias, _canonical] of this.aliasMap) {
      if (this.canonicalNames.has(alias)) {
        this.aliasMap.delete(alias);
      }
    }
  }

  /**
   * 解析工具名 — 返回规范名
   * 如果输入已经是规范名，原样返回
   * 如果是别名，返回对应的规范名
   * 如果都不是，返回 null
   */
  resolve(name: string): string | null {
    if (this.canonicalNames.has(name)) {
      return name;
    }
    return this.aliasMap.get(name) ?? null;
  }

  /**
   * 尝试解析，找不到时返回原名（用于日志等非关键路径）
   */
  resolveOrPassthrough(name: string): string {
    return this.resolve(name) ?? name;
  }

  /** 获取某个规范名的所有别名 */
  getAliases(canonicalName: string): string[] {
    const aliases: string[] = [];
    for (const [alias, canonical] of this.aliasMap) {
      if (canonical === canonicalName) {
        aliases.push(alias);
      }
    }
    return aliases;
  }

  /** 别名总数 */
  get size(): number {
    return this.aliasMap.size;
  }
}

/** 全局单例 */
export const toolAliasRegistry = new ToolAliasRegistry();
