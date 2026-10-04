/**
 * 错误行对齐截断
 *
 * 修的是: 头尾各 40% 的老策略把中段整个丢掉, 而测试失败 / 编译报错 / stack trace
 * 恰恰最常落在中段 —— 模型看不到失败真相, 只能凭汇总行猜, 于是重跑/乱改。
 */
import { describe, it, expect } from 'vitest';
import { truncateToolOutput } from '../toolOutputTruncation.js';

/** 造一段:头部噪声 + 中段错误 + 尾部汇总, 总长远超预算 */
function buildLog(opts: { errorLine: string; padLine?: string }): string {
  const pad = (opts.padLine ?? 'progress: compiling module') + ' '.repeat(40);
  const head = Array.from({ length: 300 }, (_, i) => `[head ${i}] ${pad}`).join('\n');
  const mid = Array.from({ length: 300 }, (_, i) => `[mid ${i}] ${pad}`).join('\n');
  const tail = Array.from({ length: 300 }, (_, i) => `[tail ${i}] ${pad}`).join('\n');
  return `${head}\nSTART_MARK\n${mid}\n${opts.errorLine}\n${mid}\n${tail}\nEND_MARK`;
}

const BUDGET = 4000;

describe('错误行对齐截断', () => {
  it('中段的 Error 行被保留 (老策略会整段丢掉)', () => {
    const log = buildLog({ errorLine: 'Error: expected 3 to equal 4 at foo.spec.ts:42' });
    const out = truncateToolOutput(log, BUDGET);

    expect(out).toContain('Error: expected 3 to equal 4');
    expect(out).toContain('error_aligned=true');
    /* 头尾仍在 —— 命令上下文与汇总不能丢 */
    expect(out).toContain('[head 0]');
    expect(out).toContain('END_MARK');
    expect(out.length).toBeLessThan(log.length);
  });

  it('FAILED / traceback / panic 同样识别', () => {
    for (const line of [
      'FAILED tests/test_api.py::test_create - assert 500 == 200',
      'Traceback (most recent call last):',
      'panic: runtime error: index out of range [3]',
      '    at handler (/app/src/server.ts:88:12)',
    ]) {
      const out = truncateToolOutput(buildLog({ errorLine: line }), BUDGET);
      expect(out, `should keep: ${line}`).toContain(line.trim().slice(0, 20));
    }
  });

  it('没有错误行 → 走老的中段截断 (行为不变)', () => {
    const clean = buildLog({ errorLine: '[mid ok] all good', padLine: 'ok' });
    const out = truncateToolOutput(clean, BUDGET);
    expect(out).not.toContain('error_aligned=true');
    expect(out).toContain('chars truncated in middle');
  });

  it('"0 errors" 这类汇总行不算失败证据', () => {
    const out = truncateToolOutput(
      buildLog({ errorLine: 'Summary: 0 errors, 0 warnings, 120 passed' }),
      BUDGET,
    );
    expect(out).not.toContain('error_aligned=true');
  });

  it('errorHandler / failsafe 这类命名不误伤', () => {
    const out = truncateToolOutput(
      buildLog({ errorLine: 'registered errorHandler and failsafe middleware' }),
      BUDGET,
    );
    expect(out).not.toContain('error_aligned=true');
  });

  it('错误就在头部 → 老策略已覆盖, 不做特殊处理', () => {
    const pad = 'x'.repeat(60);
    const head = `Error: boom at line 1\n${Array.from({ length: 400 }, (_, i) => `[h${i}] ${pad}`).join('\n')}`;
    const out = truncateToolOutput(`${head}\n${'y'.repeat(20000)}\nEND`, BUDGET);
    expect(out).toContain('Error: boom');
    expect(out).not.toContain('error_aligned=true');
  });

  it('短内容不动', () => {
    const short = 'Error: tiny';
    expect(truncateToolOutput(short, BUDGET)).toBe(short);
  });

  it('输出长度受预算约束 (marker 之外不失控)', () => {
    const log = buildLog({ errorLine: 'Error: budget check' });
    const out = truncateToolOutput(log, BUDGET);
    /* head 15% + window 60% + tail 25% = 100% 预算, 另加两段 marker */
    expect(out.length).toBeLessThan(BUDGET + 1200);
  });
});
