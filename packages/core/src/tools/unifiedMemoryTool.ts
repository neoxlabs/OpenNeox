
import type { Tool } from '@neoxlabs/kernel/types/index.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';
import { markToolFailure as fail } from '@neoxlabs/kernel/core/types/toolResult.js';
import type { ActionLogService } from '../platform/actionLog/actionLogService.js';
import type { MemoryCategory } from '@neoxlabs/platform/platform/memory/types.js';
import { loadProjectMemoryV2, getModuleContext, readProjectSection, extractProjectSections, type ProjectMemoryV2Result } from '../memory/projectMemoryV2.js';
import fs from 'fs/promises';
import path from 'path';

// ============================================================================
// 类型
// ============================================================================

type MemoryAction = 'read' | 'write' | 'search' | 'update_project';

type MemoryTopic = 'project-context' | 'coding-conventions' | 'debugging-notes' | 'user-preferences' | 'architecture' | 'custom';

const TASK_STATE_PATTERNS = [
  /当前正在/,
  /当前任务/,
  /正在进行/,
  /下一步/,
  /待完成/,
  /已完成.*步/,
  /任务进度/,
  /\d+\/\d+\s*(步|完成)/,
  /current(ly)?\s+(working|doing|task)/i,
  /in progress/i,
  /next step/i,
  /todo.*:/i,
];

interface MemoryToolDeps {
  actionLog: ActionLogService;
  workDir: string;
  /** 运行时缓存的 V2 记忆（可选，避免重复加载） */
  getMemoryV2?: () => ProjectMemoryV2Result | null;
}

// ============================================================================
// 工具创建
// ============================================================================

export function createUnifiedMemoryTool(deps: MemoryToolDeps): Tool {
  return {
    name: 'memory',
    description:
      'Unified memory tool. Four operations:\n' +
      '- read: read project memory and module context\n' +
      '- write: save durable knowledge to .neox/memory/ (one file per topic)\n' +
      '- search: search memory by keyword\n' +
      '- update_project: update project context\n\n' +
      '⚠️ Write rule: only save knowledge that stays valuable across sessions (project facts, coding conventions, debugging lessons, user preferences).\n' +
      'Never save current task state, task progress, temporary plans or file-change logs — the conversation history already carries those.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'search', 'update_project'],
          description: 'Operation type',
        },
        // read 参数
        category: {
          type: 'string',
          enum: ['project', 'module', 'pinned', 'standard', 'lesson', 'progress', 'all'],
          description: '[read] Memory category to read. project = project memory, module = module context, all = everything',
        },
        module_path: {
          type: 'string',
          description: '[read category=module] Module directory path (e.g. src/runtime)',
        },
        section: {
          type: 'string',
          description: '[read category=project] Fetch one section in full by its ## heading (lazy). Omit to read everything. See "project memory index" in the system prompt for the index.',
        },
        max_items: {
          type: 'number',
          description: '[read] Maximum entries returned per category (default 10)',
        },
        // write 参数
        content: {
          type: 'string',
          description: '[write/update_project] Content to save',
        },
        write_category: {
          type: 'string',
          enum: ['pinned', 'standard', 'lesson'],
          description: '[write] Write category. pinned = important decisions, standard = conventions, lesson = lessons learned. Do not use progress — task progress does not belong in memory.',
        },
        topic: {
          type: 'string',
          enum: ['project-context', 'coding-conventions', 'debugging-notes', 'user-preferences', 'architecture', 'custom'],
          description: '[write] Memory topic (inferred automatically; you rarely need to set it)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '[write] Optional tags',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '[write] Related file paths',
        },
        // search 参数
        query: {
          type: 'string',
          description: '[search] Search keyword',
        },
        // update_project 参数
        append: {
          type: 'boolean',
          description: '[update_project] Append instead of overwrite (default false = overwrite)',
        },
      },
      required: ['action'],
    },

    async function(params: Record<string, any>) {
      const action = params.action as MemoryAction;
      const startMs = Date.now();
      cliLogger.info('MEMORY', `action=${action} start`);

      let result: string;
      switch (action) {
        case 'read':
          result = await handleRead(deps, params);
          break;
        case 'write':
          result = await handleWrite(deps, params);
          break;
        case 'search':
          result = await handleSearch(deps, params);
          break;
        case 'update_project':
          result = await handleUpdateProject(deps, params);
          break;
        default:
          result = `未知操作: ${action}。支持: read, write, search, update_project`;
      }

      cliLogger.info('MEMORY', `action=${action} done in ${Date.now() - startMs}ms, resultLen=${result.length}`);
      return result;
    },
  };
}

// ============================================================================
// read 操作
// ============================================================================

async function handleRead(deps: MemoryToolDeps, params: Record<string, any>): Promise<string> {
  const category = (params.category as string) || 'all';
  const maxItems = (params.max_items as number) || 10;
  const sections: string[] = [];

  // 项目记忆 — 支持 section 参数按需读单段, 不指定就读全文
  if (category === 'all' || category === 'project') {
    try {
      const v2 = deps.getMemoryV2?.() ?? await loadProjectMemoryV2(deps.workDir);
      if (v2.project) {
        const sectionName = params.section as string | undefined;
        if (sectionName) {
          /* lazy: 只取指定 section */
          const sectionContent = readProjectSection(v2.project, sectionName);
          if (sectionContent) {
            sections.push(`📄 项目记忆 / ${sectionName} (${v2.projectSource})\n${sectionContent}`);
          } else {
            const allSections = extractProjectSections(v2.project).map(s => s.title);
            sections.push(`📄 项目记忆: 未找到 section "${sectionName}". 可用 sections: ${allSections.join(', ')}`);
          }
        } else {
          sections.push(`📄 项目记忆 (${v2.projectSource})\n${v2.project}`);
        }
      } else {
        sections.push('📄 项目记忆: 无 (.neox/project.md 不存在，可用 /init 生成)');
      }
    } catch {
      sections.push('📄 项目记忆: 加载失败');
    }
  }

  // 模块上下文
  if (category === 'module') {
    const modulePath = params.module_path as string;
    if (!modulePath) {
      return '请指定 module_path 参数（如 src/runtime）';
    }
    try {
      const v2 = deps.getMemoryV2?.() ?? await loadProjectMemoryV2(deps.workDir);
      const content = getModuleContext(v2.modules, path.resolve(deps.workDir, modulePath), deps.workDir);
      if (content) {
        sections.push(`📦 模块上下文: ${modulePath}\n${content}`);
      } else {
        sections.push(`📦 模块 ${modulePath}: 无上下文文件（可用 /init module ${modulePath} 生成）`);
      }
    } catch {
      sections.push(`📦 模块 ${modulePath}: 加载失败`);
    }
  }

  // 长期记忆
  if (category === 'all' || ['pinned', 'standard', 'lesson', 'progress'].includes(category)) {
    const categories: MemoryCategory[] =
      category === 'all'
        ? ['pinned', 'progress', 'standard', 'lesson']
        : [category as MemoryCategory];

    const labels: Record<MemoryCategory, string> = {
      pinned: '📌 固定',
      progress: '📊 进度',
      standard: '📏 规范',
      lesson: '💡 教训',
    };

    for (const cat of categories) {
      const items = await deps.actionLog.getRecentMemoryItems(cat, maxItems);
      if (items.length > 0) {
        const lines = items.map((item, i) =>
          `${i + 1}. ${item.summary}${item.tags?.length ? ` [${item.tags.join(', ')}]` : ''}`,
        );
        sections.push(`${labels[cat]} (${items.length} 条)\n${lines.join('\n')}`);
      } else if (category !== 'all') {
        sections.push(`${labels[cat]}: 无`);
      }
    }
  }

  return sections.join('\n\n') || '无记忆内容';
}

// ============================================================================
// ============================================================================

async function handleWrite(deps: MemoryToolDeps, params: Record<string, any>): Promise<string> {
  const content = params.content as string;
  if (!content) return '请指定 content 参数';

  const isTaskState = TASK_STATE_PATTERNS.some(p => p.test(content));
  if (isTaskState) {
    return '⚠️ 拒绝写入：内容看起来是任务状态/进度信息。\n' +
      '记忆只保存持久的项目知识（技术栈、编码约定、调试经验等），不保存临时任务状态。\n' +
      '任务状态自然保留在对话历史中，无需手动保存。';
  }

  // 确定写入的主题文件
  const topic = (params.topic as MemoryTopic) || inferTopic(content);
  const topicFile = `${topic}.md`;

  try {
    const memoryDir = path.join(deps.workDir, '.neox', 'memory');
    await fs.mkdir(memoryDir, { recursive: true });

    // 写入主题文件（追加）
    const topicPath = path.join(memoryDir, topicFile);
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `\n- [${timestamp}] ${content}\n`;
    await fs.appendFile(topicPath, entry, 'utf-8');

    // 更新 MEMORY.md 索引
    await updateMemoryIndex(memoryDir, topic, content);

    // 同时保存到 ActionLog（兼容旧系统）
    const category = params.write_category as MemoryCategory || 'standard';
    try {
      deps.actionLog.addMemoryItem({
        category,
        summary: content,
        tags: params.tags as string[] | undefined,
        files: params.files as string[] | undefined,
        confidence: 0.85,
      });
    } catch { /* ActionLog 失败不阻塞 */ }

    return `✓ 已保存到 memory/${topicFile}: ${content.substring(0, 80)}`;
  } catch (error: any) {
    return fail(`✗ 保存失败: ${error.message}`);
  }
}

/** 根据内容自动推断主题 */
function inferTopic(content: string): MemoryTopic {
  const lower = content.toLowerCase();
  if (lower.includes('技术栈') || lower.includes('框架') || lower.includes('项目') || lower.includes('架构') || lower.includes('stack') || lower.includes('framework'))
    return 'project-context';
  if (lower.includes('规范') || lower.includes('约定') || lower.includes('命名') || lower.includes('缩进') || lower.includes('convention') || lower.includes('style'))
    return 'coding-conventions';
  if (lower.includes('调试') || lower.includes('踩坑') || lower.includes('bug') || lower.includes('debug') || lower.includes('fix'))
    return 'debugging-notes';
  if (lower.includes('偏好') || lower.includes('喜欢') || lower.includes('prefer') || lower.includes('习惯'))
    return 'user-preferences';
  if (lower.includes('架构') || lower.includes('设计') || lower.includes('architecture') || lower.includes('design'))
    return 'architecture';
  return 'project-context'; // 默认
}

/** 更新 MEMORY.md 索引 */
async function updateMemoryIndex(memoryDir: string, topic: MemoryTopic, content: string): Promise<void> {
  const indexPath = path.join(memoryDir, 'MEMORY.md');

  let existing = '';
  try {
    existing = await fs.readFile(indexPath, 'utf-8');
  } catch { /* 文件不存在 */ }

  // 检查索引中是否已有该主题的链接
  const topicFile = `${topic}.md`;
  if (!existing.includes(`(${topicFile})`)) {
    const topicLabel = {
      'project-context': 'Project Context',
      'coding-conventions': 'Coding Conventions',
      'debugging-notes': 'Debugging Notes',
      'user-preferences': 'User Preferences',
      'architecture': 'Architecture',
      'custom': 'Custom Notes',
    }[topic] || topic;

    const newLine = `- [${topicLabel}](${topicFile}) — ${content.substring(0, 100)}\n`;

    if (!existing.trim()) {
      // 首次创建索引
      await fs.writeFile(indexPath,
        `# Memory Index\n\nAuto-generated memory index. First 200 lines loaded into context.\n\n${newLine}`,
        'utf-8');
    } else {
      await fs.appendFile(indexPath, newLine, 'utf-8');
    }
  }
}

// ============================================================================
// search 操作
// ============================================================================

const MEMORY_SEARCH_TIMEOUT_MS = 15_000;

async function handleSearch(deps: MemoryToolDeps, params: Record<string, any>): Promise<string> {
  const query = (params.query as string)?.trim();
  if (!query) return '请指定 query 参数';

  const startMs = Date.now();
  cliLogger.info('MEMORY_SEARCH', `开始搜索: query="${query}"`);

  try {
    const searchPromise = deps.actionLog.getContextSummary({
      language: 'zh',
      query,
      maxItems: 20,
      maxMemoryItems: 10,
      maxSessionItems: 5,
    });

    // 超时保护
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`memory search 超时 (${MEMORY_SEARCH_TIMEOUT_MS}ms)，query="${query}"`));
      }, MEMORY_SEARCH_TIMEOUT_MS);
    });

    const summary = await Promise.race([searchPromise, timeoutPromise]) as string | null;
    const elapsed = Date.now() - startMs;
    cliLogger.info('MEMORY_SEARCH', `搜索完成: ${elapsed}ms, resultLen=${summary?.length ?? 0}`);

    return summary || `未找到与 "${query}" 相关的记忆`;
  } catch (error: any) {
    const elapsed = Date.now() - startMs;
    cliLogger.error('MEMORY_SEARCH', `搜索失败: ${elapsed}ms, error=${error.message}`);
    return `搜索失败 (${elapsed}ms): ${error.message}`;
  }
}

// ============================================================================
// ============================================================================

async function handleUpdateProject(deps: MemoryToolDeps, params: Record<string, any>): Promise<string> {
  const content = params.content as string;
  if (!content) return '请指定 content 参数';

  const isTaskState = TASK_STATE_PATTERNS.some(p => p.test(content));
  if (isTaskState) {
    return '⚠️ 拒绝写入：内容看起来是任务状态/进度信息。\n' +
      '项目记忆只保存持久的项目知识，不保存临时任务状态。';
  }

  const append = params.append as boolean ?? false;

  try {
    const memoryDir = path.join(deps.workDir, '.neox', 'memory');
    await fs.mkdir(memoryDir, { recursive: true });
    const newPath = path.join(memoryDir, 'project-context.md');

    if (append) {
      const existing = await fs.readFile(newPath, 'utf-8').catch(() => '');
      await fs.writeFile(newPath, existing + '\n' + content, 'utf-8');
    } else {
      await fs.writeFile(newPath, content, 'utf-8');
    }

    // 更新 MEMORY.md 索引
    await updateMemoryIndex(memoryDir, 'project-context', content.substring(0, 100));

    try {
      const oldPath = path.join(deps.workDir, '.neox', 'project.md');
      if (append) {
        const existing = await fs.readFile(oldPath, 'utf-8').catch(() => '');
        await fs.writeFile(oldPath, existing + '\n' + content, 'utf-8');
      } else {
        await fs.writeFile(oldPath, content, 'utf-8');
      }
    } catch { /* 旧路径写入失败不阻塞 */ }

    return `✓ 项目记忆已${append ? '追加' : '更新'}: .neox/memory/project-context.md`;
  } catch (error: any) {
    return fail(`✗ 更新失败: ${error.message}`);
  }
}
