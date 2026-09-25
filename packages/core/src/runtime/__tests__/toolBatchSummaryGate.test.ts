/** 验证工具批摘要只有在存在消费方时启用，避免无效的模型调用和延迟。 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = readFileSync(resolve(HERE, '../agentRuntimeHost.ts'), 'utf8');
const REPO = resolve(HERE, '../../../../..');

/** 事件名在某个包的源码里出现几次 (排除转发管道和测试本身)。 */
function hits(pkgRelDir: string): number {
  const dir = resolve(REPO, pkgRelDir);
  if (!existsSync(dir)) return 0;
  try {
    const out = execSync(
      `grep -rl "tool_batch_summary" "${dir}" --include="*.ts" --include="*.tsx" || true`,
      { encoding: 'utf8' },
    );
    return out.split('\n').filter((l) => l.trim() && !/__tests__|\.test\./.test(l)).length;
  } catch {
    return 0;
  }
}

describe('开关和消费方同进同退', () => {
  const consumers =
    hits('apps/desktop/src/ui/renderer') +
    hits('apps/cli/src') +
    hits('packages/kernel/src');

  it('开关声明在, 且是 static readonly（不是运行时能被改花的东西）', () => {
    expect(HOST).toMatch(/private static readonly TOOL_BATCH_SUMMARY_ENABLED = (true|false);/);
  });

  it('开关在真正调用侧路 agent **之前**就 return —— 晚一步就白烧了', () => {
    const i = HOST.indexOf('private trackToolCallForSideAgent');
    expect(i).toBeGreaterThan(0);
    const block = HOST.slice(i, i + 1600);
    const gate = block.indexOf('TOOL_BATCH_SUMMARY_ENABLED');
    const adapter = block.indexOf('this.sideAgentAdapter?.scheduleToolBatchSummary');
    expect(gate, '找不到开关判定').toBeGreaterThan(0);
    expect(gate, '开关排在 adapter 判定后面').toBeLessThan(adapter);
  });

  it('没有消费方时开关必须关着 —— 否则每批工具白烧一次 LLM 调用', () => {
    const enabled = /TOOL_BATCH_SUMMARY_ENABLED = true;/.test(HOST);
    if (consumers === 0) {
      expect(enabled, '全仓没有任何消费方, 但开关是 true —— 用户在为看不见的东西付钱').toBe(false);
    }
  });

  it('有了消费方就该把开关翻 true —— 否则接了 UI 却永远收不到事件', () => {
    const enabled = /TOOL_BATCH_SUMMARY_ENABLED = true;/.test(HOST);
    if (consumers > 0) {
      expect(enabled, `检测到 ${consumers} 个消费方, 但开关仍是 false`).toBe(true);
    }
  });
});
