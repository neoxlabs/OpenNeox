/**
 * _assertIpcArg — IPC handler 参数类型校验 (零依赖, 最小 surface)
 *
 * 背景 (audit 2 P0-3): preload.cjs 暴露 569 个 ipcRenderer.invoke handler 给 renderer.
 * Renderer 如被 XSS 污染, 可直接调任意 IPC handler 带任意 args. 之前缺统一类型校验,
 * 类似 `path:string` 这种约定靠 TS 编译时, 但运行时 renderer 可以传任何 JS 值
 * (null / array / object / undefined / 超长字符串 / 嵌入 \0 等).
 *
 * 这个 helper 是渐进 hardening 的第一步: 关键 handler 入口加 requireString / requireNumber
 * 之类的明确校验, 拒绝畸形参数. **不**用 Zod 等大库, 避免依赖膨胀.
 *
 * 用法:
 *   ipcMain.handle('fs:read', async (event, filePath: string) => {
 *     requireString(filePath, 'filePath', { maxLen: 4096, noNull: true });
 *     // ... rest of handler
 *   });
 */

const DEFAULT_MAX_STRING_LEN = 16 * 1024; // 16KB — 防 renderer 灌大 string DoS

export class IpcArgError extends Error {
  constructor(message: string) {
    super(`[IPC ARG] ${message}`);
    this.name = 'IpcArgError';
  }
}

export interface StringConstraints {
  /** 最大长度 (字符数), 默认 16K. file path 可设小一些 (e.g. 4096) */
  maxLen?: number;
  /** 是否允许空字符串. 默认 false (空串通常是 bug) */
  allowEmpty?: boolean;
  /** 拒绝嵌入的 NUL (\0) — 防止 Windows alternate-data-stream / Unix path 截断攻击 */
  noNull?: boolean;
  /** regex 必须 match. e.g. /^[A-Za-z0-9_-]+$/ for slug */
  pattern?: RegExp;
}

export function requireString(value: unknown, name: string, opts: StringConstraints = {}): string {
  if (typeof value !== 'string') {
    throw new IpcArgError(`${name} must be string, got ${value === null ? 'null' : typeof value}`);
  }
  const { maxLen = DEFAULT_MAX_STRING_LEN, allowEmpty = false, noNull = true, pattern } = opts;
  if (!allowEmpty && value.length === 0) {
    throw new IpcArgError(`${name} cannot be empty`);
  }
  if (value.length > maxLen) {
    throw new IpcArgError(`${name} exceeds max length ${maxLen} (got ${value.length})`);
  }
  if (noNull && value.includes('\0')) {
    throw new IpcArgError(`${name} contains embedded NUL — possible truncation attack`);
  }
  if (pattern && !pattern.test(value)) {
    throw new IpcArgError(`${name} does not match required pattern`);
  }
  return value;
}

export function requireNumber(value: unknown, name: string, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new IpcArgError(`${name} must be finite number, got ${value}`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    throw new IpcArgError(`${name} must be integer, got ${value}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new IpcArgError(`${name} must be >= ${opts.min}, got ${value}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new IpcArgError(`${name} must be <= ${opts.max}, got ${value}`);
  }
  return value;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new IpcArgError(`${name} must be boolean, got ${typeof value}`);
  }
  return value;
}

/**
 * 文件路径专用 — 限制 4096 字符 + 拒绝 NUL.
 * **不**做 path traversal 防护 — 那是 validateWorkspacePath 的事 (resolve 后比对 workspace root).
 * 这里只确保 string + 长度合理 + 无截断攻击.
 */
export function requireFilePath(value: unknown, name: string = 'filePath'): string {
  return requireString(value, name, { maxLen: 4096, noNull: true });
}

/**
 * 可选字符串 (允许 undefined / null), 但如果有值必须满足约束.
 */
export function optionalString(value: unknown, name: string, opts: StringConstraints = {}): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name, opts);
}
