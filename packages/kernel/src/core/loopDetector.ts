/**
 * Loop Detector - 工具循环检测器
 *
 * 检测 LLM 是否陷入工具循环，并提供引导策略而非直接终止
 *
 * 设计原则：
 * 1. 不撒谎原则：不告诉 LLM "工具已成功"，而是引导它自己验证
 * 2. 引导而非终止：Soft/Medium loop 注入引导消息，Hard loop 才终止
 * 3. 基于证据决策：让 LLM 通过其他工具（readfile/grep）验证
 */

import { createHash } from 'crypto';
import { cliLogger } from '../platform/cliLogger.js';

/**
 * 循环检测级别
 */
export enum LoopLevel {
  /** 没有循环 */
  NONE = 0,
  /** 软循环（2次）：引导验证 */
  SOFT = 2,
  /** 中循环（3次）：强制要求验证 */
  MEDIUM = 3,
  /** 硬循环（4次+）：终止 */
  HARD = 4,
}

/**
 * 工具调用记录
 *
 *  已导出:runState.toSnapshot 依赖它 JSON 化 history。
 * 所有字段必须是 JSON-friendly(没有 Map/Set/Date/函数)。
 */
export interface ToolCallRecord {
  /** 工具名+参数的哈希 */
  hash: string;
  /** 工具名称 */
  toolName: string;
  /** 参数（用于调试） */
  args?: Record<string, unknown>;
  /** 时间戳 */
  timestamp: number;
  /** 结果状态 */
  resultStatus?: 'success' | 'error' | 'already_done';
  /** 文件路径（如果有） */
  filePath?: string;
  /** 输出尾部签名,用于差异豁免判定(例如 shell stderr 每次不同就不算循环) */
  outputSignature?: string;
}

/* 读/查看类工具享受变更豁免：目标文件在两次调用之间发生变化时，
 * 先前调用不计入重复。open_surface 属于查看产出物的工具，也使用该规则。 */
const READ_TOOL_NAMES = new Set([
  'readfile',
  'read',
  'open_surface',      // 右栏预览 = 看一眼产出物
  'word_get_paragraphs',
  'word_get_table',
  'word_get_tables',
  'word_describe',
  'sheet_get_range',
  'sheet_describe',
]);

/* 记录会修改文件的工具及其最后变更时间，用于支持上面的变更豁免。 */
const FILE_MUTATION_TOOL_NAMES = new Set([
  'edit_file',
  'edit',
  'write_file',
  'write',
  'delete_file',
  /* 文档生成/编辑 */
  'create_slides',
  'word_create',
  'word_edit_paragraph',
  'word_insert_paragraph',
  'word_delete_paragraph',
  'word_replace_text',
  'word_set_cell',
  'word_export',
  'sheet_new_workbook',
  'sheet_write_range',
  'sheet_export_file',
  /* 图像 */
  'generate_image',
  'edit_image',
]);

const SHELL_TOOL_NAMES = new Set([
  'execute_shell',
  'execute_bash',
  'bash',
  'shell',
  'run_command',
]);

const BROWSER_TOOL_NAMES = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_click',
  'browser_click_at',
  'browser_type',
  'browser_scroll',
  'browser_evaluate',
  'browser_get_state',
  'browser_get_console_logs',
  'browser_get_network',
  'browser_get_aria_tree',
  'browser_query',
  'browser_wait',
  'browser_list_surfaces',
]);

/**
 * 只有最近 N 秒内的重复调用参与循环判定；更早的调用视为上下文已切换。
 */
const DEFAULT_RECENT_WINDOW_MS = 60_000;

/**
 * 跨窗口累计 advisory 阈值 (audit §4 P2):
 * 60s 窗口挡不住"慢节奏重复" — 每隔一两分钟跑一次同命令, 单窗口命中永远只有 1,
 * 却在全会话持续烧 token。同 (tool,argsHash) 全会话累计命中达到该值、且历次输出
 * 签名从未出现差异 (每次结果一样 = 没获取新信息) 时, 把判级升到 MEDIUM advisory。
 * 保守设计: 只升不降, 从不升到 HARD (不触发 gate 硬拦, 只注入干预消息)。
 */
const CUMULATIVE_ADVISORY_THRESHOLD = 12;

/** shell 命令 output 取尾部若干字符参与签名;stderr 通常在末尾 */
const OUTPUT_SIGNATURE_TAIL = 400;

/**
 * 构造工具输出签名,用于"结果差异豁免":
 * 如果历次相同命令的输出签名都不一样,说明 LLM 在调试(每次有新信息),
 * 不该判为循环。
 */
export function buildOutputSignature(output: string | undefined | null): string | undefined {
  if (!output) return undefined;
  const str = typeof output === 'string' ? output : String(output);
  if (!str) return undefined;
  const tail = str.length > OUTPUT_SIGNATURE_TAIL ? str.slice(-OUTPUT_SIGNATURE_TAIL) : str;
  return createHash('sha256').update(tail).digest('hex').substring(0, 12);
}

/**
 * 循环干预结果
 */
export interface LoopIntervention {
  /** 干预消息 —— **写给模型的**指令 (英文祈使句), 只进对话上下文, 不该出现在界面上 */
  message: string;
  /**
   * 给**用户**看的一句人话。
   *
   *   message 只写入模型上下文，userNotice 提供简短的用户可见说明。
   */
  userNotice?: string;
  /** 是否应该终止 */
  shouldTerminate: boolean;
  /** 循环级别 */
  level: LoopLevel;
  /** 最后一次是否成功 */
  wasSuccessful?: boolean;
}

/**
 * 循环检测器
 */
/** 跨窗口累计条目: 全会话命中数 + 输出签名是否出现过差异 (慢节奏重复判定用) */
interface CumulativeCallStats {
  count: number;
  firstSignature?: string;
  hasDivergence: boolean;
}

export class LoopDetector {
  private history: ToolCallRecord[] = [];
  private maxHistory = 40;
  private interventionCount = 0;
  /**
   * 跨窗口累计: hash → 全会话统计。history 有 maxHistory=40 上限会被驱逐,
   * 这份 Map 不驱逐, 专门支撑"慢节奏重复"检测 (见 CUMULATIVE_ADVISORY_THRESHOLD)。
   */
  private cumulativeByHash = new Map<string, CumulativeCallStats>();

  private isReadToolName(toolName: string): boolean {
    return READ_TOOL_NAMES.has(toolName.toLowerCase());
  }

  private isFileMutationToolName(toolName: string): boolean {
    return FILE_MUTATION_TOOL_NAMES.has(toolName.toLowerCase());
  }

  private isShellToolName(toolName: string): boolean {
    return SHELL_TOOL_NAMES.has(toolName.toLowerCase());
  }

  private extractPath(args: Record<string, unknown>): string | undefined {
    /* 不同工具的路径参数名/层级都不一样, 只认顶层 file_path/path 会漏:
     *   open_surface  → source.path (**嵌套**)
     *   create_slides → outputPath
     * 漏了的后果不是报错而是**变更豁免静默失效** —— 表现为正当的"改完再看"被判成循环。 */
    const a = args as Record<string, any>;
    const nested = a.source && typeof a.source === 'object' ? a.source.path : undefined;
    const raw = a.file_path || a.path || a.directory || a.outputPath || a.output_path || nested;
    return typeof raw === 'string' && raw.trim() ? raw : undefined;
  }

  private pathsMaybeMatch(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.endsWith(b) || b.endsWith(a);
  }

  private getLatestMutationTimestampForPath(filePath?: string): number {
    if (!filePath) return 0;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const item = this.history[index];
      if (!this.isFileMutationToolName(item.toolName)) continue;
      if (this.pathsMaybeMatch(item.filePath, filePath)) {
        return item.timestamp;
      }
    }
    return 0;
  }

  private getRecentSameCalls(toolName: string, args: Record<string, unknown>): ToolCallRecord[] {
    const hash = this.hashArgs(toolName, args);
    const windowCutoff = Date.now() - DEFAULT_RECENT_WINDOW_MS;
    // 只看时间窗口内的同 hash 调用;超过窗口的视为已失效的旧上下文
    const sameHashCalls = this.history.filter(
      (h) => h.hash === hash && h.timestamp >= windowCutoff,
    );
    if (!this.isReadToolName(toolName)) {
      return sameHashCalls;
    }
    const filePath = this.extractPath(args);
    const mutationCutoff = this.getLatestMutationTimestampForPath(filePath);
    if (mutationCutoff <= 0) {
      return sameHashCalls;
    }
    return sameHashCalls.filter((item) => item.timestamp > mutationCutoff);
  }

  /**
   * 判定同组调用的输出是否有差异。
   *
   * 设计目的:当 LLM 重复跑相同命令但每次输出不同(例如追 bug 时 stderr 变化),
   * 说明它在获取新信息,不属于"盲目重试循环",应该放行。
   *
   * 触发条件:至少 2 条 sameCall 带签名,且签名集合有 >=2 个不同值。
   */
  private hasResultDivergence(sameCalls: ToolCallRecord[]): boolean {
    const signatures: string[] = [];
    for (const call of sameCalls) {
      if (call.outputSignature) signatures.push(call.outputSignature);
    }
    if (signatures.length < 2) return false;
    const unique = new Set(signatures);
    return unique.size >= 2;
  }

  /**
   * 计算参数哈希
   *
   * 策略：
   * - readfile: 完整参数（不同 offset 是不同操作）
   * - edit_file/Edit: file_path + old_string（不同位置编辑是不同操作）
   * - write_file/Write: 仅 file_path（重复写入同一文件是循环）
   * - 其他: 完整参数
  */
  private hashArgs(toolName: string, args: Record<string, unknown>): string {
    const hashInput: Record<string, unknown> = {};
    const normalizedToolName = toolName.toLowerCase();
    const toolArgs = args as Record<string, any>;

    // 读取类工具：使用完整参数（不同 offset 是不同操作）
    // 同文件不同 offset 的重复检测由 detect() 中的 FILE_LOOP 逻辑处理
    if (normalizedToolName === 'readfile' || normalizedToolName === 'read') {
      Object.assign(hashInput, toolArgs);
    }
    // 编辑类工具 (内容寻址): file_path + old_string + new_string.
    // 同一 (old_string → new_string) 重复才是循环; 不同 old_string = 改不同地方, 不算。
    else if (normalizedToolName === 'edit_file' || normalizedToolName === 'edit') {
      hashInput.file_path = toolArgs.file_path || toolArgs.path;

      const oldString = toolArgs.old_string ?? toolArgs.old;
      if (typeof oldString === 'string') {
        hashInput.old_string_prefix = oldString.substring(0, 200);
      }
      const newString = toolArgs.new_string ?? toolArgs.new;
      if (typeof newString === 'string') {
        hashInput.new_string_prefix = newString.substring(0, 200);
      }
      // 行号桥接路径 (模型只发 start_line) 仍带上, 区分不同位置。
      const startLine = toolArgs.start_line ?? toolArgs.startLine;
      if (typeof startLine === 'number' || typeof startLine === 'string') {
        hashInput.start_line = Number(startLine);
      }

      if (Array.isArray(toolArgs.hunks)) {
        hashInput.hunks = toolArgs.hunks.slice(0, 12).map((hunk: any) => ({
          old: typeof (hunk?.old_string ?? hunk?.old) === 'string'
            ? String(hunk.old_string ?? hunk.old).substring(0, 60)
            : '',
          new: typeof (hunk?.new_string ?? hunk?.new) === 'string'
            ? String(hunk.new_string ?? hunk.new).substring(0, 60)
            : '',
        }));
      }
    }
    // 写入类工具：文件路径 + 内容指纹 + mode。
    //
    // 指纹必须同时覆盖路径和内容: 模型反复改写同一个脚本 (每次换一种实现再跑) 属于正当
    // 迭代, 只按路径比对会把它当成循环, 硬拦之后对上层表现为「写入失败」。而内容完全相同
    // 的重写根本轮不到这里 —— write_file 自己按 sha256 在幂等窗内就判成 already_done。
    // 所以只有 (path, content) 两者都一样才算原地打转, 这也是下面把 content_sha 一起塞进
    // hashInput 的原因。
    else if (normalizedToolName === 'write_file' || normalizedToolName === 'write') {
      hashInput.file_path = toolArgs.file_path || toolArgs.path;
      const content = toolArgs.content;
      if (typeof content === 'string') {
        hashInput.content_sha = createHash('sha256').update(content).digest('hex').substring(0, 16);
      }
      if (typeof toolArgs.mode === 'string') hashInput.mode = toolArgs.mode;
    }
    // Shell 类工具:只按 command hash,忽略 background/timeout 这类元参数
    // 背景参数在不同执行场景会被自动推断而变化,参与 hash 会导致相同命令被误判为不同
    else if (SHELL_TOOL_NAMES.has(normalizedToolName)) {
      const command = toolArgs.command ?? toolArgs.cmd ?? toolArgs.script;
      if (typeof command === 'string') {
        hashInput.command = command.trim();
      }
    }
    // 搜索类工具：路径 + 查询条件
    // 避免 "同一路径不同 pattern" 被误判为同一调用
    else if (
      normalizedToolName === 'search'
      || normalizedToolName === 'search_files'
      || normalizedToolName === 'glob'
      || normalizedToolName === 'grep'
    ) {
      hashInput.path = toolArgs.path || toolArgs.file_path || toolArgs.directory;
      hashInput.mode = toolArgs.mode;
      hashInput.pattern = toolArgs.pattern;
      hashInput.query = toolArgs.query;
      hashInput.op = toolArgs.op;
      hashInput.regex = toolArgs.regex;
      hashInput.case_insensitive = toolArgs.case_insensitive;
      hashInput.recursive = toolArgs.recursive;
      hashInput.file_pattern = toolArgs.file_pattern || toolArgs.filePattern;
      hashInput.include_pattern = toolArgs.include_pattern || toolArgs.includePattern;
      hashInput.exclude_pattern = toolArgs.exclude_pattern || toolArgs.excludePattern;
      hashInput.file_type = toolArgs.file_type || toolArgs.fileType;
      hashInput.include_hidden = toolArgs.include_hidden;
      hashInput.context_lines = toolArgs.context_lines;
      hashInput.max_matches = toolArgs.max_matches;
      hashInput.count_only = toolArgs.count_only;

      if (Array.isArray(toolArgs.keywords)) {
        hashInput.keywords = toolArgs.keywords.map((item: any) => String(item));
      }

      if (Array.isArray(toolArgs.extensions)) {
        hashInput.extensions = toolArgs.extensions.map((item: any) => String(item));
      }

      if (Array.isArray(toolArgs.queries)) {
        hashInput.queries = toolArgs.queries.map((item: any) => ({
          pattern: item?.pattern,
          op: item?.op,
          regex: item?.regex,
        }));
      }
    }
    // 其他带路径的工具
    else if (toolArgs.file_path) {
      hashInput.file_path = toolArgs.file_path;
    } else if (toolArgs.path) {
      hashInput.path = toolArgs.path;
    } else if (toolArgs.directory) {
      hashInput.directory = toolArgs.directory;
    } else {
      // 其他工具使用全部参数
      Object.assign(hashInput, toolArgs);
    }

    const str = `${normalizedToolName}:${JSON.stringify(hashInput)}`;
    return createHash('sha256').update(str).digest('hex').substring(0, 16);
  }

  /** 累计一次同 hash 命中, 并按输出签名维护差异标记 */
  private trackCumulative(hash: string, outputSignature?: string): void {
    const entry = this.cumulativeByHash.get(hash);
    if (!entry) {
      this.cumulativeByHash.set(hash, { count: 1, firstSignature: outputSignature, hasDivergence: false });
      return;
    }
    entry.count++;
    this.noteCumulativeSignature(hash, outputSignature);
  }

  /** 补录输出签名 (不增计数) — updateLastStatus 后置补签名时也要参与差异判定 */
  private noteCumulativeSignature(hash: string, outputSignature?: string): void {
    if (!outputSignature) return;
    const entry = this.cumulativeByHash.get(hash);
    if (!entry) return;
    if (entry.firstSignature === undefined) {
      entry.firstSignature = outputSignature;
    } else if (entry.firstSignature !== outputSignature) {
      entry.hasDivergence = true;
    }
  }

  /**
   * 记录工具调用
   */
  record(
    toolName: string,
    args: Record<string, unknown>,
    resultStatus?: 'success' | 'error' | 'already_done',
    outputSignature?: string,
  ): void {
    const hash = this.hashArgs(toolName, args);
    this.trackCumulative(hash, outputSignature);

    /* 提取文件路径 —— **必须走 extractPath**, 不要在这里再抄一份。
       : 这里原本内联了 (file_path || path || directory), 跟 extractPath 是两份实现。
       我给 extractPath 补了 outputPath / 嵌套 source.path 之后, 这里没跟着变 →
       create_slides 的 mutation 记不下路径 → 变更豁免静默失效, 测例照旧判 HARD。
       同一个公式散在两处, 改一处永远不生效。 */
    const filePath = this.extractPath(args);

    //  DEBUG: 追踪记录过程
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('LOOP_DETECTOR', `Recording ${toolName}:`, {
        hash: hash.substring(0, 8),
        argsPreview: JSON.stringify(args).substring(0, 150),
        historyLengthBefore: this.history.length,
      });
    }

    // Defensive clone: caller 若在 record 之后继续修改 args(理论上罕见但允许),
    // 不应污染我们的历史记录。shallow clone 足够(args 内部是原始值+字符串)。
    this.history.push({
      hash,
      toolName,
      args: { ...args },
      timestamp: Date.now(),
      resultStatus,
      filePath,
      outputSignature,
    });

    // 保持历史记录在合理范围内
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * 更新最后一次调用的状态(后置调用,tool 执行后补录 status 和 output 签名)
   */
  updateLastStatus(
    status: 'success' | 'error' | 'already_done',
    outputSignature?: string,
  ): void {
    if (this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      last.resultStatus = status;
      if (outputSignature) {
        last.outputSignature = outputSignature;
        this.noteCumulativeSignature(last.hash, outputSignature);
      }
    }
  }

  /**
   * 检测循环级别
   */
  detect(toolName: string, args: Record<string, unknown>): LoopLevel {
    const hash = this.hashArgs(toolName, args);
    const recentSame = this.getRecentSameCalls(toolName, args);

    //  REMOVED: FILE_LOOP 检测（按文件路径聚合）
    // 不同 offset 读同一文件是分段读取，不是循环。
    // hash-based 检测已经能正确处理真正的重复（完全相同的参数）。

    //  DEBUG: 追踪循环检测过程
    if (process.env.CLI_DEBUG === '1') {
      cliLogger.debug('LOOP_DETECTOR', `Detecting loop for ${toolName}:`, {
        hash: hash.substring(0, 8),
        historyCount: this.history.length,
        sameHashCount: recentSame.length,
        args: JSON.stringify(args).substring(0, 100),
      });
    }

    /* 窗口内判级 + 跨窗口累计升级两层叠加:
     * 窗口层负责"快节奏原地打转", 累计层负责"时间隔开的慢节奏重复"。 */
    return this.escalateSlowRepeat(hash, this.detectWithinWindow(toolName, recentSame));
  }

  /** 60s 窗口内的判级 (原 detect 主体, 语义不变) */
  private detectWithinWindow(toolName: string, recentSame: ToolCallRecord[]): LoopLevel {
    // Shell 类工具走更宽松的阈值 + 差异豁免:
    // build/test/lint/check 这类命令在 LLM 追 bug 时经常被正常地反复运行,
    // 只有当每次输出几乎一致(真的原地打转)才应拦截。
    if (this.isShellToolName(toolName)) {
      if (recentSame.length < 3) return LoopLevel.NONE;
      if (this.hasResultDivergence(recentSame)) return LoopLevel.NONE;
      if (recentSame.length >= 5) return LoopLevel.HARD;
      if (recentSame.length >= 4) return LoopLevel.MEDIUM;
      return LoopLevel.SOFT;
    }

    /* 浏览器工具: E2E 测试会反复 screenshot/click/navigate 同一 surface,
     * 走 shell 同款宽松阈值 (5 次才 HARD, 有差异豁免). */
    if (BROWSER_TOOL_NAMES.has(toolName.toLowerCase())) {
      if (recentSame.length < 3) return LoopLevel.NONE;
      if (this.hasResultDivergence(recentSame)) return LoopLevel.NONE;
      if (recentSame.length >= 6) return LoopLevel.HARD;
      if (recentSame.length >= 5) return LoopLevel.MEDIUM;
      return LoopLevel.SOFT;
    }

    if (recentSame.length >= 4) return LoopLevel.HARD;
    // 与 Codex 策略对齐：只检测完全相同参数的重复调用
    if (recentSame.length >= 3) return LoopLevel.MEDIUM;
    if (recentSame.length >= 2) return LoopLevel.SOFT;
    return LoopLevel.NONE;
  }

  /**
   * 慢节奏重复升级: 窗口内没判出足够级别 (NONE/SOFT), 但同 hash 全会话累计命中
   * 已达 CUMULATIVE_ADVISORY_THRESHOLD 且历次输出从未出现差异 → 升 MEDIUM advisory。
   * 出现过任一次输出差异 (LLM 在拿新信息) 即永久豁免该 hash; 从不升到 HARD。
   */
  private escalateSlowRepeat(hash: string, level: LoopLevel): LoopLevel {
    if (level >= LoopLevel.MEDIUM) return level;
    const cum = this.cumulativeByHash.get(hash);
    if (!cum || cum.count < CUMULATIVE_ADVISORY_THRESHOLD || cum.hasDivergence) return level;
    return LoopLevel.MEDIUM;
  }

  /**
   * 检查相同工具调用的最近结果是否成功。
   */
  wasLastSuccessful(toolName: string, args: Record<string, unknown>): boolean {
    const hash = this.hashArgs(toolName, args);
    const lastCall = [...this.history]
      .reverse()
      .find(h => h.hash === hash);

    return lastCall?.resultStatus === 'success' ||
      lastCall?.resultStatus === 'already_done';
  }

  /**
   * 获取相同工具调用记录中的最近文件路径。
   */
  getLastFilePath(toolName: string, args: Record<string, unknown>): string | undefined {
    const hash = this.hashArgs(toolName, args);
    const lastCall = [...this.history]
      .reverse()
      .find(h => h.hash === hash);

    return lastCall?.filePath;
  }

  /**
   * 检查 LLM 是否听从了引导（换了工具）
   */
  didSwitchTool(currentTool: string): boolean {
    if (this.history.length < 2) return true;
    const lastTool = this.history[this.history.length - 1]?.toolName;
    return lastTool !== currentTool;
  }

  /**
   * 增加干预计数
   */
  incrementIntervention(): number {
    return ++this.interventionCount;
  }

  /**
   * 获取干预计数
   */
  getInterventionCount(): number {
    return this.interventionCount;
  }

  /**
   * 生成循环干预消息
   */
  generateIntervention(
    level: LoopLevel,
    toolName: string,
    args: Record<string, unknown>,
  ): LoopIntervention {
    const filePath = this.getLastFilePath(toolName, args) ||
      (args.file_path || args.path || args.directory) as string | undefined;
    const wasSuccessful = this.wasLastSuccessful(toolName, args);

    //  根据工具类型生成不同的验证建议
    // 避免建议用同一个工具验证自己（这会强化循环）
    const verifyCommand = this.getVerifyCommand(toolName, filePath);
    const alternativeAction = this.getAlternativeAction(toolName, filePath);
    /* 给用户的提示包含实际操作目标，避免只显示抽象的重复次数。 */
    const target = filePath ? String(filePath).split(/[\\/]/).pop() : undefined;
    /* 目标放在提示开头，确保窄布局优先显示最有用的文件名。 */
    const userNotice = target
      ? `${target} · 重复 ${this.getCallCount(toolName, args)} 次, 已跳过`
      : `${toolName} · 重复 ${this.getCallCount(toolName, args)} 次, 已跳过`;

    switch (level) {
      case LoopLevel.SOFT:
        // 第一次干预：温和引导，但跳过工具执行
        return {
          level,
          wasSuccessful,
          shouldTerminate: false,
          userNotice,
          message: `
[SYSTEM NOTICE]
You have called "${toolName}" ${this.getCallCount(toolName, args)} times with identical arguments.
${wasSuccessful ? '⚠️ Previous calls already returned SUCCESS.' : ''}

STOP and think:
1. ${alternativeAction}
2. If you already have the information you need, proceed with your task
3. Do NOT call ${toolName} again with the same arguments

${verifyCommand ? `To verify: ${verifyCommand}` : ''}
`.trim(),
        };

      case LoopLevel.MEDIUM:
        // 第二次干预：更强烈的警告
        return {
          level,
          wasSuccessful,
          shouldTerminate: false,
          userNotice,
          message: `
[SYSTEM WARNING]
You have called "${toolName}" ${this.getCallCount(toolName, args)} times with identical arguments.
${wasSuccessful ? '✅ Previous calls returned SUCCESS - the operation already completed!' : ''}

🛑 REQUIRED ACTION:
1. STOP calling ${toolName}
2. ${alternativeAction}
3. If stuck, ask the user for help

Next ${toolName} call with same arguments will TERMINATE the task.
`.trim(),
        };

      case LoopLevel.HARD:
        // 不直接终止 — 给 agent 决断权, 注入强警告让它自己选择继续还是结束
        return {
          level,
          wasSuccessful,
          shouldTerminate: false,
          userNotice,
          message: wasSuccessful
            ? `
[LOOP WARNING - HARD]
"${toolName}" has been called ${this.getCallCount(toolName, args)} times with identical arguments and already succeeded.

${filePath ? `File: ${filePath}` : ''}
The results from previous calls are already in your context.

🛑 You MUST either:
1. ${alternativeAction}
2. Try a completely different approach
3. If truly stuck, explain to the user and ask for guidance

Do NOT repeat this exact call. A call with DIFFERENT arguments is not blocked.
`.trim()
            : `
[LOOP WARNING - HARD]
"${toolName}" has failed ${this.getCallCount(toolName, args)} times with the same arguments.

🛑 You MUST either:
1. Try a completely different approach or different arguments
2. Skip this step and continue with what you have
3. Explain the issue to the user and ask for help

Do NOT retry the same call.
`.trim(),
        };

      default:
        return {
          level: LoopLevel.NONE,
          shouldTerminate: false,
          message: '',
        };
    }
  }

  /**
   * 获取验证命令（避免用同一工具验证自己）
   */
  getVerifyCommand(toolName: string, filePath?: string): string {
    // 读取类工具：用 grep 或 list_directory 验证
    if (toolName === 'readfile') {
      return filePath
        ? `Use search to locate specific content, or list_directory to check if file exists`
        : '';
    }

    // 写入类工具：用 readfile 验证
    if (toolName === 'write_file' || toolName === 'Write' ||
      toolName === 'edit' || toolName === 'edit_file' || toolName === 'Edit') {
      return filePath
        ? `Use readfile "${filePath}" to verify the changes`
        : '';
    }

    // 搜索类工具：直接读取或换个 pattern
    if (toolName === 'search' ||
      toolName === 'search_files' || toolName === 'Glob') {
      return 'Try a different search pattern or read the file directly';
    }

    // Shell 命令：检查输出
    if (toolName === 'execute_shell' || toolName === 'execute_bash' || toolName === 'Bash') {
      return 'Check the command output from previous calls';
    }

    return '';
  }

  /**
   * 获取替代行动建议
   */
  getAlternativeAction(toolName: string, filePath?: string): string {
    /* 读取类工具提示实际路径，并提供更换路径或显式 force 重读的选项。 */
    if (toolName === 'readfile' || toolName === 'read') {
      const which = filePath ? ` The path you actually sent was: ${filePath}.` : '';
      return `Check the path first —${which} if that is NOT the file you meant, call readfile again with the correct path (that is a different call, it will not be blocked). `
        + 'If it IS the right file, its content is already in your context from the earlier read — use it directly, '
        + 'or pass force:true only when you truly need the content re-sent.';
    }

    // 写入类工具循环：说明文件已经写入
    if (toolName === 'write_file' || toolName === 'Write') {
      return 'The file was already written - verify with readfile if needed';
    }

    // 编辑类工具循环
    if (toolName === 'edit' || toolName === 'edit_file' || toolName === 'Edit') {
      return 'The edit may have already been applied - use readfile to check current content';
    }

    // 搜索类工具循环
    if (toolName === 'search' ||
      toolName === 'search_files' || toolName === 'Glob') {
      return 'Search results should already be available - try a different pattern if not found';
    }

    // Shell 类工具循环:通常是 LLM 对失败命令盲重试
    if (SHELL_TOOL_NAMES.has(toolName.toLowerCase())) {
      return 'The stderr and exit code from previous runs are already in your context - re-read them carefully, identify the root cause, and try a different strategy (fix inputs, break into sub-steps, or use a different command) instead of rerunning the same command';
    }

    return 'Review the output from previous calls before retrying';
  }

  /**
   * 获取特定工具+参数的调用次数
   *
   * 取窗口内计数与全会话累计的较大者 — 慢节奏重复升级 (escalateSlowRepeat) 触发时
   * 窗口内可能只有 1 次, 干预消息里报累计次数才不失真。
   */
  getCallCount(toolName: string, args: Record<string, unknown>): number {
    const recentCount = this.getRecentSameCalls(toolName, args).length;
    const cumulativeCount = this.cumulativeByHash.get(this.hashArgs(toolName, args))?.count ?? 0;
    return Math.max(recentCount, cumulativeCount);
  }

  /**
   * 重置（新任务时调用）
   */
  reset(): void {
    this.history = [];
    this.interventionCount = 0;
    this.cumulativeByHash.clear();
  }

  /**
   * 获取历史记录(调试用)
   *
   * 返回 shallow-cloned 数组和记录,外部 mutate 不影响内部 state。
   * 注:record 内部的 args 在 push 时已做 shallow clone, 这里的 cloned record
   * 也是独立对象,外部可放心读取。
   */
  getHistory(): ToolCallRecord[] {
    return this.history.map((record) => ({ ...record }));
  }

  /**
   * crash-resume 恢复:把持久化的 history 灌回实例。
   *
   * 只复制业务字段,不重置 interventionCount —— 恢复后的 agent 应该继承之前
   * 的"已被引导过几次",避免死循环 LLM 恢复后又进入同样的 guide round。
   * 调用方通常在新建 detector 实例后立即 restore,所以这里用 splice 方式重置 history。
   * 跨窗口累计也从 records 重建 (history 有 40 条上限, 累计只能恢复留存部分, 可接受)。
   */
  restoreHistory(records: readonly ToolCallRecord[]): void {
    this.history.length = 0;
    this.cumulativeByHash.clear();
    for (const r of records) {
      this.history.push({ ...r });
      this.trackCumulative(r.hash, r.outputSignature);
    }
  }

  /**
   * 不可变快照(推荐在非调试路径使用):每条记录及其 args 被 Object.freeze,
   * 外部任何 mutate 尝试在严格模式下会抛错。
   */
  getHistorySnapshot(): readonly Readonly<ToolCallRecord>[] {
    return Object.freeze(
      this.history.map((record) =>
        Object.freeze({
          ...record,
          args: record.args ? Object.freeze({ ...record.args }) : undefined,
        }),
      ),
    );
  }

  /**
   * 获取最近的重复调用统计
   */
  getRecentDuplicates(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const record of this.history) {
      const key = `${record.toolName}:${record.hash}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
}

/**
 * 创建循环检测器实例
 */
export function createLoopDetector(): LoopDetector {
  return new LoopDetector();
}
