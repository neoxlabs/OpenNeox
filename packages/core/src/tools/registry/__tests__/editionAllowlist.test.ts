/**
 * 极简版 (lite edition) 工具白名单 — 行为测试。
 *
 * 白名单最危险的失效方式**不是漏加**, 而是**名字写错**: 写错了不报错, 只是那个工具
 * 静默地不在极简版里, 而"极简版本来就少工具"会让人完全注意不到。
 * 第一版就把读文件写成了 read_file (真名是 readfile), 是下面第 ① 条抓出来的。
 *
 * 所以这里对着**源码里真实注册过的工具名**核对, 而不是对着另一份手写清单核对。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LITE_TOOL_ALLOWLIST, filterToolsByEdition, isLite, currentEdition } from '../edition.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_ROOT = join(HERE, '../..');

/** 扫 tools/ 下所有 .ts, 收集 `name: 'xxx'` 形式的工具注册名。 */
function collectRegisteredToolNames(): Set<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (e === '__tests__' || e === 'node_modules') continue;
        walk(p);
      } else if (e.endsWith('.ts')) {
        const src = readFileSync(p, 'utf-8');
        for (const m of src.matchAll(/^\s*name: '([a-z_0-9]+)'/gm)) names.add(m[1]);
      }
    }
  };
  walk(TOOLS_ROOT);
  return names;
}

describe('lite 工具白名单', () => {
  const registered = collectRegisteredToolNames();

  it('扫到的工具名不能是空的 (扫法本身要先站得住)', () => {
    /* 扫法失效时会返回空集, 那样下面每条断言都会"全过" —— 假绿。先钉死这个前提。 */
    expect(registered.size).toBeGreaterThan(100);
    expect(registered.has('execute_shell')).toBe(true);
  });

  it('① 白名单里每个名字都得在源码里真的注册过 (名字写错不会报错, 只会静默少工具)', () => {
    const bogus = LITE_TOOL_ALLOWLIST.filter(n => !registered.has(n));
    expect(bogus).toEqual([]);
  });

  it('② 明确要砍的那几类, 一个都不许在白名单里', () => {
    const mustNotShip = LITE_TOOL_ALLOWLIST.filter(n =>
      n.startsWith('browser_')
      || n.startsWith('sheet_') || n.startsWith('word_')
      || n.startsWith('java_debug_') || n.startsWith('cron_')
      || n.startsWith('life_') || n.endsWith('_surface')
      || n === 'create_slides' || n === 'generate_image' || n === 'edit_image'
      || n === 'analyze_code' || n === 'smart_tree',
    );
    expect(mustNotShip).toEqual([]);
  });

  it('③ 干活的底盘不能缺 —— 少任何一个极简版就不是个能用的 agent', () => {
    for (const must of ['execute_shell', 'readfile', 'write_file', 'edit', 'list_directory', 'git_status', 'update_plan']) {
      expect(LITE_TOOL_ALLOWLIST).toContain(must);
    }
  });

  it('④ standard 形态下过滤是恒等的 —— 这条路径上标准版必须零行为变化', () => {
    delete process.env.NEOX_EDITION;
    expect(currentEdition()).toBe('standard');
    expect(isLite()).toBe(false);
    const tools = [{ name: 'browser_navigate' }, { name: 'create_slides' }, { name: 'execute_shell' }];
    expect(filterToolsByEdition(tools)).toEqual(tools);
  });

  it('⑤ lite 形态下只留白名单里的', () => {
    process.env.NEOX_EDITION = 'lite';
    try {
      const tools = [{ name: 'browser_navigate' }, { name: 'create_slides' }, { name: 'execute_shell' }, { name: 'readfile' }];
      expect(filterToolsByEdition(tools).map(t => t.name)).toEqual(['execute_shell', 'readfile']);
    } finally {
      delete process.env.NEOX_EDITION;
    }
  });

  it('⑥ 白名单确实"精简" —— 比注册总数少一个数量级不止', () => {
    expect(LITE_TOOL_ALLOWLIST.length).toBeLessThan(registered.size / 3);
  });
});
