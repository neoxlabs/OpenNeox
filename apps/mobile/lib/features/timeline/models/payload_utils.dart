/// payload_utils.dart — timeline payload 解析公共函数.
///
/// 这一层只做"原始字符串/Map → strongly-typed 显示数据"的提取, 不写 UI.
/// 所有 widget 共用, 防重复逻辑漂移.
library;

import 'dart:convert';
import 'package:neox_app/core/i18n/tr.dart';

/// 安全 JSON decode — 失败兜底返原 string, 不抛.
Object? safeDecode(String s) {
  try {
    return jsonDecode(s);
  } catch (_) {
    return s;
  }
}

/// 从 payload 里拎可显示文本 — 兼容多种字段名 + multi-content array.
String stringFromPayload(Object? payload, String fallback, {String? fallback2}) {
  if (payload is Map<String, dynamic>) {
    for (final k in const ['text', 'content', 'message', 'name', 'summary']) {
      final v = payload[k];
      if (v is String && v.isNotEmpty) return v;
      if (v is List) {
        final buf = StringBuffer();
        for (final part in v) {
          if (part is Map && part['type'] == 'text' && part['text'] is String) {
            buf.write(part['text']);
          }
        }
        final s = buf.toString();
        if (s.isNotEmpty) return s;
      }
    }
  }
  if (payload is String && payload.isNotEmpty) return payload;
  return fallback2 ?? fallback;
}

/// 从 tool_calls / name 字段提工具名.
String? toolName(Object? payload) {
  if (payload is! Map) return null;
  if (payload['tool_name'] is String) return payload['tool_name'] as String;
  if (payload['name'] is String) return payload['name'] as String;
  final tc = payload['tool_calls'];
  if (tc is List && tc.isNotEmpty) {
    final first = tc.first;
    if (first is Map) {
      final fn = first['function'];
      if (fn is Map && fn['name'] is String) return fn['name'] as String;
      if (first['name'] is String) return first['name'] as String;
    }
  }
  return null;
}

/// 抽工具 args 的"代表性 1 行摘要" — file_path / command / query / url 等.
String? toolSummary(Object? payload) {
  if (payload is! Map) return null;
  final tc = payload['tool_calls'];
  Object? args;
  if (tc is List && tc.isNotEmpty && tc.first is Map) {
    final fn = (tc.first as Map)['function'];
    if (fn is Map) {
      final a = fn['arguments'];
      if (a is String) {
        try {
          args = jsonDecode(a);
        } catch (_) {}
      } else {
        args = a;
      }
    }
  }
  /* tool_result / 老格式兜底: 直接看顶层 arguments / args / input */
  args ??= payload['arguments'] ?? payload['args'] ?? payload['input'];
  if (args is Map) {
    for (final k in const ['file_path', 'path', 'command', 'query', 'pattern', 'url']) {
      final v = args[k];
      if (v is String && v.isNotEmpty) {
        return _truncate(v);
      }
    }
  }
  return null;
}

/// 按工具名 + args 做更智能的 1 行摘要 —— 第二回合, 之前 toolSummary 拿不到时兜底.
///
/// 策略 (依优先级):
///   1. per-tool 已知 key 表 (open_surface / explore / tool_search / browser_*)
///   2. 通用候选 key (paths / prompt / prompts / title / q / term / kind / name / target)
///   3. 第一个非空 string / 第一个 string 数组首项 (最后兜底)
///   4. 都没有 → null (UI 显空; 像 browser_list_surfaces 这种零参工具就是该没摘要)
String? smartArgSummary(String toolName, Map<String, dynamic>? args) {
  if (args == null || args.isEmpty) return null;
  final tn = toolName.toLowerCase();

  /* bash_output: 在等后台进程的哪句话、最长多久 (2026-10-12 用户: 摘要没写等多长, 点开是原始参数) */
  if (tn == 'bash_output') {
    final pat = args['wait_for_pattern'];
    final ms = args['timeout'];
    final lim = ms is num ? tr(' · 最长 ${(ms / 1000).round()}s') : '';
    if (pat is String && pat.trim().isNotEmpty) return _truncate(tr('等「${pat.trim()}」出现$lim'));
    final pid = args['pid'];
    return pid == null ? null : 'pid $pid';
  }

  /* readfile/read_file/read_document — 拼 path · 行范围, 行范围有就显 */
  if (tn == 'readfile' || tn == 'read_file' || tn == 'read_document') {
    final path = _stringOrFirst(args['path']) ??
        _stringOrFirst(args['file_path']) ??
        _stringOrFirst(args['paths']);
    if (path == null) return null;
    final range = _readfileRange(args);
    return _truncate(range == null ? path : '$path · $range');
  }

  /* per-tool key 优先 — 不同工具语义不同的关键字段 */
  const perTool = <String, List<String>>{
    'open_surface': ['title', 'kind'],
    'explore': ['prompt'],
    'tool_search': ['query', 'pack'],
    'search': ['pattern', 'query', 'keywords'],
    'web_search': ['query', 'q'],
    'web_fetch': ['url'],
    'list_directory': ['path', 'pattern'],
    'glob': ['pattern', 'path'],
  };
  for (final k in perTool[tn] ?? const <String>[]) {
    final s = _stringOrFirst(args[k]);
    if (s != null) return _truncate(s);
  }

  /* prefix 匹配 — browser_*, surface_* 等家族同款 */
  if (tn.startsWith('browser_')) {
    final s = _stringOrFirst(args['surface_id']) ??
        _stringOrFirst(args['url']) ??
        _stringOrFirst(args['title']);
    if (s != null) return _truncate(s);
  }

  /* 通用候选 key */
  const generic = [
    'paths', 'prompt', 'prompts', 'title', 'name', 'target',
    'q', 'term', 'keyword', 'keywords', 'kind', 'type',
    'message', 'text', 'description',
  ];
  for (final k in generic) {
    final s = _stringOrFirst(args[k]);
    if (s != null) return _truncate(s);
  }

  /* 最后兜底 — 第一个 string / list-of-string 字段值. 不显数字/布尔 (没识别价值). */
  for (final entry in args.entries) {
    final s = _stringOrFirst(entry.value);
    if (s != null && s.isNotEmpty) return _truncate(s);
  }
  return null;
}

String? _stringOrFirst(Object? v) {
  if (v is String && v.isNotEmpty) return v;
  if (v is List && v.isNotEmpty) {
    final first = v.first;
    if (first is String && first.isNotEmpty) {
      return v.length > 1 ? '$first  +${v.length - 1}' : first;
    }
  }
  return null;
}

String _truncate(String s, [int max = 80]) {
  return s.length > max ? '${s.substring(0, max - 1)}…' : s;
}

/// readfile 行范围摘要: 1-80 / +200 行 / 全文 / symbol foo 等.
String? _readfileRange(Map<String, dynamic> args) {
  if (args['read_all'] == true) return tr('全文');
  final symbol = args['symbol'];
  if (symbol is String && symbol.isNotEmpty) return 'sym $symbol';
  final startLine = args['start_line'];
  final endLine = args['end_line'];
  if (startLine is num && endLine is num && endLine > startLine) {
    return '${startLine.toInt()}-${endLine.toInt()}';
  }
  if (startLine is num) {
    final numLines = args['num_lines'];
    if (numLines is num && numLines > 0) {
      return '${startLine.toInt()}-${(startLine + numLines).toInt()}';
    }
    return '${startLine.toInt()}+';
  }
  final numLines = args['num_lines'];
  if (numLines is num && numLines > 0) {
    return tr('+${numLines.toInt()} 行');
  }
  /* ranges: [{start, end}] 多段 */
  final ranges = args['ranges'];
  if (ranges is List && ranges.isNotEmpty) {
    return tr('${ranges.length} 段');
  }
  return null;
}

/// 抽 tool_calls 第 1 条的 args (Map) — 兼容 tool_calls / 顶层 arguments / input 多种 shape.
Map<String, dynamic>? extractArgs(Object? payload) {
  if (payload is! Map) return null;
  final tc = payload['tool_calls'];
  if (tc is List && tc.isNotEmpty && tc.first is Map) {
    final fn = (tc.first as Map)['function'];
    if (fn is Map) {
      final a = fn['arguments'];
      if (a is String) {
        try {
          final parsed = jsonDecode(a);
          if (parsed is Map<String, dynamic>) return parsed;
        } catch (_) {}
      }
      if (a is Map<String, dynamic>) return a;
    }
    final input = (tc.first as Map)['input'];
    if (input is Map<String, dynamic>) return input;
  }
  for (final k in const ['arguments', 'args', 'input']) {
    final v = payload[k];
    if (v is Map<String, dynamic>) return v;
    if (v is String) {
      try {
        final parsed = jsonDecode(v);
        if (parsed is Map<String, dynamic>) return parsed;
      } catch (_) {}
    }
  }
  return null;
}

/// 工具名 → 中文友好名映射. 未知名 fallback 原名.
///
/// 设计:
///   - 不动 monospace 字体 (保留"工具"质感), 只换显示字符串
///   - 名字短而精确, 不啰嗦 (4-6 个汉字内)
///   - 一类同源映射 (read_file/readfile/read_document 都 → 读文件)
final _friendlyNames = <String, String>{
  'bash_output': tr('等输出'),
  'bash_kill': tr('停止进程'),
  // 文件
  'readfile': tr('读文件'),
  'read_file': tr('读文件'),
  'read_document': tr('读文档'),
  'write_file': tr('写文件'),
  'edit_file': tr('编辑文件'),
  'edit': tr('编辑'),
  'delete_file': tr('删除'),
  'list_directory': tr('列目录'),
  'glob': tr('查文件'),
  // shell / 代码
  'execute_shell': tr('执行命令'),
  'execute_bash': tr('执行命令'),
  'bash': 'Bash',
  'execute_python': tr('执行 Python'),
  'execute_javascript': tr('执行 JS'),
  'execute_code': tr('执行代码'),
  // 搜
  'search': tr('搜索'),
  'search_files': tr('搜索'),
  'grep': tr('搜索'),
  'web_search': tr('搜网络'),
  'web_fetch': tr('抓网页'),
  // agent / plan
  'update_plan': tr('更新计划'),
  'edit_plan': tr('更新计划'),
  'explore': tr('探索代码'),
  // surface
  'open_surface': tr('打开面板'),
  'tool_search': tr('查工具'),
  // browser surface
  'browser_list_surfaces': tr('列浏览器'),
  'browser_navigate': tr('浏览器跳转'),
  'browser_screenshot': tr('浏览器截图'),
  'browser_click': tr('浏览器点击'),
};

/// edit / write 类 — 主 timeline 可聚合进组; 收拢行显示 +N −M.
bool isDiffToolName(String? rawName) {
  if (rawName == null || rawName.isEmpty) return false;
  final n = rawName.toLowerCase();
  return n == 'edit_file' ||
      n == 'edit' ||
      n == 'write_file' ||
      n == 'write_neox_config' ||
      n == 'apply_patch' ||
      n == 'str_replace' ||
      n == 'search_replace';
}

/// 从工具 args 估算增删行数 (对齐桌面 EditDiffCard +N/−M).
({int adds, int dels}) diffLineStats(String? toolName, Map<String, dynamic>? args) {
  if (args == null || !isDiffToolName(toolName)) {
    return (adds: 0, dels: 0);
  }
  final n = toolName!.toLowerCase();
  int lineCount(String s) {
    if (s.isEmpty) return 0;
    return '\n'.allMatches(s).length + 1;
  }

  if (n == 'write_file' || n == 'write_neox_config') {
    final content = (args['content'] ?? args['text'] ?? '').toString();
    return (adds: lineCount(content), dels: 0);
  }
  final oldS = (args['old_string'] ?? args['old'] ?? '').toString();
  final newS = (args['new_string'] ?? args['new'] ?? '').toString();
  return (adds: lineCount(newS), dels: lineCount(oldS));
}

/// 聚合一组工具的增删行.
({int adds, int dels}) aggregateDiffStats(Iterable<({String? toolName, Map<String, dynamic>? args})> tools) {
  var adds = 0;
  var dels = 0;
  for (final t in tools) {
    final s = diffLineStats(t.toolName, t.args);
    adds += s.adds;
    dels += s.dels;
  }
  return (adds: adds, dels: dels);
}

/// Cursor 风格收拢摘要: "编辑 ×2 · 读取 ×3 · 命令 ×1"
String summarizeToolOps(Iterable<String?> toolNames) {
  var edit = 0, write = 0, read = 0, shell = 0, search = 0, explore = 0, other = 0;
  for (final raw in toolNames) {
    final n = (raw ?? '').toLowerCase();
    if (isDiffToolName(n) || n.contains('write') || n.contains('edit')) {
      if (n.contains('write')) {
        write++;
      } else {
        edit++;
      }
    } else if (n.contains('read') || n.contains('list_dir') || n == 'glob') {
      read++;
    } else if (n.contains('shell') || n.contains('bash') || n.contains('exec') || n.contains('python') || n.contains('javascript')) {
      shell++;
    } else if (n.contains('search') || n.contains('grep') || n.contains('web_')) {
      search++;
    } else if (n.contains('explore') || n.contains('task')) {
      explore++;
    } else {
      other++;
    }
  }
  final parts = <String>[];
  if (edit > 0) parts.add(edit == 1 ? tr('编辑') : tr('编辑 ×$edit'));
  if (write > 0) parts.add(write == 1 ? tr('写入') : tr('写入 ×$write'));
  if (read > 0) parts.add(read == 1 ? tr('读取') : tr('读取 ×$read'));
  if (search > 0) parts.add(search == 1 ? tr('搜索') : tr('搜索 ×$search'));
  if (shell > 0) parts.add(shell == 1 ? tr('命令') : tr('命令 ×$shell'));
  if (explore > 0) parts.add(explore == 1 ? tr('探索') : tr('探索 ×$explore'));
  if (other > 0) parts.add(other == 1 ? tr('操作') : tr('操作 ×$other'));
  return parts.isEmpty ? tr('操作') : parts.join(' · ');
}

String friendlyToolName(String rawName) {
  return _friendlyNames[rawName.toLowerCase()] ?? rawName;
}

/// HH:mm 时间.
String fmtTime(int ts) {
  if (ts <= 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ts);
  final h = d.hour.toString().padLeft(2, '0');
  final m = d.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

/// 防御性 strip — 把文本里 (开头或中间) 所有独立合法 JSON 对象去掉.
///
///   背景: 某些 LLM (Claude/GPT) 在 stream text token 时, 把 tool_use args JSON 也吐出来,
///   形成 `好的, 测试 ✨{"command":"ls"}{"pattern":"..."}` 这种串.
///   tool_call 本身有独立 drift event 走 ToolBlock 渲染, agent_text 不该重复.
///
///   Desktop 端 forwarder 已经 strip, 这是 mobile 端兜底 — 防止老 desktop / 漏网数据.
///
///   ``` 围栏里的内容原样保留 (2026-10-06): 原来连代码块一起扫, `neox-card:weather` 的
///   JSON 被当成漏出来的工具参数删光, 真机上天气卡只剩一个空代码块; 空白压缩也把代码缩进压没了。
String stripStandaloneJson(String text) {
  if (!text.contains('```') && !text.contains('~~~')) return _stripJsonOutsideFence(text);
  final out = StringBuffer();
  final plain = StringBuffer();
  var inFence = false;
  void flushPlain() {
    if (plain.isEmpty) return;
    final s = _stripJsonOutsideFence(plain.toString());
    if (s.isNotEmpty) out.write(out.isEmpty ? '$s\n' : '\n$s\n');
    plain.clear();
  }

  for (final line in text.split('\n')) {
    final t = line.trimLeft();
    final fence = t.startsWith('```') || t.startsWith('~~~');
    if (!inFence && !fence) {
      plain.writeln(line);
      continue;
    }
    if (!inFence) flushPlain();
    out.writeln(line);
    if (fence) inFence = !inFence;
  }
  flushPlain();
  return out.toString().replaceAll(RegExp(r'\n{3,}'), '\n\n').trim();
}

String _stripJsonOutsideFence(String text) {
  final out = StringBuffer();
  var i = 0;
  while (i < text.length) {
    final ch = text[i];
    if (ch == '{') {
      var depth = 0;
      var inStr = false;
      var escape = false;
      var endIdx = -1;
      for (var j = i; j < text.length; j++) {
        final c = text[j];
        if (escape) { escape = false; continue; }
        if (inStr) {
          if (c == '\\') { escape = true; }
          else if (c == '"') { inStr = false; }
          continue;
        }
        if (c == '"') { inStr = true; continue; }
        if (c == '{') { depth++; }
        else if (c == '}') {
          depth--;
          if (depth == 0) { endIdx = j + 1; break; }
        }
      }
      if (endIdx > 0) {
        final candidate = text.substring(i, endIdx);
        try {
          jsonDecode(candidate);
          /* 合法 JSON → 跳过, 不入 result */
          i = endIdx;
          continue;
        } catch (_) {
          /* 不是 JSON → 当普通字符 */
        }
      }
    }
    out.write(ch);
    i++;
  }
  /* 多余空白清理 */
  return out
      .toString()
      .replaceAll(RegExp(r'[ \t]+'), ' ')
      .replaceAll(RegExp(r'\n{3,}'), '\n\n')
      .trim();
}
