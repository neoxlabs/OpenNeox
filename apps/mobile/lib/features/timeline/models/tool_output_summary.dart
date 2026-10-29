/// tool_output_summary.dart — 工具失败输出 → 一句人话.
///
/// 2026-10-18 用户真机 (编码会话「执行中」页): 工具失败卡里直接糊了一段
/// `{"type":"contextual","status":"error","tool":"browser_run",...}` 原始 JSON,
/// 用户既看不出发生了什么, 也读不懂那串字段.
///
/// 运行时的失败结果有两种形状:
///   1. `ToolResult` 信封 —— `{type:'contextual', status:'error', tool, summary, content}`
///      (见 packages/kernel/src/core/types/toolResult.ts)。`summary` 就是给人看的那句话。
///   2. 工具自己 return 的 JSON 字符串 —— `{"ok":false,"error":"No browser surface"}`。
/// 原文不丢: 失败卡点开是整页详情, 完整输出在那里。
library;

import 'dart:convert';

/// 从失败输出里摘出**一句**人话 (没有可用信息就返回 null, 调用方别硬编一句).
///
/// [max] 是长度上限 —— 这一句要能塞进一行失败卡, 超了截断加省略号。
String? toolFailureSentence(String? output, {int max = 120}) {
  final raw = (output ?? '').trim();
  if (raw.isEmpty) return null;
  final sentence = _fromJsonish(raw) ?? _firstLine(raw);
  if (sentence == null || sentence.isEmpty) return null;
  final flat = sentence.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.isEmpty) return null;
  return flat.length <= max ? flat : '${flat.substring(0, max - 1)}…';
}

/// 文本看着像 JSON 就解析; 解析不出人话返回 null.
String? _fromJsonish(String raw) {
  final t = raw.trimLeft();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  /* 多行 / 被截断的 JSON 直接解会抛 —— 只吞掉异常, 交给「取第一行」兜底 */
  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (_) {
    return null;
  }
  return _sentenceFromValue(decoded, depth: 0);
}

/// 信封里挑那句人话. 顺序有讲究:
///   summary  —— 运行时专门写的「给人看的一句话」(工具结果信封的标准字段)
///   error / message / reason / detail —— 工具自己 return 的错误说明
///   content  —— 可能是嵌套的一层 JSON (browser_run 把内层结果序列化进 content)
String? _sentenceFromValue(Object? v, {required int depth}) {
  if (depth > 2) return null;
  if (v is String) {
    final s = v.trim();
    if (s.isEmpty) return null;
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        return _sentenceFromValue(jsonDecode(s), depth: depth + 1);
      } catch (_) {
        return null;
      }
    }
    return s;
  }
  if (v is! Map) return null;
  for (final k in const ['summary', 'error', 'message', 'reason', 'detail']) {
    final x = v[k];
    if (x is String && x.trim().isNotEmpty) return x.trim();
  }
  final content = v['content'];
  if (content != null) {
    final nested = _sentenceFromValue(content, depth: depth + 1);
    if (nested != null) return nested;
  }
  return null;
}

String? _firstLine(String raw) {
  for (final l in raw.split('\n')) {
    final t = l.trim();
    if (t.isNotEmpty) return t;
  }
  return null;
}

/// 工具输出压成一行 (展开的步骤行要「一句话结果」)。
/// 不是失败也能用 —— 取第一段非空文字, 压掉换行, 超长截断。
String? firstLineSummary(String? output, {int max = 80}) {
  final raw = (output ?? '').trim();
  if (raw.isEmpty) return null;
  final t = raw.trimLeft();
  /* 整段是 JSON 时取里面那句人话, 别把 `{"ok":true,...}` 摆出来 */
  if (t.startsWith('{') || t.startsWith('[')) {
    final s = _fromJsonish(raw);
    if (s != null) return s.length <= max ? s : '${s.substring(0, max - 1)}…';
  }
  final line = _firstLine(raw);
  if (line == null) return null;
  final flat = line.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.isEmpty) return null;
  return flat.length <= max ? flat : '${flat.substring(0, max - 1)}…';
}
