/// neox_empty_art.dart — 三个模式各自的开场画面 (插画 + 一句话).
///
/// **为什么是三张图三句话, 不是一张通用的**
///
/// 2026-09-04 用户拍板: 「对话模式其实登录就可以用, 没必要连电脑; Work 有时候也
/// 没必要连电脑; 只有 Code 是要协同电脑干活。所以他们点击后有自己的开场界面
/// 是比较合适的」。
///
/// 这是产品事实, 不是装饰偏好 —— 三个模式的**前置条件根本不同**:
///   对话 — 登录就能用, 手机自己就跑得起来
///   工作 — 大多数改稿/文档/调研也不必连电脑
///   编码 — 读写文件、跑终端都在电脑那头, 没有电脑基本做不了事
/// 用同一张图配同一句话, 等于对前两种人说了一句不适用的话。
///
/// **为什么插画下面要有一行字**
/// 用户实拍圈出中间那张孤零零的画: 「漫画下面可以加一行文字, 这样协调一点」。
/// 一张画悬在空白正中是没有落点的; 图 + 一句话才成为一个**块**。而且这句话不是
/// 配文, 它就是这个模式的前置条件 —— 顺手把上面那件事也说了。
///
/// **明暗两套资产, 但暗色永远从浅色派生**
/// 出图那边支持透明背景, 但取回来的 PNG 被网关重编码成 RGB, alpha 整个丢掉,
/// 透明区被压成纯黑; 而线稿本身就是近黑, 事后抠黑底会连抗锯齿边缘一起吃掉。
/// 所以底色在出图时就指定成页面底色, 取回来归一到精确值 (#F5F5F4)。
/// 暗色那张**不重新出图**: 两次独立生成构图必然不一样, 切个主题画都换了。
/// 按墨迹覆盖率把浅色那张重算成深底浅墨, 几何完全一致。
/// ⚠️ 换插画时: 只出浅色, 暗色跑 tool 派生。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/ws_client_provider.dart';
import '../../features/home/state/home_mode_provider.dart';
import '../theme/neox_tokens.dart';
import 'neox_icons.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 首页 dashboard 的外壳: 内容在上, 开场画面把**剩下的空**占满.
///
/// 不判"内容是不是空的"再决定显不显示 —— 那要去问各个 section 的状态, 加一条
/// 会漂的判据。靠**构造**解决:
///   LayoutBuilder 拿到可视高度 → ConstrainedBox 把 Column 至少撑到那么高 →
///   IntrinsicHeight 让 [Expanded] 在滚动视图里也算得出来 (滚动视图给的是无界
///   高度, 少了 IntrinsicHeight 时 Expanded 直接 assert)。
/// 于是内容短 → 开场画面居中在剩余空间里; 内容长 → 剩余为 0, 它自己缩没。
class NeoxEmptyArtScaffold extends StatelessWidget {
  const NeoxEmptyArtScaffold({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    const bottom = 32.0;
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.only(bottom: bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: constraints.maxHeight - bottom,
          ),
          child: IntrinsicHeight(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ...children,
                const Expanded(child: NeoxEmptyArt()),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class NeoxEmptyArt extends ConsumerWidget {
  const NeoxEmptyArt({super.key});

  /// 插画最大宽度 —— **内容栏的一半**.
  ///
  /// 一开始给的 252 (内容栏 360 的 70%)。用户实拍判词"插画明显大于上下, 比例感
  /// 失调"。量出来他是对的:
  ///   输入框 pill 359 × 51pt · 「晚上好」75 × 24pt · 插画 252 宽
  /// 空态里最大的东西应该是**输入框** —— 那才是要人动手的地方。
  /// 为什么是缩插画而不是放大上下: 放大问候语会跟输入框抢, 输入框刚按对比度调过
  /// 不能再动。让步的只能是气氛件。
  static const double maxW = 196;

  /// 同时限高 —— 三张图的长宽比差很多 (对话那张竖, 编码那张扁).
  ///
  /// 换成等距插画之后从 180×132 放到 196×152: 线稿只有轮廓, 小一点也认得出;
  /// 等距是有体积和面的, 太小就糊成一坨灰。
  /// 只限宽的话, 竖的那张会比扁的那张高出一倍, 三个模式的开场轻重不一。
  /// 两边都限 + BoxFit.contain, 它们的**光学大小**才可比。
  static const double maxH = 152;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final dark = theme.brightness == Brightness.dark;
    final mode = ref.watch(homeModeProvider);
    final name = switch (mode) {
      HomeMode.chat => 'chat',
      HomeMode.work => 'work',
      HomeMode.code => 'code',
    };
    /* 这句话说的是**这个模式的前置条件**, 不是给图配的文案.
     * 写成"能得到什么"而不是"缺什么" —— 「登录就能问」不是「未连接电脑」。
     *
     * 编码这一条会跟着连接状态变, 另外两条不会 —— 因为只有编码真的被电脑卡住。
     * 中间有一版把连接状态做成了编码首页顶部单独一行, 结果同一屏上有两处在讲
     * 电脑 (那一行 + 这句图注), 又回到了"冗余重复"。合成一处: 就放在这里,
     * 用户的眼睛本来就在这; 没连上时它还是一条能点的出路。 */
    /* 2026-09-24 起工作也只在电脑上跑, 两个模式的图注都跟连接状态走;
     * 对话在手机上跑, 不看连接 (也不 watch —— 对话首页不该因为电脑那头的状态重绘)。 */
    /* 钉在本机跑 (顶栏选了「本机」): 不看电脑连没连, 图注也不再说「需要连电脑」(2026-10-12) */
    /* 工作固定在手机上跑 (2026-10-12 晚), 图注写手机能干的 */
    final onPhone = mode == HomeMode.work;
    final conn = mode.needsDesktop && !onPhone
        ? ref.watch(wsClientProvider).connection
        : null;
    final needsDesktop =
        conn != null &&
        conn != WsConnectionState.connected &&
        conn != WsConnectionState.connecting;
    /* 文案是**陈述句**, 不带模糊限定.
     * 上一版写的是「改稿 · 文档 · 调研，大多不用连电脑」——「大多」是废话:
     * 用户读完还是不知道自己这次要不要连。是什么就写什么, 不确定的部分不写。 */
    final caption = onPhone
        ? (mode == HomeMode.code ? tr('在手机上写代码、跑程序') : tr('在手机上改文档、做表格和 PPT'))
        : switch (mode) {
      HomeMode.chat => tr('在手机上直接聊，不用连电脑'),
      HomeMode.work => switch (conn) {
        WsConnectionState.connected => tr('改稿、写文档、做调研'),
        WsConnectionState.connecting => tr('正在连接电脑…'),
        _ => tr('工作需要连电脑'),
      },
      HomeMode.code => switch (conn) {
        WsConnectionState.connected => tr('读写文件、跑终端、改代码'),
        WsConnectionState.connecting => tr('正在连接电脑…'),
        _ => tr('编码需要连电脑'),
      },
    };

    /* 略微偏上 (-0.3) 而不是正中.
     * 正中时它孤零零悬在问候语和输入框之间的空当里, 是"漂着"不是"摆着"。
     * 往上提之后它跟上面的内容结成一组, 空白收拢到输入框上方 ——
     * 内容在上、动作在下、气口在中间。 */
    return Align(
      alignment: const Alignment(0, -0.3),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: maxW, maxHeight: maxH),
            child: Image.asset(
              'assets/brand/empty-$name-${dark ? 'dark' : 'light'}.png',
              fit: BoxFit.contain,
              /* 图是纯装饰, 意思全在下面那行字里 —— 读屏念图只会重复一遍 */
              excludeFromSemantics: true,
            ),
          ),
          const SizedBox(height: 14),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: InkWell(
              borderRadius: NeoxRadius.pillR,
              onTap: needsDesktop
                  ? () => context.push('/settings/devices')
                  : null,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 4,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    /* Row 给子项无限宽, 窄屏大字号会横向溢出 —— Flexible 把宽度收回来 */
                    Flexible(
                      child: Text(
                        caption,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall?.copyWith(
                          /* 该动手的那一版给足对比度, 纯陈述的那两版退到次级 */
                          color: needsDesktop
                              ? scheme.onSurface
                              : scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    if (needsDesktop)
                      NeoxIcon(
                        NeoxIconGlyph.chevronRight,
                        size: 15,
                        color: scheme.onSurfaceVariant,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
