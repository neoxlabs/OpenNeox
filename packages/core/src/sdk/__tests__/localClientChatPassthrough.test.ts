/** 进程内 chat 完整透传 ChatRequest，使重试、恢复和工作区等请求语义到达 server。 */
import { describe, expect, it } from 'vitest';
import { LocalNeoxClient } from '../localNeoxClient.js';

function captureBridge() {
  const seen: { sessionId?: string; request?: any } = {};
  const bridge = {
    chat: async (sessionId: string, request: any) => {
      seen.sessionId = sessionId;
      seen.request = request;
    },
  };
  return { seen, client: new LocalNeoxClient(() => bridge as any) };
}

/** fire-and-forget: bridge.chat 不被 await, 让出一轮事件循环再断言 */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('LocalNeoxClient.chat 透传', () => {
  it('isRetry 必须到达 bridge —— 丢了就是"重试把用户消息搬到下面"', async () => {
    const { seen, client } = captureBridge();
    await client.chat('s1', '拉代码', { isRetry: true, userMessageId: 'user-1' });
    await settle();
    expect(seen.request.isRetry).toBe(true);
    expect(seen.request.userMessageId).toBe('user-1');
  });

  it('isResume 同样要到达 (崩溃续跑也靠它跳过重复落库)', async () => {
    const { seen, client } = captureBridge();
    await client.chat('s1', '', { isResume: true });
    await settle();
    expect(seen.request.isResume).toBe(true);
  });

  it('workspacePath 要到达 (会话级工作区绑定靠它, 丢了工具会在别的项目里跑)', async () => {
    const { seen, client } = captureBridge();
    await client.chat('s1', 'hi', { workspacePath: '/tmp/projA' });
    await settle();
    expect(seen.request.workspacePath).toBe('/tmp/projA');
  });

  it('原有字段一个都不能少', async () => {
    const { seen, client } = captureBridge();
    await client.chat('s1', 'hi', {
      mode: 'code', providerId: 'p', modelName: 'm', agentMode: 'assistant',
      effortLevel: 'high', attachments: [{ id: 'a' }], isAutoRouted: true,
      routeConfig: { x: 1 }, modelConfig: { verbosity: 'low' },
      workspaceRoots: ['/a', '/b'], userMessageSource: 'desktop',
    });
    await settle();
    expect(seen.request).toMatchObject({
      mode: 'code', providerId: 'p', modelName: 'm', agentMode: 'assistant',
      effortLevel: 'high', isAutoRouted: true, userMessageSource: 'desktop',
      workspaceRoots: ['/a', '/b'],
    });
  });

  it('prompt 是显式入参, 不许被 opts 里的同名字段盖掉', async () => {
    const { seen, client } = captureBridge();
    await client.chat('s1', '真正要发的', { prompt: '不该生效的' } as any);
    await settle();
    expect(seen.request.prompt).toBe('真正要发的');
  });
});
