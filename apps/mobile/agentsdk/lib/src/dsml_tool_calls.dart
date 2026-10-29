/// DSML 文本形态工具调用 → 真调用 (手机端, 2026-10-12)。跟桌面 packages/kernel/src/utils/dsmlToolCalls.ts 同一套规则。
///
/// DeepSeek 有时不走原生 tool_calls, 把一段标记当正文吐出来:
///
///   <｜DSML｜function_calls>
///   <｜DSML｜invoke name="phone_ui">
///   <｜DSML｜parameter name="op" string="true">tap</｜DSML｜parameter>
///   <｜DSML｜parameter name="target" string="false">3</｜DSML｜parameter>
///   </｜DSML｜invoke>
///   </｜DSML｜function_calls>
///
/// 原样显示 = 一屏乱码, 调用也没执行, 整轮就断了 (2026-10-12 用户真机: 让它去 QQ 看消息, 第 11 步变成这个)。
/// 模型意图是完整的, 缺的只是翻译回结构化调用。⚠️ 半截的 (没有闭合 invoke) 绝不执行。
library;

import 'dart:convert';

const _bar = '[｜|]{1,2}';
/// 2026-10-18: 竖线和关键字之间偶尔夹空格 (`</｜｜DSML｜｜ parameter>`) —— 认它。
const _gap = r'\s*';
final _openInvoke = RegExp('<${_bar}DSML${_bar}${_gap}invoke\\s+name="([^"]+)"\\s*>');
final _closeInvoke = RegExp('</${_bar}DSML${_bar}${_gap}invoke\\s*>');
final _param = RegExp(
  '<${_bar}DSML${_bar}${_gap}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${_bar}DSML${_bar}${_gap}parameter\\s*>',
);
/// 外壳: tool_calls / function_calls / calls 都见过
final _wrapper = RegExp('</?${_bar}DSML${_bar}${_gap}\\w*calls\\s*>');
/// 正文里残留的 DSML 残片 (只有闭合标签 / 属性块没被认出的碎块) —— 从展示文本里剔掉。
final _fragment = RegExp('</?${_bar}DSML${_bar}[^>]*>');
/// 实拍里模型**只吐闭合标签** (开头那半进了思考流), 漏掉 `/` 整段就嗅不到。
final _sniff = RegExp('</?${_bar}DSML');

/// 流式时: 文本里第一处 DSML 的位置 (没有 = -1)
int dsmlStart(String text) => _sniff.firstMatch(text)?.start ?? -1;

/// 流式时: 结尾是不是可能刚开了个 DSML 的头 (「<」「<｜」「<｜DS」…), 这一截先别显示
int dsmlPartialTailStart(String text) {
  final i = text.lastIndexOf('<');
  if (i < 0 || text.length - i > 10) return -1;
  final tail = text.substring(i);
  for (final head in const [
    '<｜DSML', '<|DSML', '<｜｜DSML', '<||DSML',
    '</｜DSML', '</|DSML', '</｜｜DSML', '</||DSML',
  ]) {
    if (head.startsWith(tail)) return i;
  }
  return -1;
}

class DsmlCall {
  DsmlCall(this.name, this.arguments);
  final String name;
  final Map<String, Object?> arguments;
}

class DsmlParse {
  DsmlParse(this.calls, this.text, this.sawIncomplete);
  final List<DsmlCall> calls;

  /// 摘掉 DSML 之后剩下的人话
  final String text;

  /// 见到 DSML 但没解析出完整调用
  final bool sawIncomplete;
}

Object? _coerce(String raw, String? isString) {
  if (isString == 'true') return raw;
  final t = raw.trim();
  if (isString == 'false' || RegExp(r'^(true|false|null|-?\d|[\[{"])').hasMatch(t)) {
    try {
      return jsonDecode(t);
    } catch (_) {}
  }
  return raw;
}

DsmlParse parseDsmlToolCalls(String src) {
  if (src.isEmpty || !_sniff.hasMatch(src)) return DsmlParse(const [], src, false);
  final calls = <DsmlCall>[];
  var incomplete = false;
  final consumed = <List<int>>[];
  var from = 0;
  while (true) {
    final m = _openInvoke.firstMatch(src.substring(from));
    if (m == null) break;
    final start = from + m.start;
    final bodyStart = from + m.end;
    final rest = src.substring(bodyStart);
    final close = _closeInvoke.firstMatch(rest);
    if (close == null) {
      incomplete = true;
      consumed.add([start, src.length]);
      break;
    }
    final body = rest.substring(0, close.start);
    final args = <String, Object?>{};
    for (final p in _param.allMatches(body)) {
      args[p.group(1)!] = _coerce(p.group(3)!, p.group(2));
    }
    if (args.isEmpty && body.contains('parameter')) {
      incomplete = true;
    } else {
      calls.add(DsmlCall(m.group(1)!, args));
    }
    final end = bodyStart + close.end;
    consumed.add([start, end]);
    from = end;
  }
  final out = StringBuffer();
  var cursor = 0;
  for (final r in consumed) {
    if (r[0] > cursor) out.write(src.substring(cursor, r[0]));
    cursor = r[1];
  }
  if (cursor < src.length) out.write(src.substring(cursor));
  var text = out.toString().replaceAll(_wrapper, '').replaceAll(_fragment, '');
  /* 有 DSML 痕迹却连一个 invoke 开标签都没匹配上 (实拍只有闭合标签) —— 也算残缺,
   * 别静默把残骸当正常回复放行 (与桌面 parseDsmlToolCalls 同一口径)。 */
  if (calls.isEmpty && consumed.isEmpty) incomplete = true;
  /* 没闭合的残壳 (只有开头几个标签) 也不留在正文里 */
  final dangling = dsmlStart(text);
  if (dangling >= 0) {
    incomplete = true;
    text = text.substring(0, dangling);
  }
  return DsmlParse(calls, text.trim(), incomplete);
}
