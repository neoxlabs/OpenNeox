/**
 * Ripgrep stderr 过滤器
 *
 * macOS 的 TCC（Transparency, Consent, and Control）安全机制会阻止未获得
 * "全磁盘访问权限" 的进程读取某些受保护目录（如 ~/Library/Mail, ~/Library/HomeKit 等）。
 * 当 ripgrep 搜索 home 目录时，会在 stderr 中输出大量 "Operation not permitted" 警告，
 * 但搜索结果本身是正常的（exit code 0 或 1）。
 *
 * 如果用户已在 macOS 系统设置中授予了全磁盘访问权限，则不会出现这些错误，
 * ripgrep 可以正常搜索所有目录。
 *
 * 本模块过滤这些 OS 级权限噪音，避免干扰用户体验。
 */

/**
 * 需要过滤的 OS 级权限错误模式
 * 这些错误来自操作系统层面，不是文件本身的权限问题
 */
const OS_PERMISSION_ERROR_PATTERNS: RegExp[] = [
  // macOS TCC 保护
  /Operation not permitted \(os error 1\)/,
  // 标准 UNIX 权限拒绝（系统目录）
  /Permission denied \(os error 13\)/,
  // Windows 访问被拒绝
  /Access is denied \(os error 5\)/,
];

/**
 * Use the stable **os error code** shape to distinguish skipped paths from a search failure.
 * Localized text varies by operating system language, while ripgrep keeps the
 * path prefix and `(os error N)` suffix for this class of warning. Syntax and
 * argument errors do not have this shape and remain fatal.
 */
const PER_PATH_OS_ERROR = /\(os error \d+\)/i;

/** 这一行是不是"某个路径读不了"的逐路径警告 (跨语言) */
export function isPerPathRipgrepWarning(line: string): boolean {
  return PER_PATH_OS_ERROR.test(line);
}

/**
 * 过滤 ripgrep stderr 中的 OS 级权限错误
 *
 * @param stderr - ripgrep 的 stderr 输出
 * @returns 过滤后的 stderr（仅保留真正的错误信息）
 *
 * @example
 * ```
 * const raw = `rg: /Users/foo/Library/Mail: Operation not permitted (os error 1)
 * rg: /Users/foo/Library/HomeKit: Operation not permitted (os error 1)`;
 *
 * filterRipgrepStderr(raw); // => '' (全是权限噪音，过滤后为空)
 * ```
 */
export function filterRipgrepStderr(stderr: string): string {
  if (!stderr) return '';

  return stderr
    .split('\n')
    .filter(line => {
      if (!line.trim()) return false;
      /* 逐路径的 os error (任何语言、任何码) 一律是噪音 —— ripgrep 跳过那个路径继续搜完了 */
      if (isPerPathRipgrepWarning(line)) return false;
      // 过滤掉匹配 OS 级权限错误模式的行 (英文老判据保留, 覆盖没带 os error 码的变体)
      return !OS_PERMISSION_ERROR_PATTERNS.some(pattern => pattern.test(line));
    })
    .join('\n')
    .trim();
}

/**
 * TCC 检测结果
 */
export interface TCCDetectionResult {
  /** 是否检测到 TCC 权限问题 */
  hasTCCIssue: boolean;
  /** 受影响的目录数量 */
  affectedPaths: number;
  /** 用户友好的提示信息（仅第一次检测到时生成） */
  userHint?: string;
}

// 跟踪是否已经提示过，避免每次搜索都重复提示
let tccHintShown = false;

/**
 * 检测 stderr 中是否包含 macOS TCC 权限问题，并生成用户提示
 *
 *  核心逻辑：
 * - TCC 是 macOS 系统级保护，无法通过代码绕过
 * - CLI 程序不会触发系统授权弹窗（只有原生 App 才会）
 * - 用户需要手动去「系统设置 → 隐私与安全性 → 完全磁盘访问权限」添加终端应用
 * - 授权后需要重启终端才能生效
 *
 * @param stderr - ripgrep 的原始 stderr 输出
 * @returns TCC 检测结果
 */
export function detectTCCIssue(stderr: string): TCCDetectionResult {
  if (!stderr || process.platform !== 'darwin') {
    return { hasTCCIssue: false, affectedPaths: 0 };
  }

  const tccLines = stderr.split('\n').filter(line =>
    /Operation not permitted \(os error 1\)/.test(line)
  );

  if (tccLines.length === 0) {
    return { hasTCCIssue: false, affectedPaths: 0 };
  }

  const result: TCCDetectionResult = {
    hasTCCIssue: true,
    affectedPaths: tccLines.length,
  };

  // 只在第一次检测到时生成提示
  if (!tccHintShown) {
    tccHintShown = true;
    result.userHint = [
      `⚠️ 搜索跳过了 ${tccLines.length} 个 macOS 受保护目录`,
      `   部分目录（如 ~/Library/Mail 等）受 macOS 安全机制保护。`,
      `   如需搜索这些目录，请授予终端"完全磁盘访问权限"：`,
      `   系统设置 → 隐私与安全性 → 完全磁盘访问权限 → 添加终端应用`,
      `   授权后需重启终端生效。`,
    ].join('\n');
  }

  return result;
}

/**
 * 重置 TCC 提示状态（用于测试或新会话）
 */
export function resetTCCHintState(): void {
  tccHintShown = false;
}
