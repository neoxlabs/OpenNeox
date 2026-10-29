import { describe, it, expect } from 'vitest';
import { pickSelfTestProbe, SELFTEST_PLACEHOLDER } from '../connector/selfTestProbe';

const perm = (capability: string, effect = 'readonly') => ({ capability, effect, reason: { en: '' } });
const tool = (capability: string, required: string[] = [], props: Record<string, unknown> = {}) => ({
  name: capability, capability, description: { en: '' },
  input: { type: 'object', required, properties: props },
});

/* Linear 1.0.1 的形状: search 要 query, list_teams 零参数 */
const linear: any = {
  permissions: [perm('task.search'), perm('task.read'), perm('task.create', 'writes'), perm('channel.search')],
  tools: [tool('task.search', ['query']), tool('task.read', ['id']), tool('task.create', ['title', 'teamId']), tool('channel.search')],
};

describe('pickSelfTestProbe', () => {
  it('请求的能力要参数时, 换已授予的零参数只读能力 (2026-09-24 Linear 自检报 $q 未提供)', () => {
    const p = pickSelfTestProbe(linear, new Set(['task.search', 'task.read', 'channel.search']), 'task.search' as any);
    expect(p).toEqual({ kind: 'call', capability: 'channel.search', input: {}, placeholder: false });
  });

  it('零参数能力没授予就不能拿来打, 退回占位参数', () => {
    const p = pickSelfTestProbe(linear, new Set(['task.search']), 'task.search' as any);
    expect(p).toEqual({ kind: 'call', capability: 'task.search', input: { query: SELFTEST_PLACEHOLDER }, placeholder: true });
  });

  it('写能力不填占位', () => {
    const p = pickSelfTestProbe(linear, new Set(['task.create']), 'task.create' as any);
    expect(p).toEqual({ kind: 'none' });
  });

  it('必填参数不是字符串就不猜', () => {
    const c: any = { permissions: [perm('x.read')], tools: [tool('x.read', ['n'], { n: { type: 'number' } })] };
    expect(pickSelfTestProbe(c, new Set(['x.read']), 'x.read' as any)).toEqual({ kind: 'none' });
  });

  it('请求的能力本身零参数就直接打', () => {
    const p = pickSelfTestProbe(linear, new Set(['channel.search']), 'channel.search' as any);
    expect(p).toMatchObject({ capability: 'channel.search', placeholder: false });
  });
});
