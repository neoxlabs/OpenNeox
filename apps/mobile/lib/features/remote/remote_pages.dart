/// 远程连接 (2026-10-12) —— 电脑上的工作 / 编码都从这里进。
///
/// 用户: 「左侧加一个『远程连接』, 里面包含 work 和编码两项。新页面直接显示所有的电脑, 一行一行的;
/// 点击这个电脑进去, 是一个新页面, 展示的是所有的会话。原本左侧的工作和编码拿掉 —— 进会话里再切本机 / 电脑,
/// 学习成本太高。」
///
/// 2026-10-15 闭环重做 (用户: 「远程连接 电脑列表没有设计 我发现我找不到远程的了」, 以及第一版 HTML 稿被否:
/// 「完全跟现在的不一样退步了, 插画都去哪里…我们现在的就很好看了」)。所以两页都照设置页那套搭:
/// 右上陶土插画 + 大标题 + 小泥块 + 分组泥板, 组件全用 shared/clay。
///
///   进门   侧栏「我的电脑」一台一行 / 会话 ⋯「这台电脑上的全部会话」
///   列表   头图 (手机连电脑) + 一台一张泥板: 名字 + 状态 → 正在跑的活 (点了直接进) / 最近一条
///   某台   头图 (开着的电脑 / 合盖睡着的电脑) + 名字 + 状态; 新建工作 / 新建编码两块;
///          正在跑的在最上, 其余按项目分组 (工作的会话归「工作」一组)
///   返回   从这里点进的会话, 左上是 ← (系统返回同理) 回到这台电脑
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/edition/edition.dart' show desktopPresenceProvider;
import '../../core/errors/friendly_error.dart';
import '../../core/execution/run_target_provider.dart';
import '../../core/i18n/tr.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/network/cli_endpoint_id.dart';
import '../../core/session_routing/session_router.dart';
import '../../core/storage/database.dart';
import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_toast.dart';
import '../home/state/current_project_provider.dart';
import '../home/state/current_session_provider.dart';
import '../home/state/home_mode_provider.dart';
import '../home/state/session_return_provider.dart';
import '../home/widgets/session_actions.dart' show showSessionActions;
import '../home/widgets/where_sheet.dart' show desktopNameOf, desktopStatusOf, orderDesktops;
import '../workspace/folder_picker.dart' show pickDesktopFolder;
import '../settings/settings_ui.dart';
import '../settings/unpair_desktop.dart';
import '../timeline/state/running_sessions_provider.dart';

bool _isMac(PairedDesktop d) => (d.deviceName ?? '').toLowerCase().contains('mac');

IconData _desktopIcon(PairedDesktop d) => _isMac(d) ? Icons.laptop_mac_rounded : Icons.desktop_windows_outlined;

bool _connectedTo(String deviceId, WsClientState ws) =>
    ws.activeDesktopDeviceId == deviceId && ws.connection == WsConnectionState.connected && ws.transport != WsTransport.cloudAgent;

String _route(String deviceId) => '/remote/${Uri.encodeComponent(deviceId)}';

/// 先连上这台, 再按它建一条新会话 (工作 / 编码), 进去; 返回键记着回这台电脑
Future<void> _newOnDesktop(BuildContext context, WidgetRef ref, String deviceId, HomeMode mode, {Future<void>? connecting}) async {
  final ws = ref.read(wsClientProvider.notifier);
  await (connecting ?? ws.connectToDesktop(deviceId).then((_) => ws.requestSessionList(limit: 1000)))
      .timeout(const Duration(seconds: 15))
      .catchError((Object _) {});
  if (!context.mounted) return;
  if (!_connectedTo(deviceId, ref.read(wsClientProvider))) {
    NeoxToast.show(tr('电脑暂时连不上，请稍后重试'));
    return;
  }
  /* 钉这台电脑, 按它建会话 (createBestSession 的 desktop 档会挑首选那台) */
  ref.read(preferredDesktopProvider.notifier).set(deviceId);
  final r = await ref.read(sessionRouterProvider).createBestSession(target: RunTargetPref.desktop, agentMode: mode.wireValue);
  if (!context.mounted) return;
  ref.read(homeModeProvider.notifier).set(mode);
  ref.read(currentSessionProvider.notifier).set(r.sessionId);
  ref.read(sessionReturnRouteProvider.notifier).state = (sessionId: r.sessionId, route: _route(deviceId));
  context.go('/');
}

/// 进一条电脑上的会话: 连接指向它那台, 返回键记着回这台电脑
void _enterSession(BuildContext context, WidgetRef ref, String deviceId, SessionMirrorData s) {
  ref.read(preferredDesktopProvider.notifier).set(deviceId);
  ref.read(homeModeProvider.notifier).set(homeModeFromWire(s.agentMode) ?? HomeMode.work);
  ref.read(currentSessionProvider.notifier).set(s.id);
  ref.read(sessionReturnRouteProvider.notifier).state = (sessionId: s.id, route: _route(deviceId));
  context.go('/');
}

/// 这台电脑上开了 /rc 的 CLI 终端的会话 (2026-10-17)。终端开着才有, 关了就没了 —— 放在新建按钮下面,
/// 跟客户端的会话分开一组, 每行带「终端」签, 一眼看出这条是在终端里跑的。
class _TerminalSessions extends ConsumerWidget {
  const _TerminalSessions({required this.computerId});

  final String computerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final db = ref.watch(appDatabaseProvider);
    final live = ref.watch(liveSessionsProvider);
    return StreamBuilder<List<SessionMirrorData>>(
      stream: db.sessionMirrorDao.watchAll(),
      builder: (context, snap) {
        final rows = (snap.data ?? const <SessionMirrorData>[])
            .where((s) => isCliEndpointId(s.desktopDeviceId) && computerOfSession(s.desktopDeviceId) == computerId)
            .toList();
        if (rows.isEmpty) return const SizedBox.shrink();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClaySectionLabel(tr('终端会话')),
            ClayGroup(
              children: [
                for (final s in rows)
                  ClayRow(
                    icon: Icons.terminal_rounded,
                    title: _sessionTitle(s),
                    subtitle: [
                      if ((s.workspaceName ?? '').trim().isNotEmpty) s.workspaceName!.trim(),
                      live.running.contains(s.id) ? tr('执行中') : _ago(s),
                    ].join(' · '),
                    trailing: ClayChip(label: tr('终端'), tone: ClayTone.cobalt, dense: true),
                    onTap: () => _enterSession(context, ref, computerId, s),
                  ),
              ],
            ),
          ],
        );
      },
    );
  }
}

String _sessionTitle(SessionMirrorData s) {
  final t = (s.title ?? '').trim();
  return (t.isEmpty || t == '新会话') ? tr('未命名会话') : t;
}

int _lastAt(SessionMirrorData s) => s.lastMessageAt ?? s.createdAt;

String _ago(SessionMirrorData s) => settingsRelativeTime(DateTime.fromMillisecondsSinceEpoch(_lastAt(s)));

/// 页头 (同设置页): 右上陶土插画, 左上 ←, 右上动作, 底部大标题 + 一行状态
class _ArtHeader extends StatelessWidget {
  const _ArtHeader({required this.art, required this.title, this.status, this.actions = const [], this.artWidth = 200, this.faded = false});

  final String art;
  final String title;
  final Widget? status;
  final List<Widget> actions;
  final double artWidth;
  final bool faded;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return SizedBox(
      height: 200,
      child: Stack(
        children: [
          /* 插画压低一截, 右上的 ＋ / ⋯ 不压在物件上 */
          Positioned(right: -4, top: 40, child: Opacity(opacity: faded ? 0.75 : 1, child: ClayArt(art, width: artWidth))),
          Positioned(
            left: 8,
            top: 4,
            child: ClayRoundButton(
              icon: Icons.arrow_back_rounded,
              flat: true,
              size: 44,
              tooltip: MaterialLocalizations.of(context).backButtonTooltip,
              /* 从会话退回来时下面是首页: 没有上一页就回首页 */
              onTap: () => context.canPop() ? context.pop() : context.go('/'),
            ),
          ),
          Positioned(right: 8, top: 4, child: Row(children: actions)),
          Positioned(
            left: 24,
            right: 24,
            bottom: 16,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                /* 标题只占左边六成, 不压插画; 电脑名长 (DESKTOP-07LLJV4 这类) 降一档字号 */
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.6),
                  child: Text(title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: title.length > 10 ? 21 : 26, fontWeight: FontWeight.w700, color: c.ink, height: 1.2)),
                ),
                if (status != null) ...[const SizedBox(height: 6), status!],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 状态行: 绿点 + 「在线 · 同 Wi-Fi」/ 灰字「不在线 · 3 天前」/ 小弧「正在连接…」
class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.online, required this.text, this.connecting = false, this.size = 13, this.dot = true});

  final bool online;
  final bool dot;
  final bool connecting;
  final String text;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (connecting)
          const Padding(padding: EdgeInsets.only(right: 6), child: ClaySpinner(size: 11))
        else if (online && dot)
          Padding(padding: const EdgeInsets.only(right: 6), child: ClayDot(color: c.green, size: 7)),
        Flexible(
          child: Text(text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: size, color: online ? c.greenInk : c.grey, height: 1.3)),
        ),
      ],
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  我的电脑: 所有配对过的电脑
// ════════════════════════════════════════════════════════════════

class RemotePage extends ConsumerWidget {
  const RemotePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final db = ref.watch(appDatabaseProvider);
    final presence = ref.watch(desktopPresenceProvider);
    final ws = ref.watch(wsClientProvider);
    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: StreamBuilder<List<PairedDesktop>>(
          stream: db.pairedDesktopsDao.watchAll(),
          builder: (context, snap) {
            final desktops = orderDesktops(snap.data ?? const [], presence, ws);
            final online = desktops.where((d) => desktopStatusOf(d, presence, ws).online).length;
            return ListView(
              padding: const EdgeInsets.only(bottom: 40),
              children: [
                _ArtHeader(
                  art: 'onboard-relay',
                  artWidth: 210,
                  title: tr('我的电脑'),
                  status: desktops.isEmpty
                      ? null
                      : Text(
                          online > 0
                              ? tr('%s 台在线 · 共 %s 台').replaceFirst('%s', '$online').replaceFirst('%s', '${desktops.length}')
                              : tr('都不在线 · 共 %s 台').replaceFirst('%s', '${desktops.length}'),
                          style: TextStyle(fontSize: 13, color: c.grey),
                        ),
                  actions: [
                    ClayRoundButton(
                      flat: true,
                      size: 44,
                      icon: Icons.add_rounded,
                      tooltip: tr('配对一台新电脑'),
                      onTap: () => context.push('/pairing'),
                    ),
                  ],
                ),
                if (snap.hasData && desktops.isEmpty)
                  ClayEmpty(
                    art: 'empty-laptop',
                    title: tr('还没有配对电脑'),
                    message: tr('配对后, 电脑上的工作和编码在手机上都能看、能接着做: 进度实时同步, 要你确认的操作直接在手机上批。'),
                    action: ClayButton.ink(
                      label: tr('扫码配对一台电脑'),
                      icon: Icons.qr_code_scanner_rounded,
                      onTap: () => context.push('/pairing'),
                    ),
                  ),
                for (final d in desktops)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    child: _DesktopCard(desktop: d),
                  ),
                if (desktops.isNotEmpty)
                  ClayGroup(
                    children: [
                      ClayRow(
                        icon: Icons.add_rounded,
                        title: tr('配对一台新电脑'),
                        subtitle: tr('电脑上打开 设置 → 远程访问, 扫二维码'),
                        onTap: () => context.push('/pairing'),
                      ),
                    ],
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// 一台电脑: 整张泥板点进去。
///   [方块●] 名字 / 在线 · 同 Wi-Fi · 12 个会话        ›
///   ◌ 正在跑的活 (最多 2 条, 点了直接进)  —— 没有就写「最近: xxx · 2 小时前」
///   不在线: 「开机并打开 Neox 就会连上」
class _DesktopCard extends ConsumerWidget {
  const _DesktopCard({required this.desktop});

  final PairedDesktop desktop;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final db = ref.watch(appDatabaseProvider);
    final presence = ref.watch(desktopPresenceProvider);
    final ws = ref.watch(wsClientProvider);
    final now = ref.watch(liveSessionsProvider);
    final d = desktop;
    final st = desktopStatusOf(d, presence, ws);
    return StreamBuilder<List<SessionMirrorData>>(
      stream: db.sessionMirrorDao.watchByDesktop(d.deviceId),
      builder: (context, snap) {
        final sessions = snap.data ?? const <SessionMirrorData>[];
        /* 等你确认的排前面, 再是在跑的 */
        final live = [
          ...sessions.where((s) => now.waiting.contains(s.id)),
          ...sessions.where((s) => now.running.contains(s.id) && !now.waiting.contains(s.id)),
        ].take(2).toList();
        final latest = sessions.firstOrNull;
        final status = [st.text, if (sessions.isNotEmpty) tr('%s 个会话').replaceFirst('%s', '${sessions.length}')].join(' · ');
        return ClaySlab(
          radius: 18,
          padding: const EdgeInsets.fromLTRB(14, 14, 10, 12),
          onTap: () => context.push(_route(d.deviceId)),
          /* 长按 = 这台的管理 (解除配对), 跟设置 → 设备里同一个面板 */
          onLongPress: () => showPairedDesktopActions(context, ref, d),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  ClayTile(icon: _desktopIcon(d), size: 48, bead: st.online ? c.green : null),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(desktopNameOf(d),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: c.ink, height: 1.3)),
                        const SizedBox(height: 3),
                        /* 方块右下已有绿珠, 这行不再挂点 */
                        _StatusLine(online: st.online, text: status, size: 12.5, dot: false),
                      ],
                    ),
                  ),
                  Icon(Icons.chevron_right_rounded, size: 22, color: c.faint),
                ],
              ),
              if (live.isNotEmpty || latest != null || !st.online)
                Padding(
                  padding: const EdgeInsets.only(left: 62, top: 10, right: 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final s in live)
                        GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () => _enterSession(context, ref, d.deviceId, s),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 5),
                            child: Row(
                              children: [
                                if (now.waiting.contains(s.id)) ClayDot(color: c.amber, size: 9) else const ClaySpinner(size: 11),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Text(_sessionTitle(s),
                                      maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: c.ink)),
                                ),
                                now.waiting.contains(s.id)
                                    ? ClayChip(label: tr('等你确认'), tone: ClayTone.amber, dense: true)
                                    : ClayChip(label: tr('执行中'), tone: ClayTone.cobalt, dense: true),
                              ],
                            ),
                          ),
                        ),
                      if (live.isEmpty && latest != null)
                        Text(
                          '${tr('最近')}: ${_sessionTitle(latest)} · ${_ago(latest)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12.5, color: c.grey),
                        ),
                      if (!st.online)
                        Padding(
                          padding: EdgeInsets.only(top: latest != null && live.isEmpty ? 4 : 0),
                          child: Text(tr('电脑开机并打开 Neox 就会连上'), style: TextStyle(fontSize: 12.5, color: c.faint)),
                        ),
                    ],
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  一台电脑: 头图 + 新建两块 + 这台上的会话 (正在跑的在上, 其余按项目)
// ════════════════════════════════════════════════════════════════

enum _Kind { all, work, code }

/// 每组先露几条, 其余「全部 N ›」展开
const _fold = 4;

class RemoteDesktopPage extends ConsumerStatefulWidget {
  const RemoteDesktopPage({super.key, required this.deviceId});
  final String deviceId;

  @override
  ConsumerState<RemoteDesktopPage> createState() => _RemoteDesktopPageState();
}

class _RemoteDesktopPageState extends ConsumerState<RemoteDesktopPage> {
  String? _busy;
  _Kind _kind = _Kind.all;
  final _expanded = <String>{};

  /// 进来那一下的连接; 完成后还没连上 = 连不上
  Future<void>? _connecting;
  bool _tried = false;

  @override
  void initState() {
    super.initState();
    _connect();
  }

  /* 进来就连上这台, 会话列表跟着同步到最新 */
  void _connect() {
    final ws = ref.read(wsClientProvider.notifier);
    final f = ws
        .connectToDesktop(widget.deviceId)
        .then((_) => ws.requestSessionList(limit: 1000))
        .timeout(const Duration(seconds: 15))
        .catchError((Object _) {});
    setState(() {
      _connecting = f;
      _tried = false;
    });
    f.whenComplete(() {
      if (mounted && _connecting == f) setState(() => _tried = true);
    });
  }

  Future<void> _new(HomeMode mode) async {
    if (_busy != null) return;
    setState(() => _busy = mode.wireValue);
    try {
      await _connecting;
      if (!mounted) return;
      if (!_connectedTo(widget.deviceId, ref.read(wsClientProvider))) {
        NeoxToast.show(tr('电脑暂时连不上，请稍后重试'));
        return;
      }
      if (mode == HomeMode.code) {
        /* 编码要知道在哪个项目里: 先挑项目 (这台电脑上开着的 / 最近的 / 翻文件夹), 也可以接着上次那条 */
        final pick = await showClaySheet<_ProjectPick>(context, builder: (_) => const _ProjectSheet());
        if (pick == null || !mounted) return;
        if (pick.continueSessionId != null) {
          final s = await ref.read(appDatabaseProvider).sessionMirrorDao.findById(pick.continueSessionId!);
          if (!mounted) return;
          if (s != null) {
            _enterSession(context, ref, widget.deviceId, s);
            return;
          }
        }
        if (!await ref.read(wsClientProvider.notifier).openWorkspaceOnDesktop(pick.path)) {
          NeoxToast.show(tr('打开项目失败，请确认电脑在线'));
          return;
        }
        ref.read(currentProjectProvider.notifier).set(
              CurrentProject(path: pick.path, name: pick.name, desktopDeviceId: widget.deviceId),
            );
      } else {
        /* 工作不在项目里: 按任务自己建文件夹 (别沿用上回编码选的项目) */
        ref.read(currentProjectProvider.notifier).clear();
      }
      if (!mounted) return;
      await _newOnDesktop(context, ref, widget.deviceId, mode, connecting: _connecting);
    } catch (e) {
      if (mounted) NeoxToast.show(friendlyError(e, fallback: tr('电脑暂时连不上，请稍后重试')));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  /// 先连上这台再进会话。不等的话: 现在连着的是另一台, 进去后连接一换, 首页的换电脑保护把会话踢回首页;
  /// 列表里还可能有电脑上早删掉的会话 (手机缓存), 点进去是空白 —— 这里先问一句, 没了就提示并从列表拿掉
  Future<void> _open(SessionMirrorData s) async {
    if (_busy != null) return;
    setState(() => _busy = s.id);
    try {
      await _connecting;
      if (!mounted) return;
      final ws = ref.read(wsClientProvider.notifier);
      if (ref.read(wsClientProvider).activeDesktopDeviceId == widget.deviceId) {
        final info = await ws.fetchSessionInfo(s.id);
        if (!mounted) return;
        if (info == null && await ref.read(appDatabaseProvider).sessionMirrorDao.findById(s.id) == null) {
          NeoxToast.show(tr('这条会话已在电脑上删掉了'));
          return;
        }
      }
    } finally {
      if (mounted) setState(() => _busy = null);
    }
    if (!mounted) return;
    _enterSession(context, ref, widget.deviceId, s);
  }

  Future<void> _more(PairedDesktop? d) async {
    final isDefault = ref.read(runTargetPrefProvider) == RunTargetPref.desktop && ref.read(preferredDesktopProvider) == widget.deviceId;
    final pick = await showClaySheet<String>(
      context,
      builder: (ctx) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ClaySheetHeader(title: d == null ? tr('这台电脑') : desktopNameOf(d)),
          ClayGroup(
            children: [
              ClayRow(icon: Icons.refresh_rounded, title: tr('重新连接'), onTap: () => Navigator.pop(ctx, 'connect')),
              /* 首页输入框新开的工作 / 编码默认落到哪 —— 跟「在哪干」里选这台是同一件事 */
              ClayRow(
                icon: Icons.near_me_outlined,
                title: isDefault ? tr('不再固定用这台') : tr('首页新会话固定用这台'),
                subtitle: isDefault ? tr('改回自动: 电脑在线用电脑, 不在线用手机') : tr('首页输入框发出的工作和编码都开在这台上'),
                onTap: () => Navigator.pop(ctx, 'default'),
              ),
              ClayRow(
                icon: Icons.devices_outlined,
                title: tr('设备管理'),
                subtitle: tr('首选电脑、连接方式'),
                onTap: () => Navigator.pop(ctx, 'devices'),
              ),
              if (d != null)
                ClayRow(icon: Icons.link_off_rounded, title: tr('解除配对'), danger: true, onTap: () => Navigator.pop(ctx, 'unpair')),
            ],
          ),
          SizedBox(height: 12 + MediaQuery.paddingOf(ctx).bottom),
        ],
      ),
    );
    if (!mounted) return;
    switch (pick) {
      case 'connect':
        _connect();
      case 'default':
        if (isDefault) {
          ref.read(runTargetPrefProvider.notifier).set(RunTargetPref.auto);
          NeoxToast.show(tr('已改回自动选择'));
        } else {
          ref.read(preferredDesktopProvider.notifier).set(widget.deviceId);
          ref.read(runTargetPrefProvider.notifier).set(RunTargetPref.desktop);
          NeoxToast.show(tr('首页新会话会开在「%s」上').replaceFirst('%s', d == null ? tr('这台电脑') : desktopNameOf(d)));
        }
      case 'devices':
        context.push('/settings/devices');
      case 'unpair':
        await confirmAndUnpairDesktop(context, ref, d!);
        if (!mounted) return;
        /* 解除成功 (库里没这台了) 就退出这一页 */
        final left = await ref.read(appDatabaseProvider).pairedDesktopsDao.watchAll().first;
        if (mounted && !left.any((x) => x.deviceId == widget.deviceId)) {
          context.canPop() ? context.pop() : context.go('/');
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final db = ref.watch(appDatabaseProvider);
    final presence = ref.watch(desktopPresenceProvider);
    final ws = ref.watch(wsClientProvider);
    final live = ref.watch(liveSessionsProvider);
    final connected = _connectedTo(widget.deviceId, ws);
    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: StreamBuilder<List<PairedDesktop>>(
          stream: db.pairedDesktopsDao.watchAll(),
          builder: (context, ds) {
            final d = (ds.data ?? const <PairedDesktop>[]).where((x) => x.deviceId == widget.deviceId).firstOrNull;
            final st = d == null ? null : desktopStatusOf(d, presence, ws);
            /* 进页就去连: 连上前写「正在连接」; 连过一轮还没上 = 连不上 */
            final failed = !connected && _tried;
            final connecting = !connected && !_tried;
            final online = connected || (st?.online ?? false) && !failed;
            final statusText = connected
                ? st!.text
                : connecting
                    ? tr('正在连接…')
                    : (st?.online ?? false)
                        ? tr('开着但连不上')
                        : (st?.text ?? tr('不在线'));
            return StreamBuilder<List<SessionMirrorData>>(
              stream: db.sessionMirrorDao.watchByDesktop(widget.deviceId),
              builder: (context, snap) {
                final all = snap.data ?? const <SessionMirrorData>[];
                /* 下拉 = 重新连一次并把电脑上的会话列表拉到最新 */
                return RefreshIndicator(
                  color: c.ink,
                  backgroundColor: c.slab,
                  onRefresh: () {
                    _connect();
                    return _connecting ?? Future.value();
                  },
                  child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.only(bottom: 40),
                  children: [
                    _ArtHeader(
                      art: failed ? 'empty-laptop' : 'home-work',
                      artWidth: failed ? 170 : 200,
                      faded: failed,
                      title: d == null ? tr('未命名电脑') : desktopNameOf(d),
                      status: _StatusLine(online: online && !connecting, connecting: connecting, text: statusText),
                      actions: [
                        ClayRoundButton(flat: true, size: 44, icon: Icons.more_horiz_rounded, tooltip: tr('更多'), onTap: () => _more(d)),
                      ],
                    ),
                    if (failed)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                        child: ClaySlab(
                          color: c.amberSoft,
                          radius: 16,
                          padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  [
                                    (st?.online ?? false) ? tr('电脑开着, 但这条路连不过去。') : tr('电脑没开或 Neox 没运行。'),
                                    all.isEmpty ? tr('开机并打开 Neox 后会自动连上') : tr('下面是上次同步的会话, 能看不能接着做'),
                                  ].join(),
                                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.amberInk),
                                ),
                              ),
                              TextButton(
                                onPressed: _connect,
                                child: Text(tr('重试'), style: TextStyle(color: c.amberInk, fontWeight: FontWeight.w600)),
                              ),
                            ],
                          ),
                        ),
                      ),
                    _NewTiles(
                      busy: _busy,
                      enabled: !failed,
                      onNew: _new,
                    ),
                    _TerminalSessions(computerId: widget.deviceId),
                    ..._sessionList(all, live, connected),
                  ],
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }

  List<Widget> _sessionList(List<SessionMirrorData> all, ({Set<String> running, Set<String> waiting}) state, bool connected) {
    final c = ClayInk.of(context);
    if (all.isEmpty) {
      return [
        ClayEmpty(
          art: 'empty-shelf',
          title: tr('这台电脑上还没有会话'),
          /* 连不上时上面琥珀条已经说了怎么办, 这里不再重复 */
          message: connected ? tr('点上面开一个, 电脑上的会话也会同步过来') : null,
        ),
      ];
    }
    final works = all.where((s) => s.agentMode != 'code').length;
    final codes = all.length - works;
    final shown = switch (_kind) {
      _Kind.all => all,
      _Kind.work => all.where((s) => s.agentMode != 'code').toList(),
      _Kind.code => all.where((s) => s.agentMode == 'code').toList(),
    };
    /* 等你确认 → 正在跑 → 其余分组; 一条只出现在一处 */
    final waiting = shown.where((s) => state.waiting.contains(s.id)).toList();
    final live = shown.where((s) => state.running.contains(s.id) && !state.waiting.contains(s.id)).toList();
    final rest = shown.where((s) => !state.running.contains(s.id) && !state.waiting.contains(s.id));

    /* 编码按项目分组 (项目名); 工作没有项目, 按 今天 / 昨天 / 过去 7 天 / 更早 分组 (一台电脑上工作会话能有几百条,
     * 塞一组只露 3 条等于没法找); 组按最近活动排 */
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day).millisecondsSinceEpoch;
    const day = 86400000;
    String when(SessionMirrorData s) {
      final t = _lastAt(s);
      if (t >= today) return tr('今天');
      if (t >= today - day) return tr('昨天');
      if (t >= today - 7 * day) return tr('过去 7 天');
      return tr('更早');
    }

    final groups = <String, List<SessionMirrorData>>{};
    for (final s in rest) {
      final ws = (s.workspaceName ?? '').trim();
      final key = s.agentMode == 'code' ? (ws.isNotEmpty ? ws : tr('其他项目')) : '${tr('工作')} · ${when(s)}';
      groups.putIfAbsent(key, () => []).add(s);
    }
    final keys = groups.keys.toList()..sort((a, b) => _lastAt(groups[b]!.first).compareTo(_lastAt(groups[a]!.first)));

    return [
      /* 两种都有才给筛选 —— 只有一种时三个签全是一样的列表 */
      if (works > 0 && codes > 0)
        Padding(
          padding: const EdgeInsets.only(top: 18),
          child: ClayFilterPills<_Kind>(
            value: _kind,
            onChanged: (k) => setState(() => _kind = k),
            options: [
              (_Kind.all, '${tr('全部')} ${all.length}'),
              (_Kind.code, '${tr('编码')} $codes'),
              (_Kind.work, '${tr('工作')} $works'),
            ],
          ),
        ),
      if (waiting.isNotEmpty) ...[
        ClaySectionLabel(tr('等你确认')),
        ClayGroup(children: [for (final s in waiting) _row(s, waiting: true)]),
      ],
      if (live.isNotEmpty) ...[
        ClaySectionLabel(tr('正在跑')),
        ClayGroup(children: [for (final s in live) _row(s, running: true)]),
      ],
      for (final k in keys) ...[
        ClaySectionLabel(
          k,
          trailing: groups[k]!.length > _fold
              ? GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => setState(() => _expanded.contains(k) ? _expanded.remove(k) : _expanded.add(k)),
                  child: Text(
                    _expanded.contains(k) ? tr('收起') : '${tr('全部')} ${groups[k]!.length} ›',
                    style: TextStyle(fontSize: 13, color: c.grey),
                  ),
                )
              : null,
        ),
        ClayGroup(children: [for (final s in groups[k]!.take(_expanded.contains(k) ? 200 : _fold)) _row(s)]),
      ],
    ];
  }

  Widget _row(SessionMirrorData s, {bool running = false, bool waiting = false}) {
    final project = (s.workspaceName ?? '').trim();
    return ClayRow(
      icon: s.agentMode == 'code' ? Icons.code_rounded : Icons.description_outlined,
      title: _sessionTitle(s),
      subtitle: running || waiting
          ? [if (project.isNotEmpty) project, waiting ? tr('点进去批准或回答') : tr('执行中')].join(' · ')
          : _ago(s),
      trailing: _busy == s.id || running
          ? const ClaySpinner(size: 15)
          : waiting
              ? ClayChip(label: tr('等你'), tone: ClayTone.amber, dense: true)
              : null,
      onTap: () => _open(s),
      /* 跟侧栏一样: 长按 = 重命名 / 钉住 / 删除 */
      onLongPress: () => showSessionActions(context, ref, s),
    );
  }
}

String _shortPath(String p) => p
    .replaceFirst(RegExp(r'^/Users/[^/]+(?=/|$)'), '~')
    .replaceFirst(RegExp(r'^/home/[^/]+(?=/|$)'), '~')
    .replaceFirst(RegExp(r'^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)'), '~');

/// 最后一段目录名 (Mac / Windows 两种分隔符)
String _baseName(String p) => p.split(RegExp(r'[/\\]')).where((s) => s.isNotEmpty).lastOrNull ?? p;

bool _isTempDir(String p) =>
    RegExp(r'^(/private)?/tmp/|^/var/folders/|\\AppData\\Local\\Temp\\', caseSensitive: false).hasMatch(p);

class _ProjectPick {
  const _ProjectPick({required this.path, required this.name, this.continueSessionId});
  final String path;
  final String name;

  /// 非空 = 点的是「接着上次」
  final String? continueSessionId;
}

/// 新建编码先挑项目: 这台电脑上开着的 → 最近打开过的 → 翻电脑上的文件夹. 整行 = 在项目里开新会话, 右边「接着上次」打开那条.
class _ProjectSheet extends ConsumerStatefulWidget {
  const _ProjectSheet();

  @override
  ConsumerState<_ProjectSheet> createState() => _ProjectSheetState();
}

class _ProjectSheetState extends ConsumerState<_ProjectSheet> {
  late final Future<List<List<WorkspaceInfo>>> _future;

  @override
  void initState() {
    super.initState();
    final ws = ref.read(wsClientProvider.notifier);
    _future = Future.wait([ws.fetchWorkspaces(), ws.fetchRecentWorkspaces()]);
  }

  Future<void> _browse() async {
    final path = await pickDesktopFolder(context, ref);
    if (path == null || path.isEmpty || !mounted) return;
    Navigator.pop(context, _ProjectPick(path: path, name: _baseName(path)));
  }

  Widget _row(WorkspaceInfo w, {required bool open}) {
    final hasRecent = w.recentSessionId?.isNotEmpty ?? false;
    /* Windows 那头开着的工作区 name 字段就是整条路径 (e:\code\ordersys) —— 带分隔符的也取最后一段 */
    final raw = w.name.trim();
    final name = raw.isEmpty || raw.contains('/') || raw.contains('\\') ? _baseName(raw.isEmpty ? w.path : raw) : raw;
    return ClayRow(
      icon: open ? Icons.folder_rounded : Icons.history_rounded,
      title: name,
      /* 路径而不是「最近打开」: 同名文件夹很常见; 家目录缩成 ~ 免得一行放不下 */
      subtitle: _shortPath(w.path),
      trailing: hasRecent
          ? GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => Navigator.pop(context, _ProjectPick(path: w.path, name: name, continueSessionId: w.recentSessionId)),
              child: ClayChip(label: tr('接着上次'), tone: ClayTone.cobalt, dense: true),
            )
          : null,
      onTap: () => Navigator.pop(context, _ProjectPick(path: w.path, name: name)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return FutureBuilder<List<List<WorkspaceInfo>>>(
      future: _future,
      builder: (context, snap) {
        final loading = snap.connectionState != ConnectionState.done;
        final open = snap.data?[0] ?? const <WorkspaceInfo>[];
        final openPaths = open.map((w) => w.path).toSet();
        /* 临时目录 (测试 / 脚本跑出来的) 不算项目 */
        final recent = (snap.data?[1] ?? const <WorkspaceInfo>[])
            .where((w) => !openPaths.contains(w.path) && !_isTempDir(w.path))
            .take(6)
            .toList();
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ClaySheetHeader(title: tr('在哪个项目里编码'), subtitle: tr('项目在电脑上, 改动也落在电脑上')),
            if (loading)
              const Padding(padding: EdgeInsets.symmetric(vertical: 28), child: Center(child: ClaySpinner(size: 20)))
            else ...[
              if (snap.hasError)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                  child: Text(tr('没读到电脑上的项目列表，可以直接翻文件夹。'), style: TextStyle(fontSize: 13, color: c.grey)),
                ),
              if (open.isNotEmpty) ...[
                ClaySectionLabel(tr('电脑上开着的'), padding: const EdgeInsets.fromLTRB(24, 4, 24, 8)),
                ClayGroup(children: [for (final w in open) _row(w, open: true)]),
              ],
              if (recent.isNotEmpty) ...[
                ClaySectionLabel(tr('最近打开过')),
                ClayGroup(children: [for (final w in recent) _row(w, open: false)]),
              ],
              if (open.isEmpty && recent.isEmpty && !snap.hasError)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                  child: Text(tr('电脑上还没有打开过的项目。'), style: TextStyle(fontSize: 13, color: c.grey)),
                ),
              const SizedBox(height: 12),
              ClayGroup(
                children: [
                  ClayRow(icon: Icons.folder_open_rounded, title: tr('翻电脑上的文件夹'), subtitle: tr('选任意目录当项目'), onTap: _browse),
                ],
              ),
            ],
            SizedBox(height: 14 + MediaQuery.paddingOf(context).bottom),
          ],
        );
      },
    );
  }
}

/// 新建两块 (同设置页小泥块): 陶土图 + 「新建工作 / 在这台电脑上」
class _NewTiles extends StatelessWidget {
  const _NewTiles({required this.busy, required this.enabled, required this.onNew});

  final String? busy;
  final bool enabled;
  final ValueChanged<HomeMode> onNew;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    Widget tile(HomeMode mode, String art, String label, String hint) => Expanded(
          child: Opacity(
            opacity: enabled ? 1 : 0.5,
            child: ClaySlab(
              radius: 16,
              padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
              onTap: enabled && busy == null ? () => onNew(mode) : null,
              child: Row(
                children: [
                  SizedBox(
                    width: 40,
                    height: 40,
                    child: busy == mode.wireValue ? const Center(child: ClaySpinner(size: 16)) : ClayArt(art, width: 40, height: 40),
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(label,
                            maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: c.ink)),
                        Text(hint, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: c.grey)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Row(
        children: [
          tile(HomeMode.code, 'onboard-code', tr('新建编码'), tr('改代码、跑项目')),
          const SizedBox(width: 10),
          tile(HomeMode.work, 'onboard-work', tr('新建工作'), tr('做表格、文档、PPT')),
        ],
      ),
    );
  }
}
