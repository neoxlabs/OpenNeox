/// streaming_widgets.dart — agent 流式 in-flight 渲染.
///
/// 整体 row = StreamingTurnRow (顶 header + 内部 thinking/text/tool 三段动态).
///   - 流式 thinking 子卡 (StreamingThinking)
///   - 流式 tool pill (StreamingToolPill, 复用 StatusBadge)
///   - 流式 text + cursor blink (StreamingText)
///   - pendingFirstToken 时显 TypingDots ("思考中…")
///
/// 状态分流:
///   pendingFirstToken=true → TypingDots
///   else → 按 buffer 内容动态显示 thinking / tool / text 各段
library;

import 'package:flutter/material.dart';

import '../../../shared/theme/neox_tokens.dart';

import '../../../core/network/stream_buffer_provider.dart';
import '../models/payload_utils.dart';
import 'common.dart';
import 'markdown_view.dart';
import 'typing_dots.dart';
import 'package:neox_app/core/i18n/tr.dart';

class StreamingTurnRow extends StatelessWidget {
  const StreamingTurnRow({super.key, required this.turn});
  final StreamingTurn turn;

  @override
  Widget build(BuildContext context) {
    final ts = DateTime.now().millisecondsSinceEpoch;
    final hasThinking = turn.thinkingBuffer.isNotEmpty;
    final hasText = turn.textBuffer.isNotEmpty;
    /* ⚠️ 注意: hasTools 故意不参与渲染分流.
     *   runningTools 已经由 drift orphan tool_call 渲染 (ToolBlock 里 status=running
     *   时直接 watch runningToolProgressProvider 拿 live 输出). 这里再渲就会出现
     *   "drift 显一份 + streaming buffer 再显一份" 的双图, 而且后者永远落在 timeline 末尾,
     *   导致 agent 的最终文字总在工具上方 — 用户报的"跳"和"工具到最后了"就这。 */
    final isWaitingFirstToken =
        turn.pendingFirstToken || (!hasThinking && !hasText);
    /* 纯 in-flight 状态 (没文字、没思考、也没 placeholder) — 不渲, 由 drift orphan 承担。 */
    if (!hasText && !hasThinking && !turn.pendingFirstToken) {
      return const SizedBox.shrink();
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoxIndent.gutter, 8, NeoxIndent.gutter, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          MiniHeader(label: 'AGENT', ts: ts),
          if (isWaitingFirstToken)
            const TypingDots()
          else ...[
            if (hasThinking)
              StreamingThinking(
                text: turn.thinkingBuffer.toString(),
                done: turn.thinkingDone,
              ),
            if (hasText)
              StreamingText(
                text: turn.textBuffer.toString(),
                done: turn.textDone,
              ),
          ],
        ],
      ),
    );
  }
}

/// 流式 agent text — 全程 MarkdownView 渲染, 跟 done 后的 AgentMessage 完全同一份样式,
/// 流完没有"啪一下重排"的最终渲染感.
///
/// strip JSON 块同 message_row 防御 — 半截 `{"command":` 还没闭合不会匹配, 自然保留,
/// 等下一帧凑齐 `}` 才一起消失. 用 ValueKey 让 MarkdownBody 内部缓存命中, 减少重 parse.
class StreamingText extends StatelessWidget {
  const StreamingText({super.key, required this.text, required this.done});
  final String text;
  final bool done;

  @override
  Widget build(BuildContext context) {
    final clean = stripStandaloneJson(text);
    if (clean.isEmpty && !done) {
      /* 全是 tool args JSON, 真文字还没开始 — 不显空白 */
      return const SizedBox.shrink();
    }
    return MarkdownView(data: clean);
  }
}

/// 流式 thinking — 极简: "thinking" label + 灰小字内容, 无 spinner 无 border 无背景.
class StreamingThinking extends StatelessWidget {
  const StreamingThinking({super.key, required this.text, required this.done});
  final String text;
  final bool done;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            done ? 'thinking' : 'thinking…',
            style: TextStyle(
              color: mute,
              fontSize: 12,
              letterSpacing: 0.4,
              fontWeight: FontWeight.w600,
              fontFamily: NeoxMono.family,
              fontFamilyFallback: NeoxMono.fallback,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            text,
            style: TextStyle(
              color: mute,
              fontSize: 12.5,
              height: 1.45,
            ),
          ),
        ],
      ),
    );
  }
}

/// 流式 tool pill — 极简单行: `name · summary  ✓/⋯/✗`.
class StreamingToolPill extends StatelessWidget {
  const StreamingToolPill({super.key, required this.tool});
  final RunningTool tool;

  String _glyph() {
    if (!tool.done) return '⋯';
    return tool.ok ? '✓' : '✗';
  }

  Color _glyphColor(BuildContext ctx) {
    final theme = Theme.of(ctx);
    if (!tool.done) return theme.colorScheme.onSurfaceVariant;
    return tool.ok
        ? theme.colorScheme.onSurfaceVariant.withValues(alpha: 0.7)
        : theme.colorScheme.error;
  }

  String? _summary() {
    final args = tool.args;
    for (final k in const ['file_path', 'path', 'command', 'query', 'pattern', 'url']) {
      final v = args[k];
      if (v is String && v.isNotEmpty) {
        return v.length > 50 ? '${v.substring(0, 47)}…' : v;
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    final summary = _summary();
    final progress = tool.progressBuffer.toString();
    final hasProgress = !tool.done && progress.isNotEmpty;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                friendlyToolName(tool.toolName),
                style: TextStyle(
                  fontFamily: NeoxMono.family,
                  fontFamilyFallback: NeoxMono.fallback,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: theme.colorScheme.onSurface,
                ),
              ),
              if (summary != null) ...[
                Text(
                  '  ·  ',
                  style: TextStyle(fontSize: 12.5, color: mute.withValues(alpha: 0.5)),
                ),
                Flexible(
                  child: Text(
                    summary,
                    style: TextStyle(
                      fontFamily: NeoxMono.family,
                      fontFamilyFallback: NeoxMono.fallback,
                      fontSize: 12.5,
                      color: mute,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ] else
                const Spacer(),
              const SizedBox(width: 8),
              Text(
                _glyph(),
                style: TextStyle(
                  fontSize: 13,
                  color: _glyphColor(context),
                  fontFamily: NeoxMono.family,
                  fontFamilyFallback: NeoxMono.fallback,
                ),
              ),
            ],
          ),
          if (hasProgress)
            LiveOutputTail(
              command: _extractCommand(tool.args),
              text: progress,
            ),
        ],
      ),
    );
  }

  String? _extractCommand(Map<String, dynamic> args) {
    for (final k in const ['command', 'cmd', 'code', 'script']) {
      final v = args[k];
      if (v is String && v.isNotEmpty) return v;
    }
    return null;
  }
}

/// 实时输出尾部 N 行 — 长命令的"还在跑"反馈, 渲成真正的终端卡片:
///   - macOS 风格的窗口装饰 (左上三色点)
///   - "$ command" 头 (绿 prompt)
///   - 尾部最多 8 行输出, 灰白文字
///   - 闪烁底部 ▍ 光标暗示"still running"
///
/// done=true 时由 onToolDone / onToolFinalCommit 自动释放 — 本 widget 消失,
/// 让位给 drift 的正式 tool_result (folded shell result).
class LiveOutputTail extends StatefulWidget {
  const LiveOutputTail({super.key, required this.command, required this.text});
  final String? command;
  final String text;

  @override
  State<LiveOutputTail> createState() => LiveOutputTailState();
}

class LiveOutputTailState extends State<LiveOutputTail>
    with SingleTickerProviderStateMixin {
  late final AnimationController _cursor;

  @override
  void initState() {
    super.initState();
    _cursor = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _cursor.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final allLines = widget.text.split('\n');
    final tail = allLines.length > 8
        ? allLines.sublist(allLines.length - 8)
        : allLines;
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 6, 0, 4),
      child: Container(
        decoration: BoxDecoration(
          color: const Color(0xFF14141A),
          borderRadius: NeoxRadius.smallR,
          border: Border.all(
            color: const Color(0xFF2A2A33),
            width: 0.5,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            /* 终端窗口 header — 三色点 + 命令缩略 */
            Container(
              decoration: const BoxDecoration(
                color: Color(0xFF1F1F26),
                borderRadius: BorderRadius.vertical(top: Radius.circular(6)),
              ),
              padding: const EdgeInsets.fromLTRB(8, 6, 10, 6),
              child: Row(
                children: [
                  const _DotCluster(),
                  const SizedBox(width: 10),
                  if (widget.command != null)
                    Flexible(
                      child: Text(
                        widget.command!,
                        style: const TextStyle(
                          fontFamily: NeoxMono.family,
                          fontFamilyFallback: NeoxMono.fallback,
                          fontSize: 11.5,
                          color: Color(0xFF8A8A92),
                          height: 1.3,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    )
                  else
                    const Text(
                      'shell',
                      style: TextStyle(
                        fontFamily: NeoxMono.family,
                        fontFamilyFallback: NeoxMono.fallback,
                        fontSize: 11.5,
                        color: Color(0xFF8A8A92),
                      ),
                    ),
                ],
              ),
            ),
            /* prompt + 输出体 */
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (widget.command != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            const Text(
                              '\$ ',
                              style: TextStyle(
                                fontFamily: NeoxMono.family,
                                fontFamilyFallback: NeoxMono.fallback,
                                fontSize: 12.5,
                                color: Color(0xFF7BC97A),
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            Text(
                              widget.command!,
                              style: const TextStyle(
                                fontFamily: NeoxMono.family,
                                fontFamilyFallback: NeoxMono.fallback,
                                fontSize: 12.5,
                                color: Color(0xFFE6E6E6),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  if (allLines.length > 8)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        tr('… ${allLines.length - 8} 行省略'),
                        style: const TextStyle(
                          fontFamily: NeoxMono.family,
                          fontFamilyFallback: NeoxMono.fallback,
                          fontSize: 11,
                          color: Color(0xFF5A5A62),
                        ),
                      ),
                    ),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(
                          tail.join('\n'),
                          style: const TextStyle(
                            fontFamily: NeoxMono.family,
                            fontFamilyFallback: NeoxMono.fallback,
                            fontSize: 12,
                            height: 1.5,
                            color: Color(0xFFCFCFCF),
                          ),
                        ),
                        FadeTransition(
                          opacity: _cursor,
                          child: Container(
                            width: 6,
                            height: 12,
                            margin: const EdgeInsets.only(left: 2, bottom: 1),
                            color: const Color(0xFF7BC97A),
                          ),
                        ),
                      ],
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

/// macOS 风格的窗口三色点 — 红 / 黄 / 绿.
class _DotCluster extends StatelessWidget {
  const _DotCluster();
  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: const [
        _Dot(color: Color(0xFFFF5F57)),
        SizedBox(width: 5),
        _Dot(color: Color(0xFFFEBC2E)),
        SizedBox(width: 5),
        _Dot(color: Color(0xFF28C840)),
      ],
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot({required this.color});
  final Color color;
  @override
  Widget build(BuildContext context) => Container(
        width: 8,
        height: 8,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      );
}
