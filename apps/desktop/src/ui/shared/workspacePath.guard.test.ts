import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/* 从本文件出发定位到 apps/desktop/src —— 不依赖 vitest 的 cwd。 */
const SRC = resolve(import.meta.dirname, '../../..');

/**
 * 明确豁免的行。每一条都要写清楚为什么这处比较是安全的。
 * key = "相对 src 的路径:匹配到的代码片段"(片段做包含匹配, 不必写全行)。
 */
const ALLOWED: Array<{ file: string; snippet: string; why: string }> = [
  {
    file: 'ui/electron/context/ProjectManager.ts',
    snippet: 'existingForWindow.workspacePath === normalizedWorkspacePath',
    why: '同源比较: 两边都是 normalizeWorkspacePath 的产物, 这里就是规范化的定义处。',
  },
  {
    file: 'ui/electron/services/agentBridge.ts',
    snippet: 'this.currentConnectionWorkDir === this.workspacePath',
    why: '同实例比较: currentConnectionWorkDir 就是建连时从 this.workspacePath 抄下来的, 判的是"连接是否还对着当前工作区"。',
  },
  {
    file: 'ui/electron/services/agentBridge.ts',
    snippet: 'this.currentConnectionWorkDir !== this.workspacePath',
    why: '同上, 取反的那一处。',
  },
  {
    file: 'ui/renderer/modules/explorer/components/FileExplorer.tsx',
    snippet: 'dirPath === workspacePath',
    why: '文件树内部: dirPath 由 workspacePath 拼出来, 同源, 判的是"这个节点是不是根"。',
  },
  {
    file: 'ui/renderer/modules/explorer/components/FileExplorer.tsx',
    snippet: 'selectedFile !== workspacePath',
    why: '同上, selectedFile 取自树节点, 与 workspacePath 同源。',
  },
];

const PATTERN =
  'workspacePath\\s*[!=]==|[!=]==\\s*\\w*\\.?workspacePath|workspacePath\\s*[!=]==\\s*\\w+\\.path';

function ripgrep(pattern: string): string[] {
  try {
    return execFileSync(
      'rg',
      ['-n', '--no-heading', '-g', '*.ts', '-g', '*.tsx', '-g', '!*.test.ts', '-g', '!*.test.tsx', pattern, SRC],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ).split('\n').filter(Boolean);
  } catch (e: unknown) {
    /* rg 无匹配时 exit 1 —— 那是通过, 不是失败 */
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return [];
    throw e;
  }
}

describe('工作区路径不许裸比较', () => {
  it('所有 workspacePath 的 === / !== 都走 sameWorkspace(), 或在 ALLOWED 里说明原因', () => {
    const hits = ripgrep(PATTERN)
      /* 类型判断和空值检查不是路径比较 */
      .filter((l) => !/typeof\s|'string'|=== undefined|=== null|!== undefined|!== null/.test(l))
      /* 注释里引用这段代码 (讲历史的注释) 不算 */
      .filter((l) => {
        const code = l.replace(/\r/g, '').replace(/^\S+:\d+:/, '').trim();
        return !code.startsWith('*') && !code.startsWith('//') && !code.startsWith('/*');
      })
      /* win 上 rg 输出反斜杠路径, ALLOWED 的 file 是正斜杠 —— 归一化后比对 */
      .filter((l) => !ALLOWED.some((a) => l.replace(/\\/g, '/').includes(a.file) && l.includes(a.snippet)));

    expect(hits, [
      '发现未经归一化的工作区路径比较。',
      '同一个项目在 Windows 上有多种写法 (盘符大小写 / 反斜杠 / 尾斜杠),',
      '=== 会把它判成两个项目 —— 这正是 2026-08-02 那次侧栏事故的根因。',
      '改用 sameWorkspace() (渲染层 utils/pathUtils, 主进程 electron/utils/workspaceKey),',
      '或者如果这处确实是刻意的原样比较, 加进本文件的 ALLOWED 并写明原因。',
      '',
      ...hits,
    ].join('\n')).toEqual([]);
  });

  /**
   * 以工作区路径为键的三张 app_state 表, 只能经 storageService 的私有 accessor 存取。
   *
   *   它们的键必须是 workspaceKey(path) —— 直接拿原始路径当键, Windows 上同一个项目换个
   *   写法就取不到值: 自定义项目名没了、多根退回单根、最近文件空掉, 而旧键还堆在库里。
   *   accessor 里做了读时 rekey (治旧数据) + 写时规范键。绕过它直接 getAppState/setAppState
   *   就跳过了这层, bug 立刻回来。
   *
   *   每张表允许恰好 2 处: 一个读 accessor, 一个写 accessor。
   */
  it('路径键表只经 accessor 存取', () => {
    for (const table of ['ui:workspaceMeta', 'ui:workspaceRoots', 'ui:recentFiles']) {
      const hits = ripgrep(`'${table}'`).filter((l) => !/\.test\.tsx?:/.test(l));
      expect(hits.length, [
        `${table} 出现了 ${hits.length} 处, 期望 2 处 (storageService 里的读/写 accessor)。`,
        '新增的存取请走 accessor —— 直接 getAppState/setAppState 会绕过键归一,',
        'Windows 上换个路径写法就取不到值。',
        '',
        ...hits,
      ].join('\n')).toBe(2);
      expect(
        hits.every((l) => l.replace(/\\/g, '/').includes('platform-electron/storageService.ts')),
        `${table} 出现在 storageService 之外:\n${hits.join('\n')}`,
      ).toBe(true);
    }
  });

  it('豁免清单本身没有过期项 (指向的代码还在)', () => {
    for (const a of ALLOWED) {
      const found = ripgrep(PATTERN).some((l) => l.replace(/\\/g, '/').includes(a.file) && l.includes(a.snippet));
      expect(found, `ALLOWED 里的豁免已经失效, 请删掉: ${a.file} — ${a.snippet}`).toBe(true);
    }
  });
});
