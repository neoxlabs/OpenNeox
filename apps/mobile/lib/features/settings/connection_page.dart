library;

import 'package:flutter/material.dart';

import '../../shared/clay/clay.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/edition/edition.dart';
import '../../core/errors/friendly_error.dart';
import '../../core/network/auto_fallback_pref.dart';
import '../../core/network/ws_client_provider.dart';
import 'connect_picker.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ConnectionPage extends ConsumerWidget {
  const ConnectionPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SettingsFrame(
      title: tr('连接'),
      subtitle: tr('同一 Wi-Fi 直连, 不在一起自动走远程'),
      hero: 'bg-connection',
      body: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 28),
        children: const [
          _ConnectionSummary(),
          _ConnectionModeGroup(),
          _ConnectionActions(),
        ],
      ),
    );
  }
}

class _ConnectionSummary extends ConsumerWidget {
  const _ConnectionSummary();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final state = ref.watch(wsClientProvider);
    final color = settingsConnectionColor(theme, state);
    final modeLabel = settingsConnectionModeLabel(state);

    return SettingsSurface(
      margin: const EdgeInsets.fromLTRB(20, 12, 20, 10),
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              /* 陶土方块 (电脑 / 云 / 转圈); 出错时图标用红色 */
              ClayTile(
                icon: settingsConnectionIcon(state),
                size: 44,
                iconColor: state.connection == WsConnectionState.error ? color : null,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      settingsConnectionTitle(state),
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    /* 副标题为空就不占这一行 (见 settingsConnectionSubtitle) */
                    if (settingsConnectionSubtitle(state).isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(
                        settingsConnectionSubtitle(state),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
              if (modeLabel != null) ...[
                const SizedBox(width: 10),
                SettingsTag(label: modeLabel, color: color),
              ],
            ],
          ),
          if (state.errorMessage != null && state.errorMessage!.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(
              /* 原来直接印 errorMessage —— 那是原始错误串 ("StateError: 未连接 desktop…"),
               * 用户读不懂也做不了什么。过一遍 friendlyError, 并且最多两行。 */
              friendlyError(state.errorMessage!, fallback: tr('稍后重试')),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _ConnectionModeGroup extends ConsumerWidget {
  const _ConnectionModeGroup();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref.watch(autoFallbackProvider);
    return SettingsGroup(
      title: tr('策略'),
      children: [
        SettingsRow(
          leading: Icons.route_outlined,
          /* 副标题不再重复上面状态卡那句话 (原来两处一字不差, 还被截成「打开电脑端 Neox，或接…」) —
           * 这一行点开是选电脑, 就只说这件事 */
          title: tr('选择电脑'),
          /* 2026-08-12 明康报"点了没反应":
           * 这一行原本是纯展示 —— 没有 onTap 也没有箭头, 但它长得跟上下可点的
           * 行一模一样, 用户当然会点。而"我到底能连哪几台、想换一台怎么办"
           * 这件事只存在于另一个页面里, 从这儿完全走不过去。
           * 直接把设备列表接到这里: 点开就能看见所有电脑并挑一台连。 */
          showChevron: true,
          onTap: () => showConnectPicker(context, ref),
        ),
        SettingsRow(
          leading: Icons.swap_horiz,
          title: tr('自动保持连接'),
          subtitle: tr('离开 Wi-Fi 转远程'),
          trailing: SettingsSwitch(
            value: enabled,
            onChanged: (v) =>
                ref.read(autoFallbackProvider.notifier).setEnabled(v),
          ),
        ),
      ],
    );
  }
}

class _ConnectionActions extends ConsumerWidget {
  const _ConnectionActions();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final activeDeviceId = ref.watch(
      wsClientProvider.select((state) => state.activeDesktopDeviceId),
    );
    return SettingsGroup(
      title: tr('操作'),
      children: [
        SettingsRow(
          leading: activeDeviceId == null
              ? Icons.qr_code_scanner_outlined
              : Icons.refresh,
          title: activeDeviceId == null ? tr('连接电脑') : tr('重新连接电脑'),
          subtitle: activeDeviceId == null ? tr('扫码或输入备份码') : null,
          onTap: () => _reconnectOrPair(context, ref),
          showChevron: activeDeviceId == null,
        ),
        /* 云端下架 (2026-09-18, 成本) —— 判据见 core/feature_flags.dart。
         * 不渲染而不是灰掉: 灰掉的行还在问"这是什么", 等于没下架。 */
        if (ref.watch(cloudEntriesVisibleProvider))
          SettingsRow(
            leading: Icons.cloud_outlined,
            title: tr('云端任务'),
            showChevron: true,
            onTap: () => context.push('/cloud'),
          ),
      ],
    );
  }

  Future<void> _reconnectOrPair(BuildContext context, WidgetRef ref) async {
    final activeDeviceId = ref.read(wsClientProvider).activeDesktopDeviceId;
    if (activeDeviceId == null) {
      context.push('/pairing');
      return;
    }
    try {
      await ref
          .read(wsClientProvider.notifier)
          .connectToDesktop(activeDeviceId);
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(friendlyError(e, fallback: tr('重新连接失败，请稍后重试')))),
      );
    }
  }
}
