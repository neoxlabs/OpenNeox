/// inbox_page.dart — 「消息」页 (陶土稿 v5-inbox).
///
///   ←
///   消息                                  清空
///   今天
///   ● [猫]  小航                        09:24     ← 一条一块泥板; 没读的左边一颗蓝点
///           15 号要还信用卡 ¥3,280
///     [✓]  季度销售复盘 PPT 做好了        08:17
///     [✋]  整理客户名单 等你确认          07:42
///           (去确认)                              ← 等你的那条带琥珀小签
///   昨天 / 更早 …
///
/// 推送、任务事件、提醒都记在这里 (数据见 core/notifications/inbox.dart)。
/// 点一行: 任务事件回到对应会话, 其它弹层看全文。左滑删除。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/edition/edition.dart';
import '../../core/notifications/inbox.dart';
import '../../features/home/state/current_session_provider.dart';
import '../../shared/clay/clay.dart';
import '../pilot/pilot_avatar.dart';
import '../pilot/pilot_link.dart' show PilotLook;
import 'package:neox_app/core/i18n/tr.dart';

String _timeLabel(int ts) {
  final t = DateTime.fromMillisecondsSinceEpoch(ts);
  final now = DateTime.now();
  final hm = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  if (t.year == now.year && t.month == now.month && t.day == now.day) return hm;
  final y = now.subtract(const Duration(days: 1));
  if (t.year == y.year && t.month == y.month && t.day == y.day) return '${tr('昨天')} $hm';
  return '${t.month}/${t.day} $hm';
}

String _dayLabel(int ts) {
  final t = DateTime.fromMillisecondsSinceEpoch(ts);
  final today = DateTime.now();
  final d = DateTime(t.year, t.month, t.day);
  final diff = DateTime(today.year, today.month, today.day).difference(d).inDays;
  if (diff == 0) return tr('今天');
  if (diff == 1) return tr('昨天');
  return tr('更早');
}

/// 会话类的消息 (点了回到那个对话)
bool _isSession(InboxItem i) => (i.kind == 'agent' || i.kind == 'wait') && i.sessionId != null;

class InboxPage extends ConsumerStatefulWidget {
  const InboxPage({super.key});

  @override
  ConsumerState<InboxPage> createState() => _InboxPageState();
}

class _InboxPageState extends ConsumerState<InboxPage> {
  @override
  void dispose() {
    /* 看过了就算读过 —— 离开时清未读, 不在进来那一刻清 (蓝点要让人看到哪几条是新的) */
    InboxStore.instance.markAllRead();
    super.dispose();
  }

  Future<void> _confirmClear() async {
    final ok = await showClaySheet<bool>(
      context,
      builder: (ctx) {
        final c = ClayInk.of(ctx);
        return Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(tr('清空消息？'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: c.ink)),
              const SizedBox(height: 8),
              Text(tr('只清这台手机上的记录，电脑上的不受影响。'), style: TextStyle(fontSize: 14.5, color: c.grey)),
              const SizedBox(height: 22),
              Row(children: [
                Expanded(child: ClayButton(label: tr('取消'), size: ClayButtonSize.large, expand: true, onTap: () => Navigator.pop(ctx, false))),
                const SizedBox(width: 12),
                Expanded(child: ClayButton(label: tr('清空'), kind: ClayButtonKind.danger, size: ClayButtonSize.large, expand: true, onTap: () => Navigator.pop(ctx, true))),
              ]),
            ],
          ),
        );
      },
    );
    if (ok == true) await InboxStore.instance.clear();
  }

  void _open(InboxItem item) {
    setState(() => item.read = true);
    if (_isSession(item)) {
      openSessionOnHome(context, ref, item.sessionId!);
      return;
    }
    showClaySheet<void>(
      context,
      builder: (ctx) {
        final c = ClayInk.of(ctx);
        return Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(children: [
                _Glyph(item: item),
                const SizedBox(width: 14),
                Expanded(child: Text(item.title, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: c.ink))),
              ]),
              const SizedBox(height: 8),
              Text(_timeLabel(item.ts), style: TextStyle(fontSize: 12.5, color: c.grey)),
              const SizedBox(height: 16),
              SelectableText(item.body.isEmpty ? tr('（没有正文）') : item.body, style: TextStyle(fontSize: 15, color: c.ink, height: 1.6)),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final items = ref.watch(inboxProvider).items;
    final groups = <String, List<InboxItem>>{};
    for (final it in items) {
      groups.putIfAbsent(_dayLabel(it.ts), () => []).add(it);
    }
    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            const SliverToBoxAdapter(child: ClayTopBar()),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(24, 4, 12, 8),
                child: Row(
                  children: [
                    Expanded(child: Text(tr('消息'), style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: c.ink, letterSpacing: -0.3))),
                    if (items.isNotEmpty) ClayButton(label: tr('清空'), kind: ClayButtonKind.text, onTap: _confirmClear),
                  ],
                ),
              ),
            ),
            if (items.isEmpty)
              SliverFillRemaining(
                hasScrollBody: false,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 80),
                  child: ClayEmpty(
                    art: 'envelope',
                    title: tr('还没有消息'),
                    message: ref.watch(editionProvider).pilotAvailable
                        ? tr('Pilot 找你、任务做完、到点提醒，都会记在这里')
                        : tr('任务做完、到点提醒，都会记在这里'),
                  ),
                ),
              )
            else ...[
              for (final g in groups.entries) ...[
                SliverToBoxAdapter(child: ClaySectionLabel(g.key)),
                SliverList.separated(
                  itemCount: g.value.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (context, i) => _InboxRow(item: g.value[i], onTap: () => _open(g.value[i])),
                ),
              ],
              const SliverToBoxAdapter(child: SizedBox(height: 40)),
            ],
          ],
        ),
      ),
    );
  }
}

/// 一条消息左边那块方图标: Pilot 的是猫, 做完打勾, 等你是手, 提醒是闹钟, 推送是铃.
class _Glyph extends StatelessWidget {
  const _Glyph({required this.item});
  final InboxItem item;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final Widget g = switch (item.kind) {
      'call' => const PilotAvatar(look: PilotLook.cat, size: 28),
      'wait' => Icon(Icons.back_hand_outlined, size: 22, color: c.ink),
      'agent' => Icon(Icons.check_circle_outline_rounded, size: 22, color: c.ink),
      'reminder' => Icon(Icons.alarm_rounded, size: 22, color: c.ink),
      _ => Icon(Icons.notifications_none_rounded, size: 22, color: c.ink),
    };
    return Container(
      width: 44,
      height: 44,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(13)),
      child: g,
    );
  }
}

class _InboxRow extends StatelessWidget {
  const _InboxRow({required this.item, required this.onTap});

  final InboxItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Dismissible(
      key: ValueKey(item.id),
      direction: DismissDirection.endToStart,
      background: Container(
        alignment: Alignment.centerRight,
        margin: const EdgeInsets.symmetric(horizontal: 20),
        padding: const EdgeInsets.only(right: 22),
        decoration: BoxDecoration(color: c.redSoft, borderRadius: BorderRadius.circular(18)),
        child: Icon(Icons.delete_outline_rounded, color: c.redInk),
      ),
      onDismissed: (_) => InboxStore.instance.remove(item.id),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: ClaySlab(
          radius: 18,
          onTap: onTap,
          padding: const EdgeInsets.fromLTRB(8, 14, 16, 14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              /* 未读蓝点: 占位常在, 读过就透明 —— 图标不因此左右跳 */
              Padding(
                padding: const EdgeInsets.only(top: 18),
                child: Container(width: 6, height: 6, decoration: BoxDecoration(color: item.read ? Colors.transparent : c.cobalt, shape: BoxShape.circle)),
              ),
              const SizedBox(width: 8),
              Opacity(opacity: item.read ? 0.75 : 1, child: _Glyph(item: item)),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Expanded(
                        child: Text(item.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 15.5, fontWeight: item.read ? FontWeight.w500 : FontWeight.w600, color: c.ink)),
                      ),
                      const SizedBox(width: 8),
                      Text(_timeLabel(item.ts), style: TextStyle(fontSize: 12.5, color: c.grey)),
                    ]),
                    if (item.kind == 'wait' && !item.read) ...[
                      const SizedBox(height: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                        decoration: BoxDecoration(color: c.amberSoft, borderRadius: BorderRadius.circular(10)),
                        child: Text(tr('去确认'), style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.amberInk)),
                      ),
                    ] else if (item.body.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(item.body, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: c.grey, height: 1.45)),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
