/// workbench_page.dart — 工作 / 编码 的「设备页」.
///
/// 2026-10-12 用户四轮:
///   1) 「点工作 / 编码要有个页面, 把手机和电脑都列出来, 点手机看手机上的会话, 点电脑看那台
///      电脑的会话; 现在点进去直接就是个空白, 用户很懵逼」
///   2) 「布局优化, 出个陶土风背景素材; 缺添加设备的按钮; 连接与否让图标变色去说;
///      断开就说'已断开连接' + 上次连接是 10 小时还是一天; 会话列表要能筛选」
///   3) 「返回后 为什么就是这个界面啊 逻辑不对」
///   4) 「这个页面还是太丑了」(会话列表页)
///
/// 结构 (第 3 轮定下来的, 不再动):
///   工作 / 编码 这两个模式的**首页本身就是设备页** —— [WorkbenchView] 由 home_stage_page
///   在没有当前会话时直接渲染。没有 push 出来的第二屏, 也就没有"返回后是哪一屏"的问题。
///   唯一还 push 的是「某台设备上的会话」([DeviceSessionsPage]), 那是真的下一层。
///
/// 视觉:
///   · 首页 = 陶土横幅 ([NeoxClayBanner]) + 设备行;
///   · 会话页 = 同一套陶土页头 (设备名 + 连接状态写在图上) + 筛选片 + 按时间分组的会话卡;
///   · 状态一律**一色一图**: 图标底色随连接状态变 (绿 = 现在能派活, 灰 = 断开), 文字说清是
///     「已连接」还是「已断开连接 · 10 小时前连接过」。不用 Connected / Online 药丸 ——
///     一排药丸看过去全是灰底小字, 谁连得上要一个个读; 颜色扫一眼就知道。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/device/device_display_name.dart';
import '../../core/edition/edition.dart' show desktopPresenceProvider;
import '../../core/errors/friendly_error.dart';
import '../../core/execution/run_target.dart'
    show isPhoneLocalDeviceId, kPhoneLocalDeviceId;
import '../../core/execution/run_target_provider.dart';
import '../../core/i18n/tr.dart';
import '../../core/network/desktop_presence.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/session_routing/session_router.dart';
import '../../core/storage/database.dart';
import '../../core/storage/paired_desktop_kind.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/asset_px.dart';
import '../../shared/widgets/neox_button.dart';
import '../../shared/widgets/neox_drawer.dart' show groupSessionsByRecency;
import '../../shared/widgets/neox_page_hero.dart';
import '../../shared/widgets/neox_section.dart';
import '../../shared/widgets/session_running_dot.dart';
import '../home/state/current_session_provider.dart';
import '../home/state/home_mode_provider.dart';
import '../home/state/session_return_provider.dart';
import '../timeline/state/running_sessions_provider.dart';
import '../home/widgets/mode_dashboards.dart' show PickProjectPill;
import '../settings/settings_ui.dart';

/// 分组标题 / 卡片共同的左右留白 —— 标题落在 20, 跟各设置页同一条竖线.
const EdgeInsets _kSectionPad = EdgeInsets.fromLTRB(
  NeoxSpace.xl + NeoxSpace.xs,
  NeoxSpace.lg,
  NeoxSpace.xl,
  NeoxSpace.xs,
);
const EdgeInsets _kGroupMargin = EdgeInsets.symmetric(horizontal: NeoxSpace.xl);

/// 设备行: 图标 40 + 间距 14 → 文字从 70 起, 分隔线跟着它缩进
const double _kTileInset = NeoxSpace.lg + 40 + 14;
const double _kTileIcon = 40;

/// 会话行: 图标 30 + 间距 14 → 文字从 60 起, 分隔线跟着它缩进
const double _kSessionInset = NeoxSpace.lg + 30 + 14;

/// 这条会话归哪个模式 —— 手机本地的看 agentMode (chat/work/code), 电脑上的按 wire 值.
/// 认不出模式 (老会话没记 agentMode) 的归工作: 少列一条比凭空消失强.
HomeMode _modeOf(SessionMirrorData s) =>
    homeModeOfSession(
      agentMode: s.agentMode,
      desktopDeviceId: s.desktopDeviceId,
    ) ??
    HomeMode.work;

bool _isConnected(WsClientState ws, String deviceId) =>
    ws.activeDesktopDeviceId == deviceId &&
    ws.connection == WsConnectionState.connected;

String _desktopName(PairedDesktop d) =>
    friendlyDeviceName(d.deviceName) ?? tr('未命名电脑');

/// 一台电脑此刻的**状态**: 颜色 + 一句话.
///
/// 颜色只有两种语义 —— 绿 = 现在能干活 (连着 / 开着), 灰 = 现在不行。
/// 「开着但没连」跟「连着」共用绿色是对的: 用户关心的是"我能不能派活", 不是那条
/// socket 挂在谁身上; 真要用它, 点一下就连上了。
({Color tint, String text}) _desktopState(
  PairedDesktop d,
  DesktopPresenceView presence,
  WsClientState ws,
  ColorScheme scheme,
) {
  if (_isConnected(ws, d.deviceId)) {
    return (tint: NeoxClaudePalette.online, text: tr('已连接'));
  }
  if (presence.isOnline(d.deviceId)) {
    return (tint: NeoxClaudePalette.online, text: tr('在线, 可以派活'));
  }
  final last = d.lastConnectedAt == null
      ? null
      : DateTime.fromMillisecondsSinceEpoch(d.lastConnectedAt!);
  return (
    /* 离线用调色板里那个哑光灰 (#8A8478): 用 scheme.outline 的话暗色卡片上
     * 跟底色几乎一样, 那颗状态点就成了个看不见的黑点 (2026-10-12 用户: 「灰色就行了」) */
    tint: NeoxClaudePalette.offline,
    /* 「10 小时前」/「1 天前」比一句"不在线"有用得多: 用户判断的是"这机器多久没开过了" */
    text: last == null
        ? tr('已断开连接')
        : '${tr('已断开连接')} · ${tr('${settingsRelativeTime(last)}连接过')}',
  );
}

/// 在这台设备上新建一条会话, 然后进它.
///
/// 手机 = 本机跑 (RunTargetPref.phone); 电脑 = 钉住这台再建 (RunTargetPref.desktop).
Future<void> _createSessionOn(
  BuildContext context,
  WidgetRef ref, {
  required String deviceId,
  required HomeMode mode,
}) async {
  final isPhone = isPhoneLocalDeviceId(deviceId);
  if (!isPhone) ref.read(preferredDesktopProvider.notifier).set(deviceId);
  try {
    final r = await ref
        .read(sessionRouterProvider)
        .createBestSession(
          target: isPhone ? RunTargetPref.phone : RunTargetPref.desktop,
          agentMode: mode.wireValue,
        );
    if (!context.mounted) return;
    ref.read(homeModeProvider.notifier).set(mode);
    ref.read(currentSessionProvider.notifier).set(r.sessionId);
    context.go('/');
  } catch (e) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(friendlyError(e, fallback: tr('电脑暂时连不上，请稍后重试'))),
      ),
    );
  }
}

/// 进某台设备的会话页 —— 电脑先连上 (会话列表才同步得到最新的).
void _openDevice(
  BuildContext context,
  WidgetRef ref,
  String deviceId,
  HomeMode mode,
) {
  if (!isPhoneLocalDeviceId(deviceId)) {
    final ws = ref.read(wsClientProvider.notifier);
    unawaited(
      ws
          .connectToDesktop(deviceId)
          .then((_) => ws.requestSessionList(limit: 1000))
          .catchError((Object _) {}),
    );
    ref.read(preferredDesktopProvider.notifier).set(deviceId);
  }
  context.push(
    '/workbench/${mode.wireValue}/device/${Uri.encodeComponent(deviceId)}',
  );
}

// ════════════════════════════════════════════════════════════════
//  设备行 —— 图标底色说状态, 一行一句话
// ════════════════════════════════════════════════════════════════
class _DeviceTile extends StatelessWidget {
  const _DeviceTile({
    required this.title,
    required this.subtitle,
    required this.clay,
    required this.tint,
    required this.onTap,
    this.dot,
  });

  final String title;
  final String subtitle;

  /// assets/clay 下的名字 (i-phone / i-laptop)
  final String clay;

  /// 状态色 —— 圆底和图标都跟着它走
  final Color tint;

  /// 右下角那颗实心状态点. null = 不画 (本机没"连不连"这回事).
  final Color? dot;

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            NeoxSpace.lg,
            NeoxSpace.sm + 2,
            NeoxSpace.lg,
            NeoxSpace.sm + 2,
          ),
          child: Row(
            children: [
              /* 图标变色 —— 用户原话「连接不连接不要用 connected 来显示, 而是通过图标的一个变色」。
               * 陶土图是位图, 直接染色会脏; 染它下面那层圆底, 一眼看过去就是"这个图标变了色"。
               *
               * ⚠ 光靠圆底色**不够** (2026-10-12 用户: 「这个绿色连接状态不明显」): 暗色卡片上
               * 一层 14% 的绿差一点点才看得出来。所以再加一颗右下角的**实心状态点** ——
               * 跟首页顶栏那颗（_RunPlaceIcon）同一个做法, 描边用卡片底色, 从圆底上"切"出来。 */
              Stack(
                clipBehavior: Clip.none,
                children: [
                  Container(
                    width: _kTileIcon,
                    height: _kTileIcon,
                    decoration: BoxDecoration(
                      color: tint.withValues(alpha: dot == null ? 0.14 : 0.22),
                      borderRadius: BorderRadius.circular(NeoxRadius.chip + 4),
                    ),
                    alignment: Alignment.center,
                    child: Image.asset(
                      NeoxClay.of(clay),
                      width: 26,
                      height: 26,
                      /* 陶土图源文件是 192×192, 这里只显示 26 —— 不按显示尺寸解码的话,
                       * 一屏五台设备就是把五张 192² 的位图原样上传 GPU (见 asset_px.dart) */
                      cacheWidth: assetPx(26),
                      filterQuality: FilterQuality.medium,
                    ),
                  ),
                  if (dot != null)
                    Positioned(
                      right: -1,
                      bottom: -1,
                      child: Container(
                        width: 14,
                        height: 14,
                        decoration: BoxDecoration(
                          color: dot,
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: theme.colorScheme.surfaceContainerHigh,
                            width: 2,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontSize: 15.5,
                        fontWeight: FontWeight.w500,
                        height: 1.25,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: mute,
                        fontSize: 13,
                        height: 1.2,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Icon(
                Icons.chevron_right,
                size: 18,
                color: mute.withValues(alpha: 0.8),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  设备页本体 —— 工作 / 编码 的首页就是它
// ════════════════════════════════════════════════════════════════
class WorkbenchView extends ConsumerWidget {
  const WorkbenchView({super.key, required this.mode});

  final HomeMode mode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final db = ref.watch(appDatabaseProvider);
    final presence = ref.watch(desktopPresenceProvider);
    final ws = ref.watch(wsClientProvider);
    final scheme = Theme.of(context).colorScheme;

    return StreamBuilder<List<PairedDesktop>>(
      stream: db.pairedDesktopsDao.watchAll(),
      builder: (context, ds) {
        final desktops =
            (ds.data ?? const <PairedDesktop>[])
                .where(isRealPairedDesktop)
                .toList()
              ..sort((a, b) {
                int rank(PairedDesktop d) => _isConnected(ws, d.deviceId)
                    ? 0
                    : presence.isOnline(d.deviceId)
                    ? 1
                    : 2;
                final r = rank(a).compareTo(rank(b));
                if (r != 0) return r;
                return (b.lastConnectedAt ?? 0).compareTo(a.lastConnectedAt ?? 0);
              });

        return ListView(
          padding: const EdgeInsets.only(bottom: 24),
          children: [
            NeoxClayBanner(
              asset: 'bg-workbench',
              title: mode.label,
              /* 只留一句短的 —— 长了会仲到右边陶土物件的头上 (浅灰字压白底盘读不清):
               * "本机和电脑都行" 七个字正好落在物件左边的空区里, 下面两个分组
               * (这台手机 / 电脑) 本来就把话说完了 */
              subtitle: tr('本机和电脑都行'),
            ),

            NeoxSectionLabel(text: tr('这台手机'), padding: _kSectionPad),
            SettingsGroup(
              margin: _kGroupMargin,
              dividerIndent: _kTileInset,
              children: [
                _DeviceTile(
                  clay: 'i-phone',
                  title: tr('这台手机'),
                  /* 本机没有"连不连"这回事 —— 拿起手机就在跑, 所以直接算"能干活"那个绿 */
                  tint: NeoxClaudePalette.online,
                  subtitle: tr('本机直接跑'),
                  onTap: () =>
                      _openDevice(context, ref, kPhoneLocalDeviceId, mode),
                ),
              ],
            ),

            NeoxSectionLabel(text: tr('电脑'), padding: _kSectionPad),
            SettingsGroup(
              margin: _kGroupMargin,
              dividerIndent: _kTileInset,
              children: [
                if (desktops.isEmpty)
                  _DeviceTile(
                    clay: 'i-laptop',
                    title: tr('还没有配对电脑'),
                    subtitle: tr('在电脑上装好 Neox, 扫码配对一次就行'),
                    tint: scheme.outline,
                    onTap: () => context.push('/pairing'),
                  ),
                for (final d in desktops)
                  _DeviceTile(
                    clay: 'i-laptop',
                    title: _desktopName(d),
                    subtitle: _desktopState(d, presence, ws, scheme).text,
                    tint: _desktopState(d, presence, ws, scheme).tint,
                    dot: _desktopState(d, presence, ws, scheme).tint,
                    onTap: () => _openDevice(context, ref, d.deviceId, mode),
                  ),
              ],
            ),

            /* 添加设备的按钮 —— 用户: 「缺少添加设备的这个按钮」。
             * 原来只有分组里一行小字, 摆在一堆电脑中间看着像另一台设备。 */
            Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoxSpace.xl,
                NeoxSpace.md,
                NeoxSpace.xl,
                0,
              ),
              child: NeoxButton(
                label: tr('添加一台电脑'),
                icon: Icons.add_rounded,
                variant: NeoxButtonVariant.secondary,
                size: NeoxButtonSize.medium,
                fullWidth: true,
                onPressed: () => context.push('/pairing'),
              ),
            ),

            /* 编码: 项目在电脑上, 这颗药丸是"直接进某个仓库开工"的入口
             * (原来挂在编码首页, 首页换成设备页后跟着搬过来) */
            if (mode == HomeMode.code) ...[
              const SizedBox(height: NeoxSpace.lg),
              const PickProjectPill(),
            ],
          ],
        );
      },
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  会话行 —— 图标 + 标题 + "在哪 · 什么时候"
// ════════════════════════════════════════════════════════════════
/// 会话行: 陶土图标坐在一枚浅底圆角里 (跟设备行同一个节奏), 右侧只留一个 chevron.
///
/// 时间从"右对齐一列"挪进副标题 (用户第 4 轮: 「这个页面还是太丑了」) ——
/// 原来右边一列时间 + 一个 chevron, 两个东西抢同一块地, 扫视时眼睛要跳两次;
/// 而"在哪 + 什么时候"本来就是一句话, 合成一行读完就往下走。
class _SessionTile extends StatelessWidget {
  const _SessionTile({
    required this.mode,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.running = false,
  });

  final HomeMode mode;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  /// 这条会话此刻在跑 —— 尾巴上挂一颗呼吸点 (2026-10-12 用户: 「列表里如果运行中的
  /// 话, 有个运行的动画显示更好」)。
  final bool running;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mute = theme.colorScheme.onSurfaceVariant;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            NeoxSpace.lg,
            NeoxSpace.sm + 2,
            NeoxSpace.lg,
            NeoxSpace.sm + 2,
          ),
          child: Row(
            children: [
              /* 不套底板 (2026-10-12 用户: 「背景单独的没必要啊…双重嵌套了」):
               * 一列会话本来就装在卡片里, 图标再套一层圆角方块就是盒子里装盒子;
               * 而且 36 的框里放 22 的图, 占比小到看不清 —— 那点区分度全被吃掉了。
               * 直接给图标本身, 尺寸放到 30 (跟抽屉里那行同一个量级)。 */
              Image.asset(
                NeoxClay.of(switch (mode) {
                  HomeMode.chat => 'i-chat',
                  HomeMode.code => 'i-code',
                  HomeMode.work => 'i-doc',
                }),
                width: 30,
                height: 30,
                cacheWidth: assetPx(30),
                filterQuality: FilterQuality.medium,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontSize: 15.5,
                        fontWeight: FontWeight.w500,
                        height: 1.25,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: mute,
                        fontSize: 13,
                        height: 1.2,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              if (running) ...[
                const SessionRunningDot(),
                const SizedBox(width: 10),
              ],
              Icon(
                Icons.chevron_right,
                size: 18,
                color: mute.withValues(alpha: 0.8),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  某台设备上的会话 —— 可筛选 + 按时间分组
// ════════════════════════════════════════════════════════════════
enum _Scope { all, work, code, chat }

extension on _Scope {
  String get label => switch (this) {
    _Scope.all => tr('全部'),
    _Scope.work => tr('工作'),
    _Scope.code => tr('编码'),
    _Scope.chat => tr('对话'),
  };

  bool matches(HomeMode m) => switch (this) {
    _Scope.all => true,
    _Scope.work => m == HomeMode.work,
    _Scope.code => m == HomeMode.code,
    _Scope.chat => m == HomeMode.chat,
  };
}

class DeviceSessionsPage extends ConsumerStatefulWidget {
  const DeviceSessionsPage({
    super.key,
    required this.mode,
    required this.deviceId,
  });

  final HomeMode mode;
  final String deviceId;

  @override
  ConsumerState<DeviceSessionsPage> createState() => _DeviceSessionsPageState();
}

class _DeviceSessionsPageState extends ConsumerState<DeviceSessionsPage> {
  int _shown = 50;
  bool _creating = false;
  bool _connecting = false;

  /* 进来先看"全部" —— 挑了电脑之后第一件事是"这台机器上都有什么", 不是"这里有几条编码"。
   * 想收窄就点筛选片; 口子开在宽的一头, 比开在窄的一头让人少一次困惑。 */
  _Scope _scope = _Scope.all;

  bool get _isPhone => isPhoneLocalDeviceId(widget.deviceId);

  @override
  void initState() {
    super.initState();
    if (_isPhone) return;
    /* 进来就连上这台, 会话列表跟着同步到最新 */
    unawaited(_connect());
  }

  Future<void> _connect() async {
    if (_isPhone) return;
    final ws = ref.read(wsClientProvider.notifier);
    try {
      await ws.connectToDesktop(widget.deviceId);
      await ws.requestSessionList(limit: 1000);
    } catch (_) {
      /* 连不上不是错误 —— 列表里还有上次同步下来的会话, 页头会说清"已断开连接" */
    }
  }

  Future<void> _connectManually() async {
    if (_connecting) return;
    setState(() => _connecting = true);
    try {
      await _connect();
    } finally {
      if (mounted) setState(() => _connecting = false);
    }
  }

  Future<void> _create() async {
    if (_creating) return;
    setState(() => _creating = true);
    try {
      await _createSessionOn(
        context,
        ref,
        deviceId: widget.deviceId,
        mode: widget.mode,
      );
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  void _open(SessionMirrorData s) {
    if (!_isPhone) {
      ref.read(preferredDesktopProvider.notifier).set(widget.deviceId);
    }
    ref.read(homeModeProvider.notifier).set(_modeOf(s));
    /* 记住"从哪台设备的列表点进来的" —— 首页顶栏据此给返回键 (见 provider 说明) */
    ref.read(sessionReturnTargetProvider.notifier).state = widget.mode;
    ref.read(currentSessionProvider.notifier).set(s.id);
    context.go('/');
  }

  /// 副标题: "在哪 · 什么时候". 手机本地会话的工作区名是内部占位「手机」, 那就退回模式名.
  String _subtitleOf(SessionMirrorData s) {
    final when = settingsRelativeTime(
      DateTime.fromMillisecondsSinceEpoch(s.lastMessageAt ?? s.createdAt),
    );
    if (!isPhoneLocalDeviceId(s.desktopDeviceId)) {
      final ws = (s.workspaceName ?? '').trim();
      if (ws.isNotEmpty) return '$ws · $when';
    }
    if (s.parentSessionId != null) return '${tr('子任务')} · $when';
    return '${_modeOf(s).label} · $when';
  }

  @override
  Widget build(BuildContext context) {
    final db = ref.watch(appDatabaseProvider);
    final running = ref.watch(runningSessionsProvider);
    final presence = ref.watch(desktopPresenceProvider);
    final ws = ref.watch(wsClientProvider);
    final scheme = Theme.of(context).colorScheme;

    return StreamBuilder<List<PairedDesktop>>(
      stream: db.pairedDesktopsDao.watchAll(),
      builder: (context, ds) {
        final d = (ds.data ?? const <PairedDesktop>[])
            .where((x) => x.deviceId == widget.deviceId)
            .firstOrNull;
        final title = _isPhone
            ? tr('这台手机')
            : (d == null ? tr('未命名电脑') : _desktopName(d));
        final status = _isPhone
            ? tr('本机直接跑')
            : (d == null
                  ? tr('已断开连接')
                  : _desktopState(d, presence, ws, scheme).text);
        final connected = _isPhone || _isConnected(ws, widget.deviceId);

        return SettingsFrame(
          /* 跟「设备」页同一张陶土页头 —— 设备名和连接状态写在图上, 顶栏只留返回和新建 */
          hero: 'bg-devices',
          title: title,
          subtitle: status,
          actions: [
            IconButton(
              tooltip: tr('新建会话'),
              icon: _creating
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.add_rounded, size: 26),
              color: Theme.of(context).colorScheme.onSurface,
              onPressed: _creating ? null : _create,
            ),
          ],
          body: StreamBuilder<List<SessionMirrorData>>(
            stream: db.sessionMirrorDao.watchByDesktop(widget.deviceId),
            builder: (context, snap) {
              final all = (snap.data ?? const <SessionMirrorData>[]).toList();
              final counts = <_Scope, int>{
                for (final sc in _Scope.values)
                  sc: all.where((s) => sc.matches(_modeOf(s))).length,
              };
              final rows = all.where((s) => _scope.matches(_modeOf(s))).toList();

              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  /* 断了才出现 —— 通的时候页头那句「已连接」就够了, 不占一行 */
                  if (!connected && d != null)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        NeoxSpace.xl,
                        NeoxSpace.md,
                        NeoxSpace.xl,
                        0,
                      ),
                      child: NeoxButton(
                        label: tr('重新连接'),
                        icon: Icons.refresh_rounded,
                        variant: NeoxButtonVariant.secondary,
                        size: NeoxButtonSize.medium,
                        fullWidth: true,
                        loading: _connecting,
                        onPressed: _connecting ? null : _connectManually,
                      ),
                    ),
                  _FilterBar(
                    scope: _scope,
                    counts: counts,
                    onPick: (sc) => setState(() {
                      _scope = sc;
                      _shown = 50;
                    }),
                  ),
                  Expanded(
                    child: rows.isEmpty
                        ? ListView(
                            padding: const EdgeInsets.only(top: NeoxSpace.sm),
                            children: [
                              SettingsEmptyBlock(
                                icon: Icons.forum_outlined,
                                title: tr('这里还没有会话'),
                                subtitle: tr('点右上角 + 新建一个'),
                              ),
                            ],
                          )
                        : ListView(
                            padding: const EdgeInsets.only(bottom: 32),
                            children: [
                              for (final sec in groupSessionsByRecency([
                                for (final s in rows.take(_shown))
                                  (s: s, depth: 0),
                              ])) ...[
                                NeoxSectionLabel(
                                  text: sec.label,
                                  padding: _kSectionPad,
                                ),
                                SettingsGroup(
                                  margin: _kGroupMargin,
                                  dividerIndent: _kSessionInset,
                                  children: [
                                    for (final r in sec.rows)
                                      _SessionTile(
                                        mode: _modeOf(r.s),
                                        running: running.contains(r.s.id),
                                        title: (r.s.title ?? '').trim().isEmpty
                                            ? tr('新会话')
                                            : r.s.title!.trim(),
                                        subtitle: _subtitleOf(r.s),
                                        onTap: () => _open(r.s),
                                      ),
                                  ],
                                ),
                              ],
                              if (rows.length > _shown)
                                Padding(
                                  padding: const EdgeInsets.fromLTRB(
                                    NeoxSpace.xl,
                                    NeoxSpace.lg,
                                    NeoxSpace.xl,
                                    0,
                                  ),
                                  child: NeoxButton(
                                    label: tr('再显示 %s 条').replaceFirst(
                                      '%s',
                                      '${(rows.length - _shown).clamp(0, 50)}',
                                    ),
                                    variant: NeoxButtonVariant.secondary,
                                    fullWidth: true,
                                    onPressed: () =>
                                        setState(() => _shown += 50),
                                  ),
                                ),
                            ],
                          ),
                  ),
                ],
              );
            },
          ),
        );
      },
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  筛选片 —— 全部 / 工作 / 编码 / 对话
// ════════════════════════════════════════════════════════════════
class _FilterBar extends StatelessWidget {
  const _FilterBar({
    required this.scope,
    required this.counts,
    required this.onPick,
  });

  final _Scope scope;
  final Map<_Scope, int> counts;
  final ValueChanged<_Scope> onPick;

  @override
  Widget build(BuildContext context) {
    /* 空的筛选项不画 (手机上没有编码会话时, 摆一个「编码 0」只是占地方) */
    final items = [
      for (final sc in _Scope.values)
        if ((counts[sc] ?? 0) > 0 || sc == scope) sc,
    ];
    return SizedBox(
      height: 54,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(
          NeoxSpace.xl,
          NeoxSpace.md,
          NeoxSpace.xl,
          NeoxSpace.sm,
        ),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(width: NeoxSpace.sm),
        itemBuilder: (context, i) {
          final sc = items[i];
          return Center(
            child: _FilterPill(
              label: sc.label,
              count: counts[sc] ?? 0,
              selected: sc == scope,
              onTap: () => onPick(sc),
            ),
          );
        },
      ),
    );
  }
}

/// 筛选片 —— 比 [NeoxChip] 大一档 (高 34 / 13.5 号字).
///
/// 用 NeoxChip 时这一排是 26 高、11.5 号字, 跟下面的会话标题差了一大截,
/// 摆在页头下面像一行注释 (用户第 4 轮: 「这个页面还是太丑了」)。
/// 筛选是这一页的**主控件**之一, 给到跟按钮同量级才对得上。
class _FilterPill extends StatelessWidget {
  const _FilterPill({
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final fg = selected ? scheme.onPrimary : scheme.onSurfaceVariant;
    return Material(
      color: selected ? scheme.primary : scheme.chipFill,
      borderRadius: NeoxRadius.pillR,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: fg,
                  height: 1.1,
                ),
              ),
              const SizedBox(width: 6),
              Text(
                '$count',
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w500,
                  color: fg.withValues(alpha: 0.72),
                  height: 1.1,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
