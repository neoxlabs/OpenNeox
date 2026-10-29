/// tool_block.dart — drift tool_call / tool_result 极简单行渲染.
///
/// 视觉 (2026-07-20 用户拍板 "图标+摘要, 无边框, 对齐"):
///   `[icon] name  arg_summary                                        ✓`
///   - 无边框无背景填充 — 融入正文流, 像桌面端 timeline 的工具行
///   - 每类工具一个 Material 线性图标 (shell→terminal, read→file...)
///   - 点击展开: 内容与工具名列左对齐 (不再用竖线占位)
///   - 状态尾部: running 呼吸点 / done ✓ / fail ✗
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/stream_buffer_provider.dart';
import '../../../core/storage/database.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../models/payload_utils.dart';
import '../state/timeline_state.dart';
import '../tool_renderers.dart' as toolr;
import 'shimmer_text.dart';
import 'timeline_row.dart';
import 'streaming_widgets.dart' show LiveOutputTail;

enum _ToolStatus { running, done, failed }

class ToolBlock extends ConsumerStatefulWidget {
  const ToolBlock({
    super.key,
    this.call,
    this.result,
    this.soloResult = false,
    this.entry,
    this.dense = false,
  });

  /// 新路径: 直接吃 TimelineEntry (kind='tool') — pending/output/args 一处取齐.
  factory ToolBlock.fromEntry(TimelineEntry entry, {bool dense = false}) =>
      ToolBlock(entry: entry, call: null, result: null, dense: dense);

  final SessionEvent? call;
  final SessionEvent? result;
  final bool soloResult;
  final TimelineEntry? entry;

  /// true = 嵌在聚合组里, 去掉外层水平 padding (组已有缩进).
  final bool dense;

  @override
  ConsumerState<ToolBlock> createState() => _ToolBlockState();
}

class _ToolBlockState extends ConsumerState<ToolBlock> {
  bool _expanded = false;

  /// plan/edit_plan 工具应该当作"看板"始终展开 — 整个 update_plan 的存在意义就是给用户看任务进度,
  /// 折叠成一行就完全失去价值。
  bool _isPlanTool(String name) {
    final n = name.toLowerCase();
    return n == 'update_plan' || n == 'edit_plan';
  }

  @override
  Widget build(BuildContext context) {
    /* 新路径: entry 一处取齐 toolName/args/output/pending */
    if (widget.entry != null) {
      return _buildFromEntry(widget.entry!);
    }
    /* call 提供 toolName + args, result 提供 status + output. 二者都用上才有完整信息. */
    final callPayload = safeDecode(widget.call!.payload);
    final resultPayload = widget.result != null
        ? safeDecode(widget.result!.payload)
        : (widget.soloResult ? callPayload : null);

    final rawName =
        toolName(callPayload) ??
        (resultPayload is Map ? resultPayload['tool_name'] as String? : null) ??
        (widget.soloResult ? 'result' : 'tool');
    /* args 来源优先级 — tool_call drift 早期可能 args 空 (OpenAI streaming
     * 协议 tool_call_start 先 fire, 完整 args 等 tool_call_end 才到), forwarder
     * 已把 args 也写进 tool_result drift; callPayload 空时从 resultPayload fallback。 */
    final callArgs = widget.soloResult ? null : extractArgs(callPayload);
    final resultArgs = extractArgs(resultPayload);
    final args = (callArgs != null && callArgs.isNotEmpty)
        ? callArgs
        : resultArgs;
    /* per-tool 智能优先 (search 显 pattern 而非 path='.'), 通用 fallback 兜底 */
    final summary = smartArgSummary(rawName, args) ?? toolSummary(callPayload);

    final hasResult = widget.result != null || widget.soloResult;
    final status = hasResult
        ? _statusFromResult(resultPayload)
        : _ToolStatus.running;
    /* plan tool 永远显 board (即使没 explicit 展开).
     * edit/write 默认收拢 — 行尾 +N −M, 点开才看 diff (对齐 Cursor). */
    final isPlan = _isPlanTool(rawName);
    final showBody = _expanded || isPlan;
    final stats = diffLineStats(rawName, args);
    /* orphan tool_call (running) 时 watch streaming buffer 拿实时 shell 输出 — 接管
     *   原来 StreamingToolPill 干的事. callId 从 tool_calls[0].id 取. */
    Widget? liveProgress;
    if (status == _ToolStatus.running) {
      final callId = _extractCallId(callPayload);
      if (callId != null && callId.isNotEmpty) {
        final live = ref.watch(runningToolProgressProvider(callId));
        if (live.progress.isNotEmpty) {
          liveProgress = LiveOutputTail(
            command: live.command,
            text: live.progress,
          );
        }
      }
    }

    return _ToolRowLayout(
      displayName: friendlyToolName(rawName),
      rawName: rawName,
      summary: summary,
      status: status,
      expanded: showBody,
      durationMs: _durationOf(args),
      dense: widget.dense,
      adds: stats.adds,
      dels: stats.dels,
      onTap: isPlan ? null : () => setState(() => _expanded = !_expanded),
      expandedChild: showBody
          ? toolr.ToolView(toolName: rawName, args: args, result: resultPayload)
          : null,
      trailingBelow: liveProgress,
    );
  }

  /// 新架构: TimelineEntry 单源渲染.
  Widget _buildFromEntry(TimelineEntry e) {
    final rawName = e.toolName ?? 'tool';
    final args = e.args;
    final summary = smartArgSummary(rawName, args);
    final status = e.pending
        ? _ToolStatus.running
        : (e.toolSuccess ? _ToolStatus.done : _ToolStatus.failed);
    final isPlan = _isPlanTool(rawName);
    final showBody = _expanded || isPlan;
    final stats = diffLineStats(rawName, args);

    /* live shell 输出 — running 工具实时累积的 chunk */
    Widget? liveProgress;
    if (e.pending && (e.liveOutput ?? '').isNotEmpty) {
      String? command;
      if (args != null) {
        for (final k in const ['command', 'cmd', 'code', 'script']) {
          final v = args[k];
          if (v is String && v.isNotEmpty) {
            command = v;
            break;
          }
        }
      }
      liveProgress = LiveOutputTail(command: command, text: e.liveOutput ?? '');
    }

    /* expanded body — 用 entry 的 args + output 走 toolr.ToolView */
    Widget? expandedBody;
    if (showBody) {
      final resultPayload = e.output != null
          ? {'content': e.output, 'ok': e.toolSuccess}
          : null;
      expandedBody = toolr.ToolView(
        toolName: rawName,
        args: args,
        result: resultPayload,
      );
    }
    return _ToolRowLayout(
      displayName: friendlyToolName(rawName),
      rawName: rawName,
      summary: summary,
      status: status,
      expanded: showBody,
      durationMs: _durationOf(args),
      dense: widget.dense,
      adds: stats.adds,
      dels: stats.dels,
      onTap: isPlan ? null : () => setState(() => _expanded = !_expanded),
      expandedChild: expandedBody,
      trailingBelow: liveProgress,
    );
  }
}

String? _extractCallId(Object? callPayload) {
  if (callPayload is! Map) return null;
  final tc = callPayload['tool_calls'];
  if (tc is List && tc.isNotEmpty && tc.first is Map) {
    final id = (tc.first as Map)['id'];
    if (id is String && id.isNotEmpty) return id;
  }
  final tcid = callPayload['tool_call_id'];
  if (tcid is String && tcid.isNotEmpty) return tcid;
  return null;
}

/// 工具名 → Material 线性图标. 覆盖桌面 agent 全部内置工具 + 手机 SDK 工具.
IconData toolIcon(String rawName) {
  final n = rawName.toLowerCase();
  if (n.contains('shell') || n.contains('terminal') || n.contains('exec')) {
    return Icons.terminal;
  }
  if (n.contains('read')) return Icons.description_outlined;
  if (n.contains('write') || n.contains('edit') || n.contains('replace')) {
    return Icons.edit_note_outlined;
  }
  if (n.contains('search') || n.contains('grep') || n.contains('glob') ||
      n.contains('find')) {
    return Icons.search;
  }
  if (n.contains('web') || n.contains('http') || n.contains('fetch') ||
      n.contains('browser') || n.contains('url')) {
    return Icons.public;
  }
  if (n.contains('calc')) return Icons.calculate_outlined;
  if (n.contains('clock') || n.contains('time')) return Icons.schedule;
  if (n.contains('plan')) return Icons.checklist;
  if (n.contains('file') || n.contains('workspace') || n.contains('folder') ||
      n.contains('ls') || n.contains('list_dir')) {
    return Icons.folder_outlined;
  }
  if (n.contains('image') || n.contains('screenshot') || n.contains('photo')) {
    return Icons.image_outlined;
  }
  if (n.contains('explore') || n.contains('task_agent')) {
    return Icons.travel_explore;
  }
  if (n.contains('task') || n.contains('agent') || n.contains('worker')) {
    return Icons.smart_toy_outlined;
  }
  if (n.contains('mcp')) return Icons.extension_outlined;
  if (n.contains('todo')) return Icons.checklist;
  if (n.contains('ask') || n.contains('question')) {
    return Icons.help_outline;
  }
  if (n.contains('pptx') || n.contains('slide')) return Icons.slideshow;
  if (n.contains('skill')) return Icons.school_outlined;
  return Icons.build_outlined;
}

/// 单行 tool layout — `[icon] name  summary  +N −M  ✓` 无边框流式行 + 展开区.
class _ToolRowLayout extends StatelessWidget {
  const _ToolRowLayout({
    required this.displayName,
    required this.summary,
    required this.status,
    required this.expanded,
    this.durationMs,
    this.rawName = '',
    this.dense = false,
    this.adds = 0,
    this.dels = 0,
    this.onTap,
    this.expandedChild,
    this.trailingBelow,
  });

  final String displayName;
  final String? summary;
  final _ToolStatus status;
  final bool expanded;

  /// 工具真实耗时 (ms) — 桌面按 runtime 时间戳算好带过来的, 没有就不显示.
  final int? durationMs;
  final String rawName;
  final bool dense;
  final int adds;
  final int dels;

  /// null 时整行不响应点击 (e.g., plan tool 永远展开, 不让用户折叠).
  final VoidCallback? onTap;
  final Widget? expandedChild;

  /// 行下方额外内容 (running 工具的 live shell 输出等), 不受 expanded 控制 — 始终显.
  final Widget? trailingBelow;

  static const double _iconSize = 15;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final mute = scheme.onSurfaceVariant;
    final isRunning = status == _ToolStatus.running;
    /* 展开区左缩进 = icon 宽 + gap, 与工具名列对齐 */
    /* 展开区对齐到行内文字起点 = 固定图标列 + 间距 (跟 TimelineRowBody 同一算法) */
    const bodyIndent = NeoxIndent.icon + NeoxIndent.gap;

    return Padding(
      /* 行间垂直节奏: 上下各 3 — 连续多工具时紧凑成"活动列表"块.
       * dense (组内嵌套) 时水平 padding 交给组容器.
       * 右 padding 收窄到 6 — 状态符号贴右缘, 摘要吃满宽度 (用户拍板). */
      padding: dense
          ? const EdgeInsets.symmetric(vertical: 2)
          : const EdgeInsets.fromLTRB(NeoxIndent.gutter, 3, 6, 3),
      child: AnimatedSize(
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
        alignment: Alignment.topCenter,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
          /* 头行 — icon + name + summary + +N/−M + status, 无边框无背景.
           * running 时标题/摘要 shimmer 扫光 (对齐桌面). */
          TimelineRow(
            onTap: onTap,
            icon: Icon(
              toolIcon(rawName.isNotEmpty ? rawName : displayName),
              size: _iconSize,
              color: isRunning
                  ? NeoxClaudePalette.coral.withValues(alpha: 0.9)
                  : mute.withValues(alpha: 0.75),
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                /* 收拢时显 +N −M; 展开看完整 diff 后仍保留小统计 */
                if (!expanded && (adds > 0 || dels > 0)) ...[
                  const SizedBox(width: 6),
                  DiffStatsChip(adds: adds, dels: dels),
                ],
                /* 耗时 — 跟桌面工具行同款 (27.2s / 3.6s), 跑完才有 */
                if (durationMs != null && durationMs! > 0) ...[
                  const SizedBox(width: 6),
                  Text(
                    formatToolDuration(durationMs!),
                    style: TextStyle(
                      fontSize: 12,
                      fontFamily: NeoxMono.family,
                      fontFamilyFallback: NeoxMono.fallback,
                      color: mute.withValues(alpha: 0.6),
                    ),
                  ),
                ],
                const SizedBox(width: NeoxSpace.sm),
                _ToolStatusGlyph(status: status),
              ],
            ),
            child: Row(
                      children: [
                        Flexible(
                          child: ShimmerText(
                            displayName,
                            active: isRunning,
                            style: TextStyle(
                              fontFamily: NeoxMono.family,
                              fontFamilyFallback: NeoxMono.fallback,
                              fontSize: 13,
                              fontWeight: FontWeight.w600,
                              color: scheme.onSurface.withValues(
                                alpha: isRunning ? 0.95 : 0.8,
                              ),
                            ),
                          ),
                        ),
                        if (summary != null) ...[
                          const SizedBox(width: NeoxSpace.sm),
                          Expanded(
                            child: ShimmerText(
                              summary!,
                              active: isRunning,
                              style: TextStyle(
                                fontFamily: NeoxMono.family,
                                fontFamilyFallback: NeoxMono.fallback,
                                fontSize: 12.5,
                                color: mute.withValues(alpha: 0.9),
                              ),
                            ),
                          ),
                        ],
                      ],
            ),
          ),
          /* 展开区 / live 输出 — 与工具名列左对齐, 去掉竖线占位 */
          if (expandedChild != null)
            Padding(
              padding: const EdgeInsets.only(left: bodyIndent, top: 4),
              child: expandedChild!,
            ),
          if (trailingBelow != null)
            Padding(
              padding: const EdgeInsets.only(left: bodyIndent, top: 4),
              child: trailingBelow!,
            ),
        ],
      ),
      ),
    );
  }
}

/// +N −M 行数 chip — 绿增红删, 对齐 Cursor / 桌面 EditDiffCard.
class DiffStatsChip extends StatelessWidget {
  const DiffStatsChip({super.key, required this.adds, required this.dels});
  final int adds;
  final int dels;

  @override
  Widget build(BuildContext context) {
    if (adds <= 0 && dels <= 0) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Text.rich(
      TextSpan(
        style: theme.textTheme.labelSmall?.copyWith(
          fontFamily: NeoxMono.family,
          fontFamilyFallback: NeoxMono.fallback,
          fontSize: 12.5,
          fontWeight: FontWeight.w600,
          height: 1,
        ),
        children: [
          if (adds > 0)
            TextSpan(
              text: '+$adds',
              style: TextStyle(color: theme.colorScheme.okInk),
            ),
          if (adds > 0 && dels > 0) const TextSpan(text: ' '),
          if (dels > 0)
            TextSpan(
              text: '−$dels',
              style: TextStyle(color: theme.colorScheme.errInk),
            ),
        ],
      ),
    );
  }
}

/// 状态 glyph — running 时跳脉冲, done/fail 时静态.
class _ToolStatusGlyph extends StatefulWidget {
  const _ToolStatusGlyph({required this.status});
  final _ToolStatus status;

  @override
  State<_ToolStatusGlyph> createState() => _ToolStatusGlyphState();
}

class _ToolStatusGlyphState extends State<_ToolStatusGlyph>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;

  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    );
    if (widget.status == _ToolStatus.running) _ctrl.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(_ToolStatusGlyph old) {
    super.didUpdateWidget(old);
    if (widget.status == _ToolStatus.running && !_ctrl.isAnimating) {
      _ctrl.repeat(reverse: true);
    } else if (widget.status != _ToolStatus.running && _ctrl.isAnimating) {
      _ctrl.stop();
      _ctrl.value = 0;
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final Widget current;
    if (widget.status == _ToolStatus.running) {
      /* 一个小圆点, 透明度 0.3→0.95 来回 — 表"还在跑". 比 ⋯ 文本柔和很多. */
      current = AnimatedBuilder(
        key: const ValueKey('running'),
        animation: _ctrl,
        builder: (_, __) {
          final t = _ctrl.value;
          final opacity = 0.3 + t * 0.65;
          return Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: theme.colorScheme.onSurfaceVariant.withValues(
                alpha: opacity,
              ),
            ),
          );
        },
      );
    } else {
      final glyph = widget.status == _ToolStatus.done ? '✓' : '✗';
      final color = widget.status == _ToolStatus.done
          ? theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.55)
          : theme.colorScheme.error;
      current = Text(
        glyph,
        key: ValueKey(widget.status),
        style: TextStyle(
          fontSize: 13,
          color: color,
          fontFamily: NeoxMono.family,
          fontFamilyFallback: NeoxMono.fallback,
        ),
      );
    }
    /* 跑动圆点 → ✓/✗ 交叉淡入 — 状态收口不硬切 (跳变闪一下很出戏) */
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 180),
      switchInCurve: Curves.easeOut,
      switchOutCurve: Curves.easeIn,
      child: current,
    );
  }
}

_ToolStatus _statusFromResult(Object? resultPayload) {
  if (resultPayload is Map) {
    if (resultPayload['ok'] == false ||
        resultPayload['error'] != null ||
        resultPayload['success'] == false) {
      return _ToolStatus.failed;
    }
  }
  return _ToolStatus.done;
}

/// 工具耗时取值 — 桌面在 tool_done 里带过来, 存在 entry.args.
int? _durationOf(Map<String, dynamic>? args) {
  final v = args?['duration_ms'];
  return v is int && v > 0 ? v : null;
}

/// "3.6s" / "27.2s" / "1m05s" — 与桌面工具行同款格式.
String formatToolDuration(int ms) {
  if (ms < 1000) return '${ms}ms';
  final s = ms / 1000;
  if (s < 60) return '${s.toStringAsFixed(1)}s';
  final m = ms ~/ 60000;
  final rem = (ms % 60000) ~/ 1000;
  return '${m}m${rem.toString().padLeft(2, '0')}s';
}
