import type { PlatformServices } from '@neoxlabs/platform/platform/services.js';
import type { ActionLogService } from '../platform/actionLog/index.js';
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { ensureRuntimePluginsLoaded } from '../tools/packs/toolPack.js';
import { refreshImageModelCatalog } from '../tools/imagegen/imageGenTools.js';
import { getTools } from '../tools/runtimeTools.js';
import { chatToolsAvailability, selectToolsForTurn } from '../tools/chatTools.js';

/* 调用方按「这一轮真带上的工具」生成提示词时也要用它对齐 (见 agenticRuntime 的聊天档 prompt)。 */
export { chatToolsAvailability };

/** 「挑出来是空表」时的重装, 整个进程只试一次。 */
let repairAttempted = false;

/** 测试用: 让下一个会话重新拥有一次重装机会。 */
export function __resetChatToolPoolRepairForTests(): void {
  repairAttempted = false;
}

export interface PrepareChatTurnToolsOptions {
  /** 模式过滤后的池子 (agenticRuntime 的 modeTools) */
  pool: Tool[];
  workDir: string;
  services: PlatformServices;
  actionLog?: ActionLogService;
  sessionId?: string;
}

export interface ChatTurnTools {
  /** 本轮真正交给模型的工具表 */
  tools: Tool[];
  /** 其中真有的能力 —— 提示词按它描述 */
  availability: { search: boolean; image: boolean };
}

export async function prepareChatTurnTools(options: PrepareChatTurnToolsOptions): Promise<ChatTurnTools> {
  const { pool, workDir, services, actionLog, sessionId } = options;

  /* 跟 Work / Code 同一条路: 先装齐插件/工具, 再挑。 */
  await ensureRuntimePluginsLoaded();
  /* 画图能力目录按轮重算 (只影响工具描述, 池子和挑选都不变)。 */
  refreshImageModelCatalog();

  let tools = selectToolsForTurn(pool, true);
  if (tools.length === 0 && !repairAttempted) {
    /* 一件都没有 = 池子没装好 (真没能力时至少还有一件: 没登录只缺画图)。 */
    repairAttempted = true;
    try {
      const fresh = await getTools(workDir, services, actionLog);
      tools = selectToolsForTurn(fresh, true);
      cliLogger.warn('SINGLE_AGENT', 'chat tool pool was empty — reloaded builtin tools', {
        sessionId,
        picked: tools.map((t) => t.name),
      });
    } catch (err: any) {
      cliLogger.warn('SINGLE_AGENT', `chat tool pool reload failed: ${err?.message ?? err}`, { sessionId });
    }
  }

  const availability = chatToolsAvailability(tools);
  cliLogger.info('SINGLE_AGENT', 'chat mode: search + image only', {
    sessionId,
    tools: tools.map((t) => t.name),
    /* 池子多大 / 真带上哪件 —— 工具表为空时这一行能分清「池子没装好」和「挑选没命中」。 */
    poolSize: pool.length,
    available: availability,
  });
  return { tools, availability };
}
