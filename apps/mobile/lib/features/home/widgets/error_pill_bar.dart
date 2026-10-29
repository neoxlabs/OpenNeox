/// error_pill_bar.dart — 输入框正上方那颗错误药丸.
///
/// 明康 2026-08-12:「对于错误等异常, 我们输入框上方可以有一个药丸一样的提示,
/// 显示当前有错误, 是服务器问题还是什么问题」。
///
/// 为什么放在输入框上方而不是顶部:
///   顶部已经有三条横幅 (更新 / 登录失效 / 连接), 但用户的视线和下一步动作都在
///   **输入框**。今天实测的几个坑全是"出了错但用户不知道":
///   模型停用只弹 4 秒 toast、生图失败永远转圈、登录失效只说"电脑连不上"。
///   把"现在能不能用 / 是谁的问题 / 该点什么"压成一颗药丸放在他手指旁边。
///
/// 只显示**当前最要紧的那一条**, 不堆叠 —— 同时报三个错等于什么都没报。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/edition/edition.dart';
import '../../../core/errors/error_pill.dart';
import '../../../shared/theme/neox_tokens.dart';

/// 当前该显示的错误 — null = 一切正常, 药丸零占位.
///
/// 优先级 = "不解决它就什么都干不了" 的程度:
///   登录失效 > 额度用尽 > 电脑没连上
/// 网络/服务器类不在这里判 —— 那些由具体请求失败时写进 timeline 的错误卡承担,
/// 药丸只报**持续性的、挡住你下一步**的状态。
final activeErrorPillProvider = Provider<ErrorKind?>((ref) {
  /* 服务端明确不认这条会话 —— 最直接的信号, 不依赖 presence 连没连上。
   *
   * 之前这里只看 presenceAuthBroken, 而那面旗要 presence **先连上、再失败两次**
   * 才熔断; 没配对设备 / 云端中继关掉时 presence 根本不启动, 于是 refresh token
   * 到期那天界面上一个字都没有 (2026-09-03 真机实录: 用户只看到"读取失败")。
   *
   * 两个信号 (会话过期 / presence 鉴权熔断) 由发行版合成进 authBroken。 */
  if (ref.watch(accountStatusProvider).authBroken) return ErrorKind.auth;

  /* 额度用尽也不在药丸里报: 紧挨着的额度条 (_QuotaStrip) 同时在说, 还带恢复时间
   * 和「换用自己的 API Key」, 两条叠在输入框上方说同一件事。 */

  /* 「电脑没连上」不在药丸里报 (2026-09-17 走查)。
   * 首页顶部的连接横幅在同一时刻已经说了, 而且说得更具体 (超时/不在线/网络不通)
   * 还带「云端接管」—— 两处同时报同一件事。原来这里还漏判了手机本地会话,
   * 本地聊天时也挂着「电脑没连上」。 */
  return null;
});

class ErrorPillBar extends ConsumerWidget {
  const ErrorPillBar({super.key, this.onPickModel});

  /// 「换模型」的落点 — 由首页注入 (复用 openModelSheet).
  final VoidCallback? onPickModel;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final kind = ref.watch(activeErrorPillProvider);
    if (kind == null) return const SizedBox.shrink();

    final scheme = Theme.of(context).colorScheme;
    final blocking = kind.blocking;
    final fg = blocking ? scheme.error : NeoxClaudePalette.warning;
    final bg = fg.withValues(alpha: 0.10);
    final action = kind.actionLabel;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoxSpace.lg,
        0,
        NeoxSpace.lg,
        NeoxSpace.xs,
      ),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Material(
          color: bg,
          borderRadius: NeoxRadius.pillR,
          child: InkWell(
            borderRadius: NeoxRadius.pillR,
            onTap: action == null ? null : () => _runAction(context, ref, kind),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: NeoxSpace.md,
                vertical: 6,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      color: fg,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: NeoxSpace.sm),
                  Text(
                    kind.label,
                    style: TextStyle(
                      fontSize: 14,
                      color: fg,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (action != null) ...[
                    const SizedBox(width: NeoxSpace.sm),
                    Text(
                      action,
                      style: TextStyle(
                        fontSize: 14,
                        color: fg,
                        decoration: TextDecoration.underline,
                        decorationColor: fg,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _runAction(
    BuildContext context,
    WidgetRef ref,
    ErrorKind kind,
  ) async {
    switch (kind) {
      case ErrorKind.auth:
        /* 重新登录的走法归发行版 (商业版: 先登出再跳 /login —— router 守卫只看
         * "本地有没有 token", 不先清就会被弹回主页, 2026-08-12 实测)。 */
        await ref.read(editionProvider).onAuthPillTap(context, ref);
        break;
      case ErrorKind.quota:
        if (context.mounted) context.push('/settings/membership');
        break;
      case ErrorKind.desktop:
        if (context.mounted) context.push('/settings/connection');
        break;
      case ErrorKind.model:
        onPickModel?.call();
        break;
      case ErrorKind.network:
        /* 网络类目前不由药丸产生 (见 activeErrorPillProvider 的说明),
         * 真要重连走连接页那条现成的路, 不在这里另起一套。 */
        if (context.mounted) context.push('/settings/connection');
        break;
      case ErrorKind.server:
        break; /* 没有有用的动作, onTap 本来就是 null */
    }
  }
}
