/// session_title.dart — 本机会话的自动标题.
///
/// chat:C1-04: 手机本机会话以前只有云端任务会起标题 (截前 28 字),
/// 本机会话在抽屉里永远叫「新会话」, 一排会话分不清。
///
/// 这里只做**确定性摘要**: 不额外调模型 —— 首条消息刚发出去, 再等一次
/// 侧路请求既慢又要钱, 而标题只需要帮用户在抽屉里认出这条会话。
/// 规则: 去掉隐藏注入标签 / 链接 / 多余空白, 去掉开头客套词, 压到 12 字以内。
library;

/// 标题最多几个字 (含省略号).
const int kSessionTitleMaxChars = 12;

/// 默认标题 — 用户没改过名字, 首条消息可以覆盖.
const Set<String> kDefaultSessionTitles = {
  '新会话',
  '新任务',
  '新对话',
  '新聊天',
};

final RegExp _hiddenBlock =
    RegExp(r'<(reply-language|system-reminder)>[\s\S]*?</\1>');
final RegExp _images = RegExp(r'!\[[^\]]*\]\([^)]*\)');
final RegExp _links = RegExp(r'\[([^\]]*)\]\([^)]*\)');
final RegExp _urls = RegExp(r'https?://\S+');
final RegExp _whitespace = RegExp(r'\s+');
final RegExp _leadingPoliteness =
    RegExp(r'^(请|帮我|麻烦|能不能|可以|我想|我需要)\s*');

/// 从第一句话取标题; 空消息返回空串.
String sessionTitleFromFirstMessage(String raw) {
  var text = raw.trim();
  if (text.isEmpty) return '';

  text = text.replaceAll(_hiddenBlock, ' ');
  text = text.replaceAll(_images, ' ');
  text = text.replaceAllMapped(_links, (m) => m[1] ?? '');
  text = text.replaceAll(_urls, ' ');
  text = text.replaceAll(_whitespace, ' ').trim();

  /* 「帮我/请」这类客套词占掉前两个字, 标题就只剩半个动词 (「帮我写一个 Py」)。
   * 只剥开头一次, 不动正文里的词。 */
  text = text.replaceFirst(_leadingPoliteness, '').trim();
  if (text.isEmpty) return '';

  final runes = text.runes.toList();
  if (runes.length <= kSessionTitleMaxChars) return text;
  return '${String.fromCharCodes(runes.take(kSessionTitleMaxChars - 1))}…';
}

/// 该不该用首条消息改标题 — 已经起过名的会话返回 null (不覆盖用户/桌面的命名).
String? improvedSessionTitle(String? current, String firstMessage) {
  final c = (current ?? '').trim();
  if (c.isNotEmpty && !kDefaultSessionTitles.contains(c)) return null;
  final title = sessionTitleFromFirstMessage(firstMessage);
  return title.isEmpty ? null : title;
}
