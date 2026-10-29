/// setup_guide.dart — 起步引导: 首屏卡 + 发送前拦截面板.
///
/// 解决的是同一个问题的两个面 (2026-08-08):
///
///   全新用户装上 app, 三条起步路径一条都看不见 —— BYOK 埋在「设置 → 我的
///   模型 Key」二级页, 配对埋在「⋯ → 配对电脑」, 登录只在「设置」里。首屏是
///   一个漂亮的场景卡 dashboard, 点一张、发送, 然后撞进
///   `请先登录账户后使用手机模式` 这句没有按钮的话。
///
///   两个面:
///     1. [SetupGuideCard]  — 首屏空态顶部, 在他打字**之前**摊开三条路
///     2. [showSetupSheet]  — 他还是先打了字, 在发送**那一刻**拦下并给出路
///
///   两者共用 [SetupReadiness] 这一个判据, 也共用同一套文案 —— 用户在两处
///   看到的是同一件事, 不是两套说辞。
///
/// 文案原则: 每条都写"能得到什么", 不写"缺什么"。
///   ✗「未登录」「未配置 Key」—— 这是在报告系统状态
///   ✓「用订阅额度里的模型」「用自己的 Key, 不用注册」—— 这是在给人选择
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/edition/edition.dart';
import '../../../core/startup/setup_readiness.dart';
import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 一条起步路径的展示数据 — 卡和面板共用.
class _Route {
  const _Route({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.path,
    required this.done,
  });

  final IconData icon;
  final String title;
  final String subtitle;

  /// 点进去的路由.
  final String path;

  /// 这条路已经通了 (打勾, 不再是行动项).
  final bool done;
}

/* 登录排第一: 它是大多数人的路, 一步就通。连电脑要电脑在身边, 自带 Key 是少数人。
 * 副标题一行说完一件事 (2026-09-17 走查: 原来每条都是一整句带破折号的解释, 两行起步)。 */
/* [withAccount] = 发行版有账号体系; 没有时这条路不存在, 不列。 */
List<_Route> _routesOf(SetupReadiness r, {required bool withAccount}) => [
  if (withAccount)
    _Route(
      icon: Icons.person_outline,
      title: tr('登录 Neox 账号'),
      subtitle: tr('用订阅模型，多设备同步'),
      path: '/login',
      done: r.hasAccount,
    ),
  _Route(
    icon: Icons.qr_code_scanner_outlined,
    title: tr('连接电脑'),
    subtitle: tr('读写文件、跑终端'),
    path: '/pairing',
    done: r.hasDesktop,
  ),
  _Route(
    icon: Icons.vpn_key_outlined,
    title: tr('用自己的 API Key'),
    subtitle: tr('无需注册，直连厂商计费'),
    path: '/settings/providers',
    done: r.hasOwnKey,
  ),
];

/* 首屏引导卡 (SetupGuideCard) 已于 2026-09-04 删除.
 *
 * 它把三条路平铺成一堵字墙压在首屏顶部, 用户判词"太难看了, 你其实就可以删了"。
 * 功能没丢: 下面的 [showSetupSheet] 在**发送那一刻**用同一套判据同一套文案
 * 拦下没配好的用户 —— 该给出路时给得到, 只是不再在他开口前先摆一堵墙。 */

// ════════════════════════════════════════════════════════════════
//  发送前拦截面板 — 他已经打了字, 这里给出路
// ════════════════════════════════════════════════════════════════

/// 用户按了发送但三条路都没通时弹出.
///
/// 关键: 调用方**不要**在这之前创建会话 —— 原来的链路是先建 session 落库、
/// 再发送失败, 于是抽屉里攒下一堆删不掉的空「新任务」。
///
/// [draft] 是他刚打的那句话, 原样带在面板上 —— 让他确信这句没丢
/// (输入框里也确实还留着)。
Future<void> showSetupSheet(BuildContext context, {String? draft}) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) {
      final theme = Theme.of(sheetContext);
      final scheme = theme.colorScheme;
      return SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.sizeOf(sheetContext).height * 0.8,
          ),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(
              NeoxSpace.xl,
              0,
              NeoxSpace.xl,
              NeoxSpace.lg,
            ),
            child: Consumer(
              builder: (ctx, ref, _) {
                final readiness = ref.watch(setupReadinessProvider);
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      tr('选一种方式开始'),
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (draft != null && draft.trim().isNotEmpty) ...[
                      const SizedBox(height: NeoxSpace.md),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: NeoxSpace.md,
                          vertical: NeoxSpace.sm,
                        ),
                        decoration: BoxDecoration(
                          color: scheme.surfaceContainerHighest.withValues(
                            alpha: 0.5,
                          ),
                          borderRadius: BorderRadius.circular(NeoxRadius.chip),
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Icon(
                              Icons.edit_note_outlined,
                              size: 15,
                              color: scheme.onSurfaceVariant,
                            ),
                            const SizedBox(width: NeoxSpace.sm),
                            Expanded(
                              child: Text(
                                tr('「${draft.trim()}」已保留在输入框'),
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: scheme.onSurfaceVariant,
                                  height: 1.45,
                                ),
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: NeoxSpace.md),
                    for (final route in _routesOf(
                      readiness,
                      withAccount: ref.read(editionProvider).hasAccounts,
                    ))
                      _RouteRow(
                        route: route,
                        onTap: () {
                          Navigator.of(sheetContext).pop();
                          context.push(route.path);
                        },
                      ),
                  ],
                );
              },
            ),
          ),
        ),
      );
    },
  );
}

// ════════════════════════════════════════════════════════════════
//  共用行
// ════════════════════════════════════════════════════════════════

class _RouteRow extends StatelessWidget {
  const _RouteRow({required this.route, required this.onTap});

  final _Route route;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final done = route.done;
    /* 已通的那条不再是行动项: 收掉强调、换成对勾, 但仍可点进去改配置 */
    final fg = done ? scheme.onSurfaceVariant : scheme.onSurface;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(NeoxRadius.chip),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: NeoxSpace.md - 2,
            horizontal: NeoxSpace.xs,
          ),
          child: Row(
            children: [
              SizedBox(
                width: 26,
                child: Icon(
                  done ? Icons.check_circle : route.icon,
                  size: 19,
                  color: done ? scheme.primary : scheme.onSurface,
                ),
              ),
              const SizedBox(width: NeoxSpace.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      route.title,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                        fontSize: 16,
                        color: fg,
                      ),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      done ? tr('已就绪') : route.subtitle,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: scheme.onSurfaceVariant,
                        height: 1.35,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              Icon(Icons.chevron_right, size: 17, color: scheme.hintInk),
            ],
          ),
        ),
      ),
    );
  }
}
