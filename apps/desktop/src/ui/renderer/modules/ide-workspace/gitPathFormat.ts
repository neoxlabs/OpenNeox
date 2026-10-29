
export function shortDir(dirParts: string[]): string {
  if (dirParts.length === 0) return '';
  if (dirParts.length <= 2) return dirParts.join('/');
  return `…/${dirParts.slice(-2).join('/')}`;
}

/** porcelain 路径相对 git root; 工作区可能是子目录, 不能 `${workspacePath}/${fp}`. */
export function absGitPath(rootOrCwd: string, fp: string): string {
  if (!fp) return rootOrCwd;
  if (fp.startsWith('/')) return fp;
  const base = (rootOrCwd || '').replace(/\/+$/, '');
  return base ? `${base}/${fp}` : fp;
}
