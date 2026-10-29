/// pilot_conversation_page.dart — 跟一个 Pilot 的对话 (2026-10-01).
///
/// 跟桌面 Pilot 的「舞台头 + 对话」同一个结构: 头部是它 (头像 / 名字 / 分工 / 通话键), 下面是对话, 底下打字。
/// 对话就是容器 (电脑) 上那个 Pilot 会话本身, 在哪边说的两边都看得到。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/network/ws_client_provider.dart';
import '../../core/session_routing/session_router.dart';
import '../timeline/state/timeline_state.dart';
import '../timeline/widgets/timeline_message_list.dart';
import 'call/pilot_call_controller.dart';
import 'pilot_avatar.dart';
import 'pilot_link.dart';

class PilotConversationPage extends ConsumerStatefulWidget {
  const PilotConversationPage({super.key, required this.pilot});
  final PilotContact pilot;

  @override
  ConsumerState<PilotConversationPage> createState() => _PilotConversationPageState();
}

class _PilotConversationPageState extends ConsumerState<PilotConversationPage> {
  final _ctrl = TextEditingController();
  bool _sending = false;

  String get _sid => widget.pilot.sessionId;

  @override
  void initState() {
    super.initState();
    /* 订上这个会话, 容器那边的历史和新消息过来。attach 会改 provider, 不能在 initState 里同步调 */
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(ref.read(wsClientProvider.notifier).attachOrCatchUp(_sid).catchError((_) {}));
    });
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    try {
      await ref.read(sessionRouterProvider).sendMessage(sessionId: _sid, text: text);
      _ctrl.clear();
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tr('没发出去, 再试一次'))));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final running = ref.watch(timelineStateProvider(_sid).select((s) => s.agentRunning));
    return Scaffold(
      body: SafeArea(
        child: Column(children: [
          /* ── 头部: 它是谁、在不在忙、一键打给它 ── */
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 12, 8),
            child: Row(children: [
              IconButton(icon: const Icon(Icons.arrow_back), tooltip: tr('返回'), onPressed: () => Navigator.of(context).pop()),
              PilotAvatar(look: widget.pilot.avatar, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(widget.pilot.name, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                  Text(
                    running ? tr('在办事…') : (widget.pilot.persona.isEmpty ? 'Pilot' : widget.pilot.persona),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  ),
                ]),
              ),
              FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: const Color(0xFF34C759), foregroundColor: Colors.white),
                icon: const Icon(Icons.call, size: 18),
                label: Text(tr('通话')),
                onPressed: () => ref.read(pilotCallControllerProvider).callOut(widget.pilot),
              ),
            ]),
          ),
          Divider(height: 1, color: theme.dividerColor.withValues(alpha: 0.4)),
          Expanded(child: TimelineMessageList(sessionId: _sid)),
          /* ── 打字 ── */
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 12, 12),
            child: Container(
              padding: const EdgeInsets.only(left: 16, right: 6),
              decoration: BoxDecoration(
                color: theme.colorScheme.surface,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: theme.dividerColor.withValues(alpha: 0.5)),
              ),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    controller: _ctrl,
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                    /* 主题给 TextField 带了描边和底色, 这里外层胶囊已经是框了, 全部关掉 */
                    decoration: InputDecoration(
                      hintText: tr('跟它说点什么'),
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      filled: false,
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(vertical: 12),
                    ),
                  ),
                ),
                IconButton(
                  icon: _sending
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.arrow_upward),
                  onPressed: _send,
                ),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
}
