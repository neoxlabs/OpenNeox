/// pilot_im.dart — Pilot 当 IM 用的那一层 (2026-10-14 用户: 「就跟微信一样…多个 BOT 就是多个联系人, 还有群」)。
///
/// 数据不新造, 全从现有账本里分:
///   一个 Pilot (PilotContact)   = 一个联系人; 单聊 = 它会话里除专员交付以外的话
///   团队 (主管 + 专员)          = 群; 群聊 = 主管会话的全部 (专员交上来的是 `👥 名字 · 标题\n正文` 事件, 云端 team-runner 写)
///   一个专员 (PilotSpecialist)  = 一个联系人; 单聊 = 主管会话里它交的那些 + 你 @ 它的话和紧跟的回话
/// 你在专员单聊里说话 = 发进主管会话, 前面带「@名字 」, 主管派给它。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n/tr.dart';
import '../../core/pilot/pilot_cloud.dart';
import '../../core/pilot/pilot_records.dart';
import '../../shared/clay/clay.dart';
import '../../shared/theme/neox_tokens.dart' show NeoxClay;
import 'pilot_avatar.dart';
import 'pilot_link.dart';

enum PilotThreadKind { direct, group, specialist }

/// 一个会话窗口: 跟谁 / 哪个群
class PilotThread {
  const PilotThread.direct(this.pilot)
      : kind = PilotThreadKind.direct,
        specialist = null;
  const PilotThread.group(this.pilot)
      : kind = PilotThreadKind.group,
        specialist = null;
  const PilotThread.specialist(this.pilot, PilotSpecialist this.specialist) : kind = PilotThreadKind.specialist;

  final PilotThreadKind kind;

  /// 话落在哪个会话 (群 / 专员单聊 = 主管的会话)
  final PilotContact pilot;
  final PilotSpecialist? specialist;

  String get title => switch (kind) {
        PilotThreadKind.direct => pilot.name,
        PilotThreadKind.group => tr('我的团队'),
        PilotThreadKind.specialist => specialist!.name,
      };

  /// 在这个窗口里发的话真正发出去的样子
  String outgoing(String text) => kind == PilotThreadKind.specialist ? '@${specialist!.name} $text' : text;
}

/// 专员交付事件: `👥 名字 · 标题\n正文`
final _teamEvent = RegExp(r'^👥\s*(.+?)\s*·\s*(.*)$');

/// 这条事件是哪个专员交的 (不是专员交付 → null)
({String name, String title, String body})? specialistPost(String text) {
  final nl = text.indexOf('\n');
  final head = nl < 0 ? text : text.substring(0, nl);
  final m = _teamEvent.firstMatch(head.trim());
  if (m == null) return null;
  return (name: m[1]!.trim(), title: m[2]!.trim(), body: nl < 0 ? '' : text.substring(nl + 1).trim());
}

/// 账本里的一条 (只留做 IM 要的几个字段)
class PilotLine {
  const PilotLine({required this.role, required this.text, required this.at});
  final String role;
  final String text;
  final DateTime at;
}

/// 按窗口把账本筛一遍 (时间正序进, 正序出)
List<T> pilotFilterThread<T>(PilotThread t, List<T> rows, {required String Function(T) role, required String Function(T) text}) {
  switch (t.kind) {
    case PilotThreadKind.group:
      return rows;
    case PilotThreadKind.direct:
      return [for (final r in rows) if (!(role(r) == 'event' && specialistPost(text(r)) != null)) r];
    case PilotThreadKind.specialist:
      final name = t.specialist!.name;
      final out = <T>[];
      var following = false;
      for (final r in rows) {
        final ro = role(r);
        final tx = text(r);
        if (ro == 'event') {
          following = false;
          if (specialistPost(tx)?.name == name) out.add(r);
        } else if (ro == 'user') {
          following = tx.startsWith('@$name');
          if (following) out.add(r);
        } else if (following) {
          out.add(r);
        }
      }
      return out;
  }
}

/// 团队 (专员目录 + 开关 + 最近一次). 没开 Pilot 的发行版是空的
final pilotTeamProvider = FutureProvider.autoDispose<List<PilotSpecialist>>((ref) async {
  final api = ref.read(pilotCloudProvider)?.records;
  if (api == null) return const [];
  try {
    return await api.team();
  } catch (_) {
    return const [];
  }
});

/// 列表一行要的: 单聊最后一句 / 群最后一句 / 没读的汇报数
class PilotPreview {
  const PilotPreview({this.direct, this.group, this.unread = 0});
  final PilotLine? direct;
  final PilotLine? group;
  final int unread;
}

final pilotPreviewProvider = FutureProvider.autoDispose.family<PilotPreview, String>((ref, sid) async {
  final cloud = ref.read(pilotCloudProvider);
  if (cloud == null) return const PilotPreview();
  final rows = [
    for (final m in await cloud.messages(sid, limit: 30))
      if ('${m['text'] ?? ''}'.trim().isNotEmpty && !pilotInternalLine('${m['role']}', '${m['text']}'.trim()))
        PilotLine(
          role: '${m['role']}',
          text: '${m['text']}'.trim(),
          at: DateTime.fromMillisecondsSinceEpoch((m['at'] as num?)?.toInt() ?? 0),
        ),
  ];
  var unread = 0;
  try {
    unread = (await ref.read(pilotLinkProvider).board(sid)).reports.where((r) => !r.read).length;
  } catch (_) {}
  PilotLine? lastWhere(bool Function(PilotLine) ok) {
    for (final l in rows.reversed) {
      if (ok(l)) return l;
    }
    return null;
  }

  return PilotPreview(
    direct: lastWhere((l) => !(l.role == 'event' && specialistPost(l.text) != null)),
    group: rows.isEmpty ? null : rows.last,
    unread: unread,
  );
});

/// 账本里它跟手机之间的内部往来, 不是对话: 手机替它看到的消息 (<phone-signal>) 和它「没事」的回话 ([quiet])
bool pilotInternalLine(String role, String text) =>
    /* 带属性的也算 (<phone-signal source="mac">, Mac 转上来的 iMessage) */
    (role == 'user' && text.startsWith('<phone-signal')) || (role == 'assistant' && text == '[quiet]');

/// 一行消息的预览字: 去掉 markdown 记号, 专员交付写成「名字：标题」
String pilotPreviewText(PilotLine l, {bool withSender = false, String? pilotName}) {
  final post = l.role == 'event' ? specialistPost(l.text) : null;
  final colon = isEnglishUi ? ': ' : '：';
  if (post != null) return '${post.name}$colon${post.title}';
  final body = l.text.split('\n').map((s) => s.replaceAll(RegExp(r'[*_`#>]'), '').trim()).firstWhere((s) => s.isNotEmpty, orElse: () => '');
  if (l.role == 'user') return withSender ? '${tr('我')}$colon$body' : body;
  if (withSender && pilotName != null && l.role == 'assistant') return '$pilotName$colon$body';
  return body;
}

/// IM 里的时间: 今天 = 时:分, 昨天, 一周内 = 周几, 再早 = 月/日
String pilotListTime(DateTime t) {
  final now = DateTime.now();
  final days = DateTime(now.year, now.month, now.day).difference(DateTime(t.year, t.month, t.day)).inDays;
  if (days == 0) return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
  if (days == 1) return tr('昨天');
  if (days < 7) return trWeekday(t.weekday);
  return '${t.month}/${t.day}';
}

/// 头像: Pilot 是它的宠物; 专员是陶土单物件; 群是 2×2 拼图. 圆角方块, 填色底
class PilotFace extends StatelessWidget {
  const PilotFace.pilot(PilotContact this.pilot, {super.key, this.size = 50})
      : specialist = null,
        members = null;
  const PilotFace.specialist(PilotSpecialist this.specialist, {super.key, this.size = 50})
      : pilot = null,
        members = null;
  const PilotFace.group(PilotContact this.pilot, List<PilotSpecialist> this.members, {super.key, this.size = 50}) : specialist = null;

  final PilotContact? pilot;
  final PilotSpecialist? specialist;
  final List<PilotSpecialist>? members;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final r = BorderRadius.circular(size * 0.32);
    final Widget inner;
    if (members != null) {
      final cells = <Widget>[
        Image(image: pilotAvatarImage(pilot!.avatar, size * 0.44), fit: BoxFit.cover, width: double.infinity, height: double.infinity),
        for (final s in members!.take(3)) _clay(s.clay, size * 0.36),
      ];
      inner = Padding(
        padding: EdgeInsets.all(size * 0.06),
        child: GridView.count(
          crossAxisCount: 2,
          mainAxisSpacing: size * 0.04,
          crossAxisSpacing: size * 0.04,
          physics: const NeverScrollableScrollPhysics(),
          padding: EdgeInsets.zero,
          children: [
            for (final w in cells)
              Container(
                decoration: BoxDecoration(color: c.slab, borderRadius: BorderRadius.circular(size * 0.1)),
                clipBehavior: Clip.antiAlias,
                alignment: Alignment.center,
                child: w,
              ),
          ],
        ),
      );
    } else if (specialist != null) {
      inner = Center(child: _clay(specialist!.clay, size * 0.72));
    } else {
      inner = Image(image: pilotAvatarImage(pilot!.avatar, size), fit: BoxFit.cover);
    }
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: c.fill, borderRadius: r),
      clipBehavior: Clip.antiAlias,
      child: inner,
    );
  }

  /// 专员的陶土单物件 (assets/clay/i-*.webp, 服务端目录里给的名字)
  static Widget _clay(String name, double s) => Image.asset(
        NeoxClay.of(name),
        width: s,
        height: s,
        fit: BoxFit.contain,
        filterQuality: FilterQuality.medium,
        errorBuilder: (_, __, ___) => Image.asset(NeoxClay.of('i-team'), width: s, height: s),
      );
}
