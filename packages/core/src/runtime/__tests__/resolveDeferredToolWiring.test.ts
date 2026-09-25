import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

describe('resolveDeferredTool 四跳布线', () => {
  it('agenticRuntime 把钩子传出去', () => {
    const src = read('../agenticRuntime.ts');
    expect(src).toMatch(/const resolveDeferredTool\s*=/);
    /* 传进 host 配置 —— 光定义不传等于没有 */
    expect(src).toMatch(/^\s*resolveDeferredTool,\s*$/m);
  });

  it('RuntimeHostService 声明 + 解构 + 转发, 三处一个都不能少', () => {
    const src = read('../runtimeHostService.ts');
    /* 1. 接口里声明 (没声明 → 调用方传了也是多余属性, 被静默吃掉) */
    expect(src).toMatch(/resolveDeferredTool\?:\s*\(name:\s*string\)\s*=>\s*boolean/);
    /* 2+3. destructure 一次 + 转发给 createAgentRuntimeHost 一次 */
    const hops = src.match(/^\s*resolveDeferredTool,\s*$/gm) ?? [];
    expect(hops.length).toBeGreaterThanOrEqual(2);
  });

  it('hostFactory 声明并转发给 buildRunner', () => {
    const src = read('../hostFactory.ts');
    expect(src).toMatch(/resolveDeferredTool\?:\s*\(name:\s*string\)\s*=>\s*boolean/);
    const hops = src.match(/^\s*resolveDeferredTool,\s*$/gm) ?? [];
    expect(hops.length).toBeGreaterThanOrEqual(2);
  });

  it('runtimeBuilder 把它交给 runner', () => {
    const src = read('../runtimeBuilder.ts');
    expect(src).toMatch(/resolveDeferredTool\?:\s*\(name:\s*string\)\s*=>\s*boolean/);
    expect(src).toMatch(/resolveDeferredTool:\s*options\.resolveDeferredTool/);
  });

  it('runner 真的用它去解锁, 而不是只存下来', () => {
    const src = read('../../../../../packages/kernel/src/core/runner.ts');
    expect(src).toMatch(/this\.resolveDeferredTool\s*=\s*options\.resolveDeferredTool/);
    /* 解锁成功后必须**重算白名单** —— 不重算的话这一轮照旧被拦, 等于没解锁 */
    expect(src).toMatch(/if\s*\(unlockedAny\)/);
  });
});
