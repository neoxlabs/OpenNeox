/// spoken_lead.dart — 回复里只念口播段 (2026-10-02)。
///
/// 跟电脑上同一条规则 (packages/core/src/services/spokenLead.ts): 回复是写给眼睛的,
/// 念出来只念第一段的一两句结论 —— 遇到空行 / 列表 / 表格 / 代码就停, 最多两句,
/// 加上下一句会超过约 90 字就停在上一句。路径念文件名、链接念「链接」、(fyi) 这类代号不念。
/// 电脑在线时由电脑合成 (电脑那边做同样的处理), 这里管手机自己用系统语音念的那条路。
library;

final _structure = RegExp(r'\n\s*\n|\n\s*(?:[-*+•]\s|\d+[.、)]\s|\||#{1,6}\s|>|```)|```');
final _terminator = RegExp(r'[。！？!?]|\.(?=\s|$)');

String spokenLead(String text, {int maxSentences = 2}) {
  var t = text.trim();
  final s = _structure.firstMatch(t);
  if (s != null) t = t.substring(0, s.start);
  var count = 0;
  var prevEnd = 0;
  for (final m in _terminator.allMatches(t)) {
    count++;
    if (m.end > 90 && prevEnd > 0) { t = t.substring(0, prevEnd); break; }
    if (count >= maxSentences || m.end >= 90) { t = t.substring(0, m.end); break; }
    prevEnd = m.end;
  }
  if (t.length > 160) {
    final head = t.substring(0, 160);
    final cut = [head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('；'), head.lastIndexOf('：')].reduce((a, b) => a > b ? a : b);
    t = cut > 40 ? head.substring(0, cut + 1) : head;
  }
  return speakable(t);
}

/// 边写边念: 正在写的这段, 口播段定了没有 —— 定了返回要念的那句, 还没定返回 null。
/// 定了 = 已经空行 / 两句写完 / 一句写完且够长 (≥12 字, 「好的。」这种太短的再等等) / 它开始调工具 ([force])
String? closedLead(String text, {bool force = false}) {
  final t = text.trim();
  if (t.isEmpty) return null;
  final ends = _terminator.allMatches(t).toList();
  final closed = force ||
      _structure.hasMatch(t) ||
      ends.length >= 2 ||
      (ends.length == 1 && ends.first.end >= 12);
  if (!closed) return null;
  /* 还在写的半句不念: 截到最后一个句末 (空行 / 调工具时按 spokenLead 自己的规矩) */
  final upto = !force && !_structure.hasMatch(t) && ends.isNotEmpty ? t.substring(0, ends.last.end) : t;
  final lead = spokenLead(upto);
  return lead.isEmpty ? null : lead;
}

/// 边写边念的收尾: 已经念了 [early], 这一轮最后那段话是 [answer], 还要补念什么 (不用补返回 '')。
/// 同一段: 只补后半 (先念了第一句, 第二句后来才写完); 中间调过工具、最后是另一段: 念它的口播句
String leadRemainder(String early, String answer) {
  final full = spokenLead(answer);
  if (early.isEmpty) return full;
  if (full == early) return '';
  if (full.startsWith(early)) return full.substring(early.length).trim();
  return full;
}

/// 念出来别扭的换成能听的
String speakable(String text) => text
    .replaceAll(RegExp(r'```[\s\S]*?```'), '')
    .replaceAll(RegExp(r'https?://\S+'), '链接')
    .replaceAllMapped(RegExp(r'(?:~|\.{1,2})?(?:/?[\w.\-一-龥]+/)+([\w.\-一-龥]*)'), (m) {
      final whole = m[0]!;
      if (!RegExp(r'[a-zA-Z一-龥]').hasMatch(whole) || RegExp(r'^\d+/\d+$').hasMatch(whole)) return whole;
      final last = m[1] ?? '';
      if (last.isNotEmpty) return last;
      final segs = whole.split('/').where((x) => x.isNotEmpty).toList();
      return segs.isEmpty ? whole : segs.last;
    })
    .replaceAll(RegExp(r'[（(]\s*[A-Za-z][A-Za-z0-9_\-]{0,11}\s*[)）]'), '')
    .replaceAll(RegExp(r'[*_`#>|]'), '')
    .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m[1] ?? '')
    .replaceAll(RegExp(r'[ \t]{2,}'), ' ')
    .trim();
