/// timeline_message_list.dart — 抽出 TimelinePage 的消息列表区, 让 HomeStage 复用.
///
/// 包含:
///   - ListView.builder(reverse=true) 渲染所有 entries
///   - pending user text (用户发了但 agent 还没 ack)
///   - "思考中" typing placeholder (agent 在跑但还没 streaming)
///   - 空消息 hint (可选, 由调用方传 emptyChild 覆盖)
///
/// 不含: AppBar, Composer, banners, status bar. 这些由调用方组装.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/attachments/local_attachment_store.dart';
import '../../../core/network/history_load_status.dart';
import '../../../core/network/stream_buffer_provider.dart';
import '../../../core/network/ws_client_provider.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../../shared/widgets/neox_mark_loader.dart';
import '../../home/state/session_location_provider.dart';
import '../state/timeline_state.dart';
import 'agent_activity_rows.dart';
import 'message_row.dart';
import 'message_widgets.dart';
import 'process_row.dart';
import 'shimmer_text.dart';
import 'tool_group_row.dart';
import 'typing_dots.dart';
import 'package:neox_app/core/i18n/tr.dart';
import '../../pilot/pilot_patrol_filter.dart';

class TimelineMessageList extends ConsumerStatefulWidget {
  const TimelineMessageList({
    super.key,
    required this.sessionId,
    this.onPickModel,
    this.onRetry,
    this.emptyChild,
    this.optimisticUserText,
    this.optimisticAttachments = const [],
    this.onRegenerate,
    this.onSelectVersion,
    this.mode,
  });

  final String sessionId;

  /// 按模式分的时间线 (陶土稿 v5): 一轮的工具 / 思考 / 中间话收成一行「过程」, 回答留在外面。
  /// null = 旧的连续工具成组 (Pilot / 出图这些不分模式的页面)。
  final TimelineMode? mode;
  final Future<void> Function()? onPickModel;

  /// 最后一条回复的「重新生成」—— 只对手机本地会话生效 (列表自己判断, 调用方只管给).
  final Future<void> Function()? onRegenerate;

  /// 切回旧版回答 (chat:C1-06) — 参数是 user_message 的 seq 和版本下标.
  final void Function(int anchorSeq, int index)? onSelectVersion;

  /// 错误卡「重试」— 走 session.input control:retry.
  final Future<void> Function()? onRetry;

  /// 当 entries / pending / typing 都空时显示的占位. null 时显默认 "暂无消息".
  final Widget? emptyChild;

  /// 「刚按下发送」的占位文本 —— 会话已建好但真 pending 气泡还没到的那一帧用它兜住.
  /// 见 features/home/state/submitting_provider.dart。
  final String? optimisticUserText;

  /// 同一个占位气泡带的图 / 文件
  final List<LocalAttachmentRef> optimisticAttachments;

  @override
  ConsumerState<TimelineMessageList> createState() =>
      _TimelineMessageListState();
}

class _TimelineMessageListState extends ConsumerState<TimelineMessageList> {
  /// 已见过的渲染项 key — 首帧全量标记不动画, 之后新出现的项做进入动画.
  final Set<String> _seenKeys = {};
  bool _firstBuildDone = false;

  /// 向上翻页 (滚到最旧处自动拉更早历史) — 单飞行 + 到底后不再打扰.
  bool _loadingOlder = false;
  bool _noMoreOlder = false;

  /* 往上翻着看旧消息时发了一句 → 回到底部看自己这句和回复 (2026-10-14 真机: 发完列表停在原地, 像没发出去) */
  final ScrollController _scroll = ScrollController();
  int? _lastPendingTs;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _followNewPending(int? ts) {
    if (ts == null || ts == _lastPendingTs) return;
    _lastPendingTs = ts;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients || _scroll.offset <= 0) return;
      _scroll.animateTo(0, duration: const Duration(milliseconds: 260), curve: Curves.easeOutCubic);
    });
  }

  @override
  void didUpdateWidget(covariant TimelineMessageList old) {
    super.didUpdateWidget(old);
    if (old.sessionId != widget.sessionId) {
      _seenKeys.clear();
      _firstBuildDone = false;
      _loadingOlder = false;
      _noMoreOlder = false;
    }
  }

  Future<void> _maybeLoadOlder() async {
    if (_loadingOlder || _noMoreOlder) return;
    if (widget.sessionId.startsWith('phone-')) return; // 本地会话无翻页
    _loadingOlder = true;
    try {
      final page = await ref
          .read(wsClientProvider.notifier)
          .loadOlderHistory(widget.sessionId);
      /* **只有真的到头了**才关掉翻页。
       * 原来是 `fetched == 0 → _noMoreOlder = true`, 而失败也返回 0 ——
       * 一次超时就把这一页的向上翻页永久关掉, 用户再怎么往上拉都不会再请求,
       * 而界面从头到尾一个字都不说 (2026-09-18「历史会话 无法传输加载」)。 */
      if (page.reachedEnd) _noMoreOlder = true;
    } catch (_) {
      /* 抛出来的也是失败, 同样不关翻页 —— 用户再拉一次会重试 */
    } finally {
      _loadingOlder = false;
    }
  }

  bool _onScroll(ScrollNotification n) {
    /* reverse=true: maxScrollExtent 方向 = 最旧消息. 逼近顶部 300px 内预拉. */
    if (n.metrics.pixels >= n.metrics.maxScrollExtent - 300 &&
        n.metrics.maxScrollExtent > 0) {
      _maybeLoadOlder();
    }
    return false;
  }

  /// 首帧的项不动画 (打开即静态呈现历史); 之后 build 中第一次出现的 key 动画.
  bool _shouldAnimate(String key) {
    if (_seenKeys.contains(key)) return false;
    _seenKeys.add(key);
    return _firstBuildDone;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sessionId = widget.sessionId;
    final snap = ref.watch(timelineStateProvider(sessionId));
    /* Pilot 巡检: 没事的那轮整轮不显示, 有事只藏触发 (features/pilot/pilot_patrol_filter.dart) */
    final entries = dropPilotPatrolNoise(snap.entries
        .where((e) => e.kind != 'session_meta')
        .toList(growable: false));
    var pending = ref.watch(pendingUserTextProvider(sessionId));
    _followNewPending(pending?.ts);
    /* 回显已经在列表里了, 占位就不再画 (2026-10-11 真机: 同一句话两条)。
     * 回显走实时那条路会自己清占位; 但新会话的回显常常是订阅补发进来的, 那条路不清 —— 这里兜住并顺手清掉 */
    if (pending != null) {
      final p = pending;
      final key = p.text.trim().replaceAll(RegExp(r'\s+'), ' ');
      final echoed = entries.any((e) =>
          e.kind == 'user_message' &&
          (e.text ?? '').trim().replaceAll(RegExp(r'\s+'), ' ') == key &&
          e.createdAtMs >= p.ts - 2000);
      if (echoed) {
        pending = null;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) ref.read(streamBufferProvider.notifier).clearPendingUserText(sessionId);
        });
      }
    }

    /* 会话刚建好、真 pending 气泡还没落下来 → 先渲染调用方给的占位气泡,
     * 否则这一帧是「还没有消息」的空白屏 (2026-09-18 用户实拍)。 */
    if (entries.isEmpty &&
        pending == null &&
        widget.optimisticUserText != null) {
      return ListView(
        reverse: true,
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          /* 跟回复正文同一条左边距 —— 原来没包, 「思考中」贴着屏幕左边被切掉一截 (2026-10-05 真机) */
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: NeoxIndent.gutter),
            child: TypingDots(),
          ),
          UserMessage(
            text: widget.optimisticUserText!,
            ts: DateTime.now().millisecondsSinceEpoch,
            attachments: widget.optimisticAttachments,
          ),
        ],
      );
    }

    if (entries.isEmpty && pending == null && !snap.agentRunning) {
      /* 电脑/云端会话本地还没缓存时, 空白不代表"没有消息" —— 多半是还没同步下来。
       * 原来一律写「暂无消息」, 断网时点开一个聊了几十轮的会话也这么说, 像数据丢了。 */
      final isLocal =
          sessionId.startsWith('phone-') || sessionId.startsWith('img-');
      final conn = isLocal
          ? WsConnectionState.connected
          : ref.watch(wsClientProvider.select((s) => s.connection));
      /* 历史到底是"没有"还是"没拉到" —— 这两件事以前都写「还没有消息」。
       * 连着电脑却拉失败是最常见的那一种, 而它长得跟空会话一模一样,
       * 用户只会认为消息丢了 (2026-09-18「历史会话 无法传输加载」)。 */
      final history = isLocal
          ? HistoryLoadStatus.idle
          : ref.watch(historyLoadStatusProvider(sessionId));
      if (history.phase == HistoryLoadPhase.otherDesktop) {
        return _HistoryProblem(
          text: history.desktopName == null
              ? tr('这条会话在另一台电脑上，连上那台才能看')
              : tr('这条会话在「${history.desktopName}」上，连上它才能看'),
          actionLabel: tr('去切换电脑'),
          onAction: () => context.push('/settings/devices'),
        );
      }
      if (history.phase == HistoryLoadPhase.failed) {
        return _HistoryProblem(
          text: tr('历史消息没拉下来'),
          actionLabel: tr('重试'),
          onAction: () => ref
              .read(wsClientProvider.notifier)
              .attachOrCatchUp(sessionId),
        );
      }

      /* 在等 (连电脑 / 拉历史) 就给品牌圆环动画 —— 一行静止灰字看着像卡死了
       * (2026-09-25 用户: 「加载聊天记录要有 logo 的动画」)。
       * 真的空 / 没连上 仍是静态一句话: 不在等的时候不许转。 */
      final waiting = !isLocal &&
          (conn == WsConnectionState.connecting ||
              (conn == WsConnectionState.connected &&
                  history.phase == HistoryLoadPhase.loading));
      if (waiting && widget.emptyChild == null) {
        return Center(
          child: NeoxMarkLoader(
            label: conn == WsConnectionState.connecting
                ? tr('正在连接电脑…')
                : tr('正在同步消息…'),
          ),
        );
      }
      final emptyText = switch (conn) {
        _ when isLocal => tr('还没有消息'),
        WsConnectionState.connected =>
          history.phase == HistoryLoadPhase.loading ? tr('正在同步消息…') : tr('还没有消息'),
        /* 2026-09-22: 原来 connecting 也说「正在同步消息…」—— 但那一刻**还没连上**,
         * 同步根本无从开始。用户实录: 打开一个在 Windows 那台的会话, 屏幕中央一直
         * 挂着「正在同步消息…」, 看着像在下载数据, 实际是在反复连一台不在线的电脑,
         * 等多久都不会动。连接中就说连接中 —— 是什么就是什么。 */
        WsConnectionState.connecting => tr('正在连接电脑…'),
        _ => tr('连上电脑后显示消息'),
      };
      /* 真的空 (刚建的会话): 不是一行「还没有消息」—— 说清在哪跑、可以直接说要做什么 (2026-10-15 远程实测:
       * 从电脑页新建编码进来, 一屏只有一行灰字, 不知道下一步) */
      final trulyEmpty = isLocal || (conn == WsConnectionState.connected && history.phase != HistoryLoadPhase.loading);
      if (widget.emptyChild == null && trulyEmpty) {
        return _FreshSessionHint(sessionId: sessionId, mode: widget.mode);
      }
      return widget.emptyChild ??
          Center(
            child: Text(
              emptyText,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          );
    }
    /* 连续 tool 收拢成组 (对齐桌面 explore_group) — O(n) 一次 */
    /* 走带单槽缓存的版本 —— streaming 期间这个 build 每 32ms 跑一次, 而绝大多数
     * 次数里 entries 是同一个 List 实例 (provider 只在内容真变时换新对象)。
     * 见 groupToolEntriesCached 的说明。 */
    final mode = widget.mode;
    final items = mode == null
        ? groupToolEntriesCached(entries)
        : buildTurnItemsCached(entries, running: snap.agentRunning, mode: mode);

    /* "思考中..." 占位行 — 只在 agent 在跑、但末尾不是 streaming text 时显示.
     *   若末尾已经在 streaming text (cursor 闪烁) 就不重复占位。 */
    /* 还没吐出字的空 streaming 文本行不算 —— 它画出来是空的, 却把「思考中」顶掉了:
     * 网关在上游渠道之间重试的十几秒里, 屏幕上只剩用户气泡 (2026-10-05 用户: 「像 UI 被卡住」)。 */
    final last = entries.isNotEmpty ? entries.last : null;
    final lastIsStreaming =
        last != null &&
        last.streaming &&
        ((last.kind == 'agent_text' && (last.text ?? '').trim().isNotEmpty) ||
            last.kind == 'agent_thinking');
    /* 末尾是 running 工具组时, 组行自带 shimmer — typing dots 不再重复占位 */
    /* 末尾是跑着的过程行时同理 —— 它自己画当前一步 / 「思考中」 */
    final lastIsRunningTool =
        items.isNotEmpty &&
        switch (items.last) {
          ToolGroupRenderItem(:final anyRunning) => anyRunning,
          ProcessRenderItem(:final anyRunning) => anyRunning,
          _ => false,
        };
    /* 2026-10-22 用户: 「只能通过按钮看它是不是在运行」—— 跑着时列表最底下**永远**挂一行状态 (转圈 + 扫光字),
     * 不再因为末尾在流字 / 末尾过程行自带当前一步就藏起来。末尾什么都没有时写「思考中」, 否则写「运行中」。 */
    final showTyping = snap.agentRunning && !snap.streamFrozen;
    final statusLabel = !lastIsStreaming && !lastIsRunningTool ? tr('思考中') : tr('运行中');
    /* 「刚发送」占位气泡的位置 (2026-09-17)。原来永远画在列表最后 —— 回显没到之前
     * agent 已经开始流式输出时, 回复长在你这句话**上面**, 你的话钉在最底下。
     * 现在放到"发送之后才建出来的 entry"前面; entry.createdAtMs 和 pending.ts 都是手机时钟。 */
    var pendingPos = items.length;
    if (pending != null) {
      for (var j = items.length - 1; j >= 0; j--) {
        final it = items[j];
        final first = switch (it) {
          SingleRenderItem(:final entry) => entry,
          ToolGroupRenderItem(:final entries) => entries.first,
          ProcessRenderItem(:final entries) => entries.first,
          FilesFooterRenderItem(:final edits) => edits.first,
        };
        if (first.createdAtMs <= pending.ts) break;
        pendingPos = j;
      }
    }
    final itemCount =
        items.length + (pending != null ? 1 : 0) + (showTyping ? 1 : 0);
    final isPhoneChat = sessionId.startsWith('phone-');
    final list = NotificationListener<ScrollNotification>(
      onNotification: _onScroll,
      child: ListView.builder(
        controller: _scroll,
        reverse: true,
        cacheExtent: 1200,
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: itemCount,
        itemBuilder: (context, i) {
          /* reverse=true: i=0 是屏幕底 = 时间最新. */
          final chronologicalIndex = itemCount - 1 - i;
          if (pending != null && chronologicalIndex == pendingPos) {
            final k = 'pending-${pending.ts}';
            return EntryAppear(
              key: ValueKey(k),
              animate: _shouldAnimate(k),
              child: UserMessage(text: pending.text, ts: pending.ts, attachments: pending.attachments),
            );
          }
          /* 占位气泡插在 pendingPos, 其后的 items 下标整体后移一位 */
          final itemIndex = pending != null && chronologicalIndex > pendingPos
              ? chronologicalIndex - 1
              : chronologicalIndex;
          if (itemIndex < items.length) {
            final item = items[itemIndex];
            final child = switch (item) {
              SingleRenderItem(:final entry) => MessageRow.fromEntry(
                entry,
                onPickModel: widget.onPickModel,
                onRetry: widget.onRetry == null
                    ? null
                    : () {
                        widget.onRetry!();
                      },
                sessionId: sessionId,
                /* 只有**对话最后那条**正文挂复制/分享/举报 (2026-09-22 用户:
                 * 「每一次对话最后都有一行, 这个没必要；中间的……不需要；
                 *  最后一个结束后的 message, 是需要这个分享按钮的」)。
                 * 一轮里跑八步工具就有八段正文, 原来每段都挂一行按钮,
                 * 正文被切得七零八落。 */
                showActions: itemIndex == items.length - 1,
                /* 手机上的对话: 最后一条回复多一个 ↻ 和一行「会出错」提示 (对齐 Claude App)。
                 * 跑着的时候不给 ↻ —— 那一刻重新生成会跟正在写的回答打架。 */
                onRegenerate:
                    isPhoneChat &&
                        !snap.agentRunning &&
                        pending == null &&
                        widget.onRegenerate != null
                    ? () {
                        widget.onRegenerate!();
                      }
                    : null,
                /* 旧版回答入口只在手机对话里给 —— 电脑会话的版本由电脑那头管. */
                onSelectVersion:
                    isPhoneChat && !snap.agentRunning
                    ? widget.onSelectVersion
                    : null,
                showDisclaimer: isPhoneChat && !snap.agentRunning,
                /* 点停止后残留的正文不出、打字机停帧 (chat:C9-08) */
                streamFrozen: snap.streamFrozen,
              ),
              ToolGroupRenderItem() => ToolGroupRow(
                group: item,
                sessionId: sessionId,
              ),
              ProcessRenderItem() => ProcessRow(
                process: item,
                mode: mode ?? TimelineMode.work,
                sessionId: sessionId,
                plan: item.isLatestTurn ? snap.plan : null,
              ),
              FilesFooterRenderItem() => FilesFooterRow(item: item),
            };
            return EntryAppear(
              key: ValueKey(item.key),
              animate: _shouldAnimate(item.key),
              child: child,
            );
          }
          return _TypingPlaceholder(label: statusLabel);
        },
      ),
    );
    /* 首帧构建完成后, 之后的新项开始动画 (post-frame 置位, 避免同帧生效) */
    if (!_firstBuildDone) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _firstBuildDone = true;
      });
    }
    /* plan 卡已移到输入框上方 (home_stage_page._PlanAboveComposer, 用户拍板);
     * 这里只保留 retry pill 贴列表底. */
    if (snap.retry == null) return list;
    return Column(
      children: [
        Expanded(child: list),
        RetryPill(retry: snap.retry!),
      ],
    );
  }
}

/// 消息进入动画 — 新项淡入 + 4% 上浮, 220ms easeOutCubic.
/// 首帧历史回放与向上翻页的旧项不动画 (animate=false 直接静态);
/// 只有会话进行中新到达的消息才有动效, 不打扰阅读。
class EntryAppear extends StatefulWidget {
  const EntryAppear({super.key, required this.animate, required this.child});

  final bool animate;
  final Widget child;

  @override
  State<EntryAppear> createState() => _EntryAppearState();
}

class _EntryAppearState extends State<EntryAppear>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  late final Animation<double> _fade;
  late final Animation<Offset> _rise;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 240),
      value: widget.animate ? 0 : 1,
    );
    final curved = CurvedAnimation(parent: _c, curve: Curves.easeOutCubic);
    _fade = curved;
    _rise = Tween<Offset>(
      begin: const Offset(0, 0.06),
      end: Offset.zero,
    ).animate(curved);
    if (widget.animate) _c.forward();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_c.isCompleted) return widget.child;
    return FadeTransition(
      opacity: _fade,
      child: SlideTransition(position: _rise, child: widget.child),
    );
  }
}

/// 还没吐字时的「⟳ 思考中」—— 跟过程行里那一行一模一样 (位置 / 字号 / 转圈),
/// 第一个字到了换成过程行 (下面接滚动思维链) 时不跳。
class _TypingPlaceholder extends StatelessWidget {
  const _TypingPlaceholder({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 10, 16, 6),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const ClaySpinner(size: 12),
          const SizedBox(width: 8),
          ShimmerText(label, active: true, style: TextStyle(fontSize: 13.5, color: c.grey)),
        ],
      ),
    );
  }
}

/// 历史没拉到时的空态 —— 一句话说清 + 一个能按的动作.
///
/// 不用 SnackBar: 这是页面的**当前状态**, 不是一次事件。弹一下就没的提示,
/// 用户切回来只剩一片空白, 又回到"看不出发生过什么"。
class _HistoryProblem extends StatelessWidget {
  const _HistoryProblem({
    required this.text,
    required this.actionLabel,
    required this.onAction,
  });

  final String text;
  final String actionLabel;
  final VoidCallback onAction;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              text,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 8),
            TextButton(onPressed: onAction, child: Text(actionLabel)),
          ],
        ),
      ),
    );
  }
}

/// 刚建、还没说话的会话: 陶土图 (按模式) + 一句「说说要做什么」+ 在哪跑 (Mac · Neox / 这台手机).
class _FreshSessionHint extends ConsumerWidget {
  const _FreshSessionHint({required this.sessionId, required this.mode});

  final String sessionId;
  final TimelineMode? mode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final loc = ref.watch(sessionLocationProvider(sessionId)).valueOrNull;
    final place = switch (loc?.kind) {
      SessionLocationKind.phone => tr('这台手机'),
      SessionLocationKind.desktop || SessionLocationKind.cloud => loc!.shortLabel,
      _ => null,
    };
    final ws = (loc?.workspaceName ?? '').trim();
    final where = [?place, if (ws.isNotEmpty && loc?.kind == SessionLocationKind.desktop) ws].join(' · ');
    final (art, hint) = switch (mode) {
      TimelineMode.code => ('onboard-code', tr('说说要改什么, 或者贴一段报错')),
      TimelineMode.work => ('onboard-work', tr('说说要做什么, 做好的文件会放在这里')),
      _ => ('onboard-chat', tr('想聊什么都行')),
    };
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ClayArt(art, height: 96),
            const SizedBox(height: 16),
            Text(hint, textAlign: TextAlign.center, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: c.ink)),
            if (where.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(tr('在 %s 上做').replaceFirst('%s', where), textAlign: TextAlign.center, style: TextStyle(fontSize: 13, color: c.grey)),
            ],
          ],
        ),
      ),
    );
  }
}
