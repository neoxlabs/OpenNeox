/// types.dart — Agent SDK 公共类型.
///
/// 设计原则:
///   - 纯 Dart, 零 Flutter 依赖 — 可在任何 isolate / CLI / 测试环境跑.
///   - LLM 接入是宿主注入的 (LlmConnector), SDK 不绑定任何厂商协议.
///   - 事件 kind 与 Neox timeline 协议 1:1 对齐 (agent_text_delta / tool_running /
///     tool_done / agent_turn_done ...), 宿主可以把事件直接灌进现有渲染管线.
library;

import 'dart:async';

/// OpenAI chat shape 消息 — role + content (String 或 parts 列表).
/// SDK 内部维护对话历史用它, 宿主的 LlmConnector 负责转厂商 wire 格式.
typedef ChatMessage = Map<String, Object?>;

/// LLM 一次流式调用的增量.
class LlmDelta {
  const LlmDelta({this.text, this.thinking, this.toolCalls});

  final String? text;
  final String? thinking;

  /// 模型 emit 的工具调用 (完整聚合后; 流式聚合由 connector 内部做).
  /// 每项: { id, name, arguments(Map) }.
  final List<LlmToolCall>? toolCalls;
}

/// 模型请求的一次工具调用.
class LlmToolCall {
  const LlmToolCall({
    required this.id,
    required this.name,
    required this.arguments,
  });

  final String id;
  final String name;
  final Map<String, Object?> arguments;
}

/// 工具 JSON Schema 声明 — 传给 LLM 的 function 定义.
class ToolSpec {
  const ToolSpec({
    required this.name,
    required this.description,
    required this.parameters,
  });

  final String name;
  final String description;

  /// JSON Schema (object) — {type:'object', properties:{...}, required:[...]}
  final Map<String, Object?> parameters;

  Map<String, Object?> toJson() => {
        'name': name,
        'description': description,
        'parameters': parameters,
      };
}

/// 工具执行结果.
class ToolResult {
  const ToolResult.ok(this.output)
      : isError = false;
  const ToolResult.error(this.output)
      : isError = true;

  /// 回灌给模型的文本 (stdout / 错误信息 / JSON 字符串).
  final String output;
  final bool isError;
}

/// 工具执行上下文 — 取消信号 + 宿主可见的会话信息.
class ToolContext {
  const ToolContext({required this.cancel, this.sessionId});
  final AgentCancelToken cancel;
  final String? sessionId;
}

/// 工具接口 — SDK 内置工具和宿主注入的设备工具都实现它.
abstract class AgentTool {
  ToolSpec get spec;

  /// 执行. 抛异常等价于 ToolResult.error(e.toString()).
  Future<ToolResult> run(Map<String, Object?> args, ToolContext ctx);
}

/// 并发安全标记 —— 实现了它的工具, 同一轮里可以跟别的调用并发跑
/// (总控裁决第六节: 互不依赖的工具调用并行发、并行跑)。
///
/// 独立成标记接口而不是往 [AgentTool] 上加默认成员: 工具都是用 `implements`
/// 实现的, 加成员会让每一个实现类 (包括测试里的假工具) 都编译不过。
/// 没标记的工具 (写盘 / 跑命令 / 动手机) 仍逐个串行, 行为不变。
abstract interface class ParallelSafeTool {
  bool get parallelSafe;
}

/// LLM 连接器 — 宿主注入 (BYOK 适配器 / NeoxCloud 网关 / 测试 fake).
///
/// 契约:
///   - [messages] 是完整对话 (system + history + tool results).
///   - [tools] 非空时把 function 定义带给模型; 模型 emit tool_calls 时,
///     connector 聚合完整后通过 [LlmDelta.toolCalls] 一次性给出 (可以在流尾).
///   - 取消: [cancel] 触发时终止流 (抛 [AgentCancelled] 或静默结束都可).
abstract class LlmConnector {
  Stream<LlmDelta> stream({
    required List<ChatMessage> messages,
    required List<ToolSpec> tools,
    required AgentCancelToken cancel,
  });
}

/// 取消令牌 — 与宿主的 CancelToken 解耦 (转接即可).
class AgentCancelToken {
  bool _cancelled = false;
  final _controller = StreamController<void>.broadcast();

  bool get isCancelled => _cancelled;
  Stream<void> get onCancel => _controller.stream;

  void cancel() {
    if (_cancelled) return;
    _cancelled = true;
    _controller.add(null);
    _controller.close();
  }

  void throwIfCancelled() {
    if (_cancelled) throw const AgentCancelled();
  }
}

class AgentCancelled implements Exception {
  const AgentCancelled();
  @override
  String toString() => 'AgentCancelled';
}

/// Agent 事件 — kind 对齐 Neox timeline 协议, 宿主直接灌渲染管线.
///
/// kind 一览:
///   agent_text_delta   {content}
///   agent_thinking_delta {content}
///   tool_running       {tool_call_id, tool_name, args}
///   tool_progress      {tool_call_id, chunk}
///   tool_done          {tool_call_id, ok}
///   tool_result        {tool_call_id, tool_name, output, ok}  — 落库用
///   agent_text         {text}                                  — 每轮完整文本, 落库用
///   agent_turn_done    {}
///   session_interrupted {}
///   agent_error        {message}
class AgentEvent {
  const AgentEvent(this.kind, this.payload);
  final String kind;
  final Map<String, Object?> payload;

  @override
  String toString() => 'AgentEvent($kind, $payload)';
}

/// 一次 run 的配置.
class AgentRunConfig {
  const AgentRunConfig({
    this.maxTurns,
    this.maxToolOutputChars = 24 * 1024,
    this.systemPrompt,
    this.environmentContext,
    this.isTransientError,
    this.outagePatience = const Duration(minutes: 60),
    this.outageBackoffUnit = const Duration(seconds: 1),
  });

  /// 退避刻度单位 (5/10/20/40/60 × 它)。只给测试调短用。
  final Duration outageBackoffUnit;

  /// 判定模型请求的错误是不是"等等就好" (断网 / 超时 / 5xx / 限流) —— 是就退避重试这一轮,
  /// 不终止整个任务。null = 不重试 (旧行为: 任何错误整轮结束)。
  /// 2026-10-16: 整夜跑的任务一次上传超时就整轮挂, 跟桌面 kernel 的断网耐心对齐。
  final bool Function(Object error)? isTransientError;

  /// 连续失败多久才放弃 (中间成功一次就清零)。退避 5s → 60s 封顶。
  final Duration outagePatience;

  /// LLM 轮数上限。null (默认) = 不设上限, 做完为止, 停只靠用户点停止 (cancel)。
  /// 2026-10-12: 原来默认 12 —— Phone Use 每点一下就是一轮, 「去 QQ 看消息再去 B 站」做到一半就
  /// 「工具调用次数用完了」。任务要跑多久由任务定, 不由我们拍一个数。
  final int? maxTurns;

  /// 单个工具输出回灌上限 — 超长截断 (保头尾), 防上下文爆炸.
  final int maxToolOutputChars;

  /// 覆盖默认 system prompt (null 用 SDK 默认).
  final String? systemPrompt;

  /// 环境上下文段 — 宿主注入 (当前时间/设备/网络/用户/模型/工作区用量等),
  /// runner 拼在 system prompt 后面, 让 agent 具备自身与环境感知.
  final String? environmentContext;
}
