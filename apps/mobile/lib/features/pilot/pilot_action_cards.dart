/// pilot_action_cards.dart — 动作卡: 固定在对话顶上, 批准后原地变结果 (pilot:U-06).
///
/// 它要用你的名义对外发东西 (短信 / iMessage / 打电话) 时, 账本里挂一张卡等你点头。
/// 卡不跟着消息滚走 —— 聊天页把它钉在列表上方, 翻多久都在。
///
/// 批准之后原来是从「正在办」里消失、结果只在对话里多一句, 用户点完盯着卡找不到了反馈。
/// 现在卡原地换结果: 办好了 / 没办成 + 一句话结果, 停 [holdResult] 秒再收走。
/// 结果从账本里取 (done / failed), 拿不到也照实说「结果已经放进对话」, 不编。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/pilot/pilot_cloud.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_toast.dart';

class PilotActionCards extends ConsumerStatefulWidget {
  const PilotActionCards({
    super.key,
    required this.pilotId,
    this.onSettled,
    this.holdResult = const Duration(seconds: 6),
  });

  final String pilotId;

  /// 一张批过的卡办完了 (结果已经写回对话): 让聊天重拉一遍
  final VoidCallback? onSettled;

  /// 结果在卡上停多久
  final Duration holdResult;

  @override
  ConsumerState<PilotActionCards> createState() => PilotActionCardsState();
}

class PilotActionCardsState extends ConsumerState<PilotActionCards> {
  List<Map<String, dynamic>> _cards = const [];
  final _busy = <String, bool>{};

  /// 批过的卡 (见过 approved, 或者自己点了批准) —— 它从账本里消失就是办完了
  final _approvedSeen = <String>{};
  final _resolving = <String>{};
  final _resolved = <String>{};

  _Settled? _settled;
  Timer? _timer;
  Timer? _release;

  @override
  void initState() {
    super.initState();
    unawaited(refresh());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _release?.cancel();
    super.dispose();
  }

  /// 5 秒一刷; 有在办的 3 秒 (批了到出结果要快)
  Future<void> refresh() async {
    _timer?.cancel();
    final cloud = ref.read(pilotCloudProvider);
    if (cloud != null) {
      final titles = {for (final c in _cards) '${c['id']}': '${c['title'] ?? ''}'};
      try {
        final r = await Future.wait([
          cloud.actions(widget.pilotId, 'pending'),
          cloud.actions(widget.pilotId, 'approved'),
        ]);
        final nowIds = {for (final c in [...r[0], ...r[1]]) '${c['id']}'};
        for (final c in r[1]) {
          _approvedSeen.add('${c['id']}');
        }
        if (mounted) setState(() => _cards = [...r[1], ...r[0]]);
        /* 批过的卡从 pending / approved 里一起消失了 = 这一张有终态了: 原地换成结果 */
        for (final id in _approvedSeen) {
          if (nowIds.contains(id) || _resolved.contains(id) || _resolving.contains(id)) continue;
          unawaited(_settle(id, titles[id] ?? ''));
        }
      } catch (_) {/* 拿不到就不摆, 下一轮再问 */}
    }
    if (!mounted) return;
    final doing = _cards.any((c) => c['actionState'] == 'approved');
    _timer = Timer(Duration(seconds: doing ? 3 : 5), refresh);
  }

  /// 从账本里取这张卡的终态; 取不到就按「办好了、结果在对话里」显示, 不编数字
  Future<void> _settle(String id, String title) async {
    _resolving.add(id);
    var ok = true;
    var result = '';
    final cloud = ref.read(pilotCloudProvider);
    if (cloud != null) {
      try {
        final rows = [
          ...await cloud.actions(widget.pilotId, 'done'),
          ...await cloud.actions(widget.pilotId, 'failed'),
        ];
        for (final c in rows) {
          if ('${c['id']}' != id) continue;
          ok = '${c['actionState']}' != 'failed';
          result = '${c['actionResult'] ?? ''}'.trim();
          break;
        }
      } catch (_) {/* 结果取不到: 下面照实说 */}
    }
    _resolving.remove(id);
    _resolved.add(id);
    if (!mounted) return;
    widget.onSettled?.call();
    setState(() => _settled = _Settled(id: id, ok: ok, title: title, result: result));
    _release?.cancel();
    _release = Timer(widget.holdResult, () {
      if (mounted) setState(() => _settled = null);
    });
  }

  Future<void> _decide(Map<String, dynamic> c, bool yes) async {
    final id = '${c['id']}';
    HapticFeedback.selectionClick();
    setState(() => _busy[id] = yes);
    final opts = [for (final o in (c['options'] as List? ?? const [])) '$o'];
    final answer = yes ? (opts.isNotEmpty ? opts.first : '批准') : (opts.length > 1 ? opts[1] : '不要');
    try {
      await ref.read(pilotCloudProvider)?.answerReport(id, answer);
      if (yes) {
        _approvedSeen.add(id);
      } else if (mounted) {
        setState(() => _cards = [for (final x in _cards) if ('${x['id']}' != id) x]);
      }
    } catch (_) {
      if (mounted) setState(() => _busy.remove(id));
      NeoxToast.show(tr('没点上，检查一下网络再试'));
      return;
    }
    await refresh();
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final rows = <Widget>[
      if (_settled != null) _settledCard(c, _settled!),
      for (final card in _cards.take(3)) _card(c, card),
    ];
    return AnimatedSize(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
      alignment: Alignment.topCenter,
      child: rows.isEmpty
          ? const SizedBox(width: double.infinity)
          : Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
              child: Column(
                children: [
                  ...rows,
                  if (_cards.length > 3)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(tr('还有 ${_cards.length - 3} 张等你点'), style: TextStyle(fontSize: 12, color: c.grey)),
                    ),
                ],
              ),
            ),
    );
  }

  /// 一张等你点的卡 / 批准了正在办的卡 (平: 一块泥板, 没有渐变和投影)
  Widget _card(ClayInk c, Map<String, dynamic> card) {
    final id = '${card['id']}';
    final action = card['action'] is Map ? Map<String, dynamic>.from(card['action'] as Map) : const <String, dynamic>{};
    final kind = '${action['action'] ?? ''}';
    final doing = card['actionState'] == 'approved' || _busy[id] == true;
    final summary = '${card['summary'] ?? ''}'.trim();
    final preview = '${action['preview'] ?? ''}'.trim();
    final body = summary.isNotEmpty ? summary : preview;
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
      decoration: BoxDecoration(
        color: c.slab,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 28,
                height: 28,
                decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(8)),
                child: Icon(
                  kind == 'phone_call' ? Icons.call_outlined : Icons.chat_bubble_outline_rounded,
                  size: 16,
                  color: c.ink,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${card['title'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink, height: 1.3)),
                    if (body.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(body, maxLines: 4, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: c.grey, height: 1.4)),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: doing
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      const ClaySpinner(size: 12),
                      const SizedBox(width: 6),
                      Text(tr('正在办…'), style: TextStyle(fontSize: 13, color: c.grey)),
                    ]),
                  )
                : Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ClayButton(label: tr('不要'), size: ClayButtonSize.small, onTap: _busy.containsKey(id) ? null : () => _decide(card, false)),
                      const SizedBox(width: 8),
                      ClayButton.ink(label: tr('批准'), size: ClayButtonSize.small, onTap: _busy.containsKey(id) ? null : () => _decide(card, true)),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  /// 办完的卡: 同一张卡原地换结果 —— 不再有按钮, 停几秒自己收走
  Widget _settledCard(ClayInk c, _Settled s) {
    final tone = s.ok ? c.green : c.red;
    final line = s.result.isNotEmpty
        ? s.result
        : (s.ok ? tr('结果已经放进对话') : tr('没办成，原因在对话里'));
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: c.slab,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: c.line),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(color: c.fill, borderRadius: BorderRadius.circular(8)),
            child: Icon(s.ok ? Icons.check_rounded : Icons.error_outline_rounded, size: 18, color: tone),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  s.ok ? tr('办好了') : tr('没办成'),
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink, height: 1.3),
                ),
                if (s.title.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(s.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.35)),
                  ),
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(line, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: c.grey, height: 1.4)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Settled {
  const _Settled({required this.id, required this.ok, required this.title, required this.result});
  final String id;
  final bool ok;
  final String title;
  final String result;
}
