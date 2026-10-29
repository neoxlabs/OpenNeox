/**
 * VfsUri —— 轻量 URI 类型, 对齐 VS Code `vscode.Uri` 语义但不引入依赖.
 *
 * 支持的格式:
 *   - `file:///abs/path`        (authority 为空, path 以 `/` 开头)
 *   - `memory:buffer-id`        (无 authority, path 直接在 scheme 后)
 *   - `memory:///anonymous-1`   (有 `///` 也接受)
 *   - `git://host/repo/file.ts` (远程/自定义 scheme)
 *
 * 故意裁剪:
 *   - 不支持 query / fragment (可后续加)
 *   - 不做百分号编码 / 解码 (路径里不要含 ? # 等特殊字符, 调用方自己避免)
 *   - 不校验 scheme 字符集 (宽松接受字母数字点加减下划线, 插件可能用创意 scheme)
 *
 * 与现有 `path: string` 的兼容:
 *   - `Uri.file(absPath)` 把本地路径转成 `file://` URI
 *   - `uri.fsPath` 从 `file://` URI 取回原路径 (仅 file: scheme)
 */

export class VfsUri {
  /** 协议, e.g. "file", "memory", "git". 小写, 无冒号. */
  readonly scheme: string;
  /** authority (可空), e.g. file:// 的空串, git://host/... 的 "host". */
  readonly authority: string;
  /** path. 对 file:// 是文件系统路径; 对 memory: 是 buffer id. */
  readonly path: string;

  private constructor(scheme: string, authority: string, path: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
  }

  /**
   * 从字符串 parse. 严格失败模式 —— 格式不对抛 Error.
   *
   * 支持:
   *   - `scheme:path`                        —— 无 authority
   *   - `scheme://authority/path`            —— 有 authority
   *   - `scheme:///path`                     —— 空 authority + 绝对 path (file://)
   *   - `scheme://`                          —— 空 authority + 空 path
   */
  static parse(raw: string): VfsUri {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`VfsUri.parse: expected non-empty string, got ${typeof raw}`);
    }
    const colonIdx = raw.indexOf(':');
    if (colonIdx <= 0) {
      throw new Error(`VfsUri.parse: missing scheme in "${raw}"`);
    }
    const scheme = raw.slice(0, colonIdx).toLowerCase();
    const rest = raw.slice(colonIdx + 1);

    if (rest.startsWith('//')) {
      // scheme://authority/path 形式
      const afterSlash = rest.slice(2);
      const slashIdx = afterSlash.indexOf('/');
      if (slashIdx < 0) {
        // scheme://authority (没有后续 path)
        return new VfsUri(scheme, afterSlash, '');
      }
      const authority = afterSlash.slice(0, slashIdx);
      const path = afterSlash.slice(slashIdx);
      return new VfsUri(scheme, authority, path);
    }

    // scheme:path 形式 —— authority 空
    return new VfsUri(scheme, '', rest);
  }

  /**
   * 构造 `file://` URI. 必须传绝对路径 (UNIX 或 Windows).
   *
   * 规范化:
   *   - 反斜杠 → 正斜杠
   *   - Windows 盘符前补 `/` → `file:///C:/Users/...`
   *   - UNIX 绝对路径直接 `file://` + path
   */
  static file(absPath: string): VfsUri {
    if (!absPath) throw new Error('VfsUri.file: empty path');
    let norm = absPath.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(norm)) {
      // Windows drive letter: file:///C:/...
      norm = '/' + norm;
    }
    if (!norm.startsWith('/')) {
      throw new Error(`VfsUri.file: expected absolute path, got "${absPath}"`);
    }
    return new VfsUri('file', '', norm);
  }

  /** 显式构造 —— 适合非 file:// scheme. */
  static from(parts: { scheme: string; authority?: string; path?: string }): VfsUri {
    if (!parts.scheme) throw new Error('VfsUri.from: scheme required');
    return new VfsUri(
      parts.scheme.toLowerCase(),
      parts.authority ?? '',
      parts.path ?? '',
    );
  }

  /**
   * 仅对 file:// scheme 有效: 取出文件系统路径.
   * Windows 会去掉前导 `/` (file:///C:/... → C:/...).
   */
  get fsPath(): string {
    if (this.scheme !== 'file') {
      throw new Error(`VfsUri.fsPath: not a file:// URI (scheme=${this.scheme})`);
    }
    if (/^\/[a-zA-Z]:/.test(this.path)) {
      return this.path.slice(1);
    }
    return this.path;
  }

  /** 序列化. 与 parse 互逆. */
  toString(): string {
    // file://... 即使 authority 空也保留 `//` 前缀以产生 file:///abs 规范形式
    if (this.authority || this.path.startsWith('/')) {
      return `${this.scheme}://${this.authority}${this.path}`;
    }
    return `${this.scheme}:${this.path}`;
  }

  /** 结构化相等: scheme + authority + path 全部相等. */
  equals(other: VfsUri): boolean {
    return (
      this.scheme === other.scheme &&
      this.authority === other.authority &&
      this.path === other.path
    );
  }

  /** 派生 URI: 同 scheme/authority, 替换 path. 典型用途: 在同一 VFS 下 resolve 子路径. */
  withPath(newPath: string): VfsUri {
    return new VfsUri(this.scheme, this.authority, newPath);
  }
}

/** 工厂快捷函数 —— 避免在调用点写 `new` 或长名字. */
export const uri = {
  parse: VfsUri.parse,
  file: VfsUri.file,
  from: VfsUri.from,
};
