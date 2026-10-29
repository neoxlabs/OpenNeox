import type { ChannelRegistry } from '../../channels/registry.js';
import type { EventBus } from '../eventBus.js';
import type { RuntimeBridge } from '../index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

interface SetupChannelAdaptersOptions {
  channelRegistry: ChannelRegistry;
  channelConfig: any;
  bus: EventBus;
  bridge: RuntimeBridge;
}

export async function setupChannelAdapters(options: SetupChannelAdaptersOptions): Promise<void> {
  const { channelRegistry, channelConfig, bus, bridge } = options;
  if (!channelConfig) {
    return;
  }

  await channelRegistry.initialize(channelConfig);
  channelRegistry.setHandler(async (msg) => {
    const sessionId = msg.sessionId ?? `ch-${msg.channelId}-${msg.chatId}`;
    /* 指定了工作区的 channel (GitHub PR): 会话行先建好, 侧栏才有得看、runtime 才知道在哪个目录跑 */
    if (msg.workspacePath) {
      try {
        const { sessionStore } = await import('../../platform/sessionStore.js');
        const existing = await sessionStore.loadSession(sessionId);
        if (existing && existing.workspacePath !== msg.workspacePath) {
          /* 同一个 PR 会话, 工作区搬了 (worktree 落点变了): 行也跟着搬, 否则侧栏点开还指着旧目录 */
          await sessionStore.updateSessionMetadata(sessionId, { workspacePath: msg.workspacePath });
        }
        if (!existing) {
          await sessionStore.createSession({
            sessionId,
            workspacePath: msg.workspacePath,
            modelId: '',
            name: msg.sessionName,
            agentMode: msg.agentMode,
          });
          /* 复用 sub_agent_session_created: 桌面端收到就重拉会话列表 */
          bus.publish({
            sessionId,
            type: 'sub_agent_session_created',
            data: { type: 'sub_agent_session_created', childSessionId: sessionId } as any,
            timestamp: Date.now(),
          });
        }
      } catch (err: any) {
        cliLogger.warn('CHANNEL', `建会话失败 (${sessionId}): ${err?.message ?? err}`);
      }
    }
    return new Promise<string>((resolve) => {
      let result = '';
      const sub = bus.subscribe(sessionId);

      (async () => {
        for await (const event of sub) {
          if (event.data.type === 'run_result') {
            result = event.data.output || '';
            sub.close();
            break;
          }
          if (event.data.type === 'error') {
            result = `Error: ${event.data.message || 'unknown'}`;
            sub.close();
            break;
          }
        }
        resolve(result || '[no response]');
      })();

      bridge.chat(sessionId, {
        prompt: msg.text,
        ...(msg.workspacePath ? { workspacePath: msg.workspacePath, workspaceRoots: [msg.workspacePath] } : {}),
        ...(msg.agentMode ? { agentMode: msg.agentMode } : {}),
        ...(msg.providerId ? { providerId: msg.providerId } : {}),
        ...(msg.modelName ? { modelName: msg.modelName } : {}),
        userMessageSource: `channel-${msg.channelId}`,
      } as any).catch(err => {
        cliLogger.debug('CHANNEL', `Chat failed: ${err?.message}`);
        resolve('[error processing message]');
        sub.close();
      });
    });
  });

  await channelRegistry.startAll();
  cliLogger.info('SERVER', 'Channel adapters initialized');
}
