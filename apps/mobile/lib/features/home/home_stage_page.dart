/// home_stage_page.dart — Neox 移动端唯一主页 (一切对话发生在这).
///
/// 架构:
///   - currentSessionProvider == null → 显 GreetingHero (空态问候)
///   - currentSessionProvider != null → 显 TimelineMessageList(id)
///   - 底部始终是 StageInput (真实输入框)
///   - messages 上方: ConnectionBanner (网络问题)
///   - messages 下方 (input 上方): AskUserStack + ApprovalStack (审批拦截)
///
/// 入口:
///   - "+" 顶 bar / 抽屉 "+ 新会话" → setCurrent(null) 回 greeting
///   - 抽屉 recent session → setCurrent(id), 加载该 session 消息
///   - 用户在 StageInput 发第一条消息: 没 session 时自动 create + setCurrent
///
/// 没有跳转, 没有 push, 一页流到底 — Claude 风.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/edition/edition.dart';
import '../../core/errors/friendly_error.dart';
import '../../core/execution/run_target.dart';
import '../../core/local_agent/phone_local_agent.dart';
import 'widgets/local_linux_offer.dart';
import '../../core/network/ws_client_provider.dart';
import '../../core/network/cli_endpoint_id.dart';
import '../../core/session_routing/send_failure_note.dart';
import '../../core/session_routing/session_router.dart';
import '../../core/startup/startup_coordinator.dart';
import '../../core/storage/database.dart';
import '../../core/storage/paired_desktop_kind.dart';
import '../../shared/theme/neox_tokens.dart';
import '../../shared/widgets/neox_drawer.dart';
import '../../shared/widgets/neox_page_hero.dart';
import '../../shared/widgets/neox_icons.dart';
import '../timeline/state/timeline_state.dart' show timelineStateProvider;
import 'widgets/inline_approval_strip.dart' show ApprovalDock;
import '../settings/whats_new.dart' show maybeShowWhatsNew;
import '../../core/network/stream_buffer_provider.dart' show sessionPendingApprovalsProvider;
import '../timeline/widgets/ask_user_card.dart' show AskUserStack;
import '../timeline/widgets/common.dart' show ConnectionBanner, SyncStrip;
import '../../core/network/history_load_status.dart';
import '../timeline/widgets/subagent_status_bar.dart' show SubagentStatusBar;
import '../timeline/widgets/message_widgets.dart' show UserMessage;
import '../timeline/widgets/typing_dots.dart' show TypingDots;
import '../timeline/widgets/timeline_message_list.dart';

import 'state/connection_guard.dart';
import 'state/current_project_provider.dart';
import 'state/current_session_provider.dart';
import '../../core/execution/run_target_provider.dart' show RunTargetPref, runTargetPrefProvider;
import 'state/home_mode_provider.dart';
import '../timeline/widgets/tool_group_row.dart' show TimelineMode;
import 'state/session_location_provider.dart';
import 'state/session_return_provider.dart';
import 'state/submitting_provider.dart';
import 'widgets/error_pill_bar.dart';
import 'widgets/home_clay.dart';
import '../../shared/clay/clay.dart';
import 'widgets/session_actions.dart';
import 'widgets/stage_input.dart';
import 'widgets/update_banner.dart';
import 'widgets/where_sheet.dart' show showWhereSheet, watchEffectiveRunTarget, whereChipOf;
import 'package:neox_app/core/i18n/tr.dart';
import '../pilot/pilot_link.dart';

class HomeStagePage extends ConsumerStatefulWidget {
  const HomeStagePage({super.key});

  @override
  ConsumerState<HomeStagePage> createState() => _HomeStagePageState();
}

/* 会话实际运行位置见 state/session_location_provider.dart (顶栏/输入框/横幅共用) */

class _HomeStagePageState extends ConsumerState<HomeStagePage> {
  @override
  void initState() {
    super.initState();
    /* 启动编排 — 旧 sessions_page 退役后这里是唯一主壳, run() 内部有防重入,
     * 首帧后触发: 云端 flag 拉取 / cloud sessions 同步 / auto-pair / 自动连桌面. */
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(ref.read(startupCoordinatorProvider).run());
      /* 抽屉里的图先解好 —— 不然第一次滑出抽屉时现场解码, 正压在动画上 (2026-10-12 「刚进来侧边栏展开会卡」)。
       * 晚 600ms 再做, 不跟首屏抢 */
      Future<void>.delayed(const Duration(milliseconds: 600), () {
        if (mounted) unawaited(precacheDrawerImages(context));
        /* 首页那张陶土横幅也提前解好 —— 它比抽屉里那些小图大得多 */
        if (mounted) unawaited(precacheClayBanners(context));
      });
      /* 恢复上次会话的订阅 (app 冷启动回到旧会话) */
      unawaited(_syncTimelineSubscription(ref.read(currentSessionProvider)));
      /* 刚更新完第一次打开: 这一版有什么 (每版一次, 新装不弹) */
      Future<void>.delayed(const Duration(milliseconds: 1200), () {
        if (mounted) unawaited(maybeShowWhatsNew(context, ref));
      });
      /* 上次关 App 时停在 Pilot 上 → 直接回到 Pilot 会话列表 (返回还是这一页) */
      if (ref.read(editionProvider).pilotAvailable) {
        unawaited(lastOpenPilot().then((p) {
          if (p == null || !mounted) return;
          context.push('/pilot');
        }));
      }
    });
  }

  /// 会话订阅生命周期 — **单页重构丢失的关键副作用** (2026-07-20 联调实锤):
  /// 旧 TimelinePage initState 里做 subscribe + 拉历史, 页面删除后没人做了 →
  /// 桌面 agent 事件全部 SKIP no-sub, 手机 timeline 永远空.
  ///
  /// 现在 currentSession 变化时:
  ///   desktop/cloud 会话 → projector attachOrCatchUp (Execution 快照 + EntryLog gap)
  ///   phone-local / null → clearActiveTimeline (不需要订阅)
  Future<void> _syncTimelineSubscription(String? sessionId) async {
    final ws = ref.read(wsClientProvider.notifier);
    if (sessionId == null) {
      ws.clearActiveTimeline();
      return;
    }
    try {
      final db = ref.read(appDatabaseProvider);
      final mirror = await db.sessionMirrorDao.findById(sessionId);
      /* 冷启动恢复的上次会话已经删掉了 → 回空白首页, 别停在一个不存在的会话上 */
      if (mirror == null && mounted && ref.read(currentSessionProvider) == sessionId) {
        ref.read(currentSessionProvider.notifier).set(null);
        return;
      }
      /* 模式跟着会话走 —— 抽屉那条路自己切过了, 这里兜住点通知、跳转进来的:
       * 对话模式里打开一条电脑会话, 输入框/[+] 菜单却还是对话的样子, 发出去的也不对。 */
      /* 只纠正"跑在哪"对不上的情况 (手机会话 ↔ 对话), 工作/编码之间不互相改:
       * 电脑同步来的会话很多没记模式, 在编码里点开它不该被踢到工作。 */
      if (mirror != null && mirror.kind != 'image' && mounted) {
        final current = ref.read(homeModeProvider);
        final onPhone = isPhoneLocalDeviceId(mirror.desktopDeviceId);
        /* 手机上的会话按它自己记的模式 (2026-10-11 起工作也能在本机跑): 本机工作会话别被踢回对话 */
        final own = homeModeOfSession(agentMode: mirror.agentMode, desktopDeviceId: mirror.desktopDeviceId);
        if (onPhone && own != null && current != own) {
          ref.read(homeModeProvider.notifier).set(own);
        } else if (!onPhone && current == HomeMode.chat) {
          ref
              .read(homeModeProvider.notifier)
              .set(homeModeFromWire(mirror.agentMode) ?? HomeMode.work);
        }
      }
      if (mirror != null && isPhoneLocalDeviceId(mirror.desktopDeviceId)) {
        ws.clearActiveTimeline();
        return;
      }
      /* 记住这条会话的电脑, 下次冷启动恢复它时先连的就是这台 (见 rememberDesktop) */
      final sessionDesktop = await _sessionDesktopId(sessionId);
      /* 终端会话记它那台电脑 (终端关了就没了, 冷启动不该去连一个不在的终端) */
      if (sessionDesktop != null) ws.rememberDesktop(computerOfSession(sessionDesktop));
      if (sessionDesktop != null && isCliEndpointId(sessionDesktop)) {
        /* 终端会话: 直接连那个终端 (同一台电脑, 跟客户端不同的入口), 连上再订阅 */
        await ws.ensureConnectedToSessionOwner(sessionId);
        if (!mounted || ref.read(currentSessionProvider) != sessionId) return;
      } else {
        /* 从终端会话回到客户端会话: 先换回客户端那条 */
        await ws.ensureConnectedToSessionOwner(sessionId);
        if (!mounted || ref.read(currentSessionProvider) != sessionId) return;
        /* 电脑会话: 对话模式下冷启动没连电脑 (点通知直接进来的就是这种), 这里补连。
         * 不 await —— 连接自己去跑, attach 在连上后由重连路径补齐。 */
        unawaited(ref.read(startupCoordinatorProvider).connectDesktopIfNeeded());
      }
      await ws.attachOrCatchUp(sessionId);
    } catch (e) {
      debugPrint('[home] timeline subscription sync failed: $e');
    }
  }

  Timer? _leaveGraceTimer;

  @override
  void dispose() {
    _leaveGraceTimer?.cancel();
    super.dispose();
  }

  /// 当前会话所在电脑 —— 手机本地 / 云端 / 画布 / 查不到都返 null (不受电脑连接影响)
  Future<String?> _sessionDesktopId(String sessionId) async {
    final db = ref.read(appDatabaseProvider);
    final m = await db.sessionMirrorDao.findById(sessionId);
    if (m == null || m.kind == 'image') return null;
    if (isPhoneLocalDeviceId(m.desktopDeviceId)) return null;
    final paired = await db.pairedDesktopsDao.findByDeviceId(m.desktopDeviceId);
    if (paired != null && isCloudAgentPairedDesktop(paired)) return null;
    return m.desktopDeviceId;
  }

  Future<void> _guardConnection(WsClientState? prev, WsClientState next) async {
    final project = ref.read(currentProjectProvider);
    if (project != null &&
        projectBelongsToOtherDesktop(
          projectDesktopId: project.desktopDeviceId,
          ws: next,
        )) {
      ref.read(currentProjectProvider.notifier).clear();
    }

    final sid = ref.read(currentSessionProvider);
    if (sid == null) {
      _leaveGraceTimer?.cancel();
      _leaveGraceTimer = null;
      return;
    }
    final desktopId = await _sessionDesktopId(sid);
    if (!mounted || ref.read(currentSessionProvider) != sid) return;
    switch (decideConnectionGuard(
      prev: prev,
      next: next,
      sessionDesktopId: desktopId,
    )) {
      case ConnectionGuardAction.none:
        break;
      case ConnectionGuardAction.cancelGrace:
        _leaveGraceTimer?.cancel();
        _leaveGraceTimer = null;
      case ConnectionGuardAction.leaveNow:
        _leaveSession(sid, tr('已切换电脑，回到首页'));
      case ConnectionGuardAction.startGrace:
        _leaveGraceTimer ??= Timer(kLeaveSessionGrace, () {
          _leaveGraceTimer = null;
          if (!mounted) return;
          final ws = ref.read(wsClientProvider);
          if (ws.connection == WsConnectionState.connected &&
              ws.activeDesktopDeviceId == desktopId) {
            return;
          }
          _leaveSession(sid, tr('电脑断开了，回到首页'));
        });
    }
  }

  void _leaveSession(String sid, String message) {
    _leaveGraceTimer?.cancel();
    _leaveGraceTimer = null;
    if (ref.read(currentSessionProvider) != sid) return;
    ref.read(currentSessionProvider.notifier).set(null);
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final currentSession = ref.watch(currentSessionProvider);
    /* 按下发送到真气泡出现之间的占位文本 (见 state/submitting_provider.dart) */
    final submittingText = ref.watch(composerSubmittingTextProvider);
    final wsState = ref.watch(wsClientProvider);
    /* 会话切换 → 同步订阅 (进会话 subscribe / 离开 clear). build 里 listen 是
     * Riverpod 推荐姿势 — initState 里 listenManual 需要手动管生命周期. */
    ref.listen<String?>(currentSessionProvider, (prev, next) {
      if (prev != next) unawaited(_syncTimelineSubscription(next));
    });
    /* 从对话切到工作/编码 → 这时才去连电脑 (对话模式冷启动不连, 见 StartupCoordinator.run)。
     * 后台连, 不挡界面: 首屏图注会显示「正在连接电脑…」。 */
    ref.listen<HomeMode>(homeModeProvider, (prev, next) {
      if (prev != next && next.needsDesktop) {
        unawaited(ref.read(startupCoordinatorProvider).connectDesktopIfNeeded());
      }
      /* 切到工作 / 编码: 本地 Linux 没补全就提示一次 (用户: 「切换模式的时候弹个提示, 让用户手动补全, 跟用户说大概 100 兆」) */
      if (prev != next && next != HomeMode.chat) unawaited(offerLocalLinuxOnce(context));
    });
    /* 电脑断开 / 换电脑 → 离开这台电脑上的会话, 清掉别的电脑上的项目 (connection_guard.dart) */
    ref.listen<WsClientState>(wsClientProvider, (prev, next) {
      unawaited(_guardConnection(prev, next));
    });
    /* 只有跑在电脑/云端的会话才关心连接 —— 手机本地会话、图片画布都不显横幅
     * (真机实测 bug: BYOK 本地聊天时顶着"电脑没连上"红条)。还没查到时不显, 免得闪一下。 */
    final sessionIsRemote =
        currentSession != null &&
        (ref
                .watch(sessionLocationProvider(currentSession))
                .valueOrNull
                ?.isRemote ??
            false);
    final showConnectionBanner =
        sessionIsRemote &&
        wsState.connection != WsConnectionState.connected &&
        wsState.connection != WsConnectionState.disconnected;
    /* disconnected 不显示横幅 — 用户可能在 phone-local 模式跑, 没桌面连接也没事 */

    /* 已连接、但还在补这条会话错过的进度 (回前台 / 重连后) —— 屏上有旧消息时给一条细条;
     * 空会话不给, 列表中间已经有加载动画 */
    final history = sessionIsRemote && !showConnectionBanner
        ? ref.watch(historyLoadStatusProvider(currentSession))
        : null;
    final hasEntries = currentSession != null &&
        ref.watch(timelineStateProvider(currentSession).select((s) => s.entries.isNotEmpty));
    final showSyncStrip = hasEntries &&
        (history?.phase == HistoryLoadPhase.loading || history?.phase == HistoryLoadPhase.failed);

    /* 桌面失联出口 — 连接错误 + 非云端任务 + 登录 + 云端开关开 → 给「云端接管」.
     * 不是 stateful 迁移 (桌面死了没法上传快照), 是"去云端新建继续干"的诚实出口. */
    Widget? bannerAction;
    if (wsState.connection == WsConnectionState.error &&
        wsState.transport != WsTransport.cloudAgent) {
      /* 2026-10-11 晚: 出口从「在云端新开」改成「改在手机上做」—— 用户: 手机本地就能干是我们的优势,
       * 不需要云端 Agent (自动运行位置也不再落云端, 见 kAutoRouteToCloud)。编码在手机上做不了, 不给这个出口。 */
      if (ref.watch(homeModeProvider) == HomeMode.work) {
        bannerAction = InkWell(
          onTap: () {
            ref.read(currentSessionProvider.notifier).set(null);
            ref.read(runTargetPrefProvider.notifier).set(RunTargetPref.phone);
          },
          child: Text(
            tr('改在手机上做'),
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: scheme.primary,
              fontWeight: FontWeight.w700,
            ),
          ),
        );
      }
    }

    final composerStrip = ref.read(editionProvider).composerStrip();

    /* 强更闸门包在最外层 — 协议已不兼容时让用户看到原因和出路, 而不是一个
     * "什么都发不出去也不知道为什么"的 app。服务端没给 min_supported /
     * 接口未上线时它是纯透传, 不占任何位置。 */
    /* 会话是画在首页里的 (不是一条路由): 在会话里按系统返回 = 回到这个模式的首页,
     * 不是退出 App (2026-10-14 实测: 返回一下 App 就没了)。在首页上再返回才退出。 */
    return PopScope(
      canPop: currentSession == null,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        /* 从某台电脑的会话列表点进来的: 退回那台电脑 (见 sessionReturnRouteProvider) */
        final route = ref.read(currentSessionReturnRouteProvider);
        if (route != null) {
          _backToComputer(context, ref, route);
          return;
        }
        final back = ref.read(sessionReturnTargetProvider);
        if (back != null) {
          ref.read(homeModeProvider.notifier).set(back);
          ref.read(sessionReturnTargetProvider.notifier).state = null;
        }
        ref.read(currentSessionProvider.notifier).set(null);
      },
      child: ForcedUpdateGate(
      child: Scaffold(
        /* 页面底不写死 —— 交给 theme 的 scaffoldBackgroundColor
         * (= surfaceContainerLowest, 浅色 #F5F5F4)。
         *
         * 2026-09-04: 这一行原来写死 scheme.surface(纯白), 于是页面、引导卡、
         * 输入框**全是纯白**, 实测对比度 1.000 —— 一点层次都没有, 只能靠一根
         * 灰线去框每个东西, 用户判词"像小学生做的"。人家 (Claude) 是页面微灰、
         * 输入框纯白, 描边几乎看不见: 质感来自**面浮在面上**, 不是来自线。 */
        resizeToAvoidBottomInset: true,
        drawer: const NeoxDrawer(),
        body: SafeArea(
          bottom: true,
          child: Column(
            children: [
              const _TopBar(),
              /* 有新版可更新 — 可关闭的细条, 不打断任何事 */
              /* 更新提示不再常驻首屏 (2026-09-17 用户: 「在输入框上方很占空间」)。
               * 入口在 设置 → 关于 → Neox Mobile (有新版时带「新」角标), 点进独立更新页。 */
              /* 登录失效原来在这里单独占一条横幅。现在并进输入框上方那颗药丸
               * (ErrorPillBar) —— 顶部已经有更新/连接两条了, 同一件事在两个
               * 地方说等于噪音, 而用户的视线和下一步动作都在输入框那头。 */
              /* 顶部连接横幅 — 仅在 connecting / error 时显, disconnected 不显 */
              /* 连上后淡出 (只是外观; 显示条件 showConnectionBanner 没动) */
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 250),
                child: showConnectionBanner
                    ? ConnectionBanner(
                        key: const ValueKey('connection-pill'),
                        state: wsState.connection,
                        msg: wsState.errorMessage,
                        transport: wsState.transport,
                        action: bannerAction,
                        /* 断开点一下重连: 走现有的桌面自动连接入口 (云端任务不走这条) */
                        onRetry: wsState.transport == WsTransport.cloudAgent
                            ? null
                            : () => unawaited(ref
                                .read(wsClientProvider.notifier)
                                .connectToBestAvailableDesktop(trigger: DesktopConnectTrigger.user)),
                      )
                    : const SizedBox(key: ValueKey('no-connection-pill'), width: double.infinity),
              ),
              if (showSyncStrip)
                SyncStrip(
                  failed: history?.phase == HistoryLoadPhase.failed,
                  onRetry: () => ref.read(wsClientProvider.notifier).attachOrCatchUp(currentSession),
                ),
              /* 运行位置 / 镜像已并入顶栏 icon, 不再占第二行 */
              Expanded(
                child: currentSession == null
                    ? (submittingText == null
                          /* 刚按下发送、会话还没建好 → 先把气泡亮出来, 别停在问候页 */
                          ? const _GreetingArea()
                          : _SubmittingBubbleView(text: submittingText))
                    : TimelineMessageList(
                        sessionId: currentSession,
                        /* 点开会话时已按 homeModeOfSession 切过模式, 这里跟着它分时间线 */
                        mode: switch (ref.watch(homeModeProvider)) {
                          HomeMode.chat => TimelineMode.chat,
                          HomeMode.work => TimelineMode.work,
                          HomeMode.code => TimelineMode.code,
                        },
                        /* 会话刚建好但真 pending 气泡还没落下来的那一帧, 用占位气泡兜住,
                         * 否则用户看到的是「还没有消息」的空白屏 (2026-09-18 实拍)。 */
                        optimisticUserText: submittingText,
                        optimisticAttachments: ref.watch(composerSubmittingAttachmentsProvider),
                        /* 错误卡「换个模型」—— 2026-08-11 之前这里一直是 null,
                         * 于是模型被服务端停用时, 错误卡连按钮都不长, 用户在
                         * timeline 上没有任何出路。 */
                        onPickModel: () => openModelSheet(context, ref),
                        /* 手机上的对话: 最后一条回复重新生成 (列表只对 phone- 会话显示按钮) */
                        onRegenerate: () async {
                          try {
                            await clearTrailingFailureNotes(
                              ref,
                              currentSession,
                            );
                            await ref
                                .read(phoneLocalAgentProvider)
                                .regenerateLast(currentSession);
                          } catch (e) {
                            final msg = friendlyError(
                              e,
                              fallback: tr('重新生成失败'),
                            );
                            await writeSendFailureNote(
                              ref,
                              sessionId: currentSession,
                              message: msg,
                            );
                            if (!context.mounted) return;
                            ScaffoldMessenger.of(
                              context,
                            ).showSnackBar(SnackBar(content: Text(msg)));
                          }
                        },
                        /* 切回旧版回答 (chat:C1-06) —— 手机本地会话才有 */
                        onSelectVersion: (anchorSeq, index) {
                          ref
                              .read(phoneLocalAgentProvider)
                              .selectAnswerVersion(
                                currentSession,
                                anchorSeq,
                                index,
                              );
                        },
                        onRetry: () async {
                          try {
                            /* 先擦掉那张失败卡 —— 重试成功后它还挂在答案上面,
                             * 用户会以为这次也失败了。失败了会重新写一张新的。 */
                            await clearTrailingFailureNotes(
                              ref,
                              currentSession,
                            );
                            await ref
                                .read(sessionRouterProvider)
                                .sendControl(
                                  sessionId: currentSession,
                                  kind: 'control:retry',
                                );
                          } catch (e) {
                            if (!context.mounted) return;
                            await writeSendFailureNote(
                              ref,
                              sessionId: currentSession,
                              message: friendlyError(e, fallback: tr('重试失败')),
                            );
                            if (!context.mounted) return;
                            ScaffoldMessenger.of(context).showSnackBar(
                              SnackBar(
                                content: Text(
                                  friendlyError(e, fallback: tr('重试失败')),
                                ),
                              ),
                            );
                          }
                        },
                      ),
              ),
              /* ask_user 追问卡 — 仍在列表下方 (问题带选项, 需要空间).
               * 审批 = 输入框上方一块小板 (陶土稿 v5);
               * 计划不再钉在输入框上 —— 工作模式跑着时在时间线的过程行里画 (process_row PlanBlock)。 */
              if (currentSession != null) ...[
                AskUserStack(sessionId: currentSession),
                ApprovalDock(sessionId: currentSession),
                /* 「N 个 agent 运行中」— 仅运行态占位, 跑完即消失; 点开 agent 菜单 */
                SubagentStatusBar(sessionId: currentSession),
              ],
              /* 积分余量提示 — 选订阅模型且额度耗尽/告急时显 (BYOK 不计量不显)。
               * 额度是订阅的事, 条子本身由发行版提供 (商业版: QuotaStrip)。 */
              if (composerStrip != null) composerStrip,
              /* 错误药丸 — 紧贴输入框上方, 一眼看出"能不能用/谁的问题/点什么" */
              ErrorPillBar(onPickModel: () => openModelSheet(context, ref)),
              /* 这里曾经有一条常驻的「当前项目 · 切换」。删了 —— 它显示的是**工作区名**,
               * 而工作区恰好可能叫"生活", 于是 Code 模式下输入框上方赫然写着"生活",
               * 跟模式名撞车, 看着就像 bug。用户原话:
               * "你这个输入框上面的生活和切换肯定要删掉啊, 这他妈干什么呢"。
               * 选项目这件事属于首页内容 (见 Code 首页的最近项目), 不该贴在输入框上
               * 每时每刻占一行。 */
              /* 输入区 —— 对话、以及"已经进了某个会话"时才有.
               *
               * 工作 / 编码 没进会话时这一屏是**设备页** (见 WorkbenchView): 一列设备
               * 底下挂个输入框是错的 —— 用户在这儿打字, 到底跑在这台手机还是哪台电脑上?
               * 建会话的入口改成"点进某台设备 → 右上角 +" (用户 2026-10-12:
               * 「这个界面不需要输入框吧」)。 */
              /* 陶土稿 v5: 三个模式首页都是问候 + 输入框 (原来工作 / 编码首页是设备页、不给输入框) */
              Padding(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 10),
                  child: StageInput(
                    /* 模式和运行位置的面板住在本文件 (它们要读 session context、
                     * 配对设备等一堆本页状态)。本文件已经 import 了 stage_input,
                     * 所以只能由这里往下传回调, 不能反过来 import。 */
                    onPickLocation: () =>
                        _openSessionLocationSheet(context, ref, currentSession),
                  ),
                ),
            ],
          ),
        ),
      ),
      ),
    );
  }
}

/// 「刚按下发送、会话还没建好」那几百毫秒的画面: 用户那句话 + 思考中.
///
/// 建会话要先连电脑 (远程一个来回 0.4~0.8s) 再 session.create, 这期间原来还停在问候页,
/// 看着像没反应 (2026-09-18 用户: 「发送应该就产生气泡」)。真气泡接手后这层就消失,
/// 两者长得一样, 交班看不出来。
class _SubmittingBubbleView extends ConsumerWidget {
  const _SubmittingBubbleView({required this.text});

  final String text;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atts = ref.watch(composerSubmittingAttachmentsProvider);
    return ListView(
      reverse: true,
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        /* 跟回复正文同一条左边距 —— 原来没包, 「思考中」贴着屏幕左边被切掉一截 (2026-10-05 真机) */
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: NeoxIndent.gutter),
          child: TypingDots(),
        ),
        UserMessage(text: text, ts: DateTime.now().millisecondsSinceEpoch, attachments: atts),
      ],
    );
  }
}

// ════════════════════════════════════════════════════════════════
//  顶 bar — ☰ + 品牌 | 运行位置 / + / ⋯ (右侧同尺寸同间距)
// ════════════════════════════════════════════════════════════════

/// 顶栏统一触控格: 36×36, 画 [NeoxIcon] —— 光学大小由 glyph 自己保证.
///
/// 原来这里收 [IconData] 并按 codePoint 查一张 `_opticalGlyph` 表去调**字号**。
/// 那张表调不动真正的问题: Material 每个 glyph 在自己 em 框里的占比各不相同,
/// 加号给到 22 实测墨迹也只有 12.7pt, 而手机给到 20 却是 18.7pt —— 差 47%,
/// 正是用户实拍指出的"手机更高、加号天然显小、视觉不协调"。
/// 现在换成自绘图标集, 光学外框写在 glyph 的画法里, 见 neox_icons.dart。
class _TopBarIconBtn extends StatelessWidget {
  const _TopBarIconBtn({
    required this.glyph,
    required this.onPressed,
    required this.tooltip,
  });

  final NeoxIconGlyph glyph;
  final VoidCallback onPressed;
  final String tooltip;

  /* 去掉圆底后可见尺寸变小, 触控区放到 44 (Material 最小触控建议 48, 顶栏高 48 放得下) */
  static const double slot = 44;

  /// 渲染方框 —— 所有顶栏图标同一个值, 墨迹差异交给 glyph 自己.
  static const double box = 22;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    /* 顶栏只剩三个动作, 用主墨色: 裸图标再用浅灰就发虚 */
    final fg = scheme.onSurface;
    return Tooltip(
      message: tooltip,
      child: SizedBox(
        width: slot,
        height: slot,
        child: Material(
          /* 裸图标, 不垫圆底 (2026-09-17 用户: 「这种圆形的非常的丑, 不应该有背景」)。
           * 之前垫底是为了跟 composer 的 chip 成一家, 但顶栏只有三个孤立图标,
           * 三个灰圆排在页面顶上反而是最抢眼的东西。点击反馈交给水波纹。 */
          color: Colors.transparent,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: Center(
              child: NeoxIcon(glyph, size: box, color: fg),
            ),
          ),
        ),
      ),
    );
  }
}

/// 顶栏 —— ☰ · 会话标题 · 新会话. 对齐 Claude App.
///
/// 2026-09-17 用户: 「不要把 neox 标志放在顶部, 放在抽屉里就可以了, 有一个标志就可以」。
/// 品牌字搬进抽屉顶部, 顶栏中间换成**当前会话的标题** —— 这是用户此刻真正需要的信息。
///
/// ⋯ 菜单删掉了。它里面是两类东西混在一起:
///   - 全局去处 (我的设备 / 云端任务 / 工作区): 设备在设置里、工作区和云端在抽屉里, 全是重复入口;
///   - 当前会话的操作 (镜像同步 / 重新同步): 而同一个会话的重命名/删除却只能去抽屉长按。
/// 现在会话操作统一收进「点标题」的面板, 全局去处只留在抽屉。
class _TopBar extends ConsumerWidget {
  const _TopBar();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sid = ref.watch(currentSessionProvider);
    /* 陶土稿 v5 首页顶栏: ☰ · [ 工作 ▾ ] · ✎ (新会话)。会话里: ☰ · 标题 + 灰字 (Mac · 项目) · ⋯ */
    if (sid == null) {
      return SizedBox(
        height: 56,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            children: [
              _TopBarIconBtn(
                glyph: NeoxIconGlyph.menu,
                tooltip: tr('打开侧栏'),
                onPressed: () => Scaffold.of(context).openDrawer(),
              ),
              /* 模式胶囊 + 跑在哪, 同一行 (4.0.2 用户: 原来地点挂在胶囊下面一行, 两行一起超出 56 高的顶栏,
               * 胶囊被顶上去、跟左右两颗按钮对不齐, 小字吊在下面) */
              const Expanded(
                child: Center(
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ModePill(),
                      _NewSessionPlaceCaption(),
                    ],
                  ),
                ),
              ),
              Tooltip(
                message: tr('新会话'),
                child: ClayRoundButton(
                  flat: true,
                  size: _TopBarIconBtn.slot,
                  icon: Icons.edit_square,
                  onTap: () {
                    ref.read(currentSessionProvider.notifier).set(null);
                    ref.read(stageNewSessionTickProvider.notifier).state++;
                  },
                  child: Icon(Icons.edit_note_rounded, size: 26, color: ClayInk.of(context).ink),
                ),
              ),
            ],
          ),
        ),
      );
    }
    final returnRoute = ref.watch(currentSessionReturnRouteProvider);
    return SizedBox(
      height: 56,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            /* 从某台电脑的会话列表点进来的: 左上是 ← 回那台电脑 (列表页 ☰, 详情页 ←) */
            if (returnRoute != null)
              ClayRoundButton(
                flat: true,
                size: _TopBarIconBtn.slot,
                icon: null,
                tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                onTap: () => _backToComputer(context, ref, returnRoute),
                child: Icon(Icons.arrow_back_rounded, size: 24, color: ClayInk.of(context).ink),
              )
            else
              _TopBarIconBtn(
                glyph: NeoxIconGlyph.menu,
                tooltip: tr('打开侧栏'),
                onPressed: () => Scaffold.of(context).openDrawer(),
              ),
            /* 标题靠左, 下面一行灰字写跑在哪 (Mac · ordersys) —— 原来右上那颗运行位置图标并进这行灰字 */
            Expanded(child: _SessionTitle(sessionId: sid)),
            /* ⋯ = 这条会话的操作 (重命名 / 钉住 / 跑在哪 / 删除); 全局去处都在侧栏 (陶土稿 v5) */
            _TopBarIconBtn(
              glyph: NeoxIconGlyph.more,
              tooltip: tr('更多'),
              onPressed: () => _openSessionMenuFor(context, ref, sid),
            ),
          ],
        ),
      ),
    );
  }
}

/// 首页顶栏模式胶囊下面的小字签: 新会话将跑在哪 (= 输入框里当前选的运行位置).
class _NewSessionPlaceCaption extends ConsumerWidget {
  const _NewSessionPlaceCaption();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    /* 对话只在这台手机上跑, 不写「这台手机」(4.0.2 用户:「对话只有本手机啊, 那还要显示吗」) */
    if (ref.watch(homeModeProvider) == HomeMode.chat) return const SizedBox.shrink();
    /* 跟输入框「在哪干」签同一个判据和取名 (编码没装工具包时「本机」按自动 → 写在线那台电脑的名字) */
    final pref = watchEffectiveRunTarget(ref);
    final chip = whereChipOf(ref);
    final (IconData icon, String label) = switch (pref) {
      RunTargetPref.phone => (Icons.smartphone_rounded, tr('这台手机')),
      RunTargetPref.cloud => (Icons.cloud_outlined, tr('云端')),
      _ => (chip.icon, chip.label),
    };
    /* 胶囊右边同一行, 跟胶囊同高 36 才对得齐; 点它 = 换地方 (同输入框「在哪干」) */
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => showWhereSheet(context, ref),
      child: SizedBox(
        height: 36,
        child: Padding(
          padding: const EdgeInsets.only(left: 10, right: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 15, color: c.grey),
              const SizedBox(width: 4),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 110),
                child: Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13.5, height: 1.2, color: c.grey)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 退出当前会话, 回到某台电脑的会话列表 (首页垫底, 那页再返回 = 首页).
void _backToComputer(BuildContext context, WidgetRef ref, String route) {
  ref.read(sessionReturnRouteProvider.notifier).state = null;
  ref.read(currentSessionProvider.notifier).set(null);
  context.push(route);
}

/// 会话操作面板 (顶栏标题 / ⋯ 共用).
Future<void> _openSessionMenuFor(BuildContext context, WidgetRef ref, String sessionId) async {
  final session = await ref.read(appDatabaseProvider).sessionMirrorDao.findById(sessionId);
  if (session == null || !context.mounted) return;
  final loc = ref.read(sessionLocationProvider(sessionId)).valueOrNull;
  final remote = loc?.isRemote ?? false;
  final ws = ref.read(wsClientProvider.notifier);
  await showSessionActions(
    context,
    ref,
    session,
    extras: [
      if (loc != null && loc.kind != SessionLocationKind.image)
        (
          icon: loc.icon,
          title: tr('跑在哪'),
          subtitle: loc.shortLabel,
          onTap: () => unawaited(_openSessionLocationSheet(context, ref, sessionId)),
        ),
      /* 在电脑上的会话: 一步到那台电脑的全部会话 (翻同一台上的别的活) */
      if (loc?.kind == SessionLocationKind.desktop && !isPhoneLocalDeviceId(session.desktopDeviceId))
        (
          icon: Icons.view_list_outlined,
          title: tr('这台电脑上的全部会话'),
          subtitle: loc!.shortLabel,
          /* 往前走一步: 会话留在下面, 电脑页返回就回到这条会话 (电脑页里点别的会话会整个换掉) */
          onTap: () => context.push('/remote/${Uri.encodeComponent(session.desktopDeviceId)}'),
        ),
      if (remote) ...[
        (
          icon: Icons.sync_outlined,
          title: tr('镜像同步'),
          subtitle: _mirrorPolicyLabel(ws.mirrorPolicyOf(sessionId)),
          onTap: () => unawaited(_openMirrorSheet(context, ref, sessionId)),
        ),
        (
          icon: Icons.cloud_sync_outlined,
          title: tr('重新同步'),
          subtitle: tr('时间轴乱序或缺消息时用'),
          onTap: () => unawaited(ws.resyncSession(sessionId)),
        ),
      ],
    ],
  );
}

/// 顶栏中间的会话标题 —— 点开是这个会话的全部操作.
class _SessionTitle extends ConsumerWidget {
  const _SessionTitle({required this.sessionId});

  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final db = ref.watch(appDatabaseProvider);
    return StreamBuilder<SessionMirrorData?>(
      stream: db.sessionMirrorDao.watchById(sessionId),
      builder: (context, snap) {
        final session = snap.data;
        final raw = session?.title?.trim() ?? '';
        /* 手机本地会话建出来时库里写的是中文占位「新会话」, 显示时按界面语言换 */
        final title = (raw.isEmpty || raw == '新会话') ? tr('新会话') : raw;
        /* 「图片」「手机」这种内部工作区名不往顶栏挂 —— 它们不是用户选的项目 */
        final wsName = session?.workspaceName?.trim();
        final workspace = (wsName == null ||
                wsName.isEmpty ||
                wsName == '图片' ||
                isPhoneLocalDeviceId(session?.desktopDeviceId))
            ? null
            : wsName;
        /* 陶土稿 v5: 标题靠左 16 粗, 下面一行灰字「Mac · ordersys」—— 跑在哪 + 项目, 点开是会话操作 */
        final loc = ref.watch(sessionLocationProvider(sessionId)).valueOrNull;
        /* 电脑名走 shortLabel (friendlyDeviceName, 机器码退回「电脑」), 跟抽屉/输入框同一套取名 */
        /* 对话模式只在这台手机上跑, 写「这台手机」是废话 (4.0.2 用户:「对话只有本手机啊, 那还要显示吗」) */
        /* 按会话自己记的模式判 (跟打开会话时纠正模式同一个 homeModeOfSession), 不看当前首页模式 —— 冷启动恢复的会话那时还没纠正 */
        final ownMode = session == null
            ? null
            : homeModeOfSession(agentMode: session.agentMode, desktopDeviceId: session.desktopDeviceId);
        final chatOnPhone = loc?.kind == SessionLocationKind.phone &&
            (ownMode ?? ref.watch(homeModeProvider)) == HomeMode.chat;
        final place = chatOnPhone ? null : switch (loc?.kind) {
          SessionLocationKind.phone => tr('这台手机'),
          SessionLocationKind.cloud => tr('云端'),
          SessionLocationKind.desktop => loc!.shortLabel,
          _ => null,
        };
        final sub = [?place, ?workspace].join(' · ');
        final c = ClayInk.of(context);
        return Align(
          alignment: Alignment.centerLeft,
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: session == null ? null : () => _openSessionMenuFor(context, ref, sessionId),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 16.5, fontWeight: FontWeight.w700, color: c.ink, height: 1.2),
                  ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      /* 跑在哪一眼看出来: 手机 / 电脑 / 云端 的小图标打头 (不再靠读字) */
                      if (sub.isNotEmpty && place != null) ...[
                        Icon(
                          switch (loc?.kind) {
                            SessionLocationKind.phone => Icons.smartphone_rounded,
                            SessionLocationKind.cloud => Icons.cloud_outlined,
                            _ => Icons.laptop_mac_rounded,
                          },
                          size: 13,
                          color: c.grey,
                        ),
                        const SizedBox(width: 4),
                      ],
                      if (sub.isNotEmpty)
                        Flexible(
                          child: Text(
                            sub,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 12, height: 1.35, color: c.grey),
                          ),
                        ),
                      if (sub.isNotEmpty) const SizedBox(width: 8),
                      _RunIsland(sessionId: sessionId),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 标题下面那颗小岛: 执行中 · 3/6 · 1:12 (钴蓝) / 等你确认 · 4/6 (琥珀) / 完成 · 2:41 (绿).
///
/// 「完成」只在刚跑完的 10 分钟内挂着 —— 翻到几天前的会话, 顶上不该还写着完成。
class _RunIsland extends ConsumerStatefulWidget {
  const _RunIsland({required this.sessionId});

  final String sessionId;

  @override
  ConsumerState<_RunIsland> createState() => _RunIslandState();
}

class _RunIslandState extends ConsumerState<_RunIsland> {
  Timer? _tick;

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  static String _clock(int ms) {
    final s = (ms / 1000).floor().clamp(0, 359999);
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final snap = ref.watch(timelineStateProvider(widget.sessionId));
    final waiting = ref.watch(sessionPendingApprovalsProvider(widget.sessionId)).isNotEmpty;
    final running = snap.agentRunning;
    if (running && _tick == null) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else if (!running && _tick != null) {
      _tick!.cancel();
      _tick = null;
    }
    final entries = snap.entries;
    final userAt = entries.lastIndexWhere((e) => e.kind == 'user_message');
    if (userAt < 0) return const SizedBox.shrink();
    final u = entries[userAt];
    /* 用 timestamp 量: createdAtMs 重开会话后整轮同一刻, 「完成 · 0:00」 */
    final start = u.timestamp > 0 ? u.timestamp : u.createdAtMs;
    final last = entries.last;
    final end = last.timestamp > 0 ? last.timestamp : last.createdAtMs;
    final now = DateTime.now().millisecondsSinceEpoch;
    final plan = snap.plan;
    final progress = plan == null || plan.steps.isEmpty
        ? null
        : '${plan.steps.where((s) => s.status == 'completed').length + (plan.steps.any((s) => s.status == 'in_progress') ? 1 : 0)}/${plan.steps.length}';
    final (String label, ClayTone tone) = switch (true) {
      _ when waiting => ([tr('等你确认'), ?progress].join(' · '), ClayTone.amber),
      _ when running => ([tr('执行中'), ?progress, _clock(now - start)].join(' · '), ClayTone.cobalt),
      _ when userAt < entries.length - 1 && now - end < 10 * 60 * 1000 && end > start =>
        ('${tr('完成')} · ${_clock(end - start)}', ClayTone.green),
      _ => ('', ClayTone.neutral),
    };
    if (label.isEmpty) return const SizedBox.shrink();
    return ClayChip(label: label, tone: tone, dense: true);
  }
}

/* 模式切换面板 (原 _ModeSwitcher) 和顶栏品牌字 (原 _BrandWordmark) 2026-09-17 删除:
 * 模式只在抽屉里切, 品牌字只在抽屉顶部出现一次 (见 neox_drawer.dart)。 */

/// 会话里点输入框的位置 chip —— 说清这条会话跑在哪.
///
/// 运行位置在建会话那一刻就定了, 这里只读不改; 想换位置就开新会话。
/// 原来这个面板还有一个"没会话时"分支, 写着「点输入框 [+] → 运行位置 可修改」
/// —— 没会话时 chip 现在直接打开选择面板, 那段说明已经走不到了, 一并删掉。
Future<void> _openSessionLocationSheet(
  BuildContext context,
  WidgetRef ref,
  String? sessionId,
) async {
  if (sessionId == null) return;
  final loc = ref.read(sessionLocationProvider(sessionId)).valueOrNull;
  if (loc == null) return;
  final theme = Theme.of(context);
  final scheme = theme.colorScheme;
  final title = switch (loc.kind) {
    SessionLocationKind.phone => tr('在手机上运行'),
    SessionLocationKind.cloud => tr('在云端运行'),
    SessionLocationKind.image => tr('图片画布'),
    SessionLocationKind.desktop => tr('在电脑上运行'),
  };
  /* 远程会话把连接状态写出来 —— 顶栏图标上只有一颗小点, 点开要说清是连着还是断了 */
  final status = !loc.isRemote
      ? null
      : switch (ref.read(wsClientProvider).connection) {
          WsConnectionState.connected => tr('已连接'),
          WsConnectionState.connecting => tr('连接中…'),
          _ => tr('没连上'),
        };
  final detail = [
    /* 没有机器名时不写「电脑」—— 标题已经说了在电脑上 */
    if (loc.deviceName?.trim().isNotEmpty ?? false) loc.deviceName!.trim(),
    if (loc.workspaceName?.trim().isNotEmpty ?? false)
      loc.workspaceName!.trim(),
    ?status,
  ].join(' · ');

  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    backgroundColor: scheme.surface,
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: Icon(loc.icon, size: 22),
            title: Text(title),
            subtitle: detail.isEmpty
                ? null
                : Text(detail, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          if (loc.kind == SessionLocationKind.desktop)
            ListTile(
              leading: const Icon(Icons.devices_outlined, size: 22),
              title: Text(tr('我的设备')),
              onTap: () {
                Navigator.pop(sheet);
                context.push('/settings/devices');
              },
            ),
          ListTile(
            leading: const Icon(Icons.add, size: 22),
            title: Text(tr('换个位置，开新会话')),
            onTap: () {
              Navigator.pop(sheet);
              ref.read(currentSessionProvider.notifier).set(null);
            },
          ),
          const SizedBox(height: NeoxSpace.sm),
        ],
      ),
    ),
  );
}

String _mirrorPolicyLabel(String policy) {
  switch (policy) {
    case 'manual':
      return tr('手动推送');
    case 'never':
      return tr('不同步');
    default:
      return tr('实时镜像');
  }
}

/// 镜像策略面板 — ⋯ 菜单 / 位置面板共用; 只影响手机是否收事件.
Future<void> _openMirrorSheet(
  BuildContext context,
  WidgetRef ref,
  String sessionId,
) async {
  final theme = Theme.of(context);
  final scheme = theme.colorScheme;
  final ws = ref.read(wsClientProvider.notifier);
  final current = ws.mirrorPolicyOf(sessionId);

  final picked = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    backgroundColor: scheme.surface,
    isScrollControlled: true,
    builder: (ctx) {
      Widget tile({
        required String policy,
        required String title,
        required String subtitle,
        required IconData icon,
      }) {
        final selected = policy == current;
        return ListTile(
          leading: Icon(icon, size: 22),
          title: Text(title),
          subtitle: Text(subtitle),
          trailing: selected
              ? Icon(Icons.check, color: scheme.primary, size: 20)
              : null,
          onTap: () => Navigator.pop(ctx, policy),
        );
      }

      return SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(ctx).height * 0.85,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
                  child: Text(
                    tr('镜像同步'),
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                  child: Text(
                    tr('只影响手机是否接收本会话事件, 不改变电脑端行为'),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
                tile(
                  policy: 'always',
                  title: tr('实时镜像'),
                  subtitle: tr('桌面事件实时同步到手机 (默认)'),
                  icon: Icons.sync_outlined,
                ),
                tile(
                  policy: 'manual',
                  title: tr('手动推送'),
                  subtitle: tr('仅桌面主动「推到手机」时同步'),
                  icon: Icons.sync_alt_outlined,
                ),
                tile(
                  policy: 'never',
                  title: tr('不同步'),
                  subtitle: tr('手机列表将隐藏本会话'),
                  icon: Icons.sync_disabled_outlined,
                ),
                const SizedBox(height: 8),
              ],
            ),
          ),
        ),
      );
    },
  );

  if (picked == null || picked == current) return;
  try {
    await ws.setSessionMirror(sessionId, picked);
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(tr('已设为 ${_mirrorPolicyLabel(picked)}'))),
      );
    }
    /* never → 会话会从列表消失; 回到空态避免卡在幽灵页 */
    if (picked == 'never' && context.mounted) {
      ref.read(currentSessionProvider.notifier).set(null);
    }
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(tr('设置失败: $e'))));
    }
  }
}

// (旧 _SessionContextStrip 已并入顶栏 _RunLocationHeader)

// (额度提示条 _QuotaStrip 挪到了 commercial/home/quota_strip.dart —— 额度是订阅的事,
//  首页通过 NeoxEdition.composerStrip() 插槽放它。)

// ════════════════════════════════════════════════════════════════
//  空态 — 衬线问候居中偏上, 留下方空间给输入
// ════════════════════════════════════════════════════════════════
class _GreetingArea extends ConsumerWidget {
  const _GreetingArea();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    /* 空态首屏按模式渲染不同组件树 (对齐桌面):
     *   对话 = 问候 + 开场画面
     *   工作 / 编码 = 设备页 (手机本机 + 每台电脑), 见 features/workbench */
    /* 陶土稿 v5 (2026-10-14): 三个模式首页同一屏 —— 问候 + 泥台插画 + 输入框。
     * 设备不再是一页 (原 WorkbenchView), 变成输入框里「在哪干」那颗签。 */
    const dashboard = HomeGreetingStage();

    /* 2026-09-04: 首屏顶部那张 SetupGuideCard 删掉了.
     *
     * 它是 2026-08-08 加的, 为了让全新用户在打字**之前**就看见"连电脑 / 填
     * 自己的 Key / 登录"三条路。问题是它把三条路**平铺**成一堵字墙压在首屏
     * 顶上 —— 标题 + 副标题 + 三行 (图标 + 标题 + 副标题 + 箭头), 一张卡就
     * 吃掉大半屏, 用户判词"太难看了, 你其实就可以删了"。
     *
     * 删掉不丢功能: 同一套判据和同一套文案还有第二个出口 —— [showSetupSheet]
     * 在**发送那一刻**拦下没配好的用户。也就是说该给出路的时候一定给得到,
     * 只是不再在他还没开口时先摆一堵墙。 */
    /* SizedBox.expand 不能省: 原来外面那层 Column 带着
     * `crossAxisAlignment: stretch`, dashboard 靠它才被撑满宽度。直接 return
     * 之后它按内容宽度收缩并被居中, 问候语整块右移了 130px (截图可见)。 */
    return SizedBox.expand(child: dashboard);
  }
}
