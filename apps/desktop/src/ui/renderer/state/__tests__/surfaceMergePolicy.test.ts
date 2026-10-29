import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../hooks/useI18n', () => ({ getGlobalLanguage: () => 'zh' }));
vi.mock('../agentTurnEditsStore', () => ({
  getAgentTurnEditForPath: () => undefined,
  getAgentTurnEdits: () => [],
}));

import type { SurfaceKind } from '../surfaceStore';

const store = await import('../surfaceStore');
const { ingestSurfaceEvent, _resetSurfaceStoreForTest, SURFACE_MERGE_POLICY } = store as any;
const view = (sid: string) => (store as any).__peekSurfaces(sid);

let clock = 1_000;
function openFile(sid: string, id: string, kind: string, path: string, extra?: Record<string, unknown>) {
  clock += 1000;
  ingestSurfaceEvent(sid, {
    action: 'open',
    surface: {
      id, kind, title: path.split('/').pop(),
      source: { type: 'file', path },
      pinned: false, createdAt: clock, updatedAt: clock,
      ...(extra ? { metadata: extra } : {}),
    },
  });
}
function openInline(sid: string, id: string, kind: string, content: string, title?: string) {
  clock += 1000;
  ingestSurfaceEvent(sid, {
    action: 'open',
    surface: {
      id, kind, title: title ?? id,
      source: { type: 'inline', content },
      pinned: false, createdAt: clock, updatedAt: clock,
    },
  });
}

const ALL_KINDS = [
  'doc', 'diagram', 'image', 'html', 'svg', 'web', 'pdf', 'code',
  'diff', 'plan', 'todo', 'services', 'sheet', 'docx', 'pptx', 'team', 'files', 'git',
  'terminal', 'review', 'plugin',
] as const;

type _MissingKinds = Exclude<SurfaceKind, typeof ALL_KINDS[number]>;
const _allKindsCovered: [_MissingKinds] extends [never] ? true
  : ['ALL_KINDS 缺少这些 SurfaceKind:', _MissingKinds] = true;
void _allKindsCovered;

describe('surface 合并策略表', () => {
  beforeEach(() => { clock = 1000; _resetSurfaceStoreForTest(); });

  it('每一个 SurfaceKind 都必须在表里声明策略 (漏一个就会重复堆 tab)', () => {
    const missing = ALL_KINDS.filter(k => !SURFACE_MERGE_POLICY[k]);
    expect(missing).toEqual([]);
    /* 反向: 表里不该有已删掉的 kind (terminal / chart) */
    expect(Object.keys(SURFACE_MERGE_POLICY).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('常驻 / 内部 tab 条这两件事从同一张表派生, 不再有第二份手抄名单', () => {
    const { isPersistentSurfaceKind, surfaceHasInternalTabs } = store as any;
    expect(ALL_KINDS.filter(isPersistentSurfaceKind).sort())
      .toEqual(['files', 'git', 'plugin', 'services', 'terminal', 'web']);
    expect(ALL_KINDS.filter(surfaceHasInternalTabs).sort())
      .toEqual(['code', 'docx', 'pdf', 'pptx', 'sheet', 'web']);
    /* host-tabs 的 kind 必须都给了 hostTitle, 否则 tab 条会渲染成空标题 */
    for (const k of ALL_KINDS.filter(surfaceHasInternalTabs)) {
      expect(SURFACE_MERGE_POLICY[k].hostTitle).toBeTruthy();
    }
  });

  describe('per-source: 同一个文件只有一份', () => {
    it('.md 点四次只长一个 tab —— 就是用户实拍的那个 bug', () => {
      const p = '/w/阿里大环线自驾攻略.md';
      openFile('S', 'a', 'doc', p);
      openFile('S', 'b', 'doc', p);
      openFile('S', 'c', 'doc', p);
      openFile('S', 'd', 'doc', p);
      const docs = view('S').filter((s: any) => s.kind === 'doc');
      expect(docs).toHaveLength(1);
      /* 而且每次点击都要把它切到前台, 不能"没反应" */
      expect((store as any).__peekActiveId('S')).toBe(docs[0].id);
    });

    it('路径写法不同 (重复斜杠 / ./ / 结尾斜杠) 也算同一个文件', () => {
      openFile('S', 'a', 'doc', '/w/docs/guide.md');
      openFile('S', 'b', 'doc', '/w//docs/guide.md');
      openFile('S', 'c', 'doc', '/w/./docs/guide.md');
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(1);
    });

    /* ── Windows 专项 ────────────────────────────────────────────────────────
     * 这些写法差异在 mac 上几乎碰不到, 到 Windows 上每一条都是"同一个文件开出好几个 tab"。
     * 判等走的是全仓唯一那份 canonicalWorkspacePath (pathUtils.filePathKey),
     * 平台判不出来时按路径形状兜底 —— 有盘符/反斜杠就当 Windows。 */
    it('Windows: 反斜杠 / 正斜杠 / 盘符大小写 都是同一个文件', () => {
      openFile('S', 'a', 'doc', 'C:\\Users\\mk\\notes\\攻略.md');
      openFile('S', 'b', 'doc', 'C:/Users/mk/notes/攻略.md');
      openFile('S', 'c', 'doc', 'c:\\users\\MK\\Notes\\攻略.md');
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(1);
    });

    it('Windows: UNC 路径不被当成重复斜杠压掉 (\\\\server\\share 必须留两个斜杠)', () => {
      /* 单独先开一次原始反斜杠形态, 确认它自己就被归一成 //nas/... ——
       * 不能靠"后开的那个恰好是正斜杠写法"蒙混过去。 */
      openFile('S', 'a', 'doc', '\\\\nas\\team\\a.md');
      expect(view('S')[0].source.path).toBe('//nas/team/a.md');
      openFile('S', 'b', 'doc', '//nas/team/a.md');
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(1);
    });

    it('Windows: 原始反斜杠路径落库时已归一成正斜杠 (下游不用各写一套)', () => {
      openFile('S', 'a', 'doc', 'C:\\Users\\MK\\notes\\a.md');
      expect(view('S')[0].source.path).toBe('C:/Users/MK/notes/a.md');
    });

    it('UNC 的不同 share 仍是不同文件 (别归一过头)', () => {
      openFile('S', 'a', 'doc', '//nas/team/a.md');
      openFile('S', 'b', 'doc', '//nas/other/a.md');
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(2);
    });

    it('`..` 绕一圈回到同一个文件也要认出来', () => {
      openFile('S', 'a', 'doc', '/w/docs/a.md');
      openFile('S', 'b', 'doc', '/w/docs/sub/../a.md');
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(1);
    });

    it('POSIX 保持大小写敏感 —— /A.md 和 /a.md 是两个文件, 不能合并', () => {
      openFile('S', 'a', 'doc', '/w/A.md');
      openFile('S', 'b', 'doc', '/w/a.md');
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(2);
    });

    it('存进 tab / source 的仍是能真正打开的原始大小写路径, 不是小写化的 key', () => {
      openFile('S', 'a', 'code', 'C:\\Users\\MK\\App.ts');
      const host = view('S').find((s: any) => s.kind === 'code');
      expect(host.metadata.tabs[0].url).toBe('C:/Users/MK/App.ts');
    });

    it('不同文件仍然各占一个 tab', () => {
      openFile('S', 'a', 'doc', '/w/a.md');
      openFile('S', 'b', 'doc', '/w/b.md');
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(2);
    });

    it('同一个路径但 kind 不同不合并 (.md 可以既开渲染稿又开源码)', () => {
      openFile('S', 'a', 'doc', '/w/a.md');
      openFile('S', 'b', 'code', '/w/a.md');
      const kinds = view('S').map((s: any) => s.kind).sort();
      expect(kinds).toEqual(['code', 'doc']);
    });

    it('inline 源没有稳定身份, 每次都是新的一份 (内容各不相同)', () => {
      openInline('S', 'a', 'diagram', 'graph TD; A-->B');
      openInline('S', 'b', 'diagram', 'graph TD; C-->D');
      expect(view('S').filter((s: any) => s.kind === 'diagram')).toHaveLength(2);
    });

    it('重开同一个文件会把 metadata 刷成最新的', () => {
      openFile('S', 'a', 'doc', '/w/a.md', { line: 3 });
      openFile('S', 'b', 'doc', '/w/a.md', { line: 42 });
      const doc = view('S').find((s: any) => s.kind === 'doc');
      expect(doc.metadata.line).toBe(42);
    });
  });

  describe('host-tabs: 一个 host 内部多 tab (行为保持不变)', () => {
    it('code 多文件挂进同一个「源码」host', () => {
      openFile('S', 'a', 'code', '/w/a.ts');
      openFile('S', 'b', 'code', '/w/b.ts');
      const hosts = view('S').filter((s: any) => s.kind === 'code');
      expect(hosts).toHaveLength(1);
      expect(hosts[0].id).toBe('code-host-S');
      expect(hosts[0].metadata.tabs).toHaveLength(2);
    });

    it('同一个源码文件重复打开不新增 tab, 只激活它', () => {
      openFile('S', 'a', 'code', '/w/a.ts');
      openFile('S', 'b', 'code', '/w/b.ts');
      openFile('S', 'c', 'code', '/w/a.ts');
      const host = view('S').find((s: any) => s.kind === 'code');
      expect(host.metadata.tabs).toHaveLength(2);
      expect(host.metadata.activeTabId).toBe('a');
    });

    it('pdf / sheet / docx / pptx 各自一个 host, host id 稳定', () => {
      openFile('S', 'p1', 'pdf', '/w/a.pdf');
      openFile('S', 'p2', 'pdf', '/w/b.pdf');
      openFile('S', 's1', 'sheet', '/w/a.xlsx');
      const ids = view('S').map((s: any) => s.id).sort();
      expect(ids).toEqual(['pdf-host-S', 'sheet-host-S']);
      const pdf = view('S').find((s: any) => s.kind === 'pdf');
      expect(pdf.metadata.tabs).toHaveLength(2);
      expect(pdf.title).toBe('PDF');
    });

    it('web 按 tab.id 认身份 —— 同 URL 允许开两个标签页 (浏览器的正常语义)', () => {
      clock += 1000;
      for (const id of ['t1', 't2']) {
        ingestSurfaceEvent('S', {
          action: 'open',
          surface: {
            id, kind: 'web', title: 'x',
            source: { type: 'url', url: 'https://example.com' },
            pinned: false, createdAt: clock, updatedAt: clock,
          },
        });
      }
      const web = view('S').find((s: any) => s.kind === 'web');
      expect(web.id).toBe('web-host-S');
      expect(web.metadata.tabs).toHaveLength(2);
    });

    it('home 引导请求 (inline 空内容) 建 host 但不挂占位 tab', () => {
      openInline('S', 'h', 'sheet', '');
      const host = view('S').find((s: any) => s.kind === 'sheet');
      expect(host.metadata.tabs).toEqual([]);
    });
  });

  describe('singleton: 一个会话一份', () => {
    it('files / git / services 重复打开只激活已有那个', () => {
      for (const kind of ['files', 'git', 'services']) {
        openInline('S', `${kind}-1`, kind, '');
        openInline('S', `${kind}-2`, kind, '');
      }
      const counts = view('S').reduce((acc: any, s: any) => {
        acc[s.kind] = (acc[s.kind] ?? 0) + 1; return acc;
      }, {});
      expect(counts).toEqual({ files: 1, git: 1, services: 1 });
    });

    it('待办单实例, 且第二次 open 的新内容不会被丢掉', () => {
      openInline('S', 'todo-1', 'todo', JSON.stringify({ items: [{ text: 'A' }] }), '清单一');
      openInline('S', 'todo-2', 'todo', JSON.stringify({ items: [{ text: 'B' }] }), '清单二');
      const todos = view('S').filter((s: any) => s.kind === 'todo');
      expect(todos).toHaveLength(1);
      expect(todos[0].title).toBe('清单二');
      expect(JSON.parse(todos[0].source.content).items[0].text).toBe('B');
    });
  });

  describe('always-new: plan 两份内容不同, 不能合并', () => {
    it('两个 plan 各占一个 tab', () => {
      openInline('S', 'p1', 'plan', '# 方案一');
      openInline('S', 'p2', 'plan', '# 方案二');
      expect(view('S').filter((s: any) => s.kind === 'plan')).toHaveLength(2);
    });
  });

  describe('恢复路径也要过同一张表 (存量脏数据)', () => {
    /* 只修 open 不修 restore 的话, 用户**已经存下来的**那 4 个重复 tab 每次重启都会
     * 原样复活 —— 从用户视角看就是"根本没修"。 */
    const originalWindow = (globalThis as any).window;
    afterEach(() => { (globalThis as any).window = originalWindow; });

    const stubStored = (surfaces: any[], activeId?: string) => {
      (globalThis as any).window = {
        /* 别把真 window 的其它能力抹掉 —— requestSurfacePanelOpen 要用 dispatchEvent,
         * 漏了会让**后面**的用例莫名其妙地红。 */
        ...(originalWindow ?? {}),
        dispatchEvent: () => true,
        neox: {
          uiStateGetSurfaces: async () => ({ success: true, state: { surfaces, activeId } }),
          uiStateSetSurfaces: async () => ({ success: true }),
        },
      };
    };

    it('重启后, 存量的 4 个同路径 .md 收成 1 个', async () => {
      const p = '/w/阿里大环线自驾攻略.md';
      stubStored(['a', 'b', 'c', 'd'].map((id, i) => ({
        id, kind: 'doc', title: '攻略.md',
        source: { type: 'file', path: p },
        pinned: false, createdAt: 1000 + i, updatedAt: 1000 + i,
      })), 'd');
      await (store as any).__restoreForTest('R');
      const docs = view('R').filter((s: any) => s.kind === 'doc');
      expect(docs).toHaveLength(1);
      /* activeId 指的 'd' 已经被丢掉了 —— 不能留成死指针, 否则面板一片空白 */
      expect((store as any).__peekActiveId('R')).toBe(docs[0].id);
    });

    it('重启后, 存量的多个同 kind host 收成 1 个', async () => {
      stubStored([
        { id: 'code-host-X', kind: 'code', title: '源码', source: { type: 'file', path: '/w/a.ts' }, pinned: false, createdAt: 1, updatedAt: 1, metadata: { tabs: [{ id: 't1', url: '/w/a.ts' }] } },
        { id: 'legacy-code', kind: 'code', title: '源码', source: { type: 'file', path: '/w/b.ts' }, pinned: false, createdAt: 2, updatedAt: 2, metadata: { tabs: [{ id: 't2', url: '/w/b.ts' }] } },
      ]);
      await (store as any).__restoreForTest('R2');
      expect(view('R2').filter((s: any) => s.kind === 'code')).toHaveLength(1);
    });

    it('不同文件的存量 tab 一个都不能丢', async () => {
      stubStored(['a', 'b', 'c'].map((id, i) => ({
        id, kind: 'doc', title: `${id}.md`,
        source: { type: 'file', path: `/w/${id}.md` },
        pinned: false, createdAt: 1000 + i, updatedAt: 1000 + i,
      })), 'b');
      await (store as any).__restoreForTest('R3');
      expect(view('R3').filter((s: any) => s.kind === 'doc')).toHaveLength(3);
      expect((store as any).__peekActiveId('R3')).toBe('b');
    });
  });

  describe('别名表: 被合并掉的 id 之后仍然找得到', () => {
    it('update 打在被合并掉的 id 上, 落到承载它的那个 surface', () => {
      openFile('S', 'a', 'doc', '/w/a.md');
      openFile('S', 'b', 'doc', '/w/a.md');   // b 被合并进 a
      ingestSurfaceEvent('S', { action: 'update', surfaceId: 'b', patch: { title: '改过的标题' } });
      const doc = view('S').find((s: any) => s.kind === 'doc');
      expect(doc.id).toBe('a');
      expect(doc.title).toBe('改过的标题');
    });

    it('close 打在被合并掉的 id 上, 关掉的是真正那个 (不是静默无反应)', () => {
      openFile('S', 'a', 'doc', '/w/a.md');
      openFile('S', 'b', 'doc', '/w/a.md');
      ingestSurfaceEvent('S', { action: 'close', surfaceId: 'b' });
      expect(view('S').filter((s: any) => s.kind === 'doc')).toHaveLength(0);
    });

    it('todo_replace 用模型新给的 id 也能命中已有清单', () => {
      openInline('S', 'todo-1', 'todo', JSON.stringify({ items: [] }));
      openInline('S', 'todo-2', 'todo', JSON.stringify({ items: [] }));
      ingestSurfaceEvent('S', {
        action: 'todo_replace',
        surfaceId: 'todo-2',
        todoItems: [{ id: '1', text: '写测试', status: 'pending' }],
      });
      const todos = view('S').filter((s: any) => s.kind === 'todo');
      expect(todos).toHaveLength(1);
      expect(JSON.parse(todos[0].source.content).items).toHaveLength(1);
    });
  });

  describe('agent open 只打运行中角标, 不自动展开右栏', () => {
    it('默认 ingest 打 __agentLive, 15s 内 isSurfaceLive', () => {
      const { isSurfaceLive } = store as any;
      openInline('S', 'web-1', 'web', '');
      const web = view('S').find((s: any) => s.kind === 'web');
      expect(typeof web.metadata.__agentLive).toBe('number');
      expect(isSurfaceLive(web)).toBe(true);
      expect(isSurfaceLive(web, web.metadata.__agentLive + 16_000)).toBe(false);
    });

    it('用户 reveal 不打运行中角标', () => {
      const { isSurfaceLive } = store as any;
      ingestSurfaceEvent('S', {
        action: 'open',
        surface: {
          id: 'files-user', kind: 'files', title: '文件',
          source: { type: 'inline', content: '' },
          pinned: false, createdAt: 1, updatedAt: 1,
        },
      }, { reveal: true });
      const files = view('S').find((s: any) => s.kind === 'files');
      expect(files.metadata?.__agentLive).toBeUndefined();
      expect(isSurfaceLive(files)).toBe(false);
    });

    it('__streaming 占位在生成期间一直算 live', () => {
      const { isSurfaceLive } = store as any;
      expect(isSurfaceLive({
        id: 'tmp', kind: 'plan', title: '生成中',
        source: { type: 'inline', content: '' },
        pinned: false, createdAt: 1, updatedAt: 1,
        metadata: { __streaming: true },
      })).toBe(true);
    });
  });

  describe('agent 开的 surface 一律不抢右栏', () => {
    const originalWindow = (globalThis as any).window;
    afterEach(() => { (globalThis as any).window = originalWindow; });

    /** agent 那条路开一个 surface, 返回它有没有请求展开右栏 */
    const opensPanel = (kind: string, opts?: Record<string, unknown>): boolean => {
      let asked = false;
      (globalThis as any).window = {
        ...(originalWindow ?? {}),
        dispatchEvent: (e: any) => {
          if (e?.type === 'neox:surface-panel-open-requested') asked = true;
          return true;
        },
      };
      clock += 1000;
      ingestSurfaceEvent('AR', {
        action: 'open',
        surface: {
          id: `ar-${kind}-${clock}`, kind, title: kind,
          source: { type: 'file', path: `/w/${clock}.bin` },
          pinned: false, createdAt: clock, updatedAt: clock,
        },
      }, opts);
      return asked;
    };

    it.each([
      'services', 'files', 'git', 'terminal', 'code', 'diff', 'todo', 'plan', 'team',
    ])('%s: 过程类 agent 开它不展右栏, 只在上下文栏留胶囊', (kind) => {
      expect(opensPanel(kind)).toBe(false);
    });

    it.each([
      'pptx', 'docx', 'pdf', 'sheet', 'doc', 'image', 'diagram', 'html', 'svg',
    ])('%s: 交付物 agent 开它就展开右栏', (kind) => {
      expect(opensPanel(kind)).toBe(true);
    });

    it('用户自己点的一律照开 (点了没反应比抢屏更糟)', () => {
      expect(opensPanel('services', { reveal: true })).toBe(true);
      expect(opensPanel('pptx', { reveal: true })).toBe(true);
    });
  });
});
