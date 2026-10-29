/// home_clay.dart — 首页 (陶土稿 v5「打开就能说事」).
///
///   ☰          [ 工作 ▾ ]          ✎
///                         ┌──────────┐
///                         │ 泥台插画 │   (按模式换: 对话泡 / 电脑手机 / 终端块)
///   下午好，lmk           └──────────┘
///   今天想交付什么？
///
///   ● 季度销售复盘 · 执行中 3/7 ›          ← 有任务在跑才出
///   ╭ 输入框泥板 ─────────────────────╮
///
/// 不放建议卡、不放列表; 工作 / 编码的首页也是这一屏 (设备从页面变成输入框里「在哪干」那颗签)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/edition/edition.dart' show accountStatusProvider;
import '../../../core/i18n/tr.dart';
import '../../../core/storage/database.dart';
import '../../../shared/clay/clay.dart';
import '../../../shared/theme/display_prefs.dart';
import '../../timeline/state/running_sessions_provider.dart';
import '../../timeline/state/timeline_state.dart';
import '../state/current_session_provider.dart';
import '../state/home_mode_provider.dart';
import '../state/home_mode_switch.dart';
import 'home_greeting.dart' show homeGreetingText;

/// 每个模式首页右上那块泥台 (assets/clay/v5/home-*.webp)
String homeArtOf(HomeMode m) => switch (m) {
      HomeMode.chat => 'home-chat',
      HomeMode.work => 'home-work',
      HomeMode.code => 'home-code',
    };

/// 每个模式问候下面那句灰字
String homeTaglineOf(HomeMode m) => switch (m) {
      HomeMode.chat => tr('想聊点什么？'),
      HomeMode.work => tr('今天想交付什么？'),
      HomeMode.code => tr('今天要改哪里？'),
    };

/// 首页 (还没进会话) 的整块舞台: 插画 + 问候 + 进行中胶囊.
class HomeGreetingStage extends ConsumerStatefulWidget {
  const HomeGreetingStage({super.key});

  @override
  ConsumerState<HomeGreetingStage> createState() => _HomeGreetingStageState();
}

class _HomeGreetingStageState extends ConsumerState<HomeGreetingStage> {
  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final mode = ref.watch(homeModeProvider);
    final name = ref.watch(accountStatusProvider).promptName?.trim();
    /* 问候带问号时名字插在问号前面 (「还没睡？」→「还没睡，lmk？」; 原来拼成 "Still up?, lmk") */
    final hello = homeGreetingText();
    final q = RegExp(r'[?？]$').firstMatch(hello);
    final head = q == null ? hello : hello.substring(0, q.start);
    final greeting = name == null || name.isEmpty
        ? hello
        : '$head${isEnglishUi ? ', ' : '，'}$name${q?.group(0) ?? ''}';
    final showArt = ref.watch(displayPrefsProvider).homeArt;
    return LayoutBuilder(
      builder: (context, box) {
        /* 开始打字 (键盘弹起) 插画淡出 —— 稿上「开始输入后淡出」。
         * 读整个窗口的 insets: Scaffold 已经把 body 里 MediaQuery 的 viewInsets 吃掉了 (一直是 0,
         * 插画从没淡出过, 问候叠在插画上)。View.of 本身不触发重画, 放在 LayoutBuilder 里 ——
         * 键盘一弹 body 变矮, 这里会重跑。 */
        final keyboard = View.of(context).viewInsets.bottom > 0;
        final w = box.maxWidth;
        final artW = w * 0.72;
        return Stack(
          children: [
            Positioned(
              top: box.maxHeight * 0.02,
              right: -w * 0.06,
              child: AnimatedOpacity(
                duration: const Duration(milliseconds: 260),
                /* 设置 → 外观 → 首页插画 关掉时不画 */
                opacity: keyboard || !showArt ? 0 : 1,
                child: AnimatedSwitcher(
                  duration: const Duration(milliseconds: 320),
                  child: ClayArt(homeArtOf(mode), key: ValueKey(mode), width: artW),
                ),
              ),
            ),
            Positioned(
              left: 24,
              right: 24,
              top: keyboard ? 24 : box.maxHeight * 0.36,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    greeting,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 28, fontWeight: FontWeight.w700, color: c.ink, height: 1.25, letterSpacing: -0.3),
                  ),
                  const SizedBox(height: 6),
                  Text(homeTaglineOf(mode), style: TextStyle(fontSize: 16, color: c.grey, height: 1.4)),
                ],
              ),
            ),
            const Positioned(left: 16, right: 16, bottom: 10, child: RunningTaskChip()),
          ],
        );
      },
    );
  }
}

/// 输入框正上方那颗「季度销售复盘 · 执行中 3/7 ›」—— 有任务在跑才出, 点了进那个对话.
class RunningTaskChip extends ConsumerWidget {
  const RunningTaskChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final running = ref.watch(runningSessionsProvider);
    if (running.isEmpty) return const SizedBox.shrink();
    final id = running.first;
    final db = ref.watch(appDatabaseProvider);
    return Align(
      alignment: Alignment.centerLeft,
      child: StreamBuilder<SessionMirrorData?>(
        stream: db.sessionMirrorDao.watchById(id),
        builder: (context, snap) {
          final s = snap.data;
          if (s == null) return const SizedBox.shrink();
          final title = (s.title?.trim().isNotEmpty ?? false) ? s.title!.trim() : tr('新会话');
          final plan = ref.watch(timelineStateProvider(id).select((t) => t.plan));
          final done = plan?.steps.where((p) => p.status == 'completed').length;
          final total = plan?.steps.length;
          final progress = (total != null && total > 0) ? ' $done/$total' : '';
          final more = running.length > 1 ? ' · ${tr('还有 ${running.length - 1} 个')}' : '';
          return _RunningPill(
            label: '$title · ${tr('执行中')}$progress$more',
            onTap: () => ref.read(currentSessionProvider.notifier).set(id),
          );
        },
      ),
    );
  }
}

class _RunningPill extends StatelessWidget {
  const _RunningPill({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return ClaySlab(
      radius: 18,
      lift: 0.7,
      onTap: onTap,
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Breathing(child: ClayDot(color: c.cobalt, size: 8)),
          const SizedBox(width: 8),
          ConstrainedBox(
            constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width - 110),
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: c.ink, fontWeight: FontWeight.w500)),
          ),
          Icon(Icons.chevron_right_rounded, size: 18, color: c.grey),
        ],
      ),
    );
  }
}

/// 呼吸 (运行中的那颗钴蓝点)
class _Breathing extends StatefulWidget {
  const _Breathing({required this.child});
  final Widget child;

  @override
  State<_Breathing> createState() => _BreathingState();
}

class _BreathingState extends State<_Breathing> with SingleTickerProviderStateMixin {
  late final AnimationController _a = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _a.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FadeTransition(
        opacity: Tween<double>(begin: 0.35, end: 1).animate(CurvedAnimation(parent: _a, curve: Curves.easeInOut)),
        child: widget.child,
      );
}

/// 顶栏中间那颗「工作 ▾」—— 点开换模式 (对话 / 工作 / 编码).
class ModePill extends ConsumerWidget {
  const ModePill({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = ClayInk.of(context);
    final mode = ref.watch(homeModeProvider);
    return Builder(
      builder: (anchor) => GestureDetector(
        onTap: () => _openModeMenu(anchor, ref),
        child: Container(
          height: 36,
          padding: const EdgeInsets.fromLTRB(16, 0, 10, 0),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(18),
            color: c.fill,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(mode.label, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.ink)),
              const SizedBox(width: 2),
              Icon(Icons.keyboard_arrow_down_rounded, size: 19, color: c.grey),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openModeMenu(BuildContext anchor, WidgetRef ref) async {
    final current = ref.read(homeModeProvider);
    final picked = await showClaySheet<HomeMode>(
      anchor,
      builder: (ctx) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClaySheetHeader(title: tr('换个模式')),
          for (final (m, icon, line) in [
            (HomeMode.chat, Icons.chat_bubble_outline_rounded, tr('问答、写作、查资料')),
            (HomeMode.work, Icons.description_outlined, tr('文档、表格、调研、纪要')),
            (HomeMode.code, Icons.code_rounded, tr('开发、改 bug、重构')),
          ])
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: ClayRow(
                icon: icon,
                title: m.label,
                subtitle: line,
                selected: m == current,
                chevron: false,
                onTap: () => Navigator.pop(ctx, m),
              ),
            ),
          const SizedBox(height: 12),
        ],
      ),
    );
    if (picked == null || picked == current) return;
    /* chat:C1-03 — 当前打升的是别的模式的会话时, 切标签不把它带过来 (新开一条), 并说一声那条会话还在。 */
    final leftBehind = await switchHomeMode(ref, picked);
    if (!anchor.mounted || leftBehind == null) return;
    ScaffoldMessenger.of(anchor).showSnackBar(
      SnackBar(content: Text(tr('已新开一条对话 —— 刚才那条是「${leftBehind.label}」会话'))),
    );
  }
}
