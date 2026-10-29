/// pilot_chat_page.dart — 一个会话窗口 (稿: Pilot · 当 IM 做 ② ③).
///
///   ←  [头像] 小航              📞  ⋯
///          ● 在线
///   ………… 聊天 (PilotChatView, 按窗口筛账本) …………
///   [＋] [ 跟小航说… ] [🎤]
///
/// 左上永远是返回 (回会话列表); ⋯ / 点头像 = 资料页。打电话只在跟 Pilot 单聊时有。
library;

import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:neox_app/core/i18n/tr.dart';

import '../../core/privacy/ai_consent.dart';
import '../../shared/clay/clay.dart';
import 'call/pilot_call_controller.dart';
import 'pilot_chat_view.dart';
import 'pilot_im.dart';
import 'pilot_profile_page.dart';
import 'pilot_team_page.dart';

/// 这台手机现在有没有网 (先问一次, 再跟着系统变化)
final _phoneOfflineProvider = StreamProvider.autoDispose<bool>((ref) async* {
  bool none(List<ConnectivityResult> r) => r.isEmpty || r.every((x) => x == ConnectivityResult.none);
  final c = Connectivity();
  yield none(await c.checkConnectivity());
  yield* c.onConnectivityChanged.map(none);
});

class PilotChatPage extends ConsumerStatefulWidget {
  const PilotChatPage({super.key, required this.thread, this.openCamera = false, this.draft});
  final PilotThread thread;
  final bool openCamera;

  /// 从「我能帮你做什么」带过来的示例句: 进聊天先填进输入框, 不直接发
  final String? draft;

  @override
  ConsumerState<PilotChatPage> createState() => _PilotChatPageState();
}

class _PilotChatPageState extends ConsumerState<PilotChatPage> {
  final _view = GlobalKey<PilotChatViewState>();
  bool _ok = false;

  PilotThread get t => widget.thread;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      /* 跟 Pilot 说的话会发给 AI 模型 —— 第一次进来先问 (App Store 5.1.2(i)), 不同意就退回列表 */
      if (!await ensureAiDataConsent(context)) {
        if (mounted) Navigator.of(context).maybePop();
        return;
      }
      if (mounted) setState(() => _ok = true);
    });
  }

  Future<void> _profile() async {
    if (t.kind == PilotThreadKind.group) {
      /* 群资料 = 团队成员: 开关、几点干活 */
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PilotTeamPage(pilot: t.pilot)));
      ref.invalidate(pilotTeamProvider);
      return;
    }
    final r = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => PilotProfilePage(thread: t)));
    if (!mounted || r == null) return;
    /* 资料页里点了「现在做一次」/ 记一笔之后要它看看: 当一句话发进这个窗口 */
    unawaited(_view.currentState?.sendText(r));
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final team = ref.watch(pilotTeamProvider).valueOrNull ?? const [];
    /* 它住在云端一直在线; 连不上它的是这台手机 —— 断网时原来照样挂绿点「在线」, 发出去却全失败 (2026-10-14 实测) */
    final offline = ref.watch(_phoneOfflineProvider).valueOrNull ?? false;
    final sub = switch (t.kind) {
      PilotThreadKind.direct when offline => tr('手机没网，连不上它'),
      PilotThreadKind.direct => t.pilot.persona.isNotEmpty ? t.pilot.persona : tr('在线'),
      PilotThreadKind.group => tr('${t.pilot.name} + ${team.where((s) => s.on).length} 个专员 · 你说一句${t.pilot.name}来派'),
      PilotThreadKind.specialist => t.specialist!.on ? (t.specialist!.scheduleLabel ?? t.specialist!.duty) : tr('关着'),
    };
    final face = switch (t.kind) {
      PilotThreadKind.direct => PilotFace.pilot(t.pilot, size: 36),
      PilotThreadKind.group => PilotFace.group(t.pilot, team.where((s) => s.on).toList(), size: 36),
      PilotThreadKind.specialist => PilotFace.specialist(t.specialist!, size: 36),
    };
    final title = t.kind == PilotThreadKind.group ? tr('我的团队（${team.where((s) => s.on).length + 1}）') : t.title;
    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: Column(
          children: [
            SizedBox(
              height: 56,
              child: Row(
                children: [
                  const SizedBox(width: 6),
                  ClayRoundButton(
                    flat: true,
                    size: 44,
                    icon: Icons.arrow_back_rounded,
                    tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                    onTap: () => Navigator.of(context).maybePop(),
                  ),
                  Expanded(
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: _profile,
                      child: Row(children: [
                        face,
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: c.ink, height: 1.2)),
                              Row(children: [
                                if (t.kind == PilotThreadKind.direct) ...[ClayDot(color: offline ? c.faint : c.green, size: 7), const SizedBox(width: 5)],
                                Flexible(child: Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey, height: 1.3))),
                              ]),
                            ],
                          ),
                        ),
                      ]),
                    ),
                  ),
                  if (t.kind == PilotThreadKind.direct)
                    ClayRoundButton(
                      flat: true,
                      size: 44,
                      icon: Icons.phone_outlined,
                      tooltip: tr('让它打给你'),
                      onTap: () => ref.read(pilotCallControllerProvider).callOut(t.pilot),
                    ),
                  ClayRoundButton(flat: true, size: 44, icon: Icons.more_horiz_rounded, tooltip: tr('资料'), onTap: _profile),
                  const SizedBox(width: 6),
                ],
              ),
            ),
            Expanded(
              child: _ok
                  ? PilotChatView(key: _view, thread: t, team: team, openCamera: widget.openCamera, draft: widget.draft)
                  : const SizedBox.shrink(),
            ),
          ],
        ),
      ),
    );
  }
}
