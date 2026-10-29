/// Neox Agent SDK — 手机端本地 Agent 运行时.
///
/// 纯 Dart (零 Flutter 依赖): 工具调用循环 + 事件流 + 内置工具.
/// LLM 由宿主注入 (LlmConnector) — BYOK / 订阅网关 / 测试 fake 都行.
///
/// 用法:
/// ```dart
/// final runner = AgentRunner(
///   connector: myConnector,          // 宿主实现: BYOK / 网关适配
///   tools: ToolRegistry([
///     HttpFetchTool(),
///     ClockTool(),
///     CalculatorTool(),
///     WorkspaceFilesTool(rootDir: dir),
///   ]),
/// );
/// await for (final ev in runner.run(history: msgs, cancel: token)) {
///   // ev.kind 对齐 Neox timeline 协议, 直接灌渲染
/// }
/// ```
library;

export 'src/types.dart';
export 'src/tool_registry.dart';
export 'src/agent_runner.dart';
export 'src/tools/http_fetch_tool.dart';
export 'src/tools/workspace_files_tool.dart';
export 'src/tools/clock_tool.dart';
export 'src/tools/calculator_tool.dart';
