import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchCommandFromMain } from '../commands/commandDispatcher.js';
import { __resetCliEditionForTests } from '../edition/index.js';

describe('/whoami 是 /stats 的别名', () => {
  const noop = () => ({});
  beforeEach(() => {
    __resetCliEditionForTests();
  });

  it('不依赖发行版插槽也能被识别', async () => {
    const showStats = vi.fn(async () => {});
    const handled = await dispatchCommandFromMain({
      cmd: '/whoami',
      args: [],
      getBasicCommandRoutingDeps: noop,
      getModeAndModelCommandRoutingDeps: noop,
      getAttachmentCommandRoutingDeps: noop,
      getServiceCommandRoutingDeps: noop,
      getUiUtilityCommandRoutingDeps: noop,
      getModeFeatureCommandRoutingDeps: noop,
      getSessionProcessRoutingDeps: noop,
      getMiscCommandRoutingDeps: () => ({ showStats }),
    });
    expect(handled).toBe(true);
    expect(showStats).toHaveBeenCalledTimes(1);
  });
});
