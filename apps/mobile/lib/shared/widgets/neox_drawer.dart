/// neox_drawer.dart — 全屏侧栏 (陶土稿 v5).
///
///   ◎ neox                                  (✕)
///   [ 🔍 搜索任务和对话        ]  (✎)
///   ┌对话┐ ┌工作●┐ ┌编码┐
///   ┌Pilot┐ ┌图片┐ ┌成品 128┐
///   进行中
///   ╭ ● 季度销售复盘 PPT  执行中 3/7 · Mac   [缩略] ╮
///   最近
///   竞品价格表                                   ›
///   … (最多 5 条, 只写标题)
///   全部 ›
///   (L) lmk1010 [Max]                           (⚙)
///
/// 子 Agent 不进列表 (进父任务里看); 侧栏不放插画。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/edition/edition.dart';
import '../../core/execution/run_target.dart';
import '../../core/execution/run_target_provider.dart';
import '../../core/network/stream_buffer_provider.dart' show sessionPendingApprovalsProvider;
import '../../core/network/ws_client_provider.dart';
import '../../core/network/cli_endpoint_id.dart';
import '../../core/storage/database.dart';
import '../../core/storage/paired_desktop_kind.dart';
import '../../features/files/deliverables.dart';
import '../../features/home/state/current_session_provider.dart';
import '../../features/home/state/home_mode_provider.dart';
import '../../features/home/state/session_return_provider.dart';
import '../../features/home/widgets/session_actions.dart';
import '../../features/home/widgets/where_sheet.dart' show desktopNameOf, desktopStatusOf, orderDesktops;
import '../../features/pilot/pilot_avatar.dart';
import '../../features/pilot/pilot_link.dart' show PilotLook;
import '../../features/timeline/state/running_sessions_provider.dart';
import '../../features/timeline/state/timeline_state.dart';
import '../clay/clay.dart';
import 'asset_px.dart';
import '../../features/home/widgets/stage_input.dart' show stageNewSessionTickProvider;
import 'package:neox_app/core/i18n/tr.dart';

/// session 最后活动时间戳 — 优先 lastMessageAt, fallback createdAt.
DateTime sessionLastTime(SessionMirrorData s) {
  final ts = s.lastMessageAt ?? s.createdAt;
  return DateTime.fromMillisecondsSinceEpoch(ts);
}

/// 列表里显示的标题 —— 空的 / 中文占位「新会话」按界面语言换.
String sessionDisplayTitle(SessionMirrorData s) {
  final raw = s.title?.trim() ?? '';
  return (raw.isEmpty || raw == '新会话') ? tr('新会话') : raw;
}

/// 能进列表的顶层会话: 画布不进 (图片有自己的家), 子 Agent 不进 (进父任务里看) —— 按最近活跃倒序.
List<SessionMirrorData> visibleTopLevelSessions(List<SessionMirrorData> all) {
  final list = all
      .where((s) => s.kind != 'image' && s.parentSessionId == null && !(s.title ?? '').startsWith('子 Agent '))
      .toList()
    ..sort((a, b) => sessionLastTime(b).compareTo(sessionLastTime(a)));
  return list;
}

/// 从列表 (侧栏 / 全部会话 / 搜索) 打开一条会话.
///
/// 模式跟着会话走; 会话在哪台电脑上, 连接就指向哪台 —— 原来只切 currentSession, 连接还留在上次那台,
/// 这条会话的事件被中继整批丢掉 (2026-10-12「加载历史记录混乱…很多新消息没出现」)。
/// 从通知 / 首页提示这类「不在某个列表里」的地方打开一条会话: 首页垫底, 电脑上的会话左上给 ← 回那台电脑.
Future<void> openSessionFromOutside(WidgetRef ref, GoRouter router, String sessionId) async {
  final db = ref.read(appDatabaseProvider);
  final s = await db.sessionMirrorDao.findById(sessionId);
  router.go('/');
  if (s == null) {
    ref.read(currentSessionProvider.notifier).set(sessionId);
    return;
  }
  openSessionFromList(ref, s);
  final d = isPhoneLocalDeviceId(s.desktopDeviceId) ? null : await db.pairedDesktopsDao.findByDeviceId(s.desktopDeviceId);
  if (d != null && isRealPairedDesktop(d)) {
    ref.read(sessionReturnRouteProvider.notifier).state =
        (sessionId: s.id, route: '/remote/${Uri.encodeComponent(s.desktopDeviceId)}');
  }
}

void openSessionFromList(WidgetRef ref, SessionMirrorData session) {
  final sessionMode = homeModeOfSession(agentMode: session.agentMode, desktopDeviceId: session.desktopDeviceId);
  if (sessionMode != null && sessionMode != ref.read(homeModeProvider)) {
    ref.read(homeModeProvider.notifier).set(sessionMode);
  }
  final did = session.desktopDeviceId;
  if (isCliEndpointId(did)) {
    /* 终端会话: 首选电脑记那台电脑本身 (终端关了就没了, 不能记成首选); 连接由进会话时
     * ensureConnectedToSessionOwner 换到终端那条 */
    final computer = computerOfSession(did);
    if (computer != ref.read(preferredDesktopProvider)) ref.read(preferredDesktopProvider.notifier).set(computer);
  } else if (!isPhoneLocalDeviceId(did) && did != ref.read(preferredDesktopProvider)) {
    ref.read(preferredDesktopProvider.notifier).set(did);
    final ws = ref.read(wsClientProvider.notifier);
    unawaited(ws.connectToDesktop(did).then((_) => ws.requestSessionList(limit: 1000)).catchError((Object _) {}));
  }
  ref.read(sessionReturnTargetProvider.notifier).state = null;
  ref.read(currentSessionProvider.notifier).set(session.id);
}

const _kWordmarkH = 15.0;
const _kMark = 26.0;

String _wordmark(Brightness b) =>
    b == Brightness.dark ? 'assets/brand/wordmark-on-dark.png' : 'assets/brand/wordmark-on-light.png';

/// 启动后空闲时把侧栏里的图先解好 (见 asset_px.dart)
Future<void> precacheDrawerImages(BuildContext context) async {
  final b = Theme.of(context).brightness;
  final jobs = <ImageProvider>[
    assetAtWidth('assets/brand/mark-clay.png', _kMark),
    assetAtHeight(_wordmark(b), _kWordmarkH),
    pilotAvatarImage(PilotLook.cat, 30),
  ];
  for (final p in jobs) {
    if (!context.mounted) return;
    await precacheImage(p, context);
  }
}

class NeoxDrawer extends ConsumerStatefulWidget {
  const NeoxDrawer({super.key, this.here});

  /// 从哪一页拉出来的 ('pilot' …): 那一格亮, 三个模式格不亮。null = 首页 (按当前模式亮)
  final String? here;

  @override
  ConsumerState<NeoxDrawer> createState() => _NeoxDrawerState();
}

class _NeoxDrawerState extends ConsumerState<NeoxDrawer> {
  bool _searching = false;
  final _searchCtrl = TextEditingController();
  String _q = '';

  @override
  void dispose() {
    _searchCtrl.dispose();
    super.dispose();
  }

  void _close() => Navigator.of(context).pop();

  /// 侧栏在哪一页拉出来都一样: 先收起, 再回到首页那一层, 然后去要去的地方
  /// (2026-10-14 用户: 在 Pilot 里点菜单结果跳去了 Work —— 菜单键原来是返回)
  void _go(VoidCallback f) {
    final nav = Navigator.of(context);
    _close();
    nav.popUntil((r) => r.isFirst);
    f();
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final db = ref.watch(appDatabaseProvider);
    return Drawer(
      width: MediaQuery.sizeOf(context).width,
      backgroundColor: c.canvas,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: const RoundedRectangleBorder(),
      child: SafeArea(
        child: StreamBuilder<List<SessionMirrorData>>(
          stream: db.sessionMirrorDao.watchAll(),
          builder: (context, snap) {
            final sessions = visibleTopLevelSessions(snap.data ?? const []);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Header(onClose: _close),
                _SearchRow(
                  searching: _searching,
                  controller: _searchCtrl,
                  onStart: () => setState(() => _searching = true),
                  onQuery: (v) => setState(() => _q = v.trim()),
                  onCancel: () {
                    _searchCtrl.clear();
                    setState(() {
                      _searching = false;
                      _q = '';
                    });
                  },
                  onNew: () => _go(() {
                    ref.read(currentSessionProvider.notifier).set(null);
                    /* 本来就在首页时上一句等于没动: 让输入框清空并聚焦, 看得出「开了个新的」 */
                    ref.read(stageNewSessionTickProvider.notifier).state++;
                  }),
                ),
                Expanded(
                  child: _searching
                      ? _SearchResults(sessions: sessions, query: _q, onOpen: (s) => _go(() => openSessionFromList(ref, s)))
                      : ListView(
                          padding: const EdgeInsets.only(bottom: 12),
                          children: [
                            _Destinations(onGo: _go, here: widget.here),
                            _ComputersSection(sessions: sessions, onGo: _go, here: widget.here),
                            _RunningSection(onOpen: (s) => _go(() => openSessionFromList(ref, s)), sessions: sessions),
                            _RecentSection(
                              sessions: sessions,
                              onOpen: (s) => _go(() => openSessionFromList(ref, s)),
                              onAll: () => _go(() => context.push('/history')),
                            ),
                          ],
                        ),
                ),
                ref.read(editionProvider).drawerFooter() ?? const _SettingsFooter(),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.onClose});

  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final b = Theme.of(context).brightness;
    return SizedBox(
      height: 64,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(22, 0, 14, 0),
        child: Row(
          children: [
            Image.asset('assets/brand/mark-clay.png', width: _kMark, height: _kMark, cacheWidth: assetPx(_kMark)),
            const SizedBox(width: 12),
            Image.asset(_wordmark(b), height: _kWordmarkH, cacheHeight: assetPx(_kWordmarkH)),
            const Spacer(),
            ClayRoundButton(icon: Icons.close_rounded, size: 40, tooltip: tr('关闭'), onTap: onClose),
          ],
        ),
      ),
    );
  }
}

class _SearchRow extends StatelessWidget {
  const _SearchRow({
    required this.searching,
    required this.controller,
    required this.onStart,
    required this.onQuery,
    required this.onCancel,
    required this.onNew,
  });

  final bool searching;
  final TextEditingController controller;
  final VoidCallback onStart;
  final ValueChanged<String> onQuery;
  final VoidCallback onCancel;
  final VoidCallback onNew;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final field = Container(
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        color: c.fill,
        boxShadow: clayShadow(c, lift: 0.45),
      ),
      child: Row(
        children: [
          Icon(Icons.search_rounded, size: 20, color: c.grey),
          const SizedBox(width: 8),
          Expanded(
            child: searching
                ? TextField(
                    controller: controller,
                    autofocus: true,
                    onChanged: onQuery,
                    textInputAction: TextInputAction.search,
                    style: TextStyle(fontSize: 15, color: c.ink),
                    cursorColor: c.cobalt,
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: tr('搜索任务和对话'),
                      hintStyle: TextStyle(fontSize: 15, color: c.faint),
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      filled: false,
                      contentPadding: EdgeInsets.zero,
                    ),
                  )
                : Text(tr('搜索任务和对话'), style: TextStyle(fontSize: 15, color: c.faint)),
          ),
        ],
      ),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 14),
      child: Row(
        children: [
          Expanded(child: searching ? field : GestureDetector(onTap: onStart, child: field)),
          const SizedBox(width: 10),
          searching
              ? TextButton(onPressed: onCancel, child: Text(tr('取消'), style: TextStyle(color: c.ink)))
              : ClayRoundButton(icon: Icons.edit_note_rounded, size: 44, tooltip: tr('新会话'), onTap: onNew),
        ],
      ),
    );
  }
}

/// 3×2 陶土方块: 对话 工作 编码 / Pilot 图片 成品.
class _Destinations extends ConsumerWidget {
  const _Destinations({required this.onGo, this.here});

  final void Function(VoidCallback) onGo;
  final String? here;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(homeModeProvider);
    /* 不在首页 (比如在 Pilot 里) 时三个模式格都不亮 */
    final inSession = ref.watch(currentSessionProvider) != null || here != null;
    final files = ref.watch(deliverablesProvider).valueOrNull?.where((d) => !d.uploaded).length;
    void toMode(HomeMode m) => onGo(() {
          ref.read(homeModeProvider.notifier).set(m);
          ref.read(currentSessionProvider.notifier).set(null);
          ref.read(sessionReturnTargetProvider.notifier).state = null;
        });
    Widget tile(String label, Widget icon, VoidCallback onTap, {bool selected = false, String? corner, bool bead = false}) {
      return Expanded(
        child: _DestTile(label: label, icon: icon, onTap: onTap, selected: selected, corner: corner, bead: bead),
      );
    }

    final c = ClayInk.of(context);
    Icon glyph(IconData i) => Icon(i, size: 26, color: c.ink);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        children: [
          Row(
            children: [
              tile(tr('对话'), glyph(Icons.chat_bubble_outline_rounded), () => toMode(HomeMode.chat),
                  selected: !inSession && mode == HomeMode.chat),
              const SizedBox(width: 12),
              tile(tr('工作'), glyph(Icons.description_outlined), () => toMode(HomeMode.work),
                  selected: !inSession && mode == HomeMode.work),
              const SizedBox(width: 12),
              tile(tr('编码'), glyph(Icons.code_rounded), () => toMode(HomeMode.code),
                  selected: !inSession && mode == HomeMode.code),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              /* 没有 Pilot 的发行版 (开源版): 这一格不出, 图片 / 成品顶上来, 末尾空一格保持网格 */
              if (ref.watch(editionProvider).pilotAvailable) ...[
                tile(
                  'Pilot',
                  const PilotAvatar(look: PilotLook.cat, size: 30),
                  /* 已经在 Pilot 里: 收起侧栏就行 */
                  () => here == 'pilot' ? Navigator.of(context).pop() : onGo(() => context.push('/pilot')),
                  selected: here == 'pilot',
                ),
                const SizedBox(width: 12),
              ],
              tile(tr('图片'), glyph(Icons.image_outlined),
                  () => here == 'image' ? Navigator.of(context).pop() : onGo(() => context.push('/image')),
                  selected: here == 'image'),
              const SizedBox(width: 12),
              tile(tr('成品'), glyph(Icons.layers_outlined),
                  () => here == 'files' ? Navigator.of(context).pop() : onGo(() => context.push('/files')),
                  selected: here == 'files',
                  corner: files == null || files == 0 ? null : '$files'),
              if (!ref.watch(editionProvider).pilotAvailable) ...[
                const SizedBox(width: 12),
                const Expanded(child: SizedBox()),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

class _DestTile extends StatelessWidget {
  const _DestTile({
    required this.label,
    required this.icon,
    required this.onTap,
    this.selected = false,
    this.corner,
    this.bead = false,
  });

  final String label;
  final Widget icon;
  final VoidCallback onTap;
  final bool selected;
  final String? corner;
  final bool bead;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return ClaySlab(
      radius: 18,
      lift: selected ? 1.8 : 0.8,
      padding: EdgeInsets.zero,
      onTap: onTap,
      child: SizedBox(
        height: 92,
        child: Stack(
          children: [
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(width: 30, height: 30, child: Center(child: icon)),
                  const SizedBox(height: 8),
                  Text(
                    label,
                    style: TextStyle(fontSize: 14, fontWeight: selected ? FontWeight.w700 : FontWeight.w500, color: c.ink),
                  ),
                ],
              ),
            ),
            if (corner != null)
              Positioned(top: 8, right: 10, child: Text(corner!, style: TextStyle(fontSize: 11.5, color: c.grey))),
            if (bead) Positioned(top: 10, right: 12, child: ClayDot(color: c.cobalt, size: 8)),
          ],
        ),
      ),
    );
  }
}

/// 我的电脑: 配对过的电脑一台一行 (在线的在前, 最多 3 台), 点进去是那台的全部会话.
///
/// 2026-10-15 用户: 「远程连接 电脑列表… 我发现我找不到远程的了」—— 陶土稿 v5 把设备并进输入框
/// 「在哪干」签以后, `/remote` 页还在但全 App 没有一个入口。电脑上的活 (看进度、批审批、接着聊)
/// 得有个固定的门, 放在侧栏模式格下面, 直接写电脑名和此刻状态, 不让人去猜藏在哪。
class _ComputersSection extends ConsumerWidget {
  const _ComputersSection({required this.sessions, required this.onGo, this.here});

  final List<SessionMirrorData> sessions;
  final void Function(VoidCallback) onGo;
  final String? here;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final db = ref.watch(appDatabaseProvider);
    final presence = ref.watch(desktopPresenceProvider);
    final ws = ref.watch(wsClientProvider);
    final live = ref.watch(liveSessionsProvider);
    void open(String route) => here == 'remote' && route == '/remote'
        ? Navigator.of(context).pop()
        : onGo(() => context.push(route));
    return StreamBuilder<List<PairedDesktop>>(
      stream: db.pairedDesktopsDao.watchAll(),
      builder: (context, snap) {
        final all = orderDesktops(snap.data ?? const [], presence, ws);
        final shown = all.take(3).toList();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClaySectionLabel(
              tr('我的电脑'),
              padding: const EdgeInsets.fromLTRB(24, 22, 16, 8),
              trailing: all.isEmpty
                  ? null
                  : GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => open('/remote'),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        child: Text(
                          all.length > shown.length ? '${tr('全部')} ${all.length} ›' : '${tr('管理')} ›',
                          style: TextStyle(fontSize: 13, color: c.grey),
                        ),
                      ),
                    ),
            ),
            ClayGroup(
              children: [
                if (all.isEmpty)
                  ClayRow(
                    icon: Icons.laptop_mac_rounded,
                    title: tr('连一台电脑'),
                    subtitle: tr('在手机上看电脑上的活、改代码、跑项目'),
                    onTap: () => open('/remote'),
                  ),
                for (final d in shown)
                  Builder(builder: (context) {
                    final st = desktopStatusOf(d, presence, ws);
                    /* 这台电脑上的会话 = 客户端的 + 它上面开了 /rc 的终端的 (一台电脑一个设备) */
                    final mine = sessions.where((s) => computerOfSession(s.desktopDeviceId) == d.deviceId);
                    final busy = mine.where((s) => live.running.contains(s.id)).length;
                    final waiting = mine.where((s) => live.waiting.contains(s.id)).length;
                    final terminals = mine.where((s) => isCliEndpointId(s.desktopDeviceId)).length;
                    return ClayRow(
                      icon: _looksLikeMac(d) ? Icons.laptop_mac_rounded : Icons.desktop_windows_outlined,
                      /* 只开着终端 (客户端关着) 也算这台在线 */
                      bead: st.online || terminals > 0 ? c.green : null,
                      title: desktopNameOf(d),
                      subtitle: [
                        terminals > 0 && !st.online ? tr('终端在线') : st.text,
                        if (terminals > 0) tr('%s 个终端').replaceFirst('%s', '$terminals'),
                        if (busy > 0) tr('%s 个在跑').replaceFirst('%s', '$busy'),
                      ].join(' · '),
                      /* 远程最要紧的就是「有活等我批」—— 行尾琥珀签 */
                      trailing: waiting > 0
                          ? ClayChip(label: tr('等你 %s').replaceFirst('%s', '$waiting'), tone: ClayTone.amber, dense: true)
                          : null,
                      onTap: () => open('/remote/${Uri.encodeComponent(d.deviceId)}'),
                    );
                  }),
              ],
            ),
          ],
        );
      },
    );
  }
}

bool _looksLikeMac(PairedDesktop d) {
  final n = (d.deviceName ?? '').toLowerCase();
  return n.contains('mac') || n.contains('imac');
}

/// 进行中: 跑着的任务, 一张泥板一条.
class _RunningSection extends ConsumerWidget {
  const _RunningSection({required this.onOpen, required this.sessions});

  final ValueChanged<SessionMirrorData> onOpen;
  final List<SessionMirrorData> sessions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    /* 手机看过的 + 电脑上报的; 等你确认的排前面 */
    final live = ref.watch(liveSessionsProvider);
    final rows = [
      ...sessions.where((s) => live.waiting.contains(s.id)),
      ...sessions.where((s) => live.running.contains(s.id) && !live.waiting.contains(s.id)),
    ].take(3).toList();
    if (rows.isEmpty) return const SizedBox.shrink();
    final names = ref.watch(pairedDesktopNamesProvider).valueOrNull ?? const <String, String>{};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClaySectionLabel(tr('进行中'), padding: const EdgeInsets.fromLTRB(24, 22, 24, 8)),
        for (final s in rows)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
            child: _RunningCard(
              session: s,
              place: isPhoneLocalDeviceId(s.desktopDeviceId)
                  ? tr('这台手机')
                  : [
                      names[computerOfSession(s.desktopDeviceId)] ?? tr('电脑'),
                      if (isCliEndpointId(s.desktopDeviceId)) tr('终端'),
                    ].join(' · '),
              onTap: () => onOpen(s),
            ),
          ),
      ],
    );
  }
}

class _RunningCard extends ConsumerWidget {
  const _RunningCard({required this.session, required this.place, required this.onTap});

  final SessionMirrorData session;
  final String place;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final plan = ref.watch(timelineStateProvider(session.id).select((t) => t.plan));
    final waiting = ref.watch(sessionPendingApprovalsProvider(session.id)).isNotEmpty ||
        ref.watch(liveSessionsProvider.select((l) => l.waiting.contains(session.id)));
    final total = plan?.steps.length ?? 0;
    final done = plan?.steps.where((p) => p.status == 'completed').length ?? 0;
    final status = waiting ? tr('等你确认') : (total > 0 ? '${tr('执行中')} $done/$total' : tr('执行中'));
    final mode = homeModeOfSession(agentMode: session.agentMode, desktopDeviceId: session.desktopDeviceId);
    return ClaySlab(
      onTap: onTap,
      onLongPress: () => showSessionActions(context, ref, session),
      padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
      child: Row(
        children: [
          ClayDot(color: waiting ? c.amber : c.cobalt, size: 9),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(sessionDisplayTitle(session),
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: c.ink)),
                const SizedBox(height: 2),
                Text('$status · $place', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.grey)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          ClayTile(
            size: 40,
            icon: switch (mode) {
              HomeMode.chat => Icons.chat_bubble_outline_rounded,
              HomeMode.code => Icons.code_rounded,
              _ => Icons.description_outlined,
            },
          ),
        ],
      ),
    );
  }
}

/// 最近: 只写标题, 最多 5 条; 长按出重命名 / 钉住 / 删除.
class _RecentSection extends ConsumerWidget {
  const _RecentSection({required this.sessions, required this.onOpen, required this.onAll});

  final List<SessionMirrorData> sessions;
  final ValueChanged<SessionMirrorData> onOpen;
  final VoidCallback onAll;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    /* 上面「进行中」已列的不重复 */
    final live = ref.watch(liveSessionsProvider);
    final current = ref.watch(currentSessionProvider);
    final rows = sessions.where((s) => !live.running.contains(s.id) && !live.waiting.contains(s.id)).take(5).toList();
    /* 有终端会话的电脑, 它的会话才标「终端 / 客户端」—— 平时只有客户端会话时不多一个字 */
    final computersWithCli = {
      for (final s in sessions)
        if (isCliEndpointId(s.desktopDeviceId)) computerOfSession(s.desktopDeviceId),
    };
    if (rows.isEmpty) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(24, 24, 24, 0),
        child: Text(tr('还没有会话'), style: TextStyle(fontSize: 13.5, color: c.grey)),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ClaySectionLabel(tr('最近'), padding: const EdgeInsets.fromLTRB(24, 20, 24, 4)),
        for (final s in rows)
          _TitleRow(
            title: sessionDisplayTitle(s),
            tag: sessionSourceLabel(s.desktopDeviceId, computersWithCli),
            current: s.id == current,
            onTap: () => onOpen(s),
            onLongPress: () => showSessionActions(context, ref, s),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 2, 12, 0),
          child: Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: onAll,
              child: Text('${tr('全部')} ›', style: TextStyle(fontSize: 14, color: c.grey)),
            ),
          ),
        ),
      ],
    );
  }
}

class _TitleRow extends StatelessWidget {
  const _TitleRow({required this.title, required this.onTap, this.onLongPress, this.current = false, this.tag});

  final String title;

  /// 来源小签: 终端 / 客户端 (同一台电脑上两种会话都有时才给)
  final String? tag;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Material(
        color: current ? c.tint : Colors.transparent,
        borderRadius: BorderRadius.circular(12),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          onLongPress: onLongPress,
          child: SizedBox(
            height: 46,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15.5, color: c.ink, fontWeight: current ? FontWeight.w600 : FontWeight.w400)),
                  ),
                  if (tag != null) ...[
                    const SizedBox(width: 8),
                    ClayChip(label: tag!, tone: tag == tr('终端') ? ClayTone.cobalt : ClayTone.neutral, dense: true),
                  ],
                  Icon(Icons.chevron_right_rounded, size: 20, color: c.faint),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SearchResults extends StatelessWidget {
  const _SearchResults({required this.sessions, required this.query, required this.onOpen});

  final List<SessionMirrorData> sessions;
  final String query;
  final ValueChanged<SessionMirrorData> onOpen;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final q = query.toLowerCase();
    final hits = q.isEmpty
        ? sessions.take(20).toList()
        : sessions
            .where((s) => (s.title ?? '').toLowerCase().contains(q) || (s.workspaceName ?? '').toLowerCase().contains(q))
            .toList();
    if (hits.isEmpty) {
      return ClayEmpty(art: 'empty-search', title: tr('没找到「$query」'), message: tr('换个说法试试'));
    }
    return ListView(
      children: [
        ClaySectionLabel(q.isEmpty ? tr('最近') : tr('对话 · ${hits.length}'), padding: const EdgeInsets.fromLTRB(24, 6, 24, 4)),
        for (final s in hits)
          _TitleRow(title: sessionDisplayTitle(s), onTap: () => onOpen(s)),
        if (hits.isEmpty) Text('', style: TextStyle(color: c.grey)),
      ],
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  底栏 (头像 + 名字 + [套餐] + ⚙)
// ════════════════════════════════════════════════════════════════
/// 侧栏底栏的壳: 整条点进设置页。头像 / 名字 / 角标由调用方给 ——
/// 商业版的账户底栏 (commercial/drawer_account_footer.dart) 和下面的 [_SettingsFooter] 共用这一份排版。
class DrawerFooterShell extends StatelessWidget {
  const DrawerFooterShell({
    super.key,
    required this.leading,
    required this.name,
    this.badgeLabel,
  });

  final Widget leading;
  final String name;

  /// 名字右边那颗墨色小签 (套餐名)。null = 不画。
  final String? badgeLabel;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    void open() {
      Navigator.of(context).pop();
      context.push('/settings');
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 6, 14, 10),
      child: Row(
        children: [
          Expanded(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: open,
              child: Row(
                children: [
                  leading,
                  const SizedBox(width: 12),
                  Flexible(
                    child: Text(name,
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: c.ink)),
                  ),
                  if (badgeLabel != null) ...[
                    const SizedBox(width: 8),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                      decoration: BoxDecoration(color: c.ink, borderRadius: BorderRadius.circular(9)),
                      child: Text(badgeLabel!, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.onPrimary)),
                    ),
                  ],
                ],
              ),
            ),
          ),
          ClayRoundButton(icon: Icons.settings_outlined, size: 44, tooltip: tr('设置'), onTap: open),
        ],
      ),
    );
  }
}

/// 没有头像时的圆形占位 (人形图标)。
class DrawerFooterAvatarPlaceholder extends StatelessWidget {
  const DrawerFooterAvatarPlaceholder({super.key});

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Container(
      width: 40,
      height: 40,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: c.fill,
        boxShadow: clayShadow(c, lift: 0.5),
      ),
      child: Icon(Icons.person_outline_rounded, size: 20, color: c.grey),
    );
  }
}

/// 没有账号体系时的底栏: 只是一个进设置页的入口。
class _SettingsFooter extends StatelessWidget {
  const _SettingsFooter();

  @override
  Widget build(BuildContext context) => DrawerFooterShell(
        leading: const DrawerFooterAvatarPlaceholder(),
        name: tr('设置'),
      );
}

// ════════════════════════════════════════════════════════════════
//  会话树 / 时间分组 (全部会话页、设备会话页用)
// ════════════════════════════════════════════════════════════════

/// 会话列表摊平成 (会话, 缩进层级) 序列: 子会话嵌在父会话下面; 顶层按最近活跃倒序,
/// 同一父下的子会话按开始时间正序。父不在本地镜像里的孤儿子会话仍按顶层显示。
List<({SessionMirrorData s, int depth})> flattenSessionTree(List<SessionMirrorData> all) {
  final ids = {for (final s in all) s.id};
  bool hasParent(SessionMirrorData s) => s.parentSessionId != null && ids.contains(s.parentSessionId);

  final roots = all.where((s) => !hasParent(s)).toList()
    ..sort((a, b) => sessionLastTime(b).compareTo(sessionLastTime(a)));
  final childrenOf = <String, List<SessionMirrorData>>{};
  for (final s in all) {
    if (!hasParent(s)) continue;
    (childrenOf[s.parentSessionId!] ??= []).add(s);
  }
  for (final list in childrenOf.values) {
    list.sort((a, b) => sessionLastTime(a).compareTo(sessionLastTime(b)));
  }
  final rows = <({SessionMirrorData s, int depth})>[];
  for (final r in roots) {
    rows.add((s: r, depth: 0));
    for (final c in childrenOf[r.id] ?? const <SessionMirrorData>[]) {
      rows.add((s: c, depth: 1));
    }
  }
  return rows;
}

/// 按"大概什么时候"分段 — 今天 / 昨天 / 过去 7 天 / 更早. 子会话跟着父会话走, 不单独分段.
List<({String label, List<({SessionMirrorData s, int depth})> rows})> groupSessionsByRecency(
  List<({SessionMirrorData s, int depth})> rows, {
  DateTime? now,
}) {
  final ref = now ?? DateTime.now();
  final today = DateTime(ref.year, ref.month, ref.day);
  final yesterday = today.subtract(const Duration(days: 1));
  final week = today.subtract(const Duration(days: 7));

  final buckets = <String, List<({SessionMirrorData s, int depth})>>{
    '今天': [],
    '昨天': [],
    '过去 7 天': [],
    '更早': [],
  };

  String? currentBucket;
  for (final row in rows) {
    if (row.depth > 0 && currentBucket != null) {
      buckets[currentBucket]!.add(row);
      continue;
    }
    final t = sessionLastTime(row.s);
    /* 桶的 key 用中文原文, 显示时才 tr() —— key 要是先翻译了, 英文界面下查不到桶直接空指针 */
    final label = t.isAfter(today)
        ? '今天'
        : t.isAfter(yesterday)
            ? '昨天'
            : t.isAfter(week)
                ? '过去 7 天'
                : '更早';
    currentBucket = label;
    buckets[label]!.add(row);
  }

  return [
    for (final e in buckets.entries)
      if (e.value.isNotEmpty) (label: tr(e.key), rows: e.value),
  ];
}
