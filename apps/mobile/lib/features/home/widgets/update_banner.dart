/// update_banner.dart — 强制更新闸门.
///
/// 普通更新走 [UpdatePage] (设置 → 关于 → Neox Mobile): 2026-09-17 之前它是首页顶部
/// 一条可关闭的细条, 用户判词「在输入框上方很占空间」—— 更新一年碰几次, 不该天天占一行。
///
/// 强制更新仍然是全屏闸门, 关不掉。只在服务端明确说当前版本低于 min_supported 时出现:
/// 那意味着协议已经不兼容, 继续用只会得到"发出去没反应"这种查不出原因的故障。
library;

import 'dart:async' show unawaited;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/startup/apk_updater.dart';
import '../../../core/startup/app_update.dart';
import '../../../shared/theme/neox_tokens.dart';
import 'package:neox_app/core/i18n/tr.dart';

/// 强制更新闸门 — 关不掉, 盖住整个 app.
///
/// 只在服务端明确判定"当前版本低于最低兼容版本"时出现。这一档的存在意义是:
/// 与其让用户面对一个"什么都发不出去、也不知道为什么"的 app, 不如直接告诉他
/// 原因和出路。
class ForcedUpdateGate extends ConsumerWidget {
  const ForcedUpdateGate({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(appUpdateStatusProvider).valueOrNull;
    if (status == null || !status.mandatory) return child;

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Scaffold(
      backgroundColor: scheme.surfaceContainerLowest,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 340),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(
                    Icons.system_update_alt_outlined,
                    size: 44,
                    color: scheme.primary,
                  ),
                  const SizedBox(height: NeoxSpace.xl),
                  Text(
                    tr('需要更新才能继续'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.titleLarge,
                  ),
                  const SizedBox(height: NeoxSpace.md),
                  Text(
                    status.notes?.isNotEmpty == true
                        ? status.notes!
                        : tr('这个版本已经和服务端不兼容了，继续用会出现消息发不出去之类的问题。'
                              '更新到 ${status.latestVersion ?? "最新版"} 即可恢复。'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                      height: 1.55,
                    ),
                  ),
                  const SizedBox(height: NeoxSpace.xxl),
                  Consumer(
                    builder: (ctx, r, _) {
                      final upd = r.watch(apkUpdaterProvider);
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          if (upd.busy) ...[
                            LinearProgressIndicator(value: upd.progress),
                            const SizedBox(height: NeoxSpace.sm),
                            Text(
                              upd.progressLabel,
                              textAlign: TextAlign.center,
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                          ] else ...[
                            if (upd.error != null) ...[
                              Text(
                                upd.error!,
                                textAlign: TextAlign.center,
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: scheme.error,
                                  height: 1.45,
                                ),
                              ),
                              const SizedBox(height: NeoxSpace.md),
                            ],
                            FilledButton(
                              onPressed: () => _startUpdate(r, status),
                              style: FilledButton.styleFrom(
                                minimumSize: const Size.fromHeight(48),
                              ),
                              child: Text(
                                upd.phase == ApkUpdatePhase.readyToInstall
                                    ? tr('安装')
                                    : tr('下载并更新'
                                          '${status.sizeLabel.isEmpty ? '' : ' (${status.sizeLabel})'}'),
                              ),
                            ),
                          ],
                        ],
                      );
                    },
                  ),
                  const SizedBox(height: NeoxSpace.md),
                  Text(
                    tr('当前版本 ${status.currentVersion}'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
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

/// 开始 App 内更新 —— 下载 R2 上的 APK 再拉起系统安装器.
///
/// 不跳应用商店: Android 侧是自建分发 (dl.neox-dev.com), 上架太慢, 自己发才可控。
void _startUpdate(WidgetRef ref, AppUpdateStatus status) {
  final url = status.downloadUrl;
  final version = status.latestVersion;
  if (url == null || url.isEmpty || version == null) return;
  final updater = ref.read(apkUpdaterProvider.notifier);
  /* 已经下好了 (比如上次因为没授权退出来) → 直接进安装, 不重下 90MB */
  if (ref.read(apkUpdaterProvider).phase == ApkUpdatePhase.readyToInstall) {
    unawaited(updater.install());
    return;
  }
  unawaited(updater.downloadAndInstall(url: url, version: version));
}
