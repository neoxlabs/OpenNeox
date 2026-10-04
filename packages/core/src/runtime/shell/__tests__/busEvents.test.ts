import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const sent: any[] = [];
vi.mock('@neoxlabs/platform/platform/osNotifier.js', () => ({
  sendOsNotification: async (n: any) => { sent.push(n); },
}));

const { BackgroundTaskNotifier } = await import('../backgroundTaskNotifier.js');

function fakePm() {
  return new EventEmitter() as any;
}

beforeEach(() => { sent.length = 0; });

describe('事件总线', () => {
  it('后台进程退出: kind=process, 系统通知由总线推', () => {
    const n = new BackgroundTaskNotifier();
    const pm = fakePm();
    n.attach(pm);
    n.runWithSession('s1', () => n.trackPid(101, 'npm test'));
    pm.emit('process:exit', { pid: 101, command: 'npm test', status: 'failed', exitCode: 1, background: true });
    const [ev] = n.drainForSession('s1');
    expect(ev.kind).toBe('process');
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain('failed');
    expect(sent[0].urgency).toBe('error');
  });

  it('用户亲手停的: 照样进收件箱, 但不推系统通知', () => {
    const n = new BackgroundTaskNotifier();
    const pm = fakePm();
    n.attach(pm);
    n.runWithSession('s1', () => n.trackPid(102, 'npm run dev'));
    pm.emit('process:kill', { pid: 102, command: 'npm run dev', status: 'killed', background: true, terminatedBy: 'user' });
    expect(n.drainForSession('s1')).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('外部 agent: 带类型进收件箱, 系统通知也有了 (以前一条都没有)', () => {
    const n = new BackgroundTaskNotifier();
    const events: any[] = [];
    n.on('notification', (e) => events.push(e));
    n.enqueueMessageForSession('s2', '<agent-completion/>', {
      kind: 'external-agent', status: 'failed',
      osNotice: { title: '✗ Codex 失败', body: '找出 calc.py 的 bug' },
    });
    expect(events[0].notif.kind).toBe('external-agent');
    expect(sent[0]).toMatchObject({ title: '✗ Codex 失败', urgency: 'error' });
  });

  it('不写类型的投递记成 system, 且不推系统通知', () => {
    const n = new BackgroundTaskNotifier();
    n.enqueueMessageForSession('s3', '<x/>', { noAutoResume: true });
    expect(n.drainForSession('s3')[0].kind).toBe('system');
    expect(sent).toHaveLength(0);
  });
});
