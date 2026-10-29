/// process_row.dart — 一轮回复的「过程」(陶土稿 v5「时间线按模式分」).
///
/// 编码:
///   ✓ 11 步 · 2 分 41 秒 · 改 2 个文件 · 测试 14 通过            ›
///   (跑着时) 已做 5 步 · 读 3 个文件 · 改 1 个文件 ›
///            ◌ npm test -- auth                                  12s
///              PASS  src/auth/login.test.ts            ← 输出尾巴两行, 灰色等宽, 不加框
///   点开: 一步一行的纯文字日志 —— 没有动词列、没有图标, 命令带 $, 右边是结果
///
/// 工作: ✓ 5 步 · 4 分 12 秒 · 读了 3 张表 ›; 点开是带陶土方块图标的步骤行
/// 对话: 搜了 8 个网页 · 想了 4 秒 ›
///
/// 失败的那一步不用点就露出来 (红色一行错误)。点任意一步进全屏详情 (改动 / 终端输出)。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/i18n/tr.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../home/state/composer_pending_provider.dart';
import '../models/payload_utils.dart';
import 'remote_image.dart' show NeoxImageStrip, neoxImageNamesIn;
import '../models/tool_output_summary.dart';
import '../state/timeline_state.dart';
import '../tool_renderers.dart' as toolr;
import 'artifact_card.dart';
import 'markdown_view.dart';
import 'shimmer_text.dart';
import 'tool_group_row.dart';
import 'tool_result_cards.dart';

// ════════════════════════════════════════════════════════════════
//  一步 → 怎么说
// ════════════════════════════════════════════════════════════════

enum StepKind { think, text, read, list, search, edit, write, shell, webSearch, webFetch, image, plan, ask, phone, browser, mcp, memory, other }

StepKind stepKindOf(TimelineEntry e) {
  if (e.kind == 'agent_thinking') return StepKind.think;
  if (e.kind == 'agent_text') return StepKind.text;
  final n = (e.toolName ?? '').toLowerCase();
  /* 手机本机的文件工具是一个工具带 op (workspace_files {op: write, path, content}) */
  final action = e.args?['op'] ?? e.args?['action'];
  if (action is String && (n.contains('files') || n.contains('file_'))) {
    switch (action.toLowerCase()) {
      case 'write' || 'create' || 'append':
        return StepKind.write;
      case 'edit' || 'replace' || 'patch':
        return StepKind.edit;
      case 'read' || 'cat' || 'head':
        return StepKind.read;
      case 'list' || 'ls' || 'tree':
        return StepKind.list;
      case 'search' || 'grep' || 'find':
        return StepKind.search;
    }
  }
  if (n == 'web_search' || n.contains('web_search')) return StepKind.webSearch;
  if (n == 'web_fetch' || n.contains('fetch_url') || n == 'open_url') return StepKind.webFetch;
  if (n.contains('generate_image') || n.contains('image_gen')) return StepKind.image;
  if (n.contains('plan')) return StepKind.plan;
  if (n.contains('ask_user') || n == 'ask') return StepKind.ask;
  if (n.startsWith('phone_') || n.contains('phone_use')) return StepKind.phone;
  if (n.startsWith('browser')) return StepKind.browser;
  if (n.contains('memory') || n.contains('remember')) return StepKind.memory;
  if (n == 'write_file' || n == 'write_neox_config' || n == 'create_file') return StepKind.write;
  if (isDiffToolName(n) || n.contains('edit')) return StepKind.edit;
  if (n == 'list_directory' || n == 'glob' || n.contains('list_dir')) return StepKind.list;
  if (n.contains('read')) return StepKind.read;
  if (n.contains('grep') || n == 'search' || n.contains('search_files')) return StepKind.search;
  if (n.contains('shell') || n.contains('bash') || n.contains('exec') || n.contains('python') || n.contains('javascript')) {
    return StepKind.shell;
  }
  if (n.contains('__') || n.startsWith('mcp')) return StepKind.mcp;
  return StepKind.other;
}

IconData stepIcon(StepKind k) => switch (k) {
      StepKind.think => Icons.psychology_outlined,
      StepKind.text => Icons.notes_rounded,
      StepKind.read => Icons.description_outlined,
      StepKind.list => Icons.folder_open_outlined,
      StepKind.search => Icons.manage_search_rounded,
      StepKind.edit => Icons.edit_note_rounded,
      StepKind.write => Icons.note_add_outlined,
      StepKind.shell => Icons.terminal_rounded,
      StepKind.webSearch => Icons.language_rounded,
      StepKind.webFetch => Icons.link_rounded,
      StepKind.image => Icons.brush_outlined,
      StepKind.plan => Icons.checklist_rounded,
      StepKind.ask => Icons.help_outline_rounded,
      StepKind.phone => Icons.touch_app_outlined,
      StepKind.browser => Icons.web_rounded,
      StepKind.mcp => Icons.power_outlined,
      StepKind.memory => Icons.bookmark_border_rounded,
      StepKind.other => Icons.widgets_outlined,
    };

String _base(String p) {
  final s = p.trim();
  /* Windows 电脑的路径是反斜杠 (e:\code\x\a.ts) —— 只认 / 会把整条路径印出来 */
  final i = s.lastIndexOf(RegExp(r'[/\\]'));
  return i >= 0 && i < s.length - 1 ? s.substring(i + 1) : s;
}

String? _arg(TimelineEntry e, List<String> keys) {
  for (final k in keys) {
    final v = e.args?[k];
    if (v is String && v.trim().isNotEmpty) return v.trim();
    if (v is List && v.isNotEmpty && v.first is String) {
      final list = v.cast<String>();
      return list.length > 3 ? '${list.take(3).map(_base).join(', ')} +${list.length - 3}' : list.map(_base).join(', ');
    }
  }
  return null;
}

String? _firstLine(String? s, [int max = 90]) {
  if (s == null) return null;
  for (final l in s.split('\n')) {
    final t = l.trim();
    if (t.isNotEmpty) return t.length > max ? '${t.substring(0, max - 1)}…' : t;
  }
  return null;
}

/// 测试通过数 (npm test / pytest / go test / jest 的常见写法), 取最后一次出现
int? _passedCount(String? out) {
  if (out == null) return null;
  /* python unittest: 「Ran 4 tests in 0.000s ⏎ OK」—— 只有 OK 才算全过 */
  final ran = RegExp(r'Ran (\d+) tests? in [\d.]+s\s*\n\s*OK\b').allMatches(out).lastOrNull;
  if (ran != null) return int.tryParse(ran.group(1)!);
  int? best;
  for (final re in [
    RegExp(r'Tests?:\s+(\d+)\s+passed'),
    RegExp(r'(\d+)\s+passed'),
    RegExp(r'(\d+)\s+passing'),
    RegExp(r'(\d+)\s+tests? passed'),
  ]) {
    for (final m in re.allMatches(out)) {
      best = int.tryParse(m.group(1)!);
    }
    if (best != null) return best;
  }
  return null;
}

int? _exitCode(TimelineEntry e) {
  final out = e.output ?? '';
  final m = RegExp(r'exit(?:ed with)?(?: code)?[:\s]+(\d+)', caseSensitive: false).firstMatch(out);
  if (m != null) return int.tryParse(m.group(1)!);
  return e.toolSuccess ? 0 : 1;
}

/// 一步的显示: 目标 (等宽?) + 右边结果 + 失败时一行错误
class StepView {
  StepView({required this.kind, required this.target, this.mono = true, this.prefix, this.result, this.resultTone = ClayTone.neutral, this.error, this.verb = ''});

  final StepKind kind;
  final String target;
  final bool mono;

  /// 目标前面的小灰字 (「搜索」「新建」「$」)
  final String? prefix;
  final String? result;
  final ClayTone resultTone;
  final String? error;

  /// 工作 / 对话模式下的大白话动词 (读文件 / 执行命令 …)
  final String verb;
}

/// 一次改动加了几行删了几行。新建文件 (write_file / workspace_files op=write) 算整份内容都是加的
({int adds, int dels}) editStatsOf(TimelineEntry e) {
  final st = diffLineStats(e.toolName, e.args);
  final content = e.args?['content'];
  if (st.adds == 0 && st.dels == 0 && stepKindOf(e) == StepKind.write && content is String && content.isNotEmpty) {
    return (adds: '\n'.allMatches(content.trimRight()).length + 1, dels: 0);
  }
  return st;
}

/// 命令前面的「cd 工作目录 &&」不显示 —— 每条都一样, 挤掉了真正跑的那句
String _bareCommand(String cmd) => cmd.replaceFirst(RegExp(r'^\s*cd\s+\S+\s*&&\s*'), '');

String _secs(int ms) {
  final s = (ms / 1000).round();
  if (s < 60) return tr('$s 秒');
  return tr('${s ~/ 60} 分 ${s % 60} 秒');
}

StepView stepViewOf(TimelineEntry e) {
  final k = stepKindOf(e);
  final failed = e.kind == 'tool' && !e.pending && !e.toolSuccess;
  /* 失败原因说人话: 运行时失败结果是 ToolResult 信封 (`{type:contextual,status:error,summary:…}`),
   * 直接印原文等于给用户看一段 JSON (2026-10-18 真机)。原文在点开的详情页里。 */
  String? err() => failed ? toolFailureSentence(e.output, max: 90) : null;
  switch (k) {
    case StepKind.think:
      final ms = e.thinkingDurationMs;
      return StepView(kind: k, target: ms == null ? tr('想了一下') : tr('想了 ${_secs(ms)}'), mono: false, verb: tr('思考'));
    case StepKind.text:
      return StepView(kind: k, target: _firstLine(e.text, 120) ?? '', mono: false, verb: tr('说明'));
    case StepKind.read:
      final p = _arg(e, ['path', 'file_path', 'paths', 'files']);
      return StepView(kind: k, target: p == null ? friendlyToolName(e.toolName ?? '') : (p.contains(',') ? p : _base(p)), verb: tr('读文件'), error: err());
    case StepKind.list:
      return StepView(kind: k, target: _arg(e, ['pattern', 'path']) ?? '.', verb: tr('看目录'), error: err());
    case StepKind.search:
      final q = _arg(e, ['pattern', 'query', 'q', 'keywords']) ?? '';
      final hits = (e.output ?? '').trim().isEmpty ? null : '\n'.allMatches(e.output!.trim()).length + 1;
      return StepView(kind: k, prefix: tr('搜索'), target: '"$q"', result: hits == null ? null : tr('$hits 处'), verb: tr('搜索代码'), error: err());
    case StepKind.edit:
    case StepKind.write:
      final p = _arg(e, ['path', 'file_path', 'target_file']) ?? '';
      final st = editStatsOf(e);
      final isNew = k == StepKind.write;
      return StepView(
        kind: k,
        prefix: isNew ? tr('新建') : null,
        target: p,
        result: (st.adds > 0 || st.dels > 0) ? '+${st.adds}${st.dels > 0 ? ' −${st.dels}' : ''}' : (isNew ? null : tr('内容没变')),
        verb: isNew ? tr('写文件') : tr('改文件'),
        error: err(),
      );
    case StepKind.shell:
      final cmd = _bareCommand(_arg(e, ['command', 'cmd', 'code', 'script']) ?? friendlyToolName(e.toolName ?? ''));
      final passed = _passedCount(e.output);
      final code = e.pending ? null : _exitCode(e);
      return StepView(
        kind: k,
        prefix: r'$',
        target: _firstLine(cmd, 120) ?? cmd,
        result: e.pending
            ? null
            : failed
                ? 'exit ${code ?? 1}'
                : passed != null
                    ? tr('$passed 通过')
                    : null,
        resultTone: failed ? ClayTone.red : (passed != null ? ClayTone.green : ClayTone.neutral),
        verb: tr('执行命令'),
        error: err(),
      );
    case StepKind.webSearch:
      final q = _arg(e, ['query', 'q']) ?? '';
      final n = RegExp(r'https?://').allMatches(e.output ?? '').length;
      return StepView(kind: k, target: q, mono: false, result: n > 0 ? tr('$n 条') : null, verb: tr('联网搜索'), error: err());
    case StepKind.webFetch:
      final url = _arg(e, ['url']) ?? '';
      final host = Uri.tryParse(url)?.host ?? url;
      return StepView(kind: k, target: host.isEmpty ? url : host, mono: false, verb: tr('打开网页'), error: err());
    case StepKind.image:
      return StepView(kind: k, target: _arg(e, ['prompt']) ?? tr('出图'), mono: false, verb: tr('出图'), error: err());
    case StepKind.plan:
      return StepView(kind: k, target: tr('更新计划'), mono: false, verb: tr('计划'));
    case StepKind.ask:
      return StepView(kind: k, target: _arg(e, ['question', 'prompt']) ?? tr('问你'), mono: false, verb: tr('提问'));
    case StepKind.phone:
      return StepView(kind: k, target: smartArgSummary(e.toolName ?? '', e.args) ?? friendlyToolName(e.toolName ?? ''), mono: false, verb: tr('操作手机'), error: err());
    case StepKind.browser:
      return StepView(kind: k, target: smartArgSummary(e.toolName ?? '', e.args) ?? friendlyToolName(e.toolName ?? ''), mono: false, verb: tr('浏览器'), error: err());
    case StepKind.mcp:
      final raw = e.toolName ?? '';
      final parts = raw.split('__').where((s) => s.isNotEmpty && s != 'mcp').toList();
      final name = parts.length >= 2 ? '${parts[parts.length - 2]}/${parts.last}' : raw;
      return StepView(kind: k, target: name, result: _firstLine(e.output, 24), verb: 'MCP', error: err());
    case StepKind.memory:
      return StepView(kind: k, target: smartArgSummary(e.toolName ?? '', e.args) ?? tr('记住了'), mono: false, verb: tr('记忆'), error: err());
    case StepKind.other:
      final name = friendlyToolName(e.toolName ?? tr('操作'));
      final sum = smartArgSummary(e.toolName ?? '', e.args);
      return StepView(kind: k, target: sum == null ? name : '$name · $sum', mono: false, verb: name, error: err());
  }
}

// ════════════════════════════════════════════════════════════════
//  摘要行的一句话
// ════════════════════════════════════════════════════════════════

/// 一条的发生时刻。量时长用 timestamp (同一会话同一个钟) —— createdAtMs 是本地建出来的时刻,
/// 重开会话从库里读回来时整轮都是同一刻, 拿它算用时全是 0。
int entryTimeMs(TimelineEntry e) => e.timestamp > 0 ? e.timestamp : e.createdAtMs;

/// 这一轮过程用了多久 (第一条过程到最后一条; 跑着时到现在)
int processDurationMs(ProcessRenderItem p) {
  final startMs = entryTimeMs(p.entries.first);
  if (p.anyRunning) return DateTime.now().millisecondsSinceEpoch - startMs;
  return (entryTimeMs(p.entries.last) - startMs).clamp(0, 24 * 3600 * 1000);
}

int processStepCount(ProcessRenderItem p) =>
    p.tools.length + p.thinkings.where((t) => (t.thinking ?? t.text ?? '').trim().isNotEmpty).length;

String processSummary(ProcessRenderItem p, TimelineMode mode) {
  final tools = p.tools;
  final reads = <String>{};
  final edited = <String>{};
  var searches = 0, web = 0, cmds = 0;
  int? passed;
  for (final t in tools) {
    final k = stepKindOf(t);
    switch (k) {
      case StepKind.read:
        reads.add(_arg(t, ['path', 'file_path']) ?? t.id);
      case StepKind.edit:
      case StepKind.write:
        if (t.toolSuccess) edited.add(_arg(t, ['path', 'file_path', 'target_file']) ?? t.id);
      case StepKind.search:
        searches++;
      case StepKind.webSearch:
        web += RegExp(r'https?://').allMatches(t.output ?? '').length.clamp(1, 99);
      case StepKind.shell:
        cmds++;
        passed = _passedCount(t.output) ?? passed;
      default:
        break;
    }
  }
  final thinkMs = p.thinkings.fold<int>(0, (s, t) => s + (t.thinkingDurationMs ?? 0));
  final steps = processStepCount(p);
  final dur = processDurationMs(p);
  final sep = isEnglishUi ? ' · ' : ' · ';
  switch (mode) {
    case TimelineMode.code:
      if (p.anyRunning) {
        return [
          tr('已做 $steps 步'),
          if (reads.isNotEmpty) tr('读 ${reads.length} 个文件'),
          if (edited.isNotEmpty) tr('改 ${edited.length} 个文件'),
          if (reads.isEmpty && edited.isEmpty && searches > 0) tr('搜 $searches 次'),
        ].join(sep);
      }
      return [
        tr('$steps 步'),
        if (dur >= 1000) _secs(dur),
        if (edited.isNotEmpty) tr('改 ${edited.length} 个文件'),
        if (passed != null) tr('测试 $passed 通过') else if (edited.isEmpty && cmds > 0) tr('跑了 $cmds 条命令'),
      ].join(sep);
    case TimelineMode.work:
      if (p.anyRunning) return [tr('已做 $steps 步'), if (dur >= 1000) _secs(dur)].join(sep);
      return [
        tr('$steps 步'),
        if (dur >= 1000) _secs(dur),
        if (edited.isNotEmpty) tr('做了 ${edited.length} 个文件') else if (reads.isNotEmpty) tr('读了 ${reads.length} 个文件') else if (web > 0) tr('查了 $web 个网页'),
      ].join(sep);
    case TimelineMode.chat:
      final parts = <String>[
        if (web > 0) tr('搜了 $web 个网页'),
        if (thinkMs >= 1000) tr('想了 ${_secs(thinkMs)}') else if (p.thinkings.isNotEmpty && tools.isEmpty) tr('想了一下'),
        if (web == 0 && tools.isNotEmpty) tr('用了 ${tools.length} 个工具'),
      ];
      return parts.isEmpty ? tr('$steps 步') : parts.join(sep);
  }
}

/// 编码模式一段工具的摘要, 对齐桌面那一行: 「编辑 a.py 等 2 个 · 运行 1 条命令」。
/// 加减行数 / 步数 / 用时由头行另外画在右边。
String codeDigest(ProcessRenderItem p) {
  final order = <StepKind>[];
  final files = <StepKind, List<String>>{};
  final counts = <StepKind, int>{};
  String? firstQuery;
  for (final t in p.tools) {
    var k = stepKindOf(t);
    if (k == StepKind.write) k = StepKind.edit;
    if (!order.contains(k)) order.add(k);
    counts[k] = (counts[k] ?? 0) + 1;
    final path = _arg(t, ['path', 'file_path', 'target_file']);
    if (path != null) {
      final l = files[k] ??= [];
      if (!l.contains(path)) l.add(path);
    }
    if (k == StepKind.search) firstQuery ??= _arg(t, ['pattern', 'query', 'q']);
  }
  String part(StepKind k) {
    final n = counts[k]!;
    final fs = files[k] ?? const <String>[];
    /* verb 用中文原字拼好整句再 tr, 英文模板 (en_strings 「编辑 {} 等 {} 个」…) 才对得上 */
    String named(String verb) => tr(fs.isEmpty
        ? '$verb $n 个文件'
        : fs.length == 1
            ? '$verb ${_base(fs.first)}'
            : '$verb ${_base(fs.first)} 等 ${fs.length} 个');
    return switch (k) {
      StepKind.edit => named('编辑'),
      StepKind.read => named('读取'),
      StepKind.shell => tr('运行 $n 条命令'),
      StepKind.search => tr(firstQuery == null ? '搜索 $n 次' : '搜索 "$firstQuery"${n > 1 ? ' ×$n' : ''}'),
      StepKind.list => tr('看目录'),
      StepKind.webSearch => tr('联网搜索 $n 次'),
      StepKind.webFetch => tr('打开 $n 个网页'),
      _ => n > 1 ? '${stepViewOf(p.tools.firstWhere((t) => stepKindOf(t) == k)).verb} ×$n' : stepViewOf(p.tools.firstWhere((t) => stepKindOf(t) == k)).verb,
    };
  }

  if (order.isEmpty) {
    final ms = p.thinkings.fold<int>(0, (s, t) => s + (t.thinkingDurationMs ?? 0));
    return ms >= 1000 ? tr('思考了 ${_secs(ms)}') : tr('思考了一下');
  }
  final parts = order.take(2).map(part).toList();
  return order.length > 2 ? '${parts.join(' · ')} …' : parts.join(' · ');
}

// ════════════════════════════════════════════════════════════════
//  过程行
// ════════════════════════════════════════════════════════════════

/// 点开 / 收起时让被点的那一行钉在原地, 内容往下长。
///
/// 时间线是倒着排的 (最新在底, 底边是锚): 内容一长, 这一行就被往上顶, 展开的那一截从屏幕顶上出去,
/// 眼前只剩步骤的末尾 (2026-10-14 录屏)。动画期间每帧量一下这一行挪了多少, 把列表反向补回去。
void keepRowInPlace(BuildContext? ctx, {Duration span = const Duration(milliseconds: 320)}) {
  if (ctx == null || !ctx.mounted) return;
  final pos = Scrollable.maybeOf(ctx)?.position;
  final box = ctx.findRenderObject();
  if (pos == null || box is! RenderBox || !box.attached) return;
  final y0 = box.localToGlobal(Offset.zero).dy;
  final sign = pos.axisDirection == AxisDirection.up ? -1.0 : 1.0;
  final until = DateTime.now().add(span);
  void tick(Duration _) {
    if (!box.attached || DateTime.now().isAfter(until)) return;
    final dy = box.localToGlobal(Offset.zero).dy - y0;
    if (dy.abs() > 0.5) {
      pos.jumpTo((pos.pixels + sign * dy).clamp(pos.minScrollExtent, pos.maxScrollExtent));
    }
    WidgetsBinding.instance.addPostFrameCallback(tick);
    WidgetsBinding.instance.scheduleFrame();
  }

  WidgetsBinding.instance.addPostFrameCallback(tick);
}

/// 这一轮过程的代表性图标 (步数最多的那一类) —— 头行左边那颗细图标.
/// 全是思考 / 说明时用思考图标.
IconData _leadIcon(ProcessRenderItem p) {
  final counts = <StepKind, int>{};
  for (final e in p.entries) {
    final k = stepKindOf(e);
    if (k == StepKind.think || k == StepKind.text) continue;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  if (counts.isEmpty) return Icons.psychology_outlined;
  return stepIcon((counts.entries.toList()..sort((a, b) => b.value - a.value)).first.key);
}

class ProcessRow extends StatefulWidget {
  const ProcessRow({super.key, required this.process, required this.mode, this.sessionId, this.plan});

  final ProcessRenderItem process;
  final TimelineMode mode;
  final String? sessionId;

  /// 工作模式跑着时的计划 (有就画计划块代替摘要行)
  final PlanCardState? plan;

  @override
  State<ProcessRow> createState() => _ProcessRowState();
}

class _ProcessRowState extends State<ProcessRow> {
  bool _open = false;
  Timer? _tick;
  final _headKey = GlobalKey();

  void _toggle() {
    keepRowInPlace(_headKey.currentContext);
    setState(() => _open = !_open);
  }

  @override
  void initState() {
    super.initState();
    _syncTick();
  }

  @override
  void didUpdateWidget(ProcessRow old) {
    super.didUpdateWidget(old);
    _syncTick();
  }

  /* 跑着的时候每秒刷一次 (摘要里的用时 / 当前一步的秒数) */
  void _syncTick() {
    if (widget.process.anyRunning) {
      _tick ??= Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else {
      _tick?.cancel();
      _tick = null;
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  /// 这一轮所有联网搜索的来源, 按链接去重
  List<SearchHit> _hits(ProcessRenderItem p) {
    final seen = <String>{};
    return [
      for (final e in p.tools)
        if (e.toolName == 'web_search' && e.toolSuccess && (e.output ?? '').isNotEmpty)
          for (final h in parseWebSearchOutput(e.output!))
            if (h.url.isNotEmpty && seen.add(h.url)) h,
    ];
  }

  /// 这一轮做出了图片以外的文件
  List<String> _toolImages(ProcessRenderItem p) {
    final seen = <String>{};
    return [
      for (final e in p.tools)
        for (final n in neoxImageNamesIn(e.output))
          if (seen.add(n)) n,
    ];
  }

  bool _docMade(ProcessRenderItem p) => p.tools.any((e) => e.artifacts?.any((a) => !isImageArtifact(a)) ?? false);

  List<Map<String, dynamic>> _images(ProcessRenderItem p) => [
        for (final e in p.tools)
          for (final a in e.artifacts ?? const <Map<String, dynamic>>[])
            if (isImageArtifact(a)) a,
      ];

  void _openStep(TimelineEntry e) {
    if (e.kind != 'tool') return;
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => StepDetailPage(entry: e)));
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final p = widget.process;
    final running = p.anyRunning;
    final mode = widget.mode;
    final isCode = mode == TimelineMode.code;
    final summary = isCode ? codeDigest(p) : processSummary(p, mode);
    /* 编码模式右边跟桌面一样挂「+50 −3   3 步  16s」 */
    var adds = 0, dels = 0;
    if (isCode) {
      for (final t in p.tools) {
        final k = stepKindOf(t);
        if ((k == StepKind.edit || k == StepKind.write) && t.toolSuccess) {
          final st = editStatsOf(t);
          adds += st.adds;
          dels += st.dels;
        }
      }
    }
    final steps = isCode ? processStepCount(p) : 0;
    final durMs = isCode ? processDurationMs(p) : 0;
    final failed = p.tools.where((e) => !e.pending && !e.toolSuccess).toList();
    final live = running ? p.tools.where((e) => e.pending).lastOrNull : null;
    final plan = widget.plan;
    final showPlan = mode == TimelineMode.work && running && plan != null && plan.steps.isNotEmpty;

    /* 折叠头 = **整宽**的一行过程, 不是贴内容宽的胶囊 (2026-10-18 用户真机:
     * 「3 步 · 10 秒 ›」那种小胶囊难看, 紧跟着还有一行「用了 1 个工具 · 想了 1 秒 ›」说同一件事)。
     * 所以: 跟正文同宽同一条左线、低对比文字、左边一颗细图标, 没有底色没有圆角没有描边 ——
     * 控件风格跟客户端设置页一致 (平)。一段过程只出这一行汇总, 展开在它下面。 */
    final head = InkWell(
      key: _headKey,
      onTap: _toggle,
      borderRadius: NeoxRadius.smallR,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Icon(_leadIcon(p), size: 15, color: failed.isNotEmpty ? c.redInk : c.faint),
            const SizedBox(width: NeoxIndent.gap),
            Expanded(
              child: ShimmerText(
                summary,
                active: running,
                maxLines: 1,
                style: TextStyle(fontSize: 13, height: 1.3, color: c.grey),
              ),
            ),
            if (adds > 0) ...[const SizedBox(width: 6), Text('+$adds', style: TextStyle(fontSize: 12, color: c.greenInk, fontWeight: FontWeight.w600))],
            if (dels > 0) ...[const SizedBox(width: 4), Text('−$dels', style: TextStyle(fontSize: 12, color: c.redInk, fontWeight: FontWeight.w600))],
            if (failed.isNotEmpty) ...[
              const SizedBox(width: 6),
              Text(tr('有失败'), style: TextStyle(fontSize: 12, color: c.redInk, fontWeight: FontWeight.w600)),
            ],
            if (isCode && steps > 1) ...[const SizedBox(width: 6), Text(tr('$steps 步'), style: TextStyle(fontSize: 12, color: c.faint))],
            if (isCode && durMs >= 1000) ...[
              const SizedBox(width: 6),
              Text('${(durMs / 1000).toStringAsFixed(durMs < 60000 ? 1 : 0)}s', style: TextStyle(fontSize: 12, color: c.faint, fontFeatures: const [FontFeature.tabularFigures()])),
            ],
            const SizedBox(width: 2),
            AnimatedRotation(
              turns: _open ? 0.25 : 0,
              duration: const Duration(milliseconds: 160),
              child: Icon(Icons.chevron_right_rounded, size: 17, color: c.faint),
            ),
          ],
        ),
      ),
    );

    return Padding(
      /* 左边跟正文同一条线 (gutter), 右边同宽 —— 用户要的是「跟正文同宽的过程行」 */
      padding: const EdgeInsets.fromLTRB(NeoxIndent.gutter, 2, NeoxIndent.gutter, 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (showPlan) PlanBlock(plan: plan) else head,
          /* 展开 / 收起: 高度 220ms 缓动 + 内容淡入, 不是一下子蹦出来一大段 */
          ClipRect(
            child: AnimatedSize(
              duration: const Duration(milliseconds: 220),
              curve: Curves.easeOutCubic,
              alignment: Alignment.topCenter,
              child: !_open
                  ? const SizedBox(width: double.infinity)
                  : TweenAnimationBuilder<double>(
                      tween: Tween(begin: 0, end: 1),
                      duration: const Duration(milliseconds: 220),
                      builder: (context, t, child) => Opacity(opacity: t, child: child),
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: _ProcessBody(entries: p.entries, mode: mode, onTap: _openStep),
                      ),
                    ),
            ),
          ),
          if (!_open && live != null) _LiveStep(entry: live, mode: mode, onTap: () => _openStep(live)),
          if (!_open && live == null && running && !p.answering && (mode != TimelineMode.work || thinkingText(p) != null))
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [const ClaySpinner(size: 12), const SizedBox(width: 8), ShimmerText(tr('思考中'), active: true, style: TextStyle(fontSize: 13.5, color: c.grey))]),
                  if (thinkingText(p) case final t?) Padding(padding: const EdgeInsets.only(left: 20, top: 6), child: ThinkingTicker(text: t)),
                ],
              ),
            ),
          if (!_open)
            for (final f in failed) _FailedStep(entry: f, mode: mode, onTap: () => _openStep(f)),
          /* 做出来的文件和搜到的来源放在折叠外面, 永远可见 —— 那是这一轮真正交付的东西。
           * 这一轮有文档类成品 (PPT / 表格 / 文档) 时, 图只是它用的素材: 收成一排小缩略图放在成品卡上面 */
          if (_docMade(p) && _images(p).isNotEmpty) ArtifactThumbRow(artifacts: _images(p)),
          /* 工具输出里的图 (截图 / 看过的图, 电脑发来时已换成 neox-image 引用) —— 单独一条工具时 message_row 会露出来,
           * 收进过程行后原来就看不到了 (2026-10-22)。跟成品一样放在折叠外面。 */
          if (_toolImages(p).isNotEmpty) NeoxImageStrip(names: _toolImages(p)),
          for (final e in p.tools)
            if (e.artifacts != null && e.artifacts!.isNotEmpty) ArtifactStrip(entry: e, skipImages: _docMade(p)),
          if (mode != TimelineMode.code && !running && _hits(p).isNotEmpty) SourcesRow(hits: _hits(p)),
          if (mode != TimelineMode.code)
            for (final e in p.tools)
              if (e.toolName != 'web_search')
                if (toolResultCardFor(e) case final card?) card,
        ],
      ),
    );
  }
}

/// 正在流的那段思考 (没有就 null)
String? thinkingText(ProcessRenderItem p) {
  for (final t in p.thinkings.reversed) {
    if (!t.streaming) continue;
    final s = (t.thinking ?? t.text ?? '').trim();
    if (s.isNotEmpty) return s;
  }
  return null;
}

/// 思维链滚动: 固定三行高, 字从底下长出来, 旧行往上推出去、顶上渐隐 (淡字, 不加框).
/// 2026-10-14 用户: 「思考的时候那个思维链的一种滚动动画」。想完收成摘要里的「想了 N 秒」。
class ThinkingTicker extends StatelessWidget {
  const ThinkingTicker({super.key, required this.text, this.lines = 3});
  final String text;
  final int lines;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    const size = 13.0, lh = 1.5;
    /* 只留尾巴 (再长也只画最后一截, 不重排几千字) */
    final tail = text.length > 600 ? text.substring(text.length - 600) : text;
    return SizedBox(
      height: size * lh * lines,
      child: ShaderMask(
        shaderCallback: (r) => const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color(0x00FFFFFF), Color(0xFFFFFFFF)],
          stops: [0, 0.55],
        ).createShader(r),
        blendMode: BlendMode.dstIn,
        child: ClipRect(
          child: OverflowBox(
            alignment: Alignment.bottomLeft,
            maxHeight: double.infinity,
            child: AnimatedSize(
              duration: const Duration(milliseconds: 180),
              curve: Curves.easeOut,
              alignment: Alignment.bottomLeft,
              child: Text(
                tail.replaceAll(RegExp(r'\n{2,}'), '\n'),
                style: TextStyle(fontSize: size, height: lh, color: c.grey, fontStyle: FontStyle.italic),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 正在跑的那一步: 转圈 + 目标 + 秒数; 下面两行灰色输出尾巴 (不加框).
class _LiveStep extends StatelessWidget {
  const _LiveStep({required this.entry, required this.mode, required this.onTap});

  final TimelineEntry entry;
  final TimelineMode mode;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final v = stepViewOf(entry);
    final startMs = entryTimeMs(entry);
    final secs = ((DateTime.now().millisecondsSinceEpoch - startMs) / 1000).floor().clamp(0, 99999);
    final tail = (entry.liveOutput ?? '').trimRight().split('\n').where((l) => l.trim().isNotEmpty).toList();
    final mono = TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12.5, color: c.ink, height: 1.4);
    final label = mode == TimelineMode.code
        ? '${v.prefix != null && v.prefix != tr('新建') ? '${v.prefix} ' : ''}${v.target}'
        /* 整句一起翻: 单翻「正在」会命中模板「正在{}」→「…」, 英文界面开头变成「…联网搜索」 */
        : '${isEnglishUi ? tr(v.verb) : '正在${v.verb}'} · ${v.target}';
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const ClaySpinner(size: 13),
                const SizedBox(width: 9),
                Expanded(
                  child: ShimmerText(label,
                      active: true,
                      style: mode == TimelineMode.code && v.mono ? mono.copyWith(fontSize: 13) : TextStyle(fontSize: 13.5, color: c.ink)),
                ),
                const SizedBox(width: 8),
                Text('${secs}s', style: TextStyle(fontSize: 12, color: c.grey)),
              ],
            ),
            if (tail.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 22, top: 4),
                child: Text(
                  tail.length > 2 ? tail.sublist(tail.length - 2).join('\n') : tail.join('\n'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: mono.copyWith(color: c.grey, fontSize: 12),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 失败的一步 —— 不用点就露出来: 目标 + exit 签, 下面一行淡红底的错误.
class _FailedStep extends StatelessWidget {
  const _FailedStep({required this.entry, required this.mode, required this.onTap});

  final TimelineEntry entry;
  final TimelineMode mode;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final v = stepViewOf(entry);
    final mono = TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12.5, color: c.ink);
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 8),
      child: ClaySlab(
        onTap: onTap,
        padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                if (v.prefix != null) ...[Text(v.prefix!, style: mono.copyWith(color: c.grey)), const SizedBox(width: 6)],
                Expanded(child: Text(v.target, maxLines: 1, overflow: TextOverflow.ellipsis, style: v.mono ? mono : TextStyle(fontSize: 13.5, color: c.ink))),
                ClayChip(label: v.result ?? tr('失败'), tone: ClayTone.red, dense: true),
              ],
            ),
            if (v.error != null) ...[
              const SizedBox(height: 8),
              ClayWell(
                color: c.redSoft,
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                /* 人话用正文字体, 不是等宽 —— 等宽族里没有中文字形, 真机上这行会变方块 */
                child: Text(
                  v.error!,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, height: 1.4, color: c.redInk),
                ),
              ),
              /* 摘要只说一句人话; 原始输出 (那段 contextual JSON) 在点开的详情页里 */
              const SizedBox(height: 6),
              Text(tr('点开看完整输出'), style: TextStyle(fontSize: 11, color: c.faint)),
            ],
          ],
        ),
      ),
    );
  }
}

/// 展开后的过程: 它说的话是正文段落; 工具 / 思考按时间一步一行.
///
/// 2026-10-18 用户真机: 展开后又是一行可点的「跑了 1 条命令 · 读了 1 个文件 ›」,
/// 跟外面那行汇总说的是同一件事, 还得再点一次才看得到东西。这里**不再套第二层** ——
/// 点过程行就是最终形态: 每一步一行 (工具名 + 一句话结果), 思考给原文。
class _ProcessBody extends StatelessWidget {
  const _ProcessBody({required this.entries, required this.mode, required this.onTap});

  final List<TimelineEntry> entries;
  final TimelineMode mode;
  final ValueChanged<TimelineEntry> onTap;

  static bool _empty(TimelineEntry e) => switch (e.kind) {
        'agent_text' => (e.text ?? '').trim().isEmpty,
        'agent_thinking' => (e.thinking ?? e.text ?? '').trim().isEmpty,
        _ => false,
      };

  @override
  Widget build(BuildContext context) {
    final parts = <Widget>[];
    var run = <TimelineEntry>[];
    void flush() {
      if (run.isEmpty) return;
      final r = run;
      run = [];
      parts.add(mode == TimelineMode.code ? _CodeLog(entries: r, onTap: onTap) : _StepTiles(entries: r, onTap: onTap));
    }

    for (final e in entries) {
      if (_empty(e)) continue;
      if (e.kind == 'agent_text') {
        flush();
        parts.add(Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: MarkdownView(data: e.text ?? '')));
      } else {
        run.add(e);
      }
    }
    flush();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: parts);
  }
}

/// 一步的「一句话结果」—— 有结构化结果签 (改动行数 / 搜索命中 / 退出码) 就用它,
/// 没有就从工具输出里取第一句 (读文件 / 浏览器这类)。失败时由调用方画红字原因, 这里不给。
String? _stepResultLine(TimelineEntry e, StepKind k) {
  if (e.pending || !e.toolSuccess) return null;
  /* 这些步的「结果」就是 target 本身 / 已经在 result 里, 输出第一行是文件内容或代码, 别塞进来 */
  if (k == StepKind.read || k == StepKind.list || k == StepKind.edit || k == StepKind.write || k == StepKind.search) {
    return null;
  }
  return firstLineSummary(e.output, max: 60);
}

/// 一步思考的展开样子: 一行「思考 · N 秒」+ 原文 (低对比斜体, 不加框).
///
/// 2026-10-18 用户真机: 「想了 N 秒」点了展不开、看不到思考内容 —— 摘要行只给秒数,
/// 原文在这里给全 (跟编码日志同一条左边线, 不再套卡片).
class _ThinkingBlock extends StatelessWidget {
  const _ThinkingBlock({required this.entry, this.iconSize = 13});

  final TimelineEntry entry;
  final double iconSize;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final body = (entry.thinking ?? entry.text ?? '').trim();
    final v = stepViewOf(entry);
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(Icons.psychology_outlined, size: iconSize, color: c.faint),
            const SizedBox(width: 6),
            Text(v.target, style: TextStyle(fontSize: 12, color: c.faint)),
          ]),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(body, style: TextStyle(fontSize: 13, height: 1.45, color: c.grey, fontStyle: FontStyle.italic)),
          ],
        ],
      ),
    );
  }
}

/// 编码模式展开: 一步一行的纯文字日志. 没有动词列、没有图标, 每行从同一条左边线起.
class _CodeLog extends StatelessWidget {
  const _CodeLog({required this.entries, required this.onTap});

  final List<TimelineEntry> entries;
  final ValueChanged<TimelineEntry> onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final mono = TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12.8, color: c.ink, height: 1.3);
    final rows = <Widget>[];
    /* 连读多个文件合成一行 (login.ts, handler.ts, auth.ts +1) */
    final merged = <List<TimelineEntry>>[];
    for (final e in entries) {
      final k = stepKindOf(e);
      if (k == StepKind.text && (e.text ?? '').trim().isEmpty) continue;
      if (k == StepKind.think && (e.thinking ?? e.text ?? '').trim().isEmpty) continue;
      if (merged.isNotEmpty &&
          k == StepKind.read &&
          stepKindOf(merged.last.last) == StepKind.read &&
          merged.last.every((x) => x.toolSuccess && !x.pending) &&
          e.toolSuccess &&
          !e.pending) {
        merged.last.add(e);
      } else {
        merged.add([e]);
      }
    }
    for (var i = 0; i < merged.length; i++) {
      final group = merged[i];
      final e = group.first;
      /* 它中途说的话是正文, 不是一行「说明」(2026-10-14 用户: 说话被当成了说明): 整段照常排, 不截断 */
      if (e.kind == 'agent_text') {
        rows.add(Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: MarkdownView(data: e.text ?? '')));
        continue;
      }
      /* 思考给原文 —— 摘要行只说了「想了 N 秒」, 点开就得看得到它想了什么 (2026-10-18 真机) */
      if (e.kind == 'agent_thinking') {
        rows.add(_ThinkingBlock(entry: e));
        continue;
      }
      final v = stepViewOf(e);
      final target = group.length == 1
          ? v.target
          : () {
              final names = group.map((x) => stepViewOf(x).target).toList();
              return names.length > 3 ? '${names.take(3).join(', ')}  +${names.length - 3}' : names.join(', ');
            }();
      final failed = e.kind == 'tool' && !e.pending && !e.toolSuccess;
      final isThinkOrText = v.kind == StepKind.think || v.kind == StepKind.text;
      /* 这一步的一句话结果: 有结构化结果签就用它; 没有 (读文件 / 浏览器这类) 取输出的第一句,
       * 用户点开过程行要看到「做了什么 + 结果」, 不是只有路径 (2026-10-18 真机)。 */
      final resultLine = v.result ?? _stepResultLine(e, v.kind);
      rows.add(InkWell(
        onTap: e.kind == 'tool' ? () => onTap(e) : null,
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 30),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              children: [
                /* 工具名 —— 展开后每一步要认得是哪个工具干的 */
                if (e.kind == 'tool') ...[
                  Text(
                    friendlyToolName(e.toolName ?? ''),
                    style: TextStyle(fontSize: 11.5, color: c.faint),
                  ),
                  const SizedBox(width: 8),
                ],
                if (v.prefix != null) ...[
                  Text(v.prefix!, style: (v.prefix == r'$' ? mono : const TextStyle(fontSize: 12)).copyWith(color: c.grey)),
                  const SizedBox(width: 6),
                ],
                Expanded(
                  child: Text(
                    target,
                    maxLines: isThinkOrText ? 2 : 1,
                    overflow: TextOverflow.ellipsis,
                    style: isThinkOrText
                        ? TextStyle(fontSize: 13, color: c.grey, fontStyle: v.kind == StepKind.think ? FontStyle.italic : FontStyle.normal, height: 1.35)
                        : (v.mono ? mono : TextStyle(fontSize: 13, color: c.ink)),
                  ),
                ),
                if (e.pending) ...[const SizedBox(width: 8), const ClaySpinner(size: 11)],
                if (resultLine != null) ...[
                  const SizedBox(width: 8),
                  _ResultTag(
                    text: resultLine,
                    tone: v.result != null ? v.resultTone : ClayTone.neutral,
                    edit: v.kind == StepKind.edit || v.kind == StepKind.write,
                  ),
                ],
                if (failed && resultLine == null) ...[const SizedBox(width: 8), ClayChip(label: tr('失败'), tone: ClayTone.red, dense: true)],
              ],
            ),
          ),
        ),
      ));
      if (failed && v.error != null) {
        rows.add(Padding(
          padding: const EdgeInsets.only(left: 12, bottom: 4),
          child: Text('↳ ${v.error}', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, height: 1.4, color: c.redInk)),
        ));
      }
      if (i < merged.length - 1) rows.add(Container(height: 0.6, color: c.hairline));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
  }
}

/// 右边那颗结果: 改动 = 绿 +N / 红 −M 两颗小签; 其它是灰字或彩色签
class _ResultTag extends StatelessWidget {
  const _ResultTag({required this.text, required this.tone, required this.edit});

  final String text;
  final ClayTone tone;
  final bool edit;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    if (edit && text.startsWith('+')) {
      final parts = text.split(' ');
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final p in parts) ...[
            ClayChip(label: p, tone: p.startsWith('+') ? ClayTone.green : ClayTone.red, dense: true),
            const SizedBox(width: 4),
          ],
        ],
      );
    }
    if (tone != ClayTone.neutral) return ClayChip(label: text, tone: tone, dense: true);
    return Text(text, style: TextStyle(fontSize: 12, color: c.grey));
  }
}

/// 工作 / 对话模式展开: 带陶土方块图标的步骤行 (大白话动词 + 灰字目标 + 结果)
class _StepTiles extends StatelessWidget {
  const _StepTiles({required this.entries, required this.onTap});

  final List<TimelineEntry> entries;
  final ValueChanged<TimelineEntry> onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final steps = entries.where((e) {
      if (e.kind == 'agent_thinking') return (e.thinking ?? e.text ?? '').trim().isNotEmpty;
      if (e.kind == 'agent_text') return (e.text ?? '').trim().isNotEmpty;
      return true;
    }).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final e in steps)
          Builder(builder: (_) {
            /* 中途说的话 = 正文段落, 不是「说明」那一行 (跟编码模式同一条规矩) */
            if (e.kind == 'agent_text') {
              return Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: MarkdownView(data: e.text ?? ''));
            }
            /* 思考原文 (跟编码模式同一个块) */
            if (e.kind == 'agent_thinking') return _ThinkingBlock(entry: e, iconSize: 15);
            final v = stepViewOf(e);
            final failed = e.kind == 'tool' && !e.pending && !e.toolSuccess;
            return InkWell(
              onTap: e.kind == 'tool' ? () => onTap(e) : null,
              borderRadius: BorderRadius.circular(10),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    ClayTile(
                      icon: stepIcon(v.kind),
                      size: 28,
                      bead: e.pending ? c.cobalt : (failed ? c.red : null),
                    ),
                    const SizedBox(width: 12),
                    Text(v.verb, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.ink)),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(v.target, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: c.grey)),
                    ),
                    if (e.pending) const ClaySpinner(size: 12),
                    if (v.result != null) ...[const SizedBox(width: 6), _ResultTag(text: v.result!, tone: v.resultTone, edit: v.kind == StepKind.edit || v.kind == StepKind.write)],
                  ],
                ),
              ),
            );
          }),
      ],
    );
  }
}

/// 工作模式跑着时的计划块: 每步一句大白话. 做完 = 细勾灰字; 正在做 = 钴蓝点 + 加粗; 没开始 = 只有灰字.
class PlanBlock extends StatelessWidget {
  const PlanBlock({super.key, required this.plan});

  final PlanCardState plan;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 6),
      child: ClaySlab(
        padding: const EdgeInsets.fromLTRB(16, 12, 14, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(tr('执行计划'), style: TextStyle(fontSize: 13, color: c.grey, fontWeight: FontWeight.w500)),
            const SizedBox(height: 4),
            for (final s in plan.steps)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 7),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 20,
                      child: Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: switch (s.status) {
                          'completed' => Icon(Icons.check_rounded, size: 15, color: c.grey),
                          'in_progress' => ClayDot(color: c.cobalt, size: 9),
                          _ => const SizedBox.shrink(),
                        },
                      ),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        s.step,
                        style: TextStyle(
                          fontSize: 14.5,
                          height: 1.35,
                          color: s.status == 'in_progress' ? c.ink : c.grey,
                          fontWeight: s.status == 'in_progress' ? FontWeight.w600 : FontWeight.w400,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  编码模式回答后面的改动文件签
// ════════════════════════════════════════════════════════════════

class FilesFooterRow extends StatelessWidget {
  const FilesFooterRow({super.key, required this.item});

  final FilesFooterRenderItem item;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final byFile = <String, List<TimelineEntry>>{};
    for (final e in item.edits) {
      final p = _arg(e, ['path', 'file_path', 'target_file']) ?? '?';
      (byFile[p] ??= []).add(e);
    }
    final mono = TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12.5, color: c.ink);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 2, 16, 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final f in byFile.entries)
            Builder(builder: (context) {
              final st = f.value.map(editStatsOf).fold((adds: 0, dels: 0), (a, s) => (adds: a.adds + s.adds, dels: a.dels + s.dels));
              return GestureDetector(
                onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
                  builder: (_) => FileDiffPage(path: f.key, edits: f.value, allFiles: byFile),
                )),
                child: Container(
                  height: 32,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    color: c.fill,
                    boxShadow: clayShadow(c, lift: 0.4),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.description_outlined, size: 14, color: c.grey),
                      const SizedBox(width: 6),
                      Text(_base(f.key), style: mono),
                      const SizedBox(width: 6),
                      if (st.adds > 0) Text('+${st.adds}', style: TextStyle(fontSize: 12, color: c.greenInk, fontWeight: FontWeight.w600)),
                      if (st.dels > 0) ...[const SizedBox(width: 4), Text('−${st.dels}', style: TextStyle(fontSize: 12, color: c.redInk, fontWeight: FontWeight.w600))],
                    ],
                  ),
                ),
              );
            }),
        ],
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  全屏: 看改动 / 一步的详情
// ════════════════════════════════════════════════════════════════

/// 统一 diff 的一行
typedef _DiffLine = ({String sign, String text, int? oldNo, int? newNo});

List<_DiffLine> _diffOf(TimelineEntry e) {
  final args = e.args ?? const {};
  final n = (e.toolName ?? '').toLowerCase();
  if (n == 'write_file' || n == 'write_neox_config' || n == 'create_file' || stepKindOf(e) == StepKind.write) {
    final content = (args['content'] ?? args['text'] ?? '').toString().trimRight();
    final lines = content.split('\n');
    return [for (var i = 0; i < lines.length; i++) (sign: '+', text: lines[i], oldNo: null, newNo: i + 1)];
  }
  final oldS = (args['old_string'] ?? args['old'] ?? '').toString();
  final newS = (args['new_string'] ?? args['new'] ?? '').toString();
  final patch = (args['patch'] ?? args['diff'] ?? '').toString();
  if (oldS.isEmpty && newS.isEmpty && patch.isNotEmpty) {
    return [
      for (final l in patch.split('\n'))
        if (!l.startsWith('+++') && !l.startsWith('---'))
          (sign: l.startsWith('+') ? '+' : l.startsWith('-') ? '-' : ' ', text: l.length > 1 && (l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')) ? l.substring(1) : l, oldNo: null, newNo: null),
    ];
  }
  final o = oldS.split('\n');
  final nn = newS.split('\n');
  /* 去掉首尾相同的行当上下文, 中间按删 / 加列 */
  var head = 0;
  while (head < o.length && head < nn.length && o[head] == nn[head]) {
    head++;
  }
  var tail = 0;
  while (tail < o.length - head && tail < nn.length - head && o[o.length - 1 - tail] == nn[nn.length - 1 - tail]) {
    tail++;
  }
  return [
    for (var i = 0; i < head; i++) (sign: ' ', text: o[i], oldNo: i + 1, newNo: i + 1),
    for (var i = head; i < o.length - tail; i++) (sign: '-', text: o[i], oldNo: i + 1, newNo: null),
    for (var i = head; i < nn.length - tail; i++) (sign: '+', text: nn[i], oldNo: null, newNo: i + 1),
    for (var i = o.length - tail; i < o.length; i++) (sign: ' ', text: o[i], oldNo: i + 1, newNo: nn.length - (o.length - i) + 1),
  ];
}

/// 全屏看一个文件的改动 —— 整宽给代码, 左右滑切文件.
class FileDiffPage extends ConsumerStatefulWidget {
  const FileDiffPage({super.key, required this.path, required this.edits, this.allFiles});

  final String path;
  final List<TimelineEntry> edits;
  final Map<String, List<TimelineEntry>>? allFiles;

  @override
  ConsumerState<FileDiffPage> createState() => _FileDiffPageState();
}

class _FileDiffPageState extends ConsumerState<FileDiffPage> {
  late final List<String> _files = widget.allFiles?.keys.toList() ?? [widget.path];
  late int _i = _files.indexOf(widget.path).clamp(0, _files.length - 1);
  bool _wrap = false;

  List<TimelineEntry> get _edits => widget.allFiles?[_files[_i]] ?? widget.edits;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final path = _files[_i];
    final st = _edits.map(editStatsOf).fold((adds: 0, dels: 0), (a, s) => (adds: a.adds + s.adds, dels: a.dels + s.dels));
    final mono = TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12, height: 1.55, color: c.ink);
    final lines = <_DiffLine>[];
    for (final (i, e) in _edits.indexed) {
      if (i > 0) lines.add((sign: '@', text: '⋯', oldNo: null, newNo: null));
      lines.addAll(_diffOf(e));
    }
    Widget lineRow(_DiffLine l) {
      final bg = switch (l.sign) {
        '+' => c.greenSoft,
        '-' => c.redSoft,
        _ => Colors.transparent,
      };
      final text = Text(
        l.sign == '@' ? l.text : '${l.sign == ' ' ? ' ' : l.sign} ${l.text}',
        softWrap: _wrap,
        style: mono.copyWith(color: l.sign == '-' ? c.redInk : (l.sign == '@' ? c.grey : c.ink)),
      );
      return Container(
        color: bg,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 30,
              child: Text('${l.newNo ?? l.oldNo ?? ''}', textAlign: TextAlign.right, style: mono.copyWith(color: c.faint, fontSize: 11)),
            ),
            const SizedBox(width: 10),
            if (_wrap) Expanded(child: text) else text,
          ],
        ),
      );
    }

    final body = _wrap
        ? ListView(padding: const EdgeInsets.only(bottom: 24), children: [for (final l in lines) lineRow(l)])
        : SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: 1200,
              child: ListView(padding: const EdgeInsets.only(bottom: 24), children: [for (final l in lines) lineRow(l)]),
            ),
          );
    return ClayPage(
      topBar: ClayTopBar(
        titleWidget: Row(
          children: [
            Flexible(child: Text(_base(path), maxLines: 1, overflow: TextOverflow.ellipsis, style: mono.copyWith(fontSize: 15, fontWeight: FontWeight.w700))),
            const SizedBox(width: 8),
            if (st.adds > 0) ClayChip(label: '+${st.adds}', tone: ClayTone.green, dense: true),
            if (st.dels > 0) ...[const SizedBox(width: 4), ClayChip(label: '−${st.dels}', tone: ClayTone.red, dense: true)],
          ],
        ),
        actions: [
          if (_files.length > 1)
            TextButton(
              onPressed: () => setState(() => _i = (_i + 1) % _files.length),
              child: Text('${_i + 1} / ${_files.length} ›', style: TextStyle(color: c.grey)),
            ),
          GestureDetector(
            onTap: () => setState(() => _wrap = !_wrap),
            child: ClayChip(label: tr('自动换行'), tone: _wrap ? ClayTone.cobalt : ClayTone.neutral),
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(path, maxLines: 1, overflow: TextOverflow.ellipsis, style: mono.copyWith(color: c.grey, fontStyle: FontStyle.italic)),
          ),
          Expanded(
            child: GestureDetector(
              onHorizontalDragEnd: _files.length < 2
                  ? null
                  : (d) {
                      if ((d.primaryVelocity ?? 0).abs() < 300) return;
                      setState(() => _i = (d.primaryVelocity! < 0 ? _i + 1 : _i - 1 + _files.length) % _files.length);
                    },
              child: body,
            ),
          ),
        ],
      ),
      bottom: Row(
        children: [
          ClayButton(
            label: tr('问这段'),
            icon: Icons.chat_bubble_outline_rounded,
            onTap: () {
              ref.read(composerPendingTextProvider.notifier).state = tr('关于 ${_base(path)} 这处改动：');
              Navigator.of(context).pop();
            },
          ),
        ],
      ),
    );
  }
}

/// 一步的全屏详情: 改文件 → 看改动; 命令 → 终端输出; 其它 → 参数和结果.
class StepDetailPage extends StatelessWidget {
  const StepDetailPage({super.key, required this.entry});

  final TimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final v = stepViewOf(entry);
    if (v.kind == StepKind.edit || v.kind == StepKind.write) {
      return FileDiffPage(path: _arg(entry, ['path', 'file_path', 'target_file']) ?? v.target, edits: [entry]);
    }
    final mono = TextStyle(fontFamily: NeoxMono.family, fontFamilyFallback: NeoxMono.fallback, fontSize: 12.5, height: 1.5);
    if (v.kind == StepKind.shell) {
      final out = (entry.output ?? entry.liveOutput ?? '').trimRight();
      return ClayPage(
        title: tr('终端输出'),
        subtitle: v.result,
        body: Padding(
          padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
          child: Container(
            decoration: BoxDecoration(color: const Color(0xFF1B1916), borderRadius: BorderRadius.circular(16)),
            padding: const EdgeInsets.all(14),
            child: SingleChildScrollView(
              child: SelectableText(
                '\$ ${_arg(entry, ['command', 'cmd', 'code', 'script']) ?? ''}\n\n${out.isEmpty ? tr('(没有输出)') : out}',
                style: mono.copyWith(color: const Color(0xFFEDE8E0)),
              ),
            ),
          ),
        ),
      );
    }
    return ClayPage(
      title: v.verb,
      subtitle: v.target,
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        children: [
          toolr.ToolView(
            toolName: entry.toolName ?? 'tool',
            args: entry.args,
            result: entry.output != null ? {'content': entry.output, 'ok': entry.toolSuccess} : null,
          ),
          if (v.kind == StepKind.text) MarkdownView(data: entry.text ?? ''),
          if ((entry.output ?? '').isEmpty && entry.pending)
            Padding(padding: const EdgeInsets.only(top: 12), child: Text(tr('还在跑…'), style: TextStyle(color: c.grey))),
        ],
      ),
    );
  }
}
