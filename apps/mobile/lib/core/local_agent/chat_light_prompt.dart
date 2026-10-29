/// chat_light_prompt.dart — 手机 Chat 标签的人设 (chat:C2-04 / C2-05)
///
/// 人设文字**不在这里写**。单一源在
/// `packages/core/src/runtime/prompts/chatPersona.source.json`, 由
/// `scripts/bake-chat-persona.mjs` 同时生成桌面用的 `chatPersona.generated.ts` 和这里的
/// `chat_persona.g.dart` —— 两端说话才是同一个人, 不会一端「朋友」一端客服腔。
///
/// 手机选 `card` 变体 (正文不贴链接, 来源和图由界面展示); 桌面暂时用 `links`
/// (它还没有来源卡, 见 chat plan C3-10), 两边只差这一句, 人格段逐字节相同。
///
/// 改人设: 改源 JSON → 跑 `node scripts/bake-chat-persona.mjs` → 两端测试会自动比对。
/// 长度闸: 中文整段 ≤350 字符 (chat:C2-04), 见 test/chat_light_harness_test.dart。
library;

import 'chat_persona.g.dart';

/// 手机 Chat 人设: [search] / [image] 表示本轮工具表里**真有的**工具 ——
/// 没有的那件提示词里就不许声称有 (没登录时没有搜索)。
String chatLightPersona({bool search = true, bool image = true}) {
  final key = chatPersonaKey('zh', search: search, image: image, style: 'card');
  final text = kChatPersonas[key];
  if (text == null) {
    throw StateError('缺人设变体: $key —— 改完源 JSON 跑 node scripts/bake-chat-persona.mjs');
  }
  return text;
}
