/** 验证自动压缩只使用 kernel 引擎和 AI 摘要；没有摘要模型时明确跳过，不静默降级。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** 剥掉注释再比 —— 删除理由本身写在注释里, 不剥会被自己打中. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('机械压缩已经删除, 不许长回来', () => {
  it('compactor 里没有 lightweightCompactSession', () => {
    const src = code(read('compat/compactor.ts'));
    expect(src).not.toContain('lightweightCompactSession');
  });

  it('agentRuntimeHost 不再引用它', () => {
    const src = code(read('runtime/agentRuntimeHost.ts'));
    expect(src).not.toContain('lightweightCompactSession');
  });

  it('自动压缩只走 runner.compactNow (kernel 引擎)', () => {
    const src = code(read('runtime/agentRuntimeHost.ts'));
    /* compactNow → compressContextWindow → UnifiedCompressor (分桶 + LLM 摘要 +
     * 净增回退 + 保护区)。这是唯一的压缩入口。 */
    expect(src).toContain('compactNow');
  });

  it('没有摘要模型时**不压缩**, 而不是降级', () => {
    const src = read('runtime/agentRuntimeHost.ts');
    /* 那一支必须明确告诉用户"无法压缩"并跳过 —— 不许再出现第二种压缩实现 */
    expect(src).toContain('没有可用的摘要模型');
    expect(src).toContain('No summary model — compaction skipped');
  });
});
