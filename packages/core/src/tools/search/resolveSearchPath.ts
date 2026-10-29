import fsSync from 'fs';
import path from 'path';

export type SearchPathResolution = {
  absPath: string;
  resolvedFrom: 'workspace' | 'ancestor' | 'absolute';
};

type ResolveSearchPathArgs = {
  searchPath?: string;
  workspaceRoot: string;
  resolveWorkspacePath: (requestedPath?: string) => string;
};

type ResolveSearchPathsArgs = {
  /* paths 优先 — 多路径调用入口. 空数组 / undefined 退到 searchPath 单值. */
  paths?: string[];
  searchPath?: string;
  workspaceRoot: string;
  resolveWorkspacePath: (requestedPath?: string) => string;
};

export type SearchPathsResolution = {
  /* 每个原始输入对应一个解析结果, 与输入顺序一致. */
  resolutions: SearchPathResolution[];
  /* dedup 后的 absPath (避免传给 ripgrep 重复扫). 顺序跟 resolutions 首次出现一致. */
  uniqueAbsPaths: string[];
  /* 聚合 resolvedFrom: 全 absolute / 全 ancestor / 全 workspace / 混合 → 'mixed'. */
  aggregateResolvedFrom: 'workspace' | 'ancestor' | 'absolute' | 'mixed';
};

/** 单路径解析 — 保留给 backwards compat 调用方. 内部走 resolveSearchPaths 单 case. */
export function resolveSearchPath({
  searchPath,
  workspaceRoot,
  resolveWorkspacePath,
}: ResolveSearchPathArgs): SearchPathResolution {
  return resolveOne(searchPath, workspaceRoot, resolveWorkspacePath);
}

function resolveOne(
  searchPath: string | undefined,
  workspaceRoot: string,
  resolveWorkspacePath: (requestedPath?: string) => string,
): SearchPathResolution {
  const actualPath = searchPath || '.';
  let absPath = resolveWorkspacePath(actualPath);
  let resolvedFrom: 'workspace' | 'ancestor' | 'absolute' = 'workspace';

  if (searchPath && path.isAbsolute(searchPath)) {
    resolvedFrom = 'absolute';
  } else if (searchPath && !fsSync.existsSync(absPath)) {
    let cursor = workspaceRoot;
    let resolved: string | null = null;
    while (true) {
      const candidate = path.resolve(cursor, searchPath);
      if (fsSync.existsSync(candidate)) {
        resolved = candidate;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (resolved) {
      absPath = resolved;
      resolvedFrom = 'ancestor';
    }
  }

  return { absPath, resolvedFrom };
}

/** 多路径解析入口.
 *
 *   优先级: paths[] (非空) > searchPath > '.' (cwd).
 *
 *   path 含空格的旧"多路径塞一个字段"误用 — 这里不再尝试拆分: 路径里本就可能有空格
 *   (e.g. "My Documents"), 单字段拆空格会反伤合法路径. 模型应改用 paths[] 明确语义.
 *   schema description 已点明.
 *
 *   dedup: 解析后同 absPath 只保留一份, 避免给 ripgrep 重复扫同一目录. 顺序保留首次出现. */
export function resolveSearchPaths({
  paths,
  searchPath,
  workspaceRoot,
  resolveWorkspacePath,
}: ResolveSearchPathsArgs): SearchPathsResolution {
  const inputs = (paths && paths.length > 0) ? paths : [searchPath];
  const resolutions = inputs.map(p => resolveOne(p, workspaceRoot, resolveWorkspacePath));

  const seen = new Set<string>();
  const uniqueAbsPaths: string[] = [];
  for (const r of resolutions) {
    if (!seen.has(r.absPath)) {
      seen.add(r.absPath);
      uniqueAbsPaths.push(r.absPath);
    }
  }

  const froms = new Set(resolutions.map(r => r.resolvedFrom));
  const aggregateResolvedFrom = froms.size === 1
    ? (resolutions[0].resolvedFrom)
    : 'mixed';

  return { resolutions, uniqueAbsPaths, aggregateResolvedFrom };
}
