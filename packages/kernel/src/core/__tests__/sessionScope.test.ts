/**
 * 会话隔离闸
 * ════════════════════════════════════════════════════════════════════════
 * 服务端只有一个 AgenticRuntime, 所有会话复用它，因此会话状态必须按 session 隔离。
 * 测试覆盖只读模式、计划回灌和压缩熔断不会跨会话传播。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  runWithSessionScope,
  currentSessionScopeId,
  createSessionScopedStore,
  disposeSessionScope,
  DEFAULT_SESSION_SCOPE,
} from '../sessionScope.js';
import { SandboxMode } from '../../types/permissions.js';
import {
  getCurrentSandboxMode,
  setCurrentSandboxMode,
  __resetSandboxModeForTests,
} from '../sandboxMode.js';
import {
  trackWorkState,
  peekWorkState,
  resetWorkStateTracker,
} from '../postCompactReinject.js';
import { getApprovalCache, __resetApprovalCacheForTest } from '../permissions/approvalCache.js';

describe('SessionScope 基本语义', () => {
  it('没有上下文时是默认桶', () => {
    expect(currentSessionScopeId()).toBe(DEFAULT_SESSION_SCOPE);
  });

  it('上下文内拿到自己的 scope, 出来就复原', () => {
    runWithSessionScope({ sessionId: 's1' }, () => {
      expect(currentSessionScopeId()).toBe('s1');
    });
    expect(currentSessionScopeId()).toBe(DEFAULT_SESSION_SCOPE);
  });

  it('嵌套以内层为准 (子 agent 复用父会话 id 时不会互相顶掉)', () => {
    runWithSessionScope({ sessionId: 'outer' }, () => {
      runWithSessionScope({ sessionId: 'inner' }, () => {
        expect(currentSessionScopeId()).toBe('inner');
      });
      expect(currentSessionScopeId()).toBe('outer');
    });
  });

  it('异步链路里也跟着走 (await 之后不丢)', async () => {
    await runWithSessionScope({ sessionId: 'async-1' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentSessionScopeId()).toBe('async-1');
    });
  });
});

describe('SessionScopedStore 的两种继承语义', () => {
  it('inherit=true: 会话没设过就读默认桶 (CLI 设一次全程生效)', () => {
    const store = createSessionScopedStore(() => 'default');
    store.set('global-value', DEFAULT_SESSION_SCOPE);
    runWithSessionScope({ sessionId: 'a' }, () => {
      expect(store.get()).toBe('global-value');
      store.set('a-value');
      expect(store.get()).toBe('a-value');
    });
    runWithSessionScope({ sessionId: 'b' }, () => {
      expect(store.get(), 'b 不该看到 a 设的值').toBe('global-value');
    });
  });

  it('inherit=false: 每个会话独立初值 (运行时状态没有"全局默认"这回事)', () => {
    const store = createSessionScopedStore(() => ({ n: 0 }), { inherit: false });
    runWithSessionScope({ sessionId: 'a' }, () => { store.get().n = 5; });
    runWithSessionScope({ sessionId: 'b' }, () => {
      expect(store.get().n, 'b 拿到了 a 的对象').toBe(0);
    });
  });

  it('桶数有上限并按 LRU 淘汰 —— 长跑 daemon 的会话 id 是无限的', () => {
    const store = createSessionScopedStore(() => 0, { maxScopes: 4, inherit: false });
    for (let i = 0; i < 20; i++) {
      runWithSessionScope({ sessionId: `s${i}` }, () => store.set(i));
    }
    expect(store.size()).toBeLessThanOrEqual(5); // 4 + 默认桶
  });

  it('disposeSessionScope 一次清掉该会话在所有 store 里的桶', () => {
    const s1 = createSessionScopedStore(() => 'x', { inherit: false });
    const s2 = createSessionScopedStore(() => 'y', { inherit: false });
    runWithSessionScope({ sessionId: 'gone' }, () => { s1.set('a'); s2.set('b'); });
    disposeSessionScope('gone');
    runWithSessionScope({ sessionId: 'gone' }, () => {
      expect(s1.get()).toBe('x');
      expect(s2.get()).toBe('y');
    });
  });
});

describe('sandbox 档不再跨会话串味', () => {
  beforeEach(() => __resetSandboxModeForTests());

  it('会话 A 切 read-only 不影响会话 B', () => {
    runWithSessionScope({ sessionId: 'A' }, () => {
      setCurrentSandboxMode(SandboxMode.READ_ONLY);
      expect(getCurrentSandboxMode()).toBe(SandboxMode.READ_ONLY);
    });
    runWithSessionScope({ sessionId: 'B' }, () => {
      expect(getCurrentSandboxMode(), 'B 被 A 的只读档带走了').not.toBe(SandboxMode.READ_ONLY);
    });
  });

  it('没有会话上下文时设的档, 所有会话继承 (CLI 行为不变)', () => {
    setCurrentSandboxMode(SandboxMode.READ_ONLY);
    runWithSessionScope({ sessionId: 'C' }, () => {
      expect(getCurrentSandboxMode()).toBe(SandboxMode.READ_ONLY);
    });
  });
});

describe('压缩回灌的计划不再串会话', () => {
  beforeEach(() => resetWorkStateTracker());

  it('A 的计划不出现在 B 的回灌里', () => {
    runWithSessionScope({ sessionId: 'A' }, () => {
      trackWorkState('plan', [{ content: 'A 的第一步' }, { content: 'A 的第二步' }]);
      expect(peekWorkState().steps).toBe(2);
    });
    runWithSessionScope({ sessionId: 'B' }, () => {
      expect(peekWorkState().steps, 'B 看到了 A 的计划').toBe(0);
    });
  });
});

describe('审批缓存按会话隔离', () => {
  beforeEach(() => __resetApprovalCacheForTest());

  it('A 批准过的命令, B 仍然要问', () => {
    const key = { command: 'rm -rf ./dist', cwd: '/tmp/proj' };
    runWithSessionScope({ sessionId: 'A' }, () => {
      getApprovalCache().set(key, 'approved');
      expect(getApprovalCache().get(key)).toBe('approved');
    });
    runWithSessionScope({ sessionId: 'B' }, () => {
      expect(getApprovalCache().get(key), 'B 白蹭了 A 的批准').toBeUndefined();
    });
  });

  it('clearScope 只清一个会话, 不连累别人', () => {
    const key = { command: 'npm test', cwd: '/tmp/proj' };
    runWithSessionScope({ sessionId: 'A' }, () => getApprovalCache().set(key, 'approved'));
    runWithSessionScope({ sessionId: 'B' }, () => getApprovalCache().set(key, 'approved'));
    runWithSessionScope({ sessionId: 'A' }, () => getApprovalCache().clearScope());
    runWithSessionScope({ sessionId: 'A' }, () => expect(getApprovalCache().get(key)).toBeUndefined());
    runWithSessionScope({ sessionId: 'B' }, () => expect(getApprovalCache().get(key)).toBe('approved'));
  });
});
