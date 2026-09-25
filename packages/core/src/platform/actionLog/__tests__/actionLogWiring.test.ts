/**
 * RuntimeOrchestrator 通过构造参数接收 ActionLog，并为运行、工具和结果事件启用持久化。
 *
 *   测试验证：
 *   RuntimeOrchestrator 里每一处 record() 都写成 `if (this.actionLog)`,
 *   而 agenticRuntime 构造它的时候**根本没传 actionLog**。于是:
 *     run_start / tool_call / run_result 一律不落盘
 *       → 没有 events/*.jsonl
 *       → 短期快照 recent_summary.json 永远不生成
 *       → 没有 run_result → 会话摘要 session_summary.jsonl 永远不生成
 *
 *   断言源码连接关系，防止可选依赖未传入时事件静默丢失。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const runtime = readFileSync(resolve(HERE, '../../../runtime/agenticRuntime.ts'), 'utf8');
const orch = readFileSync(resolve(HERE, '../../../runtime/runtimeOrchestrator.ts'), 'utf8');

describe('agenticRuntime → RuntimeOrchestrator', () => {
  it('构造 orchestrator 时把 actionLog 传进去', () => {
    const i = runtime.indexOf('new RuntimeOrchestrator({');
    expect(i).toBeGreaterThan(-1);
    /* 只看构造调用的头部 —— 传参必须在这里, 不能靠别处补 */
    const head = runtime.slice(i, i + 1400);
    expect(head, 'new RuntimeOrchestrator({ ... }) 里必须有 actionLog').toMatch(/actionLog:\s*config\.actionLog/);
  });

  it('orchestrator 的 record 仍然是 optional-guard —— 所以上面那条是唯一的开关', () => {
    expect(orch).toMatch(/private actionLog\?: ActionLogService/);
    expect(orch).toMatch(/if \(this\.actionLog\)/);
    /* run_result 是会话摘要的唯一触发点, 它必须还在 */
    expect(orch).toMatch(/type: 'run_result'/);
  });
});
