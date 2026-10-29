/// chat_session_mode.dart — 「这条会话 / 这一轮是不是 Chat」的唯一判据 (chat:C1-02).
///
/// 跟桌面 `packages/core/src/runtime/chatSessionMode.ts` 是**同一张真值表**:
///   - `chatMode == true`  → Chat (会话记录上的聊天开关, 桌面界面切的)
///   - `agentMode == 'chat'` → Chat (手机本机对话会话记的就是这个值)
///   - 其余 (work / code / pilot / 未记) → 不是 Chat
///
/// 两边测试读同一份用例: `packages/core/src/runtime/__tests__/fixtures/chatSessionMode.cases.json`
/// (`apps/mobile/test/chat_session_mode_test.dart` 也读它)。改规则先改那张表, 两边一起红。
///
/// 判据本身不掺端特有默认值。比如「手机本机会话没记 agentMode 就当对话」是解析步骤,
/// 在调用点显式写 `agentMode ?? kChatAgentMode`, 不埋进这里 —— 否则两端又会走叉。
library;

/// 手机本机会话记在 agent_mode 上的 Chat 值。
const String kChatAgentMode = 'chat';

bool isChatSession({String? agentMode, bool? chatMode}) {
  if (chatMode == true) return true;
  return agentMode == kChatAgentMode;
}
