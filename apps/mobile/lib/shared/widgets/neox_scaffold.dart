/// neox_scaffold.dart — Claude 风页面壳.
///
/// 视觉特征:
///   - 大标题 (衬线宋体, 32sp), 不浮在 AppBar 而是滚到顶部内容里
///   - AppBar 透明无边框, 只放 leading (返回) + 右上 actions
///   - 整页背景使用 scaffoldBackgroundColor (暖米白)
///   - 推荐 body 用 ListView / CustomScrollView, 第一个 child 就是大标题区
///
/// 用法 A — 大标题 + body 直接给 sliver list:
///   NeoxScaffold(
///     title: '设置',
///     slivers: [SliverList(...)],
///   )
///
/// 用法 B — 紧凑模式 (二级页, 标题压在 AppBar 里):
///   NeoxScaffold.compact(
///     title: '账户',
///     body: ListView(...),
///   )
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/neox_tokens.dart';
import 'neox_page_hero.dart';

class NeoxScaffold extends StatelessWidget {
  /// 大标题模式 — 一级页面 (Settings / Sessions / Workspace).
  const NeoxScaffold({
    super.key,
    required this.title,
    this.subtitle,
    this.actions,
    this.slivers = const [],
    this.bottomNavigationBar,
    this.floatingActionButton,
    this.onRefresh,
    this.leadingAction,
    this.hero,
  })  : _compact = false,
        body = null;

  /// 紧凑模式 — 二级页面 (Account / Devices), 标题压在 AppBar.
  const NeoxScaffold.compact({
    super.key,
    required this.title,
    required this.body,
    this.actions,
    this.bottomNavigationBar,
    this.floatingActionButton,
    this.leadingAction,
  })  : _compact = true,
        subtitle = null,
        slivers = const [],
        onRefresh = null,
        hero = null;

  final String title;
  final String? subtitle;

  /// 陶土页头背景图 (assets/clay 下的名字, 见 [NeoxPageHero]): 给了就把标题 / 副标题写在图上, 顶栏透明
  final String? hero;
  final List<Widget>? actions;
  final List<Widget> slivers;
  final Widget? body;
  final Widget? bottomNavigationBar;
  final Widget? floatingActionButton;
  final Future<void> Function()? onRefresh;
  final Widget? leadingAction;
  final bool _compact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final canPop = ModalRoute.of(context)?.canPop ?? false;

    final systemOverlay = scheme.brightness == Brightness.light
        ? SystemUiOverlayStyle.dark.copyWith(
            statusBarColor: Colors.transparent,
            systemNavigationBarColor: scheme.surface,
            systemNavigationBarIconBrightness: Brightness.dark,
          )
        : SystemUiOverlayStyle.light.copyWith(
            statusBarColor: Colors.transparent,
            systemNavigationBarColor: scheme.surface,
            systemNavigationBarIconBrightness: Brightness.light,
          );

    final appBar = AppBar(
      systemOverlayStyle: systemOverlay,
      /* 页面底 / 顶栏底一律 surfaceContainerLowest (#F5F5F4), 不用 surface(纯白).
       * surface 是**卡片**的颜色 —— 页面底跟卡片同色 = 零层次, 见 2026-09-04
       * home_stage_page 里那段说明。顶栏跟页面同色, 才不会浮出一条白带。 */
      backgroundColor: scheme.surfaceContainerLowest,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleSpacing: canPop ? 0 : NeoxSpace.xl,
      leading: leadingAction ??
          (canPop
              ? IconButton(
                  icon: const Icon(Icons.arrow_back_ios_new, size: 20),
                  onPressed: () => Navigator.maybePop(context),
                  splashRadius: 22,
                )
              : null),
      /* 标题一律放 AppBar, 一律 titleMedium —— 不再分"大标题模式".
       *
       * 2026-09-04 全 app 深链截图对比后改的。原来非 compact 模式把标题放在 body
       * 顶部、用 headlineLarge(35pt)。结果同一层级的页面标题差一倍:
       *   「我」「我的模型 Key」= 35pt 衬线   vs
       *   「云端任务」「图片」「工作区」「连接体验」「我的电脑」= 17pt
       * 后面那几个页面各自造了 AppBar, 根本没走这个组件。
       *
       * 为什么收敛到小的而不是把其余页面改成大标题: **这个 app 没有顶层页** ——
       * 每一页都是从首页 push 进来的, 全都带返回箭头。大标题在 iOS 里表示
       * "这是一个根", 我们没有根, 那就不该有大标题。 */
      title: Text(
        title,
        style: theme.textTheme.titleMedium?.copyWith(
          fontWeight: FontWeight.w600,
        ),
      ),
      actions: actions == null
          ? null
          : [
              ...actions!,
              const SizedBox(width: NeoxSpace.sm),
            ],
    );

    if (_compact) {
      return Scaffold(
        /* 页面底 / 顶栏底一律 surfaceContainerLowest (#F5F5F4), 不用 surface(纯白).
       * surface 是**卡片**的颜色 —— 页面底跟卡片同色 = 零层次, 见 2026-09-04
       * home_stage_page 里那段说明。顶栏跟页面同色, 才不会浮出一条白带。 */
      backgroundColor: scheme.surfaceContainerLowest,
        appBar: appBar,
        body: body,
        bottomNavigationBar: bottomNavigationBar,
        floatingActionButton: floatingActionButton,
      );
    }

    /* 标题已经进了 AppBar, body 顶部只留副标题 (它是页面的引言, 不是标题).
     * 没有副标题时整块不占位 —— 空的 padding 会让每页顶上多出一段无来由的留白。 */
    final leadSliver = hero != null
        ? SliverToBoxAdapter(child: NeoxPageHero(asset: hero!, title: title, subtitle: subtitle))
        : subtitle == null
        ? const SliverToBoxAdapter(child: SizedBox(height: NeoxSpace.sm))
        : SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoxSpace.xl,
                NeoxSpace.xs,
                NeoxSpace.xl,
                NeoxSpace.md,
              ),
              child: Text(
                subtitle!,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ),
          );

    final scroll = CustomScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        leadSliver,
        ...slivers,
        const SliverPadding(padding: EdgeInsets.only(bottom: NeoxSpace.xxxl)),
      ],
    );

    return Scaffold(
      /* 页面底 / 顶栏底一律 surfaceContainerLowest (#F5F5F4), 不用 surface(纯白).
       * surface 是**卡片**的颜色 —— 页面底跟卡片同色 = 零层次, 见 2026-09-04
       * home_stage_page 里那段说明。顶栏跟页面同色, 才不会浮出一条白带。 */
      backgroundColor: scheme.surfaceContainerLowest,
      appBar: hero != null ? NeoxHeroAppBar(actions: actions) : appBar,
      extendBodyBehindAppBar: hero != null,
      body: onRefresh == null
          ? scroll
          : RefreshIndicator(
              onRefresh: onRefresh!,
              color: scheme.primary,
              backgroundColor: scheme.surfaceContainerHigh,
              child: scroll,
            ),
      bottomNavigationBar: bottomNavigationBar,
      floatingActionButton: floatingActionButton,
    );
  }
}
