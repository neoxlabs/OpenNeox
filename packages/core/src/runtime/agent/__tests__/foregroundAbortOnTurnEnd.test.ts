/** turn 收尾只中止前台子 agent；后台子 agent 按设计跨越当前轮次继续运行。 */
import { describe, expect, it } from 'vitest';
import { BackgroundAgentManager } from '../backgroundAgent.js';

describe('turn 收尾收前台子 agent', () => {
  it('⭐️ 前台的收掉, 后台的留着, 别的会话不碰', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('Fg-1', '前台调研员', 'p', 'S1', 'fg1', { synchronous: true });
    mgr.register('Bg-1', '后台长任务', 'p', 'S1', 'bg1');
    mgr.register('Fg-2', '别的会话的前台', 'p', 'S2', 'fg2', { synchronous: true });

    const killed = mgr.abortForegroundBySession('S1');
    expect(killed).toBe(1);

    const s1 = mgr.listActive('S1').map((t) => t.agentId);
    /* 后台按设计活过本轮 —— 收尾那一刀绝不能连坐 */
    expect(s1).toContain('Bg-1');
    expect(s1).not.toContain('Fg-1');

    /* 别的会话完全不受影响 */
    expect(mgr.listActive('S2').map((t) => t.agentId)).toContain('Fg-2');
  });

  it('没有前台在跑时是个安全的空操作', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('Bg-1', '后台', 'p', 'S1', 'bg1');
    expect(mgr.abortForegroundBySession('S1')).toBe(0);
    expect(mgr.listActive('S1').map((t) => t.agentId)).toContain('Bg-1');
  });
});
