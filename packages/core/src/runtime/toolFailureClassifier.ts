/**
 * 工具失败归因 —— 把每次工具调用失败归到可汇总的"原因桶"。
 *
 * 目的: 原始 error_kind (工具报错文本) 只反映"报了什么", 不反映"属于哪一层问题"。
 * 归因后可汇总: 参数(优化 prompt/schema) / 运行时(修基础设施) / 模型服务(调档) / 环境。
 * 作为驱动 agent 工程迭代的反馈信号。
 *
 * 纯函数, 无副作用, 不抛异常。分类只看 (工具名 + errorKind + output 文本), 关键词匹配。
 */

export type FailureClass =
  | 'bad_args'    // 参数不符合工具约定: string_not_found / ambiguous / 缺必填 / 非法 regex / 路径不符
  | 'not_found'   // 目标不存在: file/dir 不存在
  | 'stale'       // 状态漂移: 读取后文件被改, 需重读
  | 'blocked'     // 被拦截: 沙盒 / 权限 (operation not permitted / EACCES)
  | 'timeout'     // 超时 / 被中断
  | 'provider'    // 模型服务侧: 限流 / 上下文超限 / 过载 / 余额不足 (也用于 turn 级推理失败)
  | 'command_failed' // 命令级失败: shell 命令退出码非0 (测试挂/构建挂/lint 挂 — 工具执行成功但命令失败)
  | 'harness'     // 运行时/工具内部异常 (有报错但归不进上述)
  | 'unknown';    // 失败但未取得 errorKind

/** 顶层分组 (参数 / 状态 / 环境 / 命令 / 运行时 / 模型服务 / 未知)。UI 汇总用。 */
export type FailureGroup = '参数' | '状态' | '环境' | '命令' | '运行时' | '模型服务' | '未知';

export const FAILURE_GROUP: Record<FailureClass, FailureGroup> = {
  bad_args: '参数',
  not_found: '环境',
  stale: '状态',
  blocked: '运行时',
  timeout: '运行时',
  provider: '模型服务',
  command_failed: '命令',
  harness: '运行时',
  unknown: '未知',
};

/** 各归因的处理建议 (监控展示用, 中性专业措辞)。 */
export const FAILURE_HINT: Record<FailureClass, string> = {
  bad_args: '参数不符合工具约定，建议优化工具描述、schema 或示例',
  not_found: '目标路径不存在，建议先检索或列目录再操作',
  stale: '文件在读取后被修改，内容寻址已兜底；高频出现表示存在并发写',
  blocked: '被沙盒或文件权限拦截，建议检查沙盒档位与路径护栏',
  timeout: '执行超时或被中断，建议调整超时阈值或拆分任务',
  provider: '模型服务侧限制（限流、上下文超限、过载或余额不足），建议调整档位或压缩上下文',
  command_failed: 'shell 命令退出码非0（测试/构建/lint 失败等），agent 需据输出定位并修复',
  harness: '运行时或工具内部异常，依据 error_kind 定位并修复',
  unknown: '失败但缺少结构化错误信息，建议完善该工具的错误输出',
};

/**
 * 命令级失败探测 —— shell 工具即便"执行成功"(success=true), 命令本身可能退出非0。
 * foregroundShellExecution 会在输出打 `[exit N / semantics / SUCCESS|FAILURE]` 或 `[exit N]` 标签,
 * 据此判断命令是否真失败(grep exit1=no_match 算 SUCCESS 不误报)。
 */
export function detectCommandFailure(output?: string): boolean {
  if (typeof output !== 'string') return false;
  if (/\/\s*FAILURE\]/.test(output)) return true;               // 显式 FAILURE 标
  if (/\[exit\s+[1-9]\d*\]/.test(output)) return true;          // 裸 [exit N] (非0, 无语义=默认失败)
  return false;                                                 // [exit 0 ...] / / SUCCESS] 都不算
}

const has = (s: string, ...needles: string[]) => needles.some((n) => s.includes(n));

/**
 * 归因一次失败。errorKind 优先 (工具结构化 error 字段), 兜底扫 output 文本。
 * 只在 success=false 时调。
 */
export function classifyToolFailure(
  toolName: string,
  errorKind?: string,
  output?: string,
): FailureClass {
  const raw = `${errorKind ?? ''} ${typeof output === 'string' ? output.slice(0, 500) : ''}`.toLowerCase();
  if (!raw.trim()) return 'unknown';

  // 参数问题 (可通过更好的提示/schema 减少)
  if (has(raw, 'string_not_found', 'not found in file', 'old_string', 'ambiguous', 'multiple matches',
    'invalid regex', 'no query', 'missing required', 'required parameter', 'is empty', 'outside workspace',
    'provide pattern', 'at least one', 'patch')) return 'bad_args';

  // 状态漂移
  if (has(raw, 'stale', 'changed under', 'has been modified', 'snapshot')) return 'stale';

  // 被拦 (沙盒/权限)
  if (has(raw, 'operation not permitted', 'permission denied', 'eacces', 'eperm', 'sandbox', 'not allowed')) return 'blocked';

  // 超时 / 中断
  if (has(raw, 'timeout', 'timed out', 'etimedout', 'aborted', 'cancelled', 'canceled', 'killed')) return 'timeout';

  // 模型/网关侧
  if (has(raw, 'rate limit', 'ratelimit', '429', 'overloaded', 'context length', 'context_length',
    'too many tokens', 'maximum context', 'quota', 'insufficient', 'provider')) return 'provider';

  // 目标不存在
  if (has(raw, 'no such file', 'enoent', 'does not exist', 'not exist', 'cannot find', 'no matches')) return 'not_found';

  // 有报错但归不进以上 → harness/系统
  if (errorKind && errorKind.trim()) return 'harness';
  return 'unknown';
}
