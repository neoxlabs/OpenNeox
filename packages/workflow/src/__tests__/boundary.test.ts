import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 编排层边界闸。
 *
 * 三层是**叠**起来的: 模板(数据) → workflow(编排) → cluster(底座) → core(agent loop)。
 * 依赖方向由 npm 强制 (workflow 的 package.json 只依赖 cluster), 所以这里守的是
 * npm 管不到的那几条 —— **职责**边界, 不是依赖边界。
 *
 * 【为什么这几条值得写成测试】
 *   它们全是"写着写着就会破"的那种: 规划要调 LLM, 顺手 import 个 orchestrator 就能跑,
 *   于是执行逻辑悄悄长在编排层里, 两层就粘死了。老 team 就是这么长起来的 ——
 *   派发/隔离/事件/报告/协作承诺全糊在一个 682 行的工具里, 想换编排就得整个重写。
 */

const HERE = dirname(fileURLToPath(import.meta.url));   // .../workflow/src/__tests__
const PKG = join(HERE, '..', '..');                     // .../neox-workflow
const SRC = join(PKG, 'src');

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

/** 注释行不算违规 —— 边界说明本身要能提这些词 */
function codeLines(content: string): Array<{ line: string; no: number }> {
  return content.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

describe('① 编排层不执行 — 只产出/修改 NodeSpec[]', () => {
  /**
   * 规划本身要调 LLM 也不例外: 正确做法是**声明一个规划节点**交给 cluster 跑,
   * 而不是在这一层自己起 runtime。否则"改图"和"跑图"就没有接缝了。
   */
  const FORBIDDEN: Array<[RegExp, string]> = [
    [/\brunSession\b/, '直接跑 agent 会话 — 执行是 cluster 的活'],
    [/\bRuntimeOrchestrator\b/, '碰 orchestrator — 执行是 cluster 的活'],
    [/\bAgentRuntimeHost\b/, '碰 runtime host — 执行是 cluster 的活'],
    [/from\s+['"]@neoxlabs\/core/, 'import core — 它不在 dependencies 里, 引了就是幽灵依赖'],
  ];

  it('workflow 源码不碰执行层', () => {
    const violations: string[] = [];
    for (const f of srcFiles(SRC)) {
      if (f.includes('__tests__')) continue;
      for (const { line, no } of codeLines(readFileSync(f, 'utf8'))) {
        for (const [re, why] of FORBIDDEN) {
          if (re.test(line)) violations.push(`${f.replace(PKG, '')}:${no}  ${why}`);
        }
      }
    }
    expect(violations, '编排层长出了执行逻辑 — 两层会粘死, 想换编排就得整个重写').toEqual([]);
  });
});

describe('② templates/ 是数据, 不是代码', () => {
  /**
   * 模板要能被用户编辑、存进库、序列化。一旦含分支就编辑不了了, "支持用户自定义"也就没了。
   * 只准 `import type` (拿 WorkflowTemplate 的类型), 不准有任何运行时逻辑。
   */
  const TEMPLATES = join(SRC, 'templates');

  it('模板目录存在 (这条闸不是空转)', () => {
    expect(existsSync(TEMPLATES), 'templates/ 不见了 — 闸失去守护对象').toBe(true);
  });

  it('模板里没有逻辑', () => {
    const violations: string[] = [];
    for (const f of srcFiles(TEMPLATES)) {
      for (const { line, no } of codeLines(readFileSync(f, 'utf8'))) {
        const hit =
          /\bfunction\b/.test(line) ? '函数声明'
          : /=>/.test(line) ? '箭头函数'
          : /\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\bswitch\s*\(/.test(line) ? '控制流'
          : /^\s*import\s+(?!type\b)/.test(line) ? '值导入 (只准 import type)'
          : null;
        if (hit) violations.push(`${f.replace(PKG, '')}:${no}  ${hit}`);
      }
    }
    expect(violations, '模板含逻辑 — 用户就编辑不了了').toEqual([]);
  });
});

describe('③ 包声明', () => {
  it('依赖 cluster, 不依赖 core, 研究阶段不发布', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['@neoxlabs/cluster'], 'workflow 应显式依赖 cluster').toBeTruthy();
    expect(pkg.dependencies?.['@neoxlabs/core'], 'workflow 不该直接依赖 core — 执行经 cluster').toBeUndefined();
    expect(pkg.private, '研究阶段不得发布').toBe(true);
  });
});
