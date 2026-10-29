
import * as os from 'node:os';
import * as path from 'node:path';

export type UnsafeWorkspaceReason = 'home' | 'filesystem-root' | 'system-directory';

export type WorkspaceAssessment =
  | { unsafe: false }
  | { unsafe: true; reason: UnsafeWorkspaceReason; detail: string };

function isSameOrInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function systemRoots(): string[] {
  if (process.platform === 'win32') {
    const roots: string[] = [];
    for (const key of [
      'WINDIR',
      'SystemRoot',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'ProgramData',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
    ]) {
      const value = process.env[key];
      if (value) roots.push(value);
    }
    /* 所有用户的目录（C:\Users）：一个 profile 里就够重了, 再往上整台机器就废了 */
    const home = path.resolve(os.homedir());
    const parent = path.dirname(home);
    if (path.basename(parent).toLowerCase() === 'users') roots.push(parent);
    return roots;
  }
  const roots = [
    '/System',
    '/Library',
    '/Applications',
    '/usr',
    '/bin',
    '/sbin',
    '/etc',
  ];
  /* ~/Library 是系统级缓存（Spotlight/浏览器/容器数据），同样不能快照 */
  roots.push(path.join(os.homedir(), 'Library'));
  return roots;
}

/**
 * 这个目录能不能开 checkpoint？
 *
 * 只拒绝"结构上必然失控"的三类：家目录本身、盘符/文件系统根、系统目录及其子目录。
 * 家目录下的普通项目（Desktop/proj、Documents/proj）是正常用法，照常允许。
 */
export function assessCheckpointWorkspace(workspacePath: string): WorkspaceAssessment {
  const target = path.resolve(workspacePath);
  const home = path.resolve(os.homedir());

  if (target === home) {
    return { unsafe: true, reason: 'home', detail: home };
  }

  const root = path.parse(target).root;
  if (target === root) {
    return { unsafe: true, reason: 'filesystem-root', detail: root };
  }

  for (const dir of systemRoots()) {
    const resolved = path.resolve(dir);
    if (isSameOrInside(target, resolved)) {
      return { unsafe: true, reason: 'system-directory', detail: resolved };
    }
  }

  return { unsafe: false };
}

/** 给日志 / 界面用的一句话原因 */
export function describeUnsafeWorkspace(
  assessment: Extract<WorkspaceAssessment, { unsafe: true }>,
): string {
  switch (assessment.reason) {
    case 'home':
      return `工作区是用户主目录 (${assessment.detail})`;
    case 'filesystem-root':
      return `工作区是磁盘根目录 (${assessment.detail})`;
    case 'system-directory':
      return `工作区在系统目录内 (${assessment.detail})`;
  }
}
