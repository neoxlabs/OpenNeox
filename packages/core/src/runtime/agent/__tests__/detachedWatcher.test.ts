/**
 * Detached Watcher — task-agent 完成自动通知主 agent 的链路
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BackgroundAgentManager } from '../backgroundAgent.js';
import {
  __resetBackgroundTaskNotifierForTest,
  getBackgroundTaskNotifier,
} from '../../shell/backgroundTaskNotifier.js';

describe('Detached Watcher', () => {
  beforeEach(() => {
    __resetBackgroundTaskNotifierForTest();
  });

  it('complete() fires <agent-completion> into sessionId inbox', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('agent-1', 'explore auth module', 'dig through src/auth', 'main-session', 'explorer');
    mgr.complete('agent-1', 'Found 3 entry points: login, logout, refresh');

    const notifs = getBackgroundTaskNotifier().drainForSession('main-session');
    expect(notifs).toHaveLength(1);
    expect(notifs[0].xml).toContain('<agent-completion>');
    expect(notifs[0].xml).toContain('<agent-id>agent-1</agent-id>');
    expect(notifs[0].xml).toContain('<name>explorer</name>');
    expect(notifs[0].xml).toContain('<status>completed</status>');
    expect(notifs[0].xml).toContain('Found 3 entry points');
    expect(notifs[0].status).toBe('completed');
  });

  it('fail() fires <agent-completion status=failed>', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('agent-2', 'run tests', 'npm test', 'main-session');
    mgr.fail('agent-2', 'Jest exit 1 — auth.spec.ts failed');

    const [notif] = getBackgroundTaskNotifier().drainForSession('main-session');
    expect(notif).toBeDefined();
    expect(notif.xml).toContain('<status>failed</status>');
    expect(notif.xml).toContain('Jest exit 1');
    expect(notif.status).toBe('failed');
  });

  it('agents without sessionId are silent (no enqueue)', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('agent-orphan', 'detached', 'whatever', undefined);
    mgr.complete('agent-orphan', 'done');

    // No session → no target inbox; shouldn't error,shouldn't accidentally land anywhere
    expect(getBackgroundTaskNotifier().drainForSession('main-session')).toHaveLength(0);
    expect(getBackgroundTaskNotifier().drainForSession('')).toHaveLength(0);
  });

  it('duplicate complete() does not re-fire (notified flag guards)', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('agent-3', 'x', 'y', 'main-session');
    mgr.complete('agent-3', 'r1');
    mgr.complete('agent-3', 'r2');  // should be no-op

    const notifs = getBackgroundTaskNotifier().drainForSession('main-session');
    expect(notifs).toHaveLength(1);
    expect(notifs[0].xml).toContain('r1');
    expect(notifs[0].xml).not.toContain('r2');
  });

  it('long result is truncated in XML', () => {
    const mgr = new BackgroundAgentManager();
    const huge = 'X'.repeat(10_000);
    mgr.register('agent-big', 'huge', 'prompt', 'main-session');
    mgr.complete('agent-big', huge);

    const [notif] = getBackgroundTaskNotifier().drainForSession('main-session');
    expect(notif.xml.length).toBeLessThan(5_000);
    expect(notif.xml).toContain('truncated');
  });

  it('XML escapes special chars in result', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('agent-esc', 'desc with <tag>', 'prompt', 'main-session', 'name & name');
    mgr.complete('agent-esc', 'result: <foo> & "bar"');

    const [notif] = getBackgroundTaskNotifier().drainForSession('main-session');
    expect(notif.xml).toContain('&lt;tag&gt;');
    expect(notif.xml).toContain('name &amp; name');
    expect(notif.xml).toContain('&lt;foo&gt;');
    expect(notif.xml).not.toMatch(/<foo>/);
  });

  it('multiple task-agents completing go to their own session', () => {
    const mgr = new BackgroundAgentManager();
    mgr.register('a1', 'x', 'p', 'session-A');
    mgr.register('a2', 'y', 'p', 'session-B');
    mgr.complete('a1', 'result-A');
    mgr.complete('a2', 'result-B');

    expect(getBackgroundTaskNotifier().drainForSession('session-A')).toHaveLength(1);
    expect(getBackgroundTaskNotifier().drainForSession('session-B')).toHaveLength(1);
  });
});
