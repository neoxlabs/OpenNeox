/// message_widgets.dart — user / agent / thinking 三种 message 渲染.
///
/// 风格 (Claude 化):
///   - UserMessage: 右对齐 chat bubble (浅色填充 + 大圆角, max 78% 宽)
///   - AgentMessage: 无气泡, 纯 markdown 文字 (像 Claude 主区域)
///   - ThinkingFold: 极简单行折叠标头 + 展开灰斜体
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../../core/edition/edition.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../../core/attachments/local_attachment_store.dart';
import 'markdown_view.dart';
import 'user_attachments.dart';
import 'streaming_typewriter.dart';
import 'timeline_row.dart';
import 'shimmer_text.dart';
import 'package:neox_app/core/i18n/tr.dart';

class UserMessage extends StatelessWidget {
  const UserMessage({
    super.key,
    required this.text,
    required this.ts,
    this.attachments = const [],
  });
  final String text;
  // ignore: unused_element_parameter
  final int ts;

  /// 这条消息带的图片 / 文件 —— 缩略图和文件 chip 挂在气泡上方, 跟 IM 一个习惯。
  final List<LocalAttachmentRef> attachments;

  @override
  Widget build(BuildContext context) {
    /* 只发了附件没打字时, 手机本地会话给气泡写的是「📎 文件名」占位 —— 附件本身已经渲染了,
     * 这行字就是重复的, 不出气泡 */
    final showText = text.trim().isNotEmpty &&
        !(attachments.isNotEmpty && _isAttachmentPlaceholder(text));
    /* RepaintBoundary 包整个 message — 列表滚动时此 layer 不重绘, 提升流畅度 */
    return RepaintBoundary(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          NeoxSpace.lg,
          NeoxSpace.sm + 2,
          NeoxSpace.lg,
          NeoxSpace.sm + 2,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            Flexible(
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  /* max 78% 屏宽, 避免长消息占满 → 仍维持气泡感. */
                  maxWidth: MediaQuery.of(context).size.width * 0.78,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (attachments.isNotEmpty)
                      Padding(
                        padding: EdgeInsets.only(bottom: showText ? NeoxSpace.xs + 2 : 0),
                        child: UserAttachments(items: attachments),
                      ),
                    if (showText)
                      Container(
                        padding: const EdgeInsets.fromLTRB(
                          NeoxSpace.md + 2,
                          NeoxSpace.sm + 2,
                          NeoxSpace.md + 2,
                          NeoxSpace.sm + 2,
                        ),
                        /* 陶土稿 v5: 暖色淡底、圆角 18、不描边 —— 跟回答正文靠底色分开, 不靠线 */
                        decoration: BoxDecoration(
                          color: ClayInk.of(context).tint,
                          borderRadius: BorderRadius.circular(18),
                        ),
                        child: MarkdownView(data: text),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static bool _isAttachmentPlaceholder(String t) {
    final s = t.trim();
    return s == '图片' || s == '（附件）' || s.split('\n').every((l) => l.trim().startsWith('📎'));
  }
}

class AgentMessage extends StatelessWidget {
  const AgentMessage({
    super.key,
    required this.text,
    required this.ts,
    this.streaming = false,
    this.streamFrozen = false,
    this.showActions = false,
    this.onRegenerate,
    this.showDisclaimer = false,
    this.versions,
    this.onSelectVersion,
  });
  final String text;
  // ignore: unused_element_parameter
  final int ts;
  /// 2026-06-24: true 时末尾加闪烁 cursor, 表示还在 streaming.
  final bool streaming;

  /// 用户已点停止 —— 正文打字机立即停帧 (chat:C9-08)。只有 streaming 时有意义。
  final bool streamFrozen;

  /// 动作条上的「重新生成」—— 只有手机上的对话给 (电脑会话的重跑要经过电脑那头).
  final VoidCallback? onRegenerate;

  /// 动作条下面那行「Neox 是 AI，也会出错」—— 对话模式最后一条回复底下 (对齐 Claude App).
  final bool showDisclaimer;

  /// 重新生成前的旧回答 (chat:C1-06) —— 非空时动作条多一个「旧版 N」入口.
  final List<String>? versions;

  /// 切回某一版旧回答; index 是 [versions] 的下标.
  final void Function(int index)? onSelectVersion;

  /// 是否在正文底下挂「复制 / 分享 / 举报」那一行。
  ///
  /// 2026-09-22 用户: 「每一次对话最后都有一行, 这个没必要；中间的……不需要；
  /// 最后一个结束后的 message, 是需要这个分享按钮的」。
  /// 原来每条 agent 正文都常驻这一行, 一轮里跑了八步工具就挂八行, 正文被按钮
  /// 切得七零八落。现在只有**对话最后那条**挂 —— 要分享的也只会是最终答复。
  final bool showActions;

  @override
  Widget build(BuildContext context) {
    /* Agent 文字纯纯展示, 无气泡无 header — Claude 风, 视觉重心是文字本身.
     * RepaintBoundary 隔离 — streaming 期间频繁 rebuild 不波及列表其他 message. */
    return RepaintBoundary(
      child: Padding(
        /* 上下 sm(8) 而不是 md(12) —— 列表本身还有 vertical 8, 两条叠起来
         * 一段文字上下就是 20, 一屏放不下几段 (2026-09-18 用户: 「间距过大」)。 */
        /* 左右 20 —— 跟过程行同一条左边线 (陶土稿 v5) */
        padding: const EdgeInsets.fromLTRB(20, NeoxSpace.sm, 20, NeoxSpace.sm),
        child: streaming
            ? StreamingTypewriter(text: text, frozen: streamFrozen)
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  MarkdownView(data: text),
                  if (showActions)
                    _MessageActions(
                      text: text,
                      onRegenerate: onRegenerate,
                      versions: versions,
                      onSelectVersion: onSelectVersion,
                    ),
                  if (showActions && showDisclaimer)
                    Padding(
                      padding: const EdgeInsets.only(top: 14, bottom: 4),
                      child: Text(
                        tr('Neox 是 AI，也会出错。'),
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.hintInk,
                        ),
                      ),
                    ),
                ],
              ),
      ),
    );
  }
}

/// 回复底下的动作条: 复制 / 分享.
///
/// 2026-08-11 走查: 之前一条都没有。正文虽然 selectable, 但手机上手动拖选一段
/// 长回复非常痛, 而"把 agent 写的东西拿出去用"恰恰是最高频的动作。
///
/// 为什么不是长按弹菜单: MarkdownBody(selectable: true) 已经把长按占用于文本
/// 选择了, 两者会打架。所以做成常驻但极轻的一行 —— 图标 16px、40% 透明度,
/// 不抢正文的视觉重心 (Claude 手机端同款处理)。
class _MessageActions extends StatefulWidget {
  const _MessageActions({
    required this.text,
    this.onRegenerate,
    this.versions,
    this.onSelectVersion,
  });
  final String text;
  final VoidCallback? onRegenerate;
  final List<String>? versions;
  final void Function(int index)? onSelectVersion;

  @override
  State<_MessageActions> createState() => _MessageActionsState();
}

class _MessageActionsState extends State<_MessageActions> {
  bool _copied = false;
  bool _showVersions = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.text));
    if (!mounted) return;
    /* 就地变成勾 2 秒 —— 比弹一条 SnackBar 轻, 也不会盖住正文 */
    setState(() => _copied = true);
    await Future<void>.delayed(const Duration(seconds: 2));
    if (mounted) setState(() => _copied = false);
  }

  Future<void> _share() async {
    final box = context.findRenderObject() as RenderBox?;
    await Share.share(
      widget.text,
      sharePositionOrigin:
          box == null ? null : box.localToGlobal(Offset.zero) & box.size,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.text.trim().isEmpty) return const SizedBox.shrink();
    final mute = Theme.of(context).colorScheme.onSurfaceVariant;
    final versions = widget.versions ?? const <String>[];
    final canSwitch = versions.isNotEmpty && widget.onSelectVersion != null;
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _ActionIcon(
                icon: _copied ? Icons.check_rounded : Icons.copy_rounded,
                tooltip: _copied ? tr('已复制') : tr('复制'),
                color: mute,
                onTap: _copy,
              ),
              _ActionIcon(
                icon: Icons.ios_share,
                tooltip: tr('分享'),
                color: mute,
                onTap: _share,
              ),
              if (widget.onRegenerate != null)
                _ActionIcon(
                  icon: Icons.refresh_rounded,
                  tooltip: tr('重新生成'),
                  color: mute,
                  onTap: widget.onRegenerate!,
                ),
              /* chat:C1-06: 重新生成过 — 旧答案还留着, 点这里展开 / 切回.
               * 图标跟「重新生成」区分开 (history 而不是 refresh), 避免两个 ↻ 打架. */
              if (canSwitch)
                _ActionIcon(
                  icon: Icons.history_rounded,
                  tooltip: tr('旧版回答'),
                  color: mute,
                  onTap: () => setState(() => _showVersions = !_showVersions),
                ),
              /* 举报 — App Store 审核指南 1.2 要求 AI 生成内容有可达的举报入口。
               * 放在这条已有的动作条里而不是做成长按菜单: 长按是隐藏手势, 审核员
               * 找不到就等于没有; 这里跟复制/分享并排, 一眼可见。
               * 图标用描边 flag 且同为 mute 色 —— 它不该比"复制"更显眼, 举报是极低频动作。 */
              /* 举报要把内容送到服务方 —— 有收件的一方才有这个按钮 (发行版提供)。 */
              Consumer(
                builder: (context, ref, _) {
                  final report = ref.read(editionProvider).contentReporter;
                  if (report == null) return const SizedBox.shrink();
                  return _ActionIcon(
                    icon: Icons.flag_outlined,
                    tooltip: tr('举报'),
                    color: mute,
                    onTap: () => report(context, ref, text: widget.text),
                  );
                },
              ),
            ],
          ),
          if (_showVersions && canSwitch)
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 2),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var i = versions.length - 1; i >= 0; i--)
                    _VersionTile(
                      label: tr('旧版 ${versions.length - i}'),
                      text: versions[i],
                      onTap: () {
                        setState(() => _showVersions = false);
                        widget.onSelectVersion!(i);
                      },
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// 一条旧回答的折叠行 — 点一下切回这一版 (当前那版会顶替它留在列表里).
class _VersionTile extends StatelessWidget {
  const _VersionTile({
    required this.label,
    required this.text,
    required this.onTap,
  });
  final String label;
  final String text;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.45),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    label,
                    style: theme.textTheme.labelMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  Text(
                    tr('切回这一版'),
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 3),
              Text(
                text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ActionIcon extends StatelessWidget {
  const _ActionIcon({
    required this.icon,
    required this.tooltip,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkResponse(
        onTap: onTap,
        radius: 18,
        child: Padding(
          /* 图标 17px 但点击区 40px —— 视觉要轻, 手指要够得着 */
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          /* 不再 `color × 0.55`.
           * color 传进来的已经是 onSurfaceVariant (对底 4.9), 再乘 0.55 掉到 2.4 ——
           * 又一处"在已经够浅的色上再乘一次 alpha"。实拍这三个图标淡到快看不见,
           * 而它们是**用户唯一能对一条回答做的三件事**。 */
          child: Icon(icon, size: 17, color: color),
        ),
      ),
    );
  }
}

/// Markdown 内容 + 末尾闪烁 cursor (▍). chunk 到达即刻 rebuild Markdown 不延迟,
/// 视觉上"加了 cursor" → 接近桌面端"在打字"感受.
/// Thinking 段 — 单行 `thinking · 4s ▸`, 点击展开正文.
///
/// 流式中 (streaming=true): 标头 shimmer 扫光 + 实时跳秒 (对齐桌面).
/// 完成后: 静态 `thinking · 4s` (durationMs 由状态机写入; 历史回放无值不显).
class ThinkingFold extends StatefulWidget {
  const ThinkingFold({
    super.key,
    required this.text,
    required this.ts,
    this.streaming = false,
    this.durationMs,
    this.dense = false,
  });
  final String text;

  /// 首 delta 时间戳 — streaming 时实时计秒的基准.
  final int ts;
  final bool streaming;
  final int? durationMs;

  /// 组内嵌套 — 水平内边距交给组容器, 自己不再叠一层.
  /// (不加这个的话组里的"思考"比同组的工具行右移一个 gutter, 就是明康看到的没对齐)
  final bool dense;

  @override
  State<ThinkingFold> createState() => _ThinkingFoldState();
}

class _ThinkingFoldState extends State<ThinkingFold> {
  bool _expanded = false;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _syncTimer();
  }

  @override
  void didUpdateWidget(ThinkingFold old) {
    super.didUpdateWidget(old);
    if (old.streaming != widget.streaming) _syncTimer();
  }

  void _syncTimer() {
    if (widget.streaming) {
      /* 每秒跳一次 — 只重建标头这一小块 (setState 于本 fold) */
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

  String _label() {
    int? ms = widget.durationMs;
    if (ms == null && widget.streaming) {
      ms = DateTime.now().millisecondsSinceEpoch - widget.ts;
    }
    /* 过滤 hydrate 假时长 (now - 事件 ts → 动辄数分钟) */
    if (ms != null && ms > 3 * 60 * 1000) ms = null;
    /* 对齐桌面: 流式 "思考中 · Ns", 完成 "思考 · Ns"。
     * 文字里原来还带一个 ▸/▾, 行尾又有展开图标 —— 同一件事画了两遍, 去掉文字那个 */
    final head = widget.streaming ? tr('思考中') : tr('思考');
    if (ms == null) return head;
    if (widget.streaming && ms < 1000) return head;
    final s = ms < 1000 ? 1 : (ms / 1000).round();
    final t = s >= 60 ? '${s ~/ 60}m${s % 60}s' : '${s}s';
    return '$head · $t';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    /* 走统一行骨架: thinking 行以前没图标, 文字直接顶在 gutter 上, 比同屏所有
     * 工具行都靠左一截 —— 这就是"思考没对齐"。现在补一个图标占住那 18px 列。 */
    return Padding(
      padding: widget.dense
          ? const EdgeInsets.symmetric(vertical: 2)
          : const EdgeInsets.fromLTRB(
              NeoxIndent.gutter,
              2,
              NeoxIndent.gutter,
              2,
            ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TimelineRow(
            onTap: () => setState(() => _expanded = !_expanded),
            verticalPadding: 4,
            icon: Icon(
              Icons.psychology_outlined,
              size: 14,
              color: mute.withValues(alpha: 0.75),
            ),
            trailing: Icon(
              _expanded ? Icons.expand_less : Icons.expand_more,
              size: 15,
              color: mute.withValues(alpha: 0.5),
            ),
            child: ShimmerText(
              _label(),
              active: widget.streaming,
              /* 正文字体, 不用等宽 (2026-09-24 用户: 「工具字体和 message 字体协调」)。
               * 等宽 + 字距 0.4 的「Thinking · 5s」夹在圆体正文和工具行中间, 像终端日志贴进来的。
               * 字号字重跟工具摘要行 (tool_group_row) 同一档。 */
              style: theme.textTheme.bodySmall?.copyWith(
                color: mute,
                fontWeight: FontWeight.w500,
                fontSize: 14,
                height: 1.35,
              ),
            ),
          ),
          if (_expanded)
            TimelineRowBody(
              child: MarkdownView(data: widget.text, muted: true),
            ),
        ],
      ),
    );
  }
}
