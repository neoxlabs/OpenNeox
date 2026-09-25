import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';


const HERE = dirname(fileURLToPath(import.meta.url));   // .../cluster/src/__tests__
const ULTRA = join(HERE, '..', '..');                   // .../cluster
const PKGS = join(ULTRA, '..');                         // .../packages
const CORE = join(PKGS, 'core');

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) { if (e !== 'node_modules' && e !== 'dist') walk(p); }
      else if (/\.tsx?$/.test(e)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('① 依赖方向 — core 不许依赖 teamwork', () => {
  it('core 的 package.json 里没有 teamwork', () => {
    const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const bad = Object.keys(deps ?? {}).filter((d) => d === '@neoxlabs/cluster');
    expect(bad, 'core 依赖了 teamwork —— 主干被研究代码绑架, 且构建顺序会反过来').toEqual([]);
  });

  it('core 源码里没有 import teamwork', () => {
    const hits: string[] = [];
    for (const f of srcFiles(join(CORE, 'src'))) {
      const c = readFileSync(f, 'utf8');
      if (/from\s+['"]@neoxlabs\/cluster/.test(c)) hits.push(f.replace(PKGS, ''));
    }
    expect(hits, 'core 直接 import 了 teamwork —— 应该走注册表由外层接线').toEqual([]);
  });
});

describe('② 同进程隔离 — 不许污染 agentic 的运行环境', () => {
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/Object\.defineProperty\s*\(\s*(?:globalThis|global)\b/, '往全局挂东西'],
    [/\b\w+\.prototype\.\w+\s*=[^=]/, 'monkey-patch 原型'],
    [/process\.env\.NEOX_\w+\s*=[^=]/, '改 NEOX_* 环境变量 (同进程的 agentic 会跟着变)'],
    [/require\.cache/, '动 require 缓存'],
  ];

  it('teamwork 不得 monkey-patch / 改全局 / 改 NEOX_* env', () => {
    const violations: string[] = [];
    for (const f of srcFiles(join(ULTRA, 'src'))) {
      if (f.includes('__tests__')) continue;
      const c = readFileSync(f, 'utf8');
      for (const [re, why] of FORBIDDEN) {
        if (re.test(c)) violations.push(`${f.replace(PKGS, '')}: ${why}`);
      }
    }
    expect(violations, '污染了同进程环境 —— 用户正在跑的 agentic 会被波及').toEqual([]);
  });
});

describe('③ core 里的 teamwork 分支必须是 mode 守卫的', () => {
  /**
   * 允许在 core 里加扩展点, 但**必须**满足: 提到 teamwork 的地方, 附近要有 mode 守卫
   * (if (mode === 'teamwork') / registry lookup 之类)。裸露的无条件改动 = 动了 agentic 的路。
   */
  const CLUSTER_MODE_RE = /(['"`])teamwork\1\s*(?:[,;)\]}]|$)|\bclusterMode\b|@neoxlabs\/cluster|ClusterRuntime/;

  it('core 中每处 teamwork 模式提及都在 mode 守卫内', () => {
    const violations: string[] = [];
    for (const f of srcFiles(join(CORE, 'src'))) {
      /* 测试文件天然要写裸的 'teamwork' 字面量 (正是为了断言归一化行为), 不构成
       * 运行时路径。第一版没排除, 把 core 的 modeFactory.test.ts 自己判成了违规。 */
      if (/__tests__|\.test\.tsx?$/.test(f)) continue;
      const c = readFileSync(f, 'utf8');
      if (!CLUSTER_MODE_RE.test(c)) continue;
      const lines = c.split('\n');
      lines.forEach((line, i) => {
        if (!CLUSTER_MODE_RE.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // 注释不算
        /* 前后 6 行内要能看到 mode 守卫或注册表查表 */
        const win = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
        const guarded = /mode\s*===|mode\s*!==|runMode|getRunModeHandler|RUN_MODE_HANDLERS|registerRunModeHandler|AgentRunMode/.test(win);
        if (!guarded) violations.push(`${f.replace(PKGS, '')}:${i + 1}  ${line.trim().slice(0, 70)}`);
      });
    }
    expect(violations, 'core 里有未被 mode 守卫的 teamwork 分支 —— agentic 的路被动了').toEqual([]);
  });
});

describe('④ 包声明', () => {
  it('teamwork 显式依赖 core, 且研究阶段不发布', () => {
    const pkg = JSON.parse(readFileSync(join(ULTRA, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['@neoxlabs/core'], 'teamwork 应显式依赖 core').toBeTruthy();
    expect(pkg.private, 'teamwork 研究阶段不得发布').toBe(true);
  });
});
