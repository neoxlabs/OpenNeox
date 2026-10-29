import type { Tool, ToolCapabilitySet } from '@neoxlabs/kernel/types/index.js';
import type { ActionLogService } from '../../platform/actionLog/actionLogService.js';
import type { PlatformLogger } from '@neoxlabs/platform/platform/services.js';
import { loadConfig } from '@neoxlabs/platform/utils/config.js';
import { applyParallelSafety } from '../../core/capabilityResolver.js';
import { createEditorTools } from '../editor/tools.js';
import { createTerminalTools } from '../terminal/index.js';
import { createJavaDebugTools } from '../java-debug/index.js';
import { createSmartReadTools } from '../smart-read/index.js';
import { createUnifiedMemoryTool } from '../unifiedMemoryTool.js';
import { createKnowledgeTools } from '../knowledgeTool.js';
import { webSearch } from '../webTools.js';
import { wrapWriteTools } from '../guardedWriteTools.js';
import { filterToolsByCapability, shouldPreferNativeOpenAIWebSearch, webSearchAvailable, getDefaultProvider } from './capabilityFilters.js';
import { filterToolsByEdition, isLite } from './edition.js';

export interface CollectRuntimeToolsParams {
  actionLog?: ActionLogService;
  baseTools: Tool[];
  capabilities?: ToolCapabilitySet;
  logger: PlatformLogger;
  workspacePath?: string;
}

export async function collectRuntimeTools({
  actionLog,
  baseTools,
  capabilities,
  logger,
  workspacePath,
}: CollectRuntimeToolsParams): Promise<Tool[]> {
  const config = loadConfig();
  const tools = [...baseTools];

  const webSearchOff = config.webSearch?.enabled === false;
  const providerProtocol = getDefaultProvider(config)?.protocol;
  if (!webSearchOff && webSearchAvailable(config, providerProtocol) && !shouldPreferNativeOpenAIWebSearch(config)) {
    tools.push(webSearch);
  }

  /* 极简版直接不走下面几个分支 —— 它们不只是多几个 schema, 还各自要拉起一坨实现
   * (java-debug 2.5k 行还要另下 JAR; knowledge 要建索引; terminal/editor 是 GUI 的东西)。
   * 光靠后面那道白名单过滤只能把 schema 摘掉, 模块照样被加载。
   *
   * smart-read **不在**跳过之列: 极简版留的 `readfile` 正是它提供的, 那是读文件的主路。 */
  if (!isLite() && config.javaDebug?.enabled) {
    try {
      const javaDebugTools = await createJavaDebugTools(config.javaDebug?.jarPath);
      tools.push(...javaDebugTools);
      logger.info('TOOLS', `Java Debug 工具已启用 (${javaDebugTools.length} 个工具)`);
    } catch (error: any) {
      logger.error('TOOLS', `Java Debug 工具加载失败: ${error.message}`);
      logger.error('TOOLS', '提示: 运行 npm run setup-java-debug 自动下载 JAR 文件');
    }
  }

  if (config.smartRead?.enabled !== false) {
    try {
      const smartReadTools = createSmartReadTools(workspacePath);
      tools.push(...smartReadTools);
      logger.info('TOOLS', `readfile 工具已启用 (${smartReadTools.length} 个工具)`);
    } catch (error: any) {
      logger.error('TOOLS', `readfile 工具加载失败: ${error.message}`);
    }
  }

  const isRenderer = typeof process !== 'undefined' && (process as any).type === 'renderer';
  if (!isLite() && capabilities?.terminal && isRenderer) {
    tools.push(...createTerminalTools());
  }
  if (!isLite() && capabilities?.editor && isRenderer) {
    tools.push(...createEditorTools());
  } else if (!isLite() && capabilities?.editor) {
    /* Desktop agent 跑在 main/worker: breakpoint/debug 工具仍需 renderer API,
     * 但 read_lints 走 diagnostics bridge, 必须在非 renderer 也挂上. */
    const { readLintsTool } = await import('../editor/readLintsTool.js');
    tools.push({
      ...readLintsTool,
      capabilities: Array.from(new Set([...(readLintsTool.capabilities || []), 'editor' as const])),
    });
  }

  if (actionLog && workspacePath) {
    tools.push(createUnifiedMemoryTool({ actionLog, workDir: workspacePath }));
    logger.info('TOOLS', 'Memory tools enabled (unified)');
  }

  if (!isLite() && workspacePath) {
    tools.push(...createKnowledgeTools({ workDir: workspacePath }));
  }

  const { createNeoxConfigTools } = await import('../neoxConfigTool.js');
  tools.push(...createNeoxConfigTools());

  /* 发行版形态过滤 —— 极简版只留白名单里的十来个 (见 edition.ts)。
   * 放在能力/开关过滤**之前**: 极简版里那些工具压根不该存在, 不是"存在但被关掉"。
   * standard 形态下这一步是恒等的。 */
  const editionFiltered = filterToolsByEdition(tools);
  if (isLite() && editionFiltered.length !== tools.length) {
    logger.info('TOOLS', `lite 形态: ${tools.length} → ${editionFiltered.length} 个工具`);
  }

  const capabilityFiltered = filterToolsByCapability(editionFiltered, capabilities);
  const enabledTools = config.enabledTools || {};
  const filteredTools = capabilityFiltered.filter(tool => enabledTools[tool.name] !== false);

  return wrapWriteTools(applyParallelSafety(filteredTools));
}

export function getAllTools(baseTools: Tool[]): Tool[] {
  return [...baseTools, webSearch];
}
