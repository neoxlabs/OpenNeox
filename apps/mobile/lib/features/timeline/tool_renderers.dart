/// tool_renderers.dart — 按 toolName 派发的专属 args/result 渲染器.
///
/// 不匹配的工具 fallback 到 [CodeBlock] 通用 JSON.
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import '../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

// ────────────────────────────────────────────────────────────────
// 公共入口
// ────────────────────────────────────────────────────────────────

class ToolView extends StatelessWidget {
  const ToolView({
    super.key,
    required this.toolName,
    required this.args,
    required this.result,
  });

  final String toolName;
  final Map<String, dynamic>? args;
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final tool = toolName.toLowerCase();
    final argsView = _buildArgs(tool, args);
    final resultView = _buildResult(tool, args, result);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (argsView != null) argsView,
        if (resultView != null) ...[
          const SizedBox(height: 8),
          resultView,
        ],
      ],
    );
  }
}

Widget? _buildArgs(String tool, Map<String, dynamic>? args) {
  if (args == null || args.isEmpty) return null;
  switch (tool) {
    case 'readfile':
    case 'read_file':
    case 'read_document':
      return _ReadArgs(args: args);
    case 'write_file':
    case 'write_neox_config':
      return _WriteArgs(args: args);
    case 'edit_file':
    case 'edit':
      return _EditArgs(args: args);
    case 'execute_shell':
    case 'execute_bash':
    case 'execute_python':
    case 'execute_javascript':
    case 'execute_code':
      return _ShellArgs(args: args);
    case 'update_plan':
    case 'edit_plan':
      return _PlanArgs(args: args);
    case 'delete_file':
      return _DeleteArgs(args: args);
    case 'search_files':
    case 'search':
    case 'grep':
      return _SearchArgs(args: args);
    case 'list_directory':
    case 'glob':
      return _ListDirArgs(args: args);
    case 'web_search':
      return _WebSearchArgs(args: args);
    case 'web_fetch':
      return _WebFetchArgs(args: args);
    case 'explore':
    case 'task':
    case 'task_agent':
      return _ExploreArgs(args: args);
    case 'agent':
      return _AgentArgs(args: args);
    default:
      /* 桌面 browser_* 工具族 — 手机无法渲染可视 surface, 显关键参数 */
      if (tool.startsWith('browser_')) return _BrowserArgs(args: args);
      return _GenericArgs(args: args);
  }
}

Widget? _buildResult(String tool, Map<String, dynamic>? args, Object? result) {
  if (result == null) return null;
  switch (tool) {
    case 'execute_shell':
    case 'execute_bash':
    case 'execute_python':
    case 'execute_javascript':
    case 'execute_code':
      return _ShellResult(result: result);
    case 'readfile':
    case 'read_file':
    case 'read_document':
      return _ReadResult(result: result);
    /* edit result 的 success JSON 没信息量 — args 里已有 diff, 跳过 */
    case 'write_file':
    case 'edit_file':
    case 'edit':
      return null;
    case 'delete_file':
      return _OkResult(result: result);
    case 'update_plan':
    case 'edit_plan':
      /* plan tool 的 result 是 {success, message, planPath} 这种内务 JSON,
       *   用户看不出价值. 渲简单 "✓ 计划已更新" 即可, 不暴露 path. */
      return _PlanResult(result: result);
    case 'search_files':
    case 'search':
    case 'grep':
      return _SearchResult(result: result);
    case 'list_directory':
    case 'glob':
      return _ListDirResult(result: result);
    case 'web_search':
      return _WebSearchResult(result: result);
    case 'web_fetch':
      return _WebFetchResult(result: result);
    case 'agent':
      return _AgentResult(result: result);
    default:
      /* browser 可视 surface (截图/快照) 手机不传输 — 诚实降级为提示行 */
      if (tool == 'browser_screenshot' || tool == 'browser_get_aria_tree' ||
          tool == 'browser_list_surfaces') {
        return _DesktopOnlySurfaceNote(label: tr('可视化结果在电脑端呈现'));
      }
      return _GenericResult(result: result);
  }
}

/// 桌面 browser_* 工具参数 — 只显 url/selector/text 等关键项.
class _BrowserArgs extends StatelessWidget {
  const _BrowserArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final rows = <Widget>[];
    for (final k in const ['url', 'selector', 'text', 'key', 'direction']) {
      final v = args[k];
      if (v is String && v.isNotEmpty) {
        rows.add(Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: Text(
            '$k: $v',
            style: theme.textTheme.bodySmall?.copyWith(
              fontFamily: NeoxMono.family,
              fontFamilyFallback: NeoxMono.fallback,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ));
      }
    }
    if (rows.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: rows);
  }
}

/// 桌面独有可视 surface 的降级提示行 — 跨端诚实标注, 不装作能显示.
class _DesktopOnlySurfaceNote extends StatelessWidget {
  const _DesktopOnlySurfaceNote({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.desktop_mac_outlined, size: 13, color: mute),
        const SizedBox(width: 6),
        Text(
          label,
          style: theme.textTheme.bodySmall?.copyWith(color: mute),
        ),
      ],
    );
  }
}

// ────────────────────────────────────────────────────────────────
// 单元: PathChip / KvRow / CodeBlock / StatusPill
// ────────────────────────────────────────────────────────────────

class PathChip extends StatelessWidget {
  const PathChip({
    super.key,
    required this.path,
    this.icon = Icons.insert_drive_file_outlined,
    this.color,
  });
  final String path;
  final IconData icon;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final c = color ?? theme.colorScheme.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        borderRadius: NeoxRadius.smallR,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: c),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              path,
              style: theme.textTheme.bodySmall?.copyWith(
                fontFamily: NeoxMono.family,
                fontFamilyFallback: NeoxMono.fallback,
                color: theme.colorScheme.onSurface,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: NeoxRadius.barR,
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          fontFamily: NeoxMono.family,
          fontFamilyFallback: NeoxMono.fallback,
          letterSpacing: 0.4,
        ),
      ),
    );
  }
}

class CodeBlock extends StatelessWidget {
  const CodeBlock({
    super.key,
    this.label,
    required this.body,
    this.maxLines,
    this.dark = false,
  });
  final String? label;
  final String body;
  final int? maxLines;
  final bool dark;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final bg = dark
        ? const Color(0xFF1F1F22)
        : theme.colorScheme.surfaceContainerLowest;
    final fg = dark ? const Color(0xFFE6E6E6) : theme.colorScheme.onSurface;
    final shown = maxLines == null
        ? body
        : _truncateLines(body, maxLines!);
    final clipped = shown.length < body.length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (label != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              label!,
              style: theme.textTheme.labelSmall?.copyWith(
                color: mute,
                letterSpacing: 1.0,
                fontSize: 11,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        Container(
          decoration: BoxDecoration(
            color: bg,
            border: Border.all(
              color: dark
                  ? Colors.transparent
                  : theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
            ),
            borderRadius: NeoxRadius.smallR,
          ),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.all(10),
            child: SelectableText(
              clipped ? '$shown\n…' : shown,
              style: theme.textTheme.bodySmall?.copyWith(
                fontFamily: NeoxMono.family,
                fontFamilyFallback: NeoxMono.fallback,
                height: 1.45,
                fontSize: 13,
                color: fg,
              ),
            ),
          ),
        ),
      ],
    );
  }

  String _truncateLines(String s, int n) {
    final lines = s.split('\n');
    if (lines.length <= n) return s;
    return lines.take(n).join('\n');
  }
}

// ────────────────────────────────────────────────────────────────
// readfile / read_document
// ────────────────────────────────────────────────────────────────

class _ReadArgs extends StatelessWidget {
  const _ReadArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final path = (args['file_path'] ?? args['path']) as String? ?? '?';
    final start = args['offset'] ?? args['start_line'];
    final lim = args['limit'] ?? args['line_count'];
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Wrap(
      spacing: 6,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        PathChip(path: path, icon: Icons.menu_book_outlined),
        if (start is int)
          Text(tr('行 $start${lim is int ? '-${start + lim}' : ''}'),
              style: theme.textTheme.bodySmall?.copyWith(color: mute)),
      ],
    );
  }
}

class _ReadResult extends StatelessWidget {
  const _ReadResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final text = _toResultString(result);
    if (text.isEmpty) return const SizedBox.shrink();
    final lineCount = '\n'.allMatches(text).length + 1;
    return _FoldedCode(
      headerLeading: Icons.subject,
      headerLabel: '$lineCount lines',
      body: text,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// write_file
// ────────────────────────────────────────────────────────────────

class _WriteArgs extends StatelessWidget {
  const _WriteArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final path = (args['file_path'] ?? args['path']) as String? ?? '?';
    final content = args['content'] as String? ?? '';
    final lines = content.isEmpty ? 0 : '\n'.allMatches(content).length + 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 6,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            PathChip(path: path, icon: Icons.note_add_outlined),
            if (lines > 0)
              StatusPill(label: '+$lines L', color: Theme.of(context).colorScheme.okInk),
          ],
        ),
        if (content.isNotEmpty) ...[
          const SizedBox(height: 8),
          /* 写文件 = 全量新增, 用绿 diff 块对齐桌面 write DiffView */
          _DiffBlock(oldText: '', newText: content),
        ],
      ],
    );
  }
}

// ────────────────────────────────────────────────────────────────
// edit_file / edit
// ────────────────────────────────────────────────────────────────

class _EditArgs extends StatelessWidget {
  const _EditArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final path = (args['file_path'] ?? args['path']) as String? ?? '?';
    final oldS = args['old_string'] as String? ?? args['old'] as String? ?? '';
    final newS = args['new_string'] as String? ?? args['new'] as String? ?? '';
    final replaceAll = args['replace_all'] == true;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 6,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            PathChip(path: path, icon: Icons.edit_outlined),
            if (replaceAll)
              StatusPill(label: 'REPLACE ALL', color: Theme.of(context).colorScheme.warnInk),
          ],
        ),
        const SizedBox(height: 8),
        _DiffBlock(oldText: oldS, newText: newS),
      ],
    );
  }
}

class _DiffBlock extends StatelessWidget {
  const _DiffBlock({required this.oldText, required this.newText});
  final String oldText;
  final String newText;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final delColor = theme.colorScheme.errInk;
    final addColor = theme.colorScheme.okInk;
    final delBg = delColor.withValues(alpha: 0.08);
    final addBg = addColor.withValues(alpha: 0.08);
    if (oldText.isEmpty && newText.isEmpty) {
      return Text(
        tr('无 diff 内容'),
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      );
    }
    return Container(
      width: double.infinity,
      clipBehavior: Clip.hardEdge,
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withValues(alpha: 0.03),
        borderRadius: NeoxRadius.chipR,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (oldText.isNotEmpty)
            _diffSide(theme: theme, prefix: '−', text: oldText, fg: delColor, bg: delBg),
          if (oldText.isNotEmpty && newText.isNotEmpty)
            Divider(
              height: 1,
              color: theme.colorScheme.outlineVariant.withValues(alpha: 0.35),
            ),
          if (newText.isNotEmpty)
            _diffSide(theme: theme, prefix: '+', text: newText, fg: addColor, bg: addBg),
        ],
      ),
    );
  }

  Widget _diffSide({
    required ThemeData theme,
    required String prefix,
    required String text,
    required Color fg,
    required Color bg,
  }) {
    final lines = text.split('\n');
    final display = lines.length > 24
        ? tr('${lines.take(24).join('\n')}\n  … 还有 ${lines.length - 24} 行')
        : text;
    return Container(
      color: bg,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
        child: SelectableText.rich(
          TextSpan(
            children: display.split('\n').map((l) {
              return TextSpan(
                text: '$prefix $l\n',
                style: TextStyle(
                  fontFamily: NeoxMono.family,
                  fontFamilyFallback: NeoxMono.fallback,
                  fontSize: 13,
                  height: 1.45,
                  color: fg,
                ),
              );
            }).toList(),
          ),
        ),
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// execute_shell
// ────────────────────────────────────────────────────────────────

class _ShellArgs extends StatelessWidget {
  const _ShellArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final cmd = (args['command'] ?? args['cmd'] ?? args['code']) as String? ?? '';
    final theme = Theme.of(context);
    return Container(
      decoration: BoxDecoration(
        /* 【固定深色是有意的, 不要"顺手统一成 token"】(2026-09-18 审查时确认)
         * 这是**终端命令块** —— 终端一律深底是所有开发工具的共识 (GitHub 的 diff、
         * VS Code 的集成终端都这样), 浅色主题下跟着变白反而认不出"这是命令行"。
         * 所以这里不跟主题走。真正该跟主题走的是它周围的卡片和文字, 那些已经走 token。 */
        color: const Color(0xFF1F1F22),
        borderRadius: NeoxRadius.smallR,
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        child: SelectableText.rich(
          TextSpan(
            children: [
              const TextSpan(
                text: '\$ ',
                style: TextStyle(
                  fontFamily: NeoxMono.family,
                  fontFamilyFallback: NeoxMono.fallback,
                  fontSize: 13,
                  height: 1.5,
                  color: Color(0xFF7BC97A),
                  fontWeight: FontWeight.w700,
                ),
              ),
              TextSpan(
                text: cmd,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: NeoxMono.family,
                  fontFamilyFallback: NeoxMono.fallback,
                  height: 1.5,
                  fontSize: 13,
                  color: const Color(0xFFE6E6E6),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ShellResult extends StatelessWidget {
  const _ShellResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final text = _toResultString(result);
    final exit = _extractExitCode(result);
    final ok = exit == null || exit == 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (text.isNotEmpty)
          _FoldedCode(
            headerLeading: Icons.terminal,
            headerLabel: 'output',
            body: text,
            dark: true,
          ),
        const SizedBox(height: 4),
        Align(
          alignment: Alignment.centerLeft,
          child: StatusPill(
            label: 'exit ${exit ?? 0}',
            color: ok ? Theme.of(context).colorScheme.okInk : Theme.of(context).colorScheme.errInk,
          ),
        ),
      ],
    );
  }

  int? _extractExitCode(Object? r) {
    if (r is Map) {
      final v = r['exit_code'] ?? r['exitCode'] ?? r['code'] ?? r['exit'];
      if (v is int) return v;
      if (v is String) return int.tryParse(v);
    }
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// update_plan / edit_plan
// ────────────────────────────────────────────────────────────────

class _PlanArgs extends StatelessWidget {
  const _PlanArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    /* Neox update_plan: { plan: [{step, status}] }, 兼容历史/其它 agents 的字段名. */
    final raw = args['plan'] ?? args['tasks'] ?? args['todos'] ?? args['items'];
    final tasks = <Map<String, dynamic>>[];
    if (raw is List) {
      for (final t in raw) {
        if (t is Map<String, dynamic>) {
          tasks.add(t);
        } else if (t is String) {
          tasks.add({'step': t, 'status': 'pending'});
        }
      }
    }
    if (tasks.isEmpty) {
      return CodeBlock(label: 'PLAN', body: prettyJson(args));
    }
    final theme = Theme.of(context);
    return Container(
      decoration: BoxDecoration(
        border: Border.all(
          color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
        ),
        borderRadius: NeoxRadius.smallR,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final t in tasks) _PlanRow(task: t),
        ],
      ),
    );
  }
}

class _PlanRow extends StatelessWidget {
  const _PlanRow({required this.task});
  final Map<String, dynamic> task;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    /* Neox 走 step, 其它兼容 — 'step' 不在原 fallback 里, 导致 plan 卡显 '?' */
    final content = (task['step'] ?? task['content'] ?? task['title'] ?? task['text'] ?? '?').toString();
    final status = (task['status'] ?? '').toString().toLowerCase();
    IconData icon;
    Color color;
    bool strike = false;
    switch (status) {
      case 'completed':
      case 'done':
        icon = Icons.check_circle;
        color = theme.colorScheme.okInk;
        strike = true;
        break;
      case 'in_progress':
      case 'doing':
      case 'active':
        icon = Icons.adjust;
        color = theme.colorScheme.primary;
        break;
      case 'cancelled':
      case 'canceled':
      case 'skipped':
        icon = Icons.remove_circle_outline;
        color = theme.colorScheme.onSurfaceVariant;
        strike = true;
        break;
      default:
        icon = Icons.radio_button_unchecked;
        color = theme.colorScheme.onSurfaceVariant;
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(icon, size: 14, color: color),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              content,
              style: theme.textTheme.bodySmall?.copyWith(
                height: 1.4,
                decoration: strike ? TextDecoration.lineThrough : null,
                color: strike ? theme.colorScheme.onSurfaceVariant : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// plan 工具的 result 一般是 {success, message, planPath}, 路径/JSON 对用户无意义,
/// 渲一行 "✓ 计划已更新" 就够. 失败时显 message.
class _PlanResult extends StatelessWidget {
  const _PlanResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    bool ok = true;
    String? msg;
    if (result is Map) {
      final m = result as Map;
      if (m['success'] == false || m['ok'] == false) ok = false;
      final raw = m['message'];
      if (raw is String) msg = raw;
    }
    final icon = ok ? Icons.check_circle_outline : Icons.error_outline;
    final color = ok ? theme.colorScheme.okInk : theme.colorScheme.error;
    final label = ok ? tr('计划已更新') : (msg ?? tr('更新失败'));
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: color),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(color: mute),
          ),
        ),
      ],
    );
  }
}

// ────────────────────────────────────────────────────────────────
// delete_file
// ────────────────────────────────────────────────────────────────

class _DeleteArgs extends StatelessWidget {
  const _DeleteArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final path = (args['file_path'] ?? args['path']) as String? ?? '?';
    return PathChip(
      path: path,
      icon: Icons.delete_outline,
      color: Theme.of(context).colorScheme.errInk,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// search / grep / search_files
// ────────────────────────────────────────────────────────────────

class _SearchArgs extends StatelessWidget {
  const _SearchArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final pattern = (args['pattern'] ?? args['query'] ?? args['regex']) as String? ?? '';
    final path = (args['path'] ?? args['cwd']) as String?;
    final theme = Theme.of(context);
    return Wrap(
      spacing: 6,
      runSpacing: 4,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerLow,
            borderRadius: NeoxRadius.smallR,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.search, size: 12, color: theme.colorScheme.onSurfaceVariant),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  pattern,
                  style: theme.textTheme.bodySmall?.copyWith(
                    fontFamily: NeoxMono.family,
                    fontFamilyFallback: NeoxMono.fallback,
                    color: theme.colorScheme.onSurface,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
        if (path != null && path.isNotEmpty) PathChip(path: path, icon: Icons.folder_outlined),
      ],
    );
  }
}

class _SearchResult extends StatelessWidget {
  const _SearchResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final text = _toResultString(result);
    final lines = text.split('\n').where((l) => l.trim().isNotEmpty).toList();
    return _FoldedCode(
      headerLeading: Icons.format_list_bulleted,
      headerLabel: '${lines.length} matches',
      body: text,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// list_directory / glob
// ────────────────────────────────────────────────────────────────

class _ListDirArgs extends StatelessWidget {
  const _ListDirArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final path = (args['path'] ?? args['pattern']) as String? ?? '?';
    return PathChip(path: path, icon: Icons.folder_open_outlined);
  }
}

class _ListDirResult extends StatelessWidget {
  const _ListDirResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final text = _toResultString(result);
    final lines = text.split('\n').where((l) => l.trim().isNotEmpty).toList();
    return _FoldedCode(
      headerLeading: Icons.list,
      headerLabel: '${lines.length} entries',
      body: text,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// web_search / web_fetch
// ────────────────────────────────────────────────────────────────

class _WebSearchArgs extends StatelessWidget {
  const _WebSearchArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final q = (args['query'] ?? args['q']) as String? ?? '';
    return PathChip(path: q, icon: Icons.travel_explore);
  }
}

class _WebSearchResult extends StatelessWidget {
  const _WebSearchResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    return CodeBlock(label: 'WEB RESULTS', body: prettyJson(result), maxLines: 12);
  }
}

class _WebFetchArgs extends StatelessWidget {
  const _WebFetchArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final url = (args['url'] ?? args['link']) as String? ?? '';
    return PathChip(path: url, icon: Icons.link);
  }
}

class _WebFetchResult extends StatelessWidget {
  const _WebFetchResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final text = _toResultString(result);
    return _FoldedCode(
      headerLeading: Icons.article_outlined,
      headerLabel: 'content',
      body: text,
    );
  }
}

// ────────────────────────────────────────────────────────────────
// agent (派子 agent) — 专用渲染
//
// 之前它不在专用渲染器名单里 (只有 explore/task/task_agent), 掉进 _GenericArgs:
// 展开后铺一张 ARGUMENTS 表 (description / prompt / run_in_background / type) +
// 工具返回的原始 JSON `{"status":"background_launched","agentId":…}` + META ok:true。
// 明康 2026-07-29: "这展示的是啥？我没看懂" —— 确实没有阅读价值, 那是给模型看的
// 调用载荷。派活这件事用户只关心两件: **派了谁干什么**、**它交回了什么**;
// 后者在下面的完成卡 / 子会话页里, 这里只讲清楚前者。
// ────────────────────────────────────────────────────────────────

class _AgentArgs extends StatelessWidget {
  const _AgentArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final desc = (args['description'] ?? '').toString().trim();
    final prompt = (args['prompt'] ?? args['task'] ?? '').toString().trim();
    final type = (args['type'] ?? '').toString().trim();
    final background = args['run_in_background'] == true;
    if (desc.isEmpty && prompt.isEmpty) return const SizedBox.shrink();

    final tags = <String>[
      if (type.isNotEmpty) type,
      if (background) tr('后台'),
    ];

    return Container(
      width: double.infinity,
      clipBehavior: Clip.hardEdge,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: scheme.onSurface.withValues(alpha: 0.04),
        borderRadius: NeoxRadius.chipR,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (desc.isNotEmpty)
            Row(
              children: [
                Icon(Icons.smart_toy_outlined, size: 14, color: scheme.primary),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    desc,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurface,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                for (final t in tags) ...[
                  const SizedBox(width: 6),
                  Text(
                    t,
                    style: theme.textTheme.labelSmall?.copyWith(
                      fontSize: 11,
                      color: scheme.hintInk,
                    ),
                  ),
                ],
              ],
            ),
          if (prompt.isNotEmpty) ...[
            if (desc.isNotEmpty) const SizedBox(height: 6),
            Padding(
              padding: EdgeInsets.only(left: desc.isNotEmpty ? 22 : 0),
              child: Text(
                prompt,
                maxLines: 8,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: scheme.onSurfaceVariant,
                  height: 1.45,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// agent 工具的返回 — 只讲一句话, 不铺 JSON.
/// 真正的产出在完成卡 / 子会话页 (长按痕迹或完成卡进去)。
class _AgentResult extends StatelessWidget {
  const _AgentResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    /* ToolBlock 传进来的是 {'content': <工具原始输出字符串>, 'ok': bool} —
     * agent 工具真正的返回 JSON 在 content 里, 要再解一层。 */
    Map<String, dynamic>? m;
    Object? payload = result;
    if (payload is Map<String, dynamic> && payload['content'] != null) {
      payload = payload['content'];
    }
    if (payload is Map<String, dynamic>) {
      m = payload;
    } else if (payload is String) {
      try {
        final parsed = jsonDecode(payload);
        if (parsed is Map<String, dynamic>) m = parsed;
      } catch (_) {/* 不是 JSON 就当纯文本 */}
    }
    final agentId = (m?['agentId'] ?? m?['agent_id'] ?? '').toString().trim();
    final status = (m?['status'] ?? '').toString().trim();
    final error = (m?['error'] ?? '').toString().trim();

    final String line;
    if (error.isNotEmpty) {
      line = tr('派发失败: $error');
    } else if (status == 'background_launched') {
      line = agentId.isEmpty
          ? tr('已在后台启动, 完成后自动回报')
          : tr('$agentId 已在后台启动, 完成后自动回报');
    } else if (agentId.isNotEmpty) {
      line = tr('$agentId 已完成');
    } else {
      final raw = payload?.toString().trim() ?? '';
      if (raw.isEmpty) return const SizedBox.shrink();
      line = raw.length > 160 ? '${raw.substring(0, 160)}…' : raw;
    }

    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            error.isNotEmpty ? Icons.error_outline : Icons.subdirectory_arrow_right_rounded,
            size: 14,
            color: error.isNotEmpty
                ? scheme.error
                : scheme.onSurfaceVariant.withValues(alpha: 0.7),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              line,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                fontSize: 13,
                color: error.isNotEmpty
                    ? scheme.error
                    : scheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// explore / TaskAgent — 对齐桌面 ExploreView: 浅底无边框, 只显 prompt
// ────────────────────────────────────────────────────────────────

class _ExploreArgs extends StatelessWidget {
  const _ExploreArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final prompt = (args['prompt'] ?? args['task'] ?? args['query'] ?? '')
        .toString()
        .trim();
    if (prompt.isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      clipBehavior: Clip.hardEdge,
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(
        color: scheme.onSurface.withValues(alpha: 0.04),
        borderRadius: NeoxRadius.chipR,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.travel_explore, size: 14, color: scheme.primary),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              prompt,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurface,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// 通用 ok result (write/edit/delete/plan)
// ────────────────────────────────────────────────────────────────

class _OkResult extends StatelessWidget {
  const _OkResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final text = _toResultString(result);
    final hasError = text.toLowerCase().contains('error') ||
        text.toLowerCase().contains('failed');
    if (text.length > 200 || hasError) {
      return _FoldedCode(
        headerLeading: hasError ? Icons.warning_amber_outlined : Icons.check,
        headerLabel: hasError ? 'error' : 'output',
        body: text,
        dark: false,
      );
    }
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(Icons.check_circle_outline,
            size: 14, color: theme.colorScheme.okInk),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            text.isEmpty ? 'OK' : text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
      ],
    );
  }
}

// ────────────────────────────────────────────────────────────────
// _GenericArgs / _GenericResult — 未识别工具的结构化兜底渲染
//
// 默认场景: 新加的工具 (browser_*, spawn_agent, custom skill...) 第一次出现在 mobile,
// 不写 hardcode 也能看出"调了啥". 思路:
//   - Map: 顶层 KV 行渲染, 短 string 行内, 长/嵌套折叠
//   - List: 逐项 chip / 短摘要; 大 list 折叠
//   - 标量: 直接显
// 不再裸 prettyJson 一坨, 减少"raw 字符串墙"的视觉.
// ────────────────────────────────────────────────────────────────

class _GenericArgs extends StatelessWidget {
  const _GenericArgs({required this.args});
  final Map<String, dynamic> args;

  @override
  Widget build(BuildContext context) {
    return _KvBlock(label: 'ARGUMENTS', map: args);
  }
}

class _GenericResult extends StatelessWidget {
  const _GenericResult({required this.result});
  final Object? result;

  @override
  Widget build(BuildContext context) {
    final r = result;
    if (r == null) return const SizedBox.shrink();
    /* string / list 多模态文本 → 走 _FoldedCode 同 read result 一致 */
    if (r is String) {
      if (r.trim().isEmpty) return const SizedBox.shrink();
      return _FoldedCode(
        headerLeading: Icons.subject,
        headerLabel: 'result',
        body: r,
      );
    }
    if (r is List) {
      /* multimodal: 拼 text 段 */
      final text = _toResultString(r);
      if (text.isNotEmpty) {
        return _FoldedCode(
          headerLeading: Icons.subject,
          headerLabel: 'result',
          body: text,
        );
      }
      return CodeBlock(label: 'RESULT', body: prettyJson(r), maxLines: 12);
    }
    if (r is Map<String, dynamic>) {
      /* 优先抽 text/output/stdout 类字段 — 工具大多走这条路, 给独立 code 块 */
      for (final k in const ['text', 'output', 'stdout', 'content', 'result', 'message']) {
        final v = r[k];
        if (v is String && v.isNotEmpty) {
          final rest = Map<String, dynamic>.from(r)..remove(k);
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _FoldedCode(
                headerLeading: Icons.subject,
                headerLabel: k,
                body: v,
              ),
              if (rest.isNotEmpty) ...[
                const SizedBox(height: 6),
                _KvBlock(label: 'META', map: rest),
              ],
            ],
          );
        }
      }
      /* 其余 → KV 渲染 */
      return _KvBlock(label: 'RESULT', map: r);
    }
    return CodeBlock(label: 'RESULT', body: r.toString());
  }
}

/// 结构化 KV 块 — 顶层 key 一行: `key: value`. 长 value / 嵌套结构自动折叠.
class _KvBlock extends StatelessWidget {
  const _KvBlock({required this.label, required this.map});
  final String label;
  final Map<String, dynamic> map;

  @override
  Widget build(BuildContext context) {
    if (map.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final keys = map.keys.toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 4),
          child: Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: mute,
              letterSpacing: 1.0,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        Container(
          decoration: BoxDecoration(
            border: Border.all(
              color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
            ),
            borderRadius: NeoxRadius.smallR,
          ),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < keys.length; i++) ...[
                _KvRow(name: keys[i], value: map[keys[i]]),
                if (i < keys.length - 1)
                  Divider(
                    height: 8,
                    thickness: 0.5,
                    color: theme.colorScheme.outlineVariant.withValues(alpha: 0.3),
                  ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _KvRow extends StatelessWidget {
  const _KvRow({required this.name, required this.value});
  final String name;
  final Object? value;

  bool get _isComplex {
    final v = value;
    if (v is String) return v.length > 80 || v.contains('\n');
    if (v is Map) return v.isNotEmpty;
    if (v is List) {
      return v.length > 3 ||
          v.any((x) =>
              x is Map ||
              x is List ||
              (x is String && (x.length > 40 || x.contains('\n'))));
    }
    return false;
  }

  String _inlineValue(Object? v) {
    if (v == null) return 'null';
    if (v is String) return v;
    if (v is bool || v is num) return v.toString();
    if (v is List) {
      if (v.isEmpty) return '[]';
      final items = v.take(3).map((x) {
        if (x is String) return x.length > 24 ? '${x.substring(0, 21)}…' : x;
        return x.toString();
      }).join(', ');
      return v.length > 3 ? '[$items, …${v.length - 3} more]' : '[$items]';
    }
    return v.toString();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    if (_isComplex) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              name,
              style: TextStyle(
                fontFamily: NeoxMono.family,
                fontFamilyFallback: NeoxMono.fallback,
                fontSize: 12,
                color: mute,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.2,
              ),
            ),
            const SizedBox(height: 3),
            CodeBlock(
              body: value is String
                  ? value as String
                  : prettyJson(value),
              maxLines: 12,
            ),
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 80, maxWidth: 140),
            child: Text(
              name,
              style: TextStyle(
                fontFamily: NeoxMono.family,
                fontFamilyFallback: NeoxMono.fallback,
                fontSize: 12,
                color: mute,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: SelectableText(
              _inlineValue(value),
              style: TextStyle(
                fontFamily: NeoxMono.family,
                fontFamilyFallback: NeoxMono.fallback,
                fontSize: 12.5,
                color: theme.colorScheme.onSurface,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ────────────────────────────────────────────────────────────────
// _FoldedCode — 默认折叠首 24 行的 code block
// ────────────────────────────────────────────────────────────────

class _FoldedCode extends StatefulWidget {
  const _FoldedCode({
    required this.headerLeading,
    required this.headerLabel,
    required this.body,
    this.dark = false,
  });
  final IconData headerLeading;
  final String headerLabel;
  final String body;
  final bool dark;

  @override
  State<_FoldedCode> createState() => _FoldedCodeState();
}

class _FoldedCodeState extends State<_FoldedCode> {
  bool _expanded = false;
  static const int _peekLines = 8;

  @override
  Widget build(BuildContext context) {
    final lines = widget.body.split('\n');
    final foldable = lines.length > _peekLines + 4;
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Icon(widget.headerLeading, size: 12, color: mute),
            const SizedBox(width: 6),
            Text(widget.headerLabel,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: mute,
                  fontSize: 11,
                  letterSpacing: 0.8,
                  fontWeight: FontWeight.w600,
                )),
            const Spacer(),
            if (foldable)
              InkWell(
                borderRadius: NeoxRadius.smallR,
                onTap: () => setState(() => _expanded = !_expanded),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                  child: Row(
                    children: [
                      Text(
                        _expanded ? tr('收起') : tr('展开'),
                        style: theme.textTheme.labelSmall?.copyWith(color: mute),
                      ),
                      Icon(_expanded ? Icons.expand_less : Icons.expand_more,
                          size: 14, color: mute),
                    ],
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 4),
        CodeBlock(
          body: foldable && !_expanded
              ? lines.take(_peekLines).join('\n')
              : widget.body,
          dark: widget.dark,
        ),
        if (foldable && !_expanded)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              tr('… 还有 ${lines.length - _peekLines} 行'),
              style: theme.textTheme.labelSmall?.copyWith(color: mute),
            ),
          ),
      ],
    );
  }
}

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────

String _toResultString(Object? r) {
  if (r == null) return '';
  if (r is String) return r;
  if (r is Map) {
    /* 优先取常见的 text/output 字段 */
    for (final k in const ['text', 'output', 'stdout', 'content', 'result', 'message']) {
      final v = r[k];
      if (v is String) return v;
    }
    final stderr = r['stderr'];
    if (stderr is String && stderr.isNotEmpty) return stderr;
    return prettyJson(r);
  }
  if (r is List) {
    /* multi-modal content: [{type:text,text:...}, ...] */
    final buf = StringBuffer();
    for (final p in r) {
      if (p is Map && p['type'] == 'text' && p['text'] is String) {
        buf.write(p['text']);
      }
    }
    if (buf.isNotEmpty) return buf.toString();
    return prettyJson(r);
  }
  return r.toString();
}

String prettyJson(Object? v) {
  try {
    return const JsonEncoder.withIndent('  ').convert(v);
  } catch (_) {
    return v?.toString() ?? '';
  }
}
