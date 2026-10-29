/// onboarding_page.dart — 首启引导 (三页, 陶土稿 v5).
///
///   1 / 3  交付成品   一句话出 PPT / 表格 / 文档 (陶土台子逐件进场)
///   2 / 3  选模式     对话 / 工作 / 编码 → 直接设成默认 HomeMode
///   3 / 3  多设备     手机发起, 电脑完成; 下面两行能直接去「连一台电脑」「试试语音」
///
/// 顶上「n / 3 ······ 跳过」, 底下页点 + 通栏墨色主按钮 (平的, 跟登录页同一颗)。
/// 文案是产品介绍口吻: 一行标题 + 一行说明, 不讲道理 (用户: 「说的跟议论文一样」)。
///
/// 登录 / 配对 / 填 Key 不强塞进引导 —— 第 3 页给两个可选入口, 其余交给首页。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../shared/clay/clay.dart';
import '../../shared/widgets/neox_primary_button.dart';
import '../home/state/home_mode_provider.dart';
import 'onboarding_stage.dart';
import 'onboarding_state.dart';
import 'package:neox_app/core/i18n/tr.dart';

class OnboardingPage extends ConsumerStatefulWidget {
  const OnboardingPage({super.key, required this.onDone, this.initialPage = 0});

  /// 引导结束 (完成或跳过) 后调 —— 由 shell 负责切回主页.
  final VoidCallback onDone;

  /// 只给渲染台用: 直接截某一页
  final int initialPage;

  @override
  ConsumerState<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends ConsumerState<OnboardingPage> {
  static const int _pageCount = 3;

  late final PageController _controller = PageController(initialPage: widget.initialPage);
  late int _page = widget.initialPage;

  /// 第 2 页选中的模式; 默认就是现在的模式 (稿里一进来就勾着一个)
  late HomeMode _kind = ref.read(homeModeProvider);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _next() {
    if (_page >= _pageCount - 1) return _finish();
    _controller.animateToPage(_page + 1, duration: const Duration(milliseconds: 420), curve: Curves.easeInOutCubic);
  }

  /// [then] 结束后顺手去的地方 (第 3 页那两行)
  void _finish({String? then}) {
    final router = GoRouter.of(context);
    /* 选的模式落成默认 —— 第 2 页给用户的回报, 不能只是问问 */
    ref.read(homeModeProvider.notifier).set(_kind);
    ref.read(onboardingSeenProvider.notifier).markSeen();
    widget.onDone();
    if (then != null) router.push(then);
  }

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    final last = _page == _pageCount - 1;
    return Scaffold(
      backgroundColor: c.canvas,
      body: SafeArea(
        child: Column(
          children: [
            /* ── 顶: 1 / 3 ······ 跳过 ── */
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 6, 10, 0),
              child: SizedBox(
                height: 48,
                child: Row(
                  children: [
                    Text('${_page + 1} / $_pageCount', style: TextStyle(fontSize: 15, color: c.grey, fontFeatures: const [FontFeature.tabularFigures()])),
                    const Spacer(),
                    if (!last) ClayButton(label: tr('跳过'), kind: ClayButtonKind.text, onTap: _finish),
                  ],
                ),
              ),
            ),
            Expanded(
              child: PageView(
                controller: _controller,
                onPageChanged: (i) => setState(() => _page = i),
                children: [
                  _IntroPane(active: _page == 0),
                  _KindPane(selected: _kind, onSelect: (k) => setState(() => _kind = k)),
                  _RelayPane(
                    onPair: () => _finish(then: '/pairing'),
                    onVoice: () => _finish(then: '/voice-chat'),
                  ),
                ],
              ),
            ),
            /* ── 底: 页点 + 主按钮 ── */
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
              child: Column(
                children: [
                  _Dots(count: _pageCount, page: _page),
                  const SizedBox(height: 20),
                  NeoxPrimaryButton(label: last ? tr('开始使用') : tr('继续'), onPressed: _next),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/* ══════════ 文案 ══════════ */

class _Copy extends StatelessWidget {
  const _Copy({required this.title, required this.body});
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(title, style: TextStyle(fontSize: 27, height: 1.25, fontWeight: FontWeight.w700, letterSpacing: -0.4, color: c.ink)),
        const SizedBox(height: 8),
        Text(body, style: TextStyle(fontSize: 15, height: 1.5, color: c.grey)),
      ],
    );
  }
}

/* ══════════ 1 / 3: 交付成品 ══════════ */

class _IntroPane extends StatelessWidget {
  const _IntroPane({required this.active});
  final bool active;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, box) {
          final art = (box.maxHeight * 0.55).clamp(160.0, 340.0);
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Spacer(flex: 2),
                /* 陶土台子上的成品一件件进场 (见 OnboardingStage) */
                SizedBox(height: art, child: OnboardingStage(kind: OnboardingStageKind.deliver, active: active)),
                const Spacer(flex: 2),
                _Copy(title: tr('一句话，生成完整文件'), body: tr('幻灯片、表格和文档，直接可用。')),
                const Spacer(),
              ],
            ),
          );
        },
      );
}

/* ══════════ 2 / 3: 选常用模式 ══════════ */

class _KindPane extends StatelessWidget {
  const _KindPane({required this.selected, required this.onSelect});
  final HomeMode selected;
  final ValueChanged<HomeMode> onSelect;

  /* 名字跟顶栏模式菜单一字不差 —— 引导里选了什么, 进去就能找到叫这个的地方 */
  static List<(HomeMode, String, String, String)> get _options => [
        (HomeMode.chat, 'onboard-chat', tr('对话'), tr('问答、写作、查资料')),
        (HomeMode.work, 'onboard-work', tr('工作'), tr('文档、表格、调研、纪要')),
        (HomeMode.code, 'onboard-code', tr('编码'), tr('开发、改 bug、重构')),
      ];

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 40, 24, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _Copy(title: tr('选择常用模式'), body: tr('首页可随时切换。')),
            const SizedBox(height: 32),
            for (final (mode, art, title, sub) in _options) ...[
              _KindCard(art: art, title: title, subtitle: sub, selected: selected == mode, onTap: () => onSelect(mode)),
              const SizedBox(height: 12),
            ],
          ],
        ),
      );
}

class _KindCard extends StatelessWidget {
  const _KindCard({required this.art, required this.title, required this.subtitle, required this.selected, required this.onTap});

  final String art;
  final String title;
  final String subtitle;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    /* 平的: 卡都是泥板色; 选中那张一圈墨线 + 右边墨色勾 */
    return AnimatedContainer(
      duration: const Duration(milliseconds: 160),
      foregroundDecoration: BoxDecoration(
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: selected ? c.ink : Colors.transparent, width: 1.4),
      ),
      child: ClaySlab(
        radius: 22,
        onTap: onTap,
        padding: const EdgeInsets.fromLTRB(14, 14, 18, 14),
        child: Row(
          children: [
            AnimatedScale(
              duration: const Duration(milliseconds: 280),
              curve: Curves.easeOutBack,
              scale: selected ? 1.06 : 1,
              child: ClayArt(art, width: 64, height: 64),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: c.ink)),
                  const SizedBox(height: 4),
                  Text(subtitle, style: TextStyle(fontSize: 14, color: c.grey)),
                ],
              ),
            ),
            AnimatedOpacity(
              duration: const Duration(milliseconds: 160),
              opacity: selected ? 1 : 0,
              child: Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(shape: BoxShape.circle, color: c.primary),
                child: Icon(Icons.check_rounded, size: 17, color: c.onPrimary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/* ══════════ 3 / 3: 手机发起, 电脑完成 ══════════ */

class _RelayPane extends StatelessWidget {
  const _RelayPane({required this.onPair, required this.onVoice});
  final VoidCallback onPair;
  final VoidCallback onVoice;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            decoration: BoxDecoration(color: c.slab, borderRadius: BorderRadius.circular(24)),
            padding: const EdgeInsets.symmetric(vertical: 18),
            child: const ClayArt('onboard-relay', height: 210),
          ),
          const SizedBox(height: 28),
          _Copy(title: tr('手机发起，电脑完成'), body: tr('连上电脑，调用完整的本地工具。')),
          const SizedBox(height: 22),
          /* 两条可选的「现在就试」—— 不做也能直接开始使用 */
          ClayGroup(
            margin: EdgeInsets.zero,
            children: [
              ClayRow(icon: Icons.laptop_rounded, title: tr('连一台电脑'), subtitle: tr('扫电脑上的二维码'), onTap: onPair),
              ClayRow(icon: Icons.mic_none_rounded, title: tr('试试语音'), subtitle: tr('开口说，直接语音对话'), onTap: onVoice),
            ],
          ),
        ],
      ),
    );
  }
}

/* ══════════ 页点 ══════════ */

class _Dots extends StatelessWidget {
  const _Dots({required this.count, required this.page});
  final int count;
  final int page;

  @override
  Widget build(BuildContext context) {
    final c = ClayInk.of(context);
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        for (var i = 0; i < count; i++)
          AnimatedContainer(
            duration: const Duration(milliseconds: 260),
            margin: const EdgeInsets.symmetric(horizontal: 5),
            width: 7,
            height: 7,
            decoration: BoxDecoration(shape: BoxShape.circle, color: i == page ? c.ink : c.line),
          ),
      ],
    );
  }
}
