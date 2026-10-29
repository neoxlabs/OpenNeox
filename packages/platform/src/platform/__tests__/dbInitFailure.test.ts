import { describe, it, expect, afterEach } from 'vitest';
import {
  clearDbInitFailure,
  describeDbInitFailure,
  getDbInitFailure,
  recordDbInitFailure,
} from '../dbInitFailure.js';
import { routingUnavailableError } from '../providerResolver.js';


afterEach(() => clearDbInitFailure());

describe('dbInitFailure → routing 报错', () => {
  it('有库失败记录时报真实原因, 不再报"需要登录"', () => {
    recordDbInitFailure('/tmp/neox.db', new Error('database disk image is malformed'));
    const failure = getDbInitFailure();
    expect(failure).not.toBeNull();

    const text = describeDbInitFailure(failure!);
    expect(text).toContain('/tmp/neox.db');
    expect(text).toContain('malformed');
    expect(text).toContain('这不是账号登录问题');

    const err = routingUnavailableError();
    expect(err.name).toBe('NeoxRoutingError');
    expect(err.code).toBe('NEOX_DB_UNAVAILABLE');
    expect(err.message).toContain('会话库无法打开');
    expect(err.message).not.toContain('需要登录后使用');
  });

  it('没有库失败记录时保持原登录文案', () => {
    clearDbInitFailure();
    const err = routingUnavailableError();
    expect(err.code).toBe('NEOX_ROUTING_DISABLED');
    expect(err.message).toContain('需要登录后使用');
  });

  it('clearDbInitFailure(path) 只清同一条路径的记录', () => {
    recordDbInitFailure('/tmp/a.db', new Error('boom'));
    clearDbInitFailure('/tmp/other.db');
    expect(getDbInitFailure()?.dbPath).toBe('/tmp/a.db');
    clearDbInitFailure('/tmp/a.db');
    expect(getDbInitFailure()).toBeNull();
  });
});
