/**
 * DynamicContextInjector — 动态模块上下文注入器
 *
 * 在工具调用后，检测操作的文件路径，自动注入对应的：
 *   - .neox/modules/*.md（模块上下文）
 *   - .neox/rules/*.md（匹配 glob 的条件规则）
 *
 * 通过 ShortTermMemory.upsertSystemTagged 注入，避免重复。
 */

import path from 'path';
import type { ShortTermMemory } from '@neoxlabs/kernel/memory/shortterm.js';
import type { ProjectMemoryV2Result, RuleEntry } from './projectMemoryV2.js';
import { getModuleContext, matchRules } from './projectMemoryV2.js';
import { cliLogger } from '@neoxlabs/kernel/platform/cliLogger.js';

// ============================================================================
// 类型
// ============================================================================

export interface DynamicInjectorConfig {
  memory: ShortTermMemory;
  memoryV2: ProjectMemoryV2Result;
  workDir: string;
}

// ============================================================================
// 注入器
// ============================================================================

const MAX_SECTIONS = 12;
const MAX_CHARS = 12_000;

export class DynamicContextInjector {
  private config: DynamicInjectorConfig;
  /** 淘汰用: section key → 最近一次被命中的序号 (单调自增, 不用时钟) */
  private touchedAt = new Map<string, number>();
  private tick = 0;
  /** 被挤掉过的 section 数 —— 只为日志: "上下文被截断过"这件事得看得见 */
  private evicted = 0;
  /** 已注入的模块 key，避免重复 */
  private injectedModules = new Set<string>();
  /** 已注入的规则 key */
  private injectedRules = new Set<string>();
  private accumulatedSections: Map<string, string> = new Map();

  constructor(config: DynamicInjectorConfig) {
    this.config = config;
  }

  /**
   * 工具调用后触发：根据文件路径注入上下文
   */
  onToolCall(toolName: string, args: any): void {
    const filePaths = extractFilePaths(toolName, args);
    if (filePaths.length === 0) return;

    let changed = false;
    for (const filePath of filePaths) {
      if (this.collectForFile(filePath)) {
        changed = true;
      }
    }

    if (changed) {
      this.flushToMemory();
    }
  }

  /**
   * 收集文件对应的模块/规则上下文，返回是否有新增
   */
  private collectForFile(filePath: string): boolean {
    const { memoryV2 } = this.config;
    /* 规则的 glob 是相对**记忆根**写的, 不是相对当前工作目录 ——
     * 在 <repo>/packages/foo 里干活时, 这两个不是一回事 (见 resolveMemoryRoot)。 */
    const workDir = memoryV2.root || this.config.workDir;
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workDir, filePath);
    const dirPath = path.dirname(absolutePath);
    const relativePath = path.relative(workDir, absolutePath);
    let changed = false;

    // 1. 模块上下文
    if (memoryV2.modules.size > 0) {
      const moduleKey = path.relative(workDir, dirPath).replace(/\//g, '-').split('-').slice(0, 2).join('-');
      if (moduleKey && !this.injectedModules.has(moduleKey)) {
        const content = getModuleContext(memoryV2.modules, dirPath, workDir);
        if (content) {
          this.accumulatedSections.set(`module:${moduleKey}`, `## 模块上下文: ${moduleKey}\n${content}`);
          this.touchedAt.set(`module:${moduleKey}`, ++this.tick);
          this.injectedModules.add(moduleKey);
          cliLogger.info('DYNAMIC_INJECT', `Module context collected: ${moduleKey}`);
          changed = true;
        }
      }
    }

    // 2. 条件规则
    if (memoryV2.rules.size > 0) {
      const matched = matchRules(memoryV2.rules, relativePath);
      for (const rule of matched) {
        const ruleKey = rule.sourcePath;
        if (!this.injectedRules.has(ruleKey)) {
          const name = path.basename(ruleKey, '.md');
          this.accumulatedSections.set(`rule:${name}`, `## 规则: ${name}\n${rule.content}`);
          this.touchedAt.set(`rule:${name}`, ++this.tick);
          this.injectedRules.add(ruleKey);
          cliLogger.info('DYNAMIC_INJECT', `Rule collected: ${name}`);
          changed = true;
        }
      }
    }

    return changed;
  }

  private flushToMemory(): void {
    if (this.accumulatedSections.size === 0) return;
    this.enforceLimits();
    const { memory } = this.config;
    const combined = [...this.accumulatedSections.values()].join('\n\n');
    memory.upsertSystemTagged('dynamic_context', combined);
  }

  /** 到顶就淘汰最久没被碰过的。条数和字符数两条线, 谁先到算谁。 */
  private enforceLimits(): void {
    const order = (): string[] =>
      [...this.accumulatedSections.keys()].sort(
        (a, b) => (this.touchedAt.get(a) ?? 0) - (this.touchedAt.get(b) ?? 0));

    while (this.accumulatedSections.size > MAX_SECTIONS) this.dropOldest(order());
    let chars = [...this.accumulatedSections.values()].reduce((n, s) => n + s.length, 0);
    while (chars > MAX_CHARS && this.accumulatedSections.size > 1) {
      const dropped = this.dropOldest(order());
      if (!dropped) break;
      chars -= dropped.length;
    }
  }

  private dropOldest(sorted: string[]): string | null {
    const key = sorted[0];
    if (!key) return null;
    const content = this.accumulatedSections.get(key) ?? '';
    this.accumulatedSections.delete(key);
    this.touchedAt.delete(key);
    /* 同时从"已注入"集合里摘掉 —— 不摘的话这个模块以后再也不会被重新收集,
     * 而模型正好可能又回到那个目录。淘汰是"先放一放", 不是"永久拉黑"。 */
    this.injectedModules.delete(key.replace(/^module:/, ''));
    this.injectedRules.forEach((r) => {
      if (`rule:${r.split('/').pop()?.replace(/\.md$/, '')}` === key) this.injectedRules.delete(r);
    });
    this.evicted++;
    cliLogger.info('DYNAMIC_INJECT', `上下文到顶, 挤掉最久没用的 ${key} (累计 ${this.evicted} 次)`);
    return content;
  }
}

// ============================================================================
// 文件路径提取
// ============================================================================

/**
 * 从工具调用参数中提取文件路径
 */
function extractFilePaths(toolName: string, args: any): string[] {
  if (!args || typeof args !== 'object') return [];

  const paths: string[] = [];

  // 常见的文件路径参数名
  const pathKeys = [
    'file_path', 'filePath', 'path', 'target',
    'old_file_path', 'new_file_path',
    'source', 'destination',
  ];

  for (const key of pathKeys) {
    if (typeof args[key] === 'string' && args[key]) {
      paths.push(args[key]);
    }
  }

  // glob/grep 的 path 参数
  if (toolName === 'glob' || toolName === 'grep' || toolName === 'search') {
    if (typeof args.directory === 'string') paths.push(args.directory);
  }

  // shell 命令中的文件路径（简单提取）
  if (toolName === 'shell' || toolName === 'bash') {
    const cmd = args.command as string;
    if (cmd) {
      // 提取 cd 后的路径
      const cdMatch = cmd.match(/cd\s+(\S+)/);
      if (cdMatch) paths.push(cdMatch[1]);
    }
  }

  return paths.filter(p => p && !p.startsWith('http'));
}
