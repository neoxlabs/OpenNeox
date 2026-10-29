
/** 纯字符串归一 —— 不碰磁盘, 可以放在每条消息这种热路径上调。 */
export function canonicalWorkspacePath(path: string | null | undefined, isWindows: boolean): string {
  if (!path) return '';
  let p = String(path).trim().replace(/\\/g, '/');
  /* C://foo -> C:/foo */
  p = p.replace(/^([A-Za-z]:)\/{2,}/, '$1/');
  /* /a//b -> /a/b, 但保住 UNC //server/share 的头两个斜杠 */
  if (p.startsWith('//')) p = `//${p.slice(2).replace(/\/{2,}/g, '/')}`;
  else p = p.replace(/\/{2,}/g, '/');
  /* 去尾斜杠, 但根路径 "/" 和 "C:/" 要留着 */
  if (p.length > 1 && !/^[A-Za-z]:\/$/.test(p)) p = p.replace(/\/+$/, '');
  /* Windows 文件系统大小写不敏感; POSIX 敏感 (/A 与 /a 可以是两个目录), 不能一律小写。 */
  return isWindows ? p.toLowerCase() : p;
}

/**
 * 平台判定的兜底 —— 只在调用方拿不到平台信息时用。
 *
 * 单看路径也能认出 Windows: 有盘符, 或含反斜杠 (POSIX 路径里反斜杠是合法文件名字符,
 * 但工作区目录里出现它属于病态, 认错的代价只是多做一次大小写折叠)。
 * 渲染层与主进程都能拿到真实平台, 走各自的 wrapper, 不依赖这个兜底。
 */
export function looksLikeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.includes('\\');
}
