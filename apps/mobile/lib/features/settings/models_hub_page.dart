/// 设置 → 我的模型 (2026-09-30 用户: 「我的模型 Key」换成「我的模型」, 点进去两类: 本地部署 / 云端 Key)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/byok/byok_store.dart';
import '../../core/local_llm/local_model_catalog.dart';
import '../../core/models/model_store.dart';
import '../../shared/theme/neox_tokens.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

class ModelsHubPage extends ConsumerWidget {
  const ModelsHubPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final keys = ref.watch(byokStoreProvider).length;
    final states = ref.watch(modelStoreProvider);
    final local = kLocalLlms.where((m) => states[m.pack.key]?.installed == true).length;
    return SettingsFrame(
      title: tr('我的模型'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: NeoxSpace.xl),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(NeoxSpace.xl, NeoxSpace.sm, NeoxSpace.xl, NeoxSpace.md),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(NeoxRadius.card + 6),
              child: AspectRatio(
                aspectRatio: 3 / 2,
                child: Image.asset(
                  dark ? 'assets/brand/models-dark.png' : 'assets/brand/models-light.png',
                  fit: BoxFit.cover,
                ),
              ),
            ),
          ),
          SettingsGroup(
            children: [
              if (kLocalLlmSupported)
              SettingsRow(
                leading: Icons.phone_android_outlined,
                title: tr('本地部署'),
                subtitle: local > 0 ? tr('已下载 $local 个 · 离线可用') : tr('下到手机上跑，不联网'),
                showChevron: true,
                onTap: () => context.push('/settings/models/local'),
              ),
              SettingsRow(
                leading: Icons.vpn_key_outlined,
                title: tr('云端 Key'),
                subtitle: keys > 0 ? tr('已接入 $keys 家') : tr('用自己的 API Key 直连厂商'),
                showChevron: true,
                onTap: () => context.push('/settings/providers'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
