/// mode_dashboards.dart — 模式首页里**留下来**的那部分.
///
/// 2026-10-12: 工作 / 编码 两个首页 (WorkDashboard / CodeDashboard) 删掉了。
/// 它们就是「插画 + 一句问候 (+ 编码那颗选项目药丸)」, 而用户两轮的原话是:
///   「现在点编码、点工作, 直接就是个空白, 用户会很懵逼, 也不知道当前什么状态」
///   「返回后 为什么就是这个界面啊 逻辑不对」(从设备页返回又露出它)
///
/// 工作 / 编码 现在各自有一个真页面: 设备页 —— 手机本机 + 每台电脑, 点到哪台就看
/// 哪台的会话 (见 features/workbench 的 WorkbenchView); 首页没有当前会话时直接渲染它
/// (见 home_stage_page 的 _GreetingArea)。一个去处一套界面, 不再有"插画 + 问候"的空屏。
///
/// 留在这里的是对话首页 [ChatDashboard], 以及编码那颗「选项目」药丸
/// ([PickProjectPill] / [PickProjectPillView], 现在挂在设备页底部)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/execution/run_target_provider.dart';
import '../../../shared/theme/neox_tokens.dart';
import '../../../shared/widgets/neox_page_hero.dart';
import '../state/current_project_provider.dart';
import 'home_greeting.dart';
import 'new_session_project.dart';
import 'package:neox_app/core/i18n/tr.dart';

/* ════════════════════════════════════════════════════════════════
 *  对话首页 — 手机自己跑, 只有问候和开场画面
 * ════════════════════════════════════════════════════════════════ */
class ChatDashboard extends StatelessWidget {
  const ChatDashboard({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    /* 用户 2026-10-12: 「chat 页面可以一样美化」—— 眼工作 / 编码 同一套陶土横幅
     * (同一张图、同一个位置), 标题仍然是那句时段问候, 只是从光秃的页面上挪到了图上。
     * 原来那张孤零零的等距插画 (NeoxEmptyArt) 不再用。 */
    return ListView(
      padding: const EdgeInsets.only(bottom: 24),
      children: [
        NeoxClayBanner(
          asset: 'bg-chat',
          title: homeGreetingText(),
          /* 问候用大衬线 (跟原来那句一致), 但**字号收到 24**: 28 号时「Good evening」
           * 正好伸到右边陶土手机的头上 (2026-10-12 用户: 「这个 good 文字位置不对吧」)。
           * 衬线不变就不丢气质, 24 号它缩在物件左边的空区里。 */
          titleStyle: theme.textTheme.headlineMedium?.copyWith(
            fontSize: 24,
            height: 1.2,
            letterSpacing: -0.3,
          ),
          subtitle: tr('在手机上直接聊，不用连电脑'),
        ),
      ],
    );
  }
}

/* ════════════════════════════════════════════════════════════════
 *  选项目 —— 编码模式设备页底部的一颗药丸
 * ════════════════════════════════════════════════════════════════ */

/// 「选电脑上的项目」入口 —— 挂在**设备页**底部 (只有编码模式)。
///
/// 做成一颗小药丸而不是一张大卡: 它只是一条可选的捷径, 主角是上面那串设备。
/// 没连电脑时也**照样显示**, 点了会明确说"项目在电脑上, 先连上" —— 隐藏起来的话,
/// 用户根本不知道这个功能存在。
///
/// 连接状态不在这颗药丸上表达, 见 [PickProjectPillView] 的说明。
class PickProjectPill extends ConsumerWidget {
  const PickProjectPill({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    /* 选过项目就显示项目名 —— 「当前在哪个项目下」以前界面上一个字都没有
     * (2026-09-18 用户: 「完全懵逼」)。点它可以换。 */
    /* 编码钉在本机跑 (2026-10-12): 项目在手机工作区里, 「选电脑上的项目」不适用 */
    if (ref.watch(runTargetPrefProvider) == RunTargetPref.phone) {
      return const SizedBox.shrink();
    }
    final project = ref.watch(currentProjectProvider);
    return PickProjectPillView(
      project: project?.label,
      onTap: () => pickProjectAndStartSession(context, ref),
    );
  }
}

/// 纯展示的那一半 —— 拆出来是为了能进渲染台
/// (带 wsClientProvider 的那一半在 flutter_test 里起不来, 它会真的去连)。
///
/// **不按连接状态改文案** (2026-09-18 真机截图后改的): 没连电脑时这里写过
/// 「连上电脑选项目」, 而插画下面那句图注本来就是「编码需要连电脑 ›」——
/// 一屏上两处讲同一件事, 正是这个仓库反复踩的"冗余重复"。
/// 药丸只说**动作**, 连不连得上由图注和点下去之后的提示负责。
class PickProjectPillView extends StatelessWidget {
  const PickProjectPillView({super.key, required this.onTap, this.project});

  /// 当前项目名; null = 还没选过.
  final String? project;

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    /* 左对齐, 跟问候同一条轴 (NeoxSpace.xl) —— 居中过一版, 但这一屏的问候和
     * 输入框都是左起的, 中间插一颗居中的药丸就成了一页两条轴线 (踩过)。
     *
     * 样式照抄输入框上的 chip (实底 chipFill + pillR + 右 chevron), 不自创
     * 描边款: 第一版用 outlineVariant 描边, 截图上那圈边几乎看不见
     * (anye 主题是刻意单色的, 见 memory「改配色前先量同主题下产品自己的同类控件」)。 */
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: NeoxSpace.xl),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Material(
          color: scheme.chipFill,
          borderRadius: NeoxRadius.pillR,
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onTap,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 9, 6, 9),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    project == null
                        ? Icons.folder_outlined
                        : Icons.folder_open_rounded,
                    size: 16,
                    color: scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 7),
                  /* 选过之后显示项目名, 前面不加"项目 ·"之类的标签:
                   * 文件夹图标已经说了它是什么, 再加两个字只是变长 */
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 200),
                    child: Text(
                      project ?? tr('选电脑上的项目'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: scheme.onSurface,
                      ),
                    ),
                  ),
                  Icon(
                    Icons.chevron_right,
                    size: 18,
                    color: scheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
