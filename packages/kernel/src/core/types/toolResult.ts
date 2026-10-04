/**
 * Tool Result 类型定义
 *
 * 核心设计：区分「执行确认」和「推理信息」
 *
 * - Ephemeral: 执行确认型，不进入长期上下文（write_file, edit_file...）
 * - Contextual: 信息供给型，必须进入上下文（readfile, grep...）
 * - Summarized: 摘要型，压缩后进入上下文（test, build...）
 */

import { cliLogger } from '../../platform/cliLogger.js';

/**
 * Tool Result 分类
 * 决定工具结果是否进入 LLM 长期上下文
 */
export enum ToolResultType {
  /**
   * 执行确认型 - 不进入长期上下文
   *
   * 适用于：write_file, edit_file, mkdir, git commit 等
   * 特点：模型只需知道"执行成功了"，不需要看完整内容
   * 处理：只在当前 step 可见，下一轮清理
   */
  EPHEMERAL = 'ephemeral',

  /**
   * 信息供给型 - 必须进入上下文
   *
   * 适用于：readfile, grep, ls, git diff 等
   * 特点：是模型继续思考的原材料
   * 处理：完整保留（或按需截断）
   */
  CONTEXTUAL = 'contextual',

  /**
   * 摘要型 - 压缩后进入上下文
   *
   * 适用于：execute_shell, test, build 等
   * 特点：完整输出太长，但关键信息需要保留
   * 处理：只保留 exit_code + 错误信息
   */
  SUMMARIZED = 'summarized',
}

/**
 * 统一的 Tool Result 接口
 *
 * 所有工具都应该返回符合此接口的结果
 */
export interface ToolResult {
  /**
   * 结果分类 - 决定是否进入长期上下文
   */
  type: ToolResultType;

  /**
   * 执行状态
   * - success: 执行成功
   * - already_done: 幂等检测，之前已完成
   * - error: 执行失败
   */
  status: 'success' | 'already_done' | 'error';

  /**
   * 工具名称
   */
  tool: string;

  /**
   * 简短摘要（必需）
   * 不超过 200 字符，用于：
   * 1. LLM 快速了解执行结果
   * 2. UI 显示
   * 3. 日志记录
   */
  summary: string;

  /**
   * 标记任务完成
   * 当 final=true 时，LLM 不应再重试此操作
   */
  final?: boolean;

  /**
   * 文件路径（可选）
   * 用于文件相关操作
   */
  file_path?: string;

  /**
   * 内容校验和（可选）
   * 用于幂等性检测
   */
  checksum?: string;

  /**
   * 详细内容（可选）
   * 只有 Contextual 类型才应该填充此字段
   * Ephemeral 和 Summarized 不应该有此字段
   */
  content?: string;

  /**
   * 错误信息（可选）
   * 当 status='error' 时填充
   */
  error?: string;

  /**
   * 验证提示（可选）
   * 告诉 LLM 如何验证操作结果
   * 例如："Use readfile to verify the content"
   */
  verify_hint?: string;

  actual_content?: string;

  expected_start_line?: number;

  /**
   * 额外元数据（可选）
   * 工具特定的附加信息
   */
  metadata?: Record<string, unknown>;

  /**
   * 这一步没做成, 但**环境本来就不具备** —— 不是故障 (见 PRECONDITION_FLAG_DOC)。
   * 例: 工作区不是 git 仓库 / 机器上没装 pytest / 这个项目没有测试框架。
   * 渲染层据此不弹红卡; status 仍是 'error', 模型照旧知道"没成"。
   */
  precondition?: boolean;

  /**
   * 这一步被"参数闸"打回, 正文就是给模型的整改指令 —— 不是故障 (见 PRECONDITION_FLAG_DOC)。
   */
  guidance?: boolean;
}

/**
 * 创建 Ephemeral 类型的结果
 * 用于 write_file, edit_file, mkdir 等执行确认型工具
 */
export function createEphemeralResult(
  tool: string,
  status: 'success' | 'already_done' | 'error',
  summary: string,
  options?: {
    file_path?: string;
    checksum?: string;
    error?: string;
    verify_hint?: string;
    actual_content?: string;  //  添加 actual_content 字段支持（用于 edit_file 错误处理）
    expected_start_line?: number;  //  添加 expected_start_line 字段支持
    metadata?: Record<string, unknown>;
    /** 见 PRECONDITION_FLAG_DOC —— 「环境不具备」而不是「东西坏了」。 */
    precondition?: boolean;
    /** 见 PRECONDITION_FLAG_DOC —— 「参数不合格, 模型自己改」而不是「东西坏了」。 */
    guidance?: boolean;
  }
): ToolResult {
  return {
    type: ToolResultType.EPHEMERAL,
    status,
    tool,
    summary,
    final: status === 'success' || status === 'already_done',
    /* 两个"不是故障"的标记排在最前 : 回执会被事件转发/界面截断成前缀,
     * 排在 verify_hint (动辄几 KB) 后面就被截掉, 界面拿不到标记 → 照样弹红卡。 */
    ...(options?.guidance === true ? { guidance: true } : {}),
    ...(options?.precondition === true ? { precondition: true } : {}),
    ...options,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 纯文本工具的失败标记
 *
 * 一批工具的返回值就是给人/给模型看的**一段文本** (readfile 的文件内容、search 的
 * 匹配行、tree 的目录树)。它们失败时返回的也是一段文本 —— `✗ 读取失败: ENOENT…`。
 * 于是失败信息只存在于"文本长什么样"里, 时间线拿不到结论, 一律打绿勾。
 *
 * 为什么不去猜文本: 见 core/toolOutcome.ts 顶部 —— 「读一个日志文件」「grep 出一堆
 * 报错行」都会返回以 ✗//Error 开头的**成功**结果, 猜就会制造反向假信号。
 *
 * 所以跟 shell 同一个办法: 由**我们自己**在失败时贴一个固定尾标, 只认这个标。
 * 判据是"最后一个非空行恰好等于尾标" —— 文件内容里出现同样一行的概率可以忽略,
 * 而且那也只能是自己写进去的。
 *
 * 用法: `return markToolFailure(`✗ 读取失败: ${err.message}`)`。
 * 返回结构化 ToolResult 的工具不需要它 —— 那条路上的 status 字段已经是明确信号。
 * ──────────────────────────────────────────────────────────────────────────── */
export const TOOL_FAILURE_TAG = '[tool_outcome: FAILURE]';

/** 给纯文本失败返回贴上尾标; 已经贴过的不重复贴。 */
export function markToolFailure(text: string): string {
  const body = typeof text === 'string' ? text : String(text ?? '');
  if (body.trimEnd().endsWith(TOOL_FAILURE_TAG)) return body;
  return `${body.trimEnd()}\n${TOOL_FAILURE_TAG}`;
}

/** 摘掉尾标 —— 给**界面**用。尾标是判读器的信号, 不是给用户读的一行字。
 *  只摘最后那一整行, 正文里出现的同样字样不动 (跟判读器同一口径)。 */
export function stripToolFailureTag(text: string): string {
  if (typeof text !== 'string' || !text.includes(TOOL_FAILURE_TAG)) return text;
  const lines = text.split('\n');
  let tailIdx = lines.length - 1;
  while (tailIdx >= 0 && lines[tailIdx].trim() === '') tailIdx--;
  if (tailIdx < 0 || lines[tailIdx].trim() !== TOOL_FAILURE_TAG) return text;
  lines.splice(tailIdx, 1);
  return lines.join('\n').trimEnd();
}

/* ── 判读器 —— 跟上面几种"结果形状"住在同一个文件里 ─────────────────────
 * 它本来在 core/toolOutcome.ts, 搬到这里是因为**生产端在 neox-core**: 判读器和
 * 生产端要能被同一份测试同时拿到, 才验得了"真工具失败 → 判读器读出失败"这条链
 * (只验判读器认不认信号是假绿 —— 上一版的洞恰恰在两端之间没接上)。
 * 而 core/toolOutcome.js 不在 kernel 的 exports 清单里, 深引会被包边界闸挡下,
 * types/toolResult.js 本来就是对外那扇门。core/toolOutcome.ts 保留为再导出。
 * ──────────────────────────────────────────────────────────────────────── */

/** 我们自己的 ToolResult 形状: status 是这三个词之一, 且带 tool / type 字段。
 *  两个条件都要 —— 光看 status 会把别家 API 原样透传回来的 JSON 也当成我们的。 */
function readStructuredStatus(value: unknown): boolean | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const status = o.status;
  if (status !== 'success' && status !== 'error' && status !== 'already_done') return null;
  if (typeof o.tool !== 'string' && typeof o.type !== 'string') return null;
  return status !== 'error';
}

/**
 * 从工具返回值里读出"它自己认为成没成"。判据的完整说明在 core/toolOutcome.ts 顶部。
 *
 * @returns true / false = 工具明确表了态; null = 没有任何明确信号, 交给调用方默认
 *          (默认仍是"没抛就算成功" —— 绝大多数工具确实是这个语义, 不能反过来
 *          默认失败, 那会把整棵时间线刷成红的)。
 */
export function readToolSelfReportedOutcome(output: unknown): boolean | null {
  /* 1) 返回对象且自带成败字段 —— 最明确的信号 */
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (typeof o.success === 'boolean') return o.success;
    if (o.isError === true) return false;
    /* 结构化 ToolResult 直接返回 (没被 stringify) 的那条路 */
    return readStructuredStatus(o);
  }

  if (typeof output !== 'string' || !output) return null;

  /* 2) 纯文本工具自己贴的失败尾标 —— 必须是**最后一个非空行整行**。
   *    不用 includes: 那样读一个记录过这行的日志文件就会被判成失败。 */
  const lines = output.split('\n');
  let tailIdx = lines.length - 1;
  while (tailIdx >= 0 && lines[tailIdx].trim() === '') tailIdx--;
  if (tailIdx >= 0 && lines[tailIdx].trim() === TOOL_FAILURE_TAG) return false;

  /* 3) 结构化 ToolResult 被 JSON.stringify 过 —— write_file / edit / edit_batch 等
   *    执行确认型工具走的都是这条路 (invokeTool 只在非字符串时才 stringify,
   *    而它们自己就 stringify 完了再 return)。 */
  if (output.trimStart().startsWith('{')) {
    try {
      const structured = readStructuredStatus(JSON.parse(output));
      if (structured !== null) return structured;
    } catch { /* 不是 JSON 就继续往下判 */ }
  }

  /* Shell exit markers describe the command result, not tool invocation health,
   * so a non-zero command exit does not by itself mark the tool as failed. */
  return null;
}

/**
 * Distinguish tool faults from unmet preconditions and parameter guidance.
 *
 * `status: 'error'` is accompanied by two envelope flags so the renderer can
 * distinguish these three cases:
 *
 *   1. A real fault requires user attention.
 *   2. `precondition: true` means the environment cannot perform the action.
 *   3. `guidance: true` means the model should correct its arguments.
 *
 * Both flags stay at envelope level so renderers can classify the result without
 * parsing metadata; status remains `error` so the model sees that the step did
 * not complete.
 */
export const PRECONDITION_FLAG_DOC = 'see toolResult.ts — precondition / guidance envelope flags';

/**
 * 创建 Contextual 类型的结果
 * 用于 readfile, grep, ls 等信息供给型工具
 */
export function createContextualResult(
  tool: string,
  status: 'success' | 'error',
  summary: string,
  content?: string,
  options?: {
    file_path?: string;
    error?: string;
    metadata?: Record<string, unknown>;
    /** 见 PRECONDITION_FLAG_DOC —— 「环境不具备」而不是「东西坏了」。 */
    precondition?: boolean;
    /** 见 PRECONDITION_FLAG_DOC —— 「参数不合格, 模型自己改」而不是「东西坏了」。 */
    guidance?: boolean;
  }
): ToolResult {
  return {
    type: ToolResultType.CONTEXTUAL,
    status,
    tool,
    summary,
    content,
    ...options,
  };
}

/**
 * 创建 Summarized 类型的结果
 * 用于 execute_shell, test, build 等摘要型工具
 */
export function createSummarizedResult(
  tool: string,
  status: 'success' | 'error',
  summary: string,
  options?: {
    error?: string;
    metadata?: Record<string, unknown>;
    /** 见 PRECONDITION_FLAG_DOC —— 「环境不具备」而不是「东西坏了」。 */
    precondition?: boolean;
    /** 见 PRECONDITION_FLAG_DOC —— 「参数不合格, 模型自己改」而不是「东西坏了」。 */
    guidance?: boolean;
  }
): ToolResult {
  return {
    type: ToolResultType.SUMMARIZED,
    status,
    tool,
    summary,
    ...options,
  };
}

/**
 * 判断是否是成功的结果
 */
export function isSuccessResult(result: ToolResult): boolean {
  return result.status === 'success' || result.status === 'already_done';
}

/**
 * 判断结果是否应该进入长期上下文
 */
export function shouldEnterContext(result: ToolResult): boolean {
  // Ephemeral 不进入长期上下文
  if (result.type === ToolResultType.EPHEMERAL) {
    return false;
  }
  return true;
}

/**
 * 获取用于 LLM 的精简结果
 * Ephemeral 类型只返回状态信息，不返回内容
 *  但错误情况必须包含错误详情，让 LLM 能够理解问题
 */
export function getResultForLLM(result: ToolResult): string {
  //  日志：记录输入的原始 ToolResult
  cliLogger.info('TOOL_RESULT', `🔄 getResultForLLM input: ${result.tool}`, {
    type: result.type,
    status: result.status,
    tool: result.tool,
    hasContent: !!result.content,
    contentLength: result.content?.length || 0,
    summary: result.summary?.substring(0, 100),
  });

  let llmResult: string;

  if (result.type === ToolResultType.EPHEMERAL) {
    //  错误情况：必须包含 error 和 verify_hint，让 LLM 能够诊断问题
    if (result.status === 'error') {
      //  特殊处理 edit_file 错误：包含 actual_content 让 LLM 可以直接复制
      if (result.tool === 'edit_file') {
        llmResult = JSON.stringify({
          status: result.status,
          tool: result.tool,
          summary: result.summary,
          error: result.error,
          verify_hint: result.verify_hint,
          file_path: result.file_path,
          //  关键：包含真实的文件内容，让 LLM 可以精确复制
          actual_content: result.actual_content,
          expected_start_line: result.expected_start_line,
          // 如果有元数据中的相似匹配，也包含进来帮助 LLM 理解
          similar_matches: result.metadata?.similar_matches,
          suggestions: result.metadata?.suggestions,
        });
      } else {
        // 其他工具的错误处理
        llmResult = JSON.stringify({
          status: result.status,
          tool: result.tool,
          summary: result.summary,
          error: result.error,
          verify_hint: result.verify_hint,
          file_path: result.file_path,
          // 如果有元数据中的相似匹配，也包含进来帮助 LLM 理解
          similar_matches: result.metadata?.similar_matches,
          suggestions: result.metadata?.suggestions,
        });
      }
    } else {
      //  Phase 1: 成功情况统一返回精简确认
      // edit 成功时不再回显 old/new 预览 — LLM 刚发送过这些内容，已在上下文中
      // 这将 edit 成功输出从 ~500-2000 bytes 降到 ~150 bytes
      llmResult = JSON.stringify({
        status: result.status,
        tool: result.tool,
        summary: result.summary,
        final: result.final,
        file_path: result.file_path,
      });
    }
  } else if (result.type === ToolResultType.SUMMARIZED) {
    // Summarized: 返回状态、摘要和错误（如果有）
    llmResult = JSON.stringify({
      status: result.status,
      tool: result.tool,
      summary: result.summary,
      error: result.error,
      /* run_tests / run_lint 成功时的输出尾巴 (测试汇总在末尾) —— 只有一句 "succeeded" 的话,
       * 模型为了知道过了几条会再用 shell 跑一遍 (structuredCommand.ts outputTail) */
      output_tail: result.metadata?.output_tail,
    });
  } else {
    // Contextual:对齐 Claude Code —— 给 LLM 的是 plain content (就像 stdout).
    // summary/status/tool 等元数据走 UI 事件通道(getUiMetaForResult),不塞进
    // tool_result.content 里给 LLM 看,避免模型解析一层 JSON 包装.
    if (result.status === 'error') {
      const prefix = result.error ? `Error: ${result.error}\n` : 'Error\n';
      llmResult = (result.content ?? '').trim()
        ? `${prefix}\n${result.content}`
        : prefix.trimEnd();
    } else {
      /* 关键 — content 可能是空串(例如 git_diff 没 diff / git_status 干净仓库
         / search 0 命中). 直接喂空 tool_result, Anthropic 会判"工具失败/没响
         应",模型下一轮就会写"X 失败"叙事. fallback 顺序: content 非空 →
         summary 非空 → 至少一个 ASCII 占位 "(empty)" — 永远不能给 LLM 空串. */
      const c = result.content ?? '';
      if (c.length > 0) {
        llmResult = c;
      } else if (result.summary && result.summary.trim().length > 0) {
        llmResult = result.summary;
      } else {
        llmResult = '(empty result)';
      }
    }
  }

  //  日志：记录返回给 LLM 的精简结果
  cliLogger.info('TOOL_RESULT', `✅ getResultForLLM output: ${result.tool}`, {
    type: result.type,
    tool: result.tool,
    llmResultLength: llmResult.length,
    llmResultPreview: llmResult.substring(0, 500),
  });

  return llmResult;
}

/**
 * 获取用于 UI 显示的结果
 * 可以包含更多细节给用户看
 */
export function getResultForUI(result: ToolResult): string {
  if (result.content && result.content.length > 2000) {
    return result.content.slice(0, 2000) + '...(truncated)';
  }
  return result.content || result.summary;
}

// ════════════════════════════════════════════════════════════════════════════
// 双轨道分离 —— 给 UI 看的 meta (不进 LLM 消息体)
// ════════════════════════════════════════════════════════════════════════════

/**
 * UI 事件专属的 tool meta —— 由 agentLoop 在发 tool_result 事件时展开到事件字段.
 * 注意:这些信息**不会**进入 tool_result.content,LLM 看不到.
 * UI 层可以直接消费 event.summary / event.toolStatus / event.toolKind 等.
 */
export interface ToolUiMeta {
  /** 工具结果分类 —— 对应 ToolResult.type */
  kind: ToolResultType;
  /** 简短摘要(200 字符内),卡片头部/状态栏可直接显示 */
  summary: string;
  /** 执行状态 */
  status: 'success' | 'already_done' | 'error';
  /** 错误信息(仅 status='error' 时有) */
  error?: string;
  /** 文件路径(如适用) */
  file_path?: string;
  /** 工具特定的元数据(similar_matches / suggestions / pid / exit_code 等) */
  metadata?: Record<string, unknown>;
}

/**
 * 从 ToolResult 提取给 UI 的 meta 部分.
 * LLM 轨道用 getResultForLLM, UI 轨道用本函数 —— 双轨道的唯一公共入口.
 */
export function getUiMetaForResult(result: ToolResult): ToolUiMeta {
  return {
    kind: result.type,
    summary: result.summary,
    status: result.status,
    error: result.error,
    file_path: result.file_path,
    metadata: result.metadata,
  };
}

/**
 * 尝试把字符串 parse 成 ToolResult 对象 —— 向后兼容.
 *
 * 背景:项目里大量工具用 `return JSON.stringify(createContextualResult(...))`
 * 的模式,结果是 stringify 过的 ToolResult.为了不改动 89 处工具代码,这里
 * 在 agentLoop 的 invoke 层做一次 parse 探测:如果字符串刚好是合法 JSON
 * 且 shape 匹配 ToolResult,就当作 ToolResult 处理(走 getResultForLLM +
 * getUiMetaForResult 的双轨道),否则原样返回给旧链路.
 *
 * parse 失败(非 JSON 或 shape 不符)一律返回 null,不抛错.
 */
export function tryParseToolResult(raw: string): ToolResult | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null; // 快速短路,非 JSON object 直接跳过
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.tool === 'string'
      && typeof parsed.summary === 'string'
      && typeof parsed.status === 'string'
      && (parsed.type === ToolResultType.EPHEMERAL
        || parsed.type === ToolResultType.CONTEXTUAL
        || parsed.type === ToolResultType.SUMMARIZED)
    ) {
      return parsed as ToolResult;
    }
  } catch {
    // not JSON, or malformed — let caller fall back to raw string
  }
  return null;
}
