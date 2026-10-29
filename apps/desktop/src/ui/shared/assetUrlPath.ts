export function assetPathnameToAbsolute(pathname: string): string {
  const stripped = pathname.replace(/^\/+/, '');
  const isDriveAbs = /^[A-Za-z]:[\\/]/.test(stripped);
  const isUnc = /^[\\/]{2}[^\\/]/.test(stripped);
  return (isDriveAbs || isUnc) ? stripped : pathname;
}

export function absoluteToAssetUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const withLeading = normalized.startsWith('/') ? normalized : '/' + normalized;
  return 'neox-asset://local' + withLeading.split('/').map(encodeURIComponent).join('/');
}

/**
 * target 是否落在任一 allowedRoot 之下 (root 本身也算)。
 *
 * 判等口径由调用方以 keyOf 注入 —— 主进程传 workspaceKey (Windows 下大小写不敏感,
 * 且相对路径先 resolve); 抽成纯函数是为了能在单测里同时覆盖 POSIX / Windows 两种口径。
 * 用裸 startsWith 比会在 Windows 上把工作区里的图判成越权 403 (3b7f3c3ba 统一过)。
 */
export function isUnderAnyRoot(
  target: string,
  roots: Iterable<string>,
  keyOf: (p: string) => string,
): boolean {
  const targetKey = keyOf(target);
  if (!targetKey) return false;
  for (const root of roots) {
    const rootKey = keyOf(root);
    if (!rootKey) continue;
    if (targetKey === rootKey
      || targetKey.startsWith(rootKey + '/')
      || targetKey.startsWith(rootKey + '\\')) {
      return true;
    }
  }
  return false;
}
