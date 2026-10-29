import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** crash-resume 的调度点位于进程内与 HTTP 宿主共用的初始化入口。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, '..', 'main.ts');

function fnRange(src: string, decl: string): { start: number; end: number } {
  const start = src.indexOf(decl);
  expect(start, `找不到函数声明: ${decl}`).toBeGreaterThan(-1);
  /* 顶层函数以列 0 的 `}` 收尾 */
  const end = src.indexOf('\n}', start);
  expect(end, `找不到 ${decl} 的结束`).toBeGreaterThan(start);
  return { start, end };
}

describe('crash-resume 的宿主覆盖面', () => {
  const src = fs.readFileSync(MAIN, 'utf-8');

  it('initRuntimeBridge (两条宿主路径共用入口) 里必须调度 resume scan', () => {
    const { start, end } = fnRange(src, 'export async function initRuntimeBridge(');
    const body = src.slice(start, end);
    expect(body).toMatch(/scheduleResumeScan\(/);
  });

  it('调度点带一次性闸 — HTTP 路径重复调不会跑两遍', () => {
    expect(src).toMatch(/if\s*\(_resumeScanScheduled\)/);
    expect(src).toMatch(/_resumeScanScheduled\s*=\s*true/);
  });

  it('两条宿主路径都标了 source, 断链时日志里看得出来是谁没调', () => {
    expect(src).toMatch(/source:\s*'in-process-bridge'/);
    expect(src).toMatch(/source:\s*'http-server'/);
  });
});
