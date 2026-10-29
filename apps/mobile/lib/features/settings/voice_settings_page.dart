/// 设置 → 语音: 用哪个识别引擎、Pilot 的声音从哪来、本地模型下载管理; 云端识别的配置在二级页 (cloud_asr_page.dart)。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/models/model_store.dart';
import '../../core/voice/hosted_asr.dart';
import '../../core/voice/local_tts.dart';
import '../../core/voice/pilot_voice.dart';
import '../../core/voice/voice_settings.dart';
import '../../shared/theme/neox_tokens.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

class VoiceSettingsPage extends ConsumerStatefulWidget {
  const VoiceSettingsPage({super.key});
  @override
  ConsumerState<VoiceSettingsPage> createState() => _VoiceSettingsPageState();
}

class _VoiceSettingsPageState extends ConsumerState<VoiceSettingsPage> {
  @override
  void initState() {
    super.initState();
    final store = ref.read(modelStoreProvider.notifier);
    store.refresh(kAsrStreamingPack);
    store.refresh(kAsrRefinePack);
    store.refresh(kTtsMeloPack);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(voiceSettingsProvider);
    final ctl = ref.read(voiceSettingsProvider.notifier);
    final theme = Theme.of(context);
    final localReady = ref.watch(modelStatusProvider(kAsrStreamingPack)).installed;
    final hostedAsr = ref.watch(hostedAsrProvider);
    final subscriptionUsable = hostedAsr?.available ?? false;
    /* 勾打在「实际在用的」那个上: 没选过的订阅用户实际走订阅, 勾不能还挂在本地 */
    final inUse = s.effectiveEngine(subscriptionUsable: subscriptionUsable);

    Widget engineRow(VoiceEngine e, IconData icon, String title, String? sub, {bool enabled = true}) => SettingsRow(
          leading: icon,
          title: title,
          subtitle: sub,
          trailing: inUse == e ? Icon(Icons.check, color: theme.colorScheme.primary, size: 20) : null,
          onTap: enabled ? () => ctl.setEngine(e) : null,
        );

    ref.watch(pilotVoiceProvider);
    final voice = ref.read(pilotVoiceProvider.notifier);
    final current = voice.source;
    final aliyunKey = s.configFor('aliyun').apiKey.trim().isNotEmpty;
    final localVoiceReady = ref.watch(modelStatusProvider(kTtsMeloPack)).installed;

    /* 没准备好的那种: 点一下先去准备 (填 Key / 下模型), 准备好了点一下就用它 */
    Widget voiceRow(PilotVoiceSource src, IconData icon, String title, String sub,
            {required bool usable, VoidCallback? setup}) =>
        SettingsRow(
          leading: icon,
          title: title,
          subtitle: sub,
          trailing: current == src ? Icon(Icons.check, color: theme.colorScheme.primary, size: 20) : null,
          onTap: usable ? () => voice.choose(src) : setup,
        );

    return SettingsFrame(
      title: tr('语音'),
      subtitle: tr('识别用哪种, Pilot 用哪种声音'),
      hero: 'bg-voice',
      body: ListView(
        padding: const EdgeInsets.only(bottom: NeoxSpace.xl),
        children: [
          SettingsGroup(
            title: tr('识别方式'),
            children: [
              if (hostedAsr != null)
                engineRow(VoiceEngine.subscription, Icons.workspace_premium_outlined, tr('订阅'),
                    subscriptionUsable ? tr('套餐附带 · 不用配置') : tr('登录订阅账号后可用'),
                    enabled: subscriptionUsable),
              /* 有订阅识别时推荐的是订阅 (点了就能说), 本地是给要离线的人选的 */
              engineRow(VoiceEngine.local, Icons.offline_bolt_outlined, hostedAsr != null ? tr('本地') : tr('本地（推荐）'),
                  localReady ? tr('已就绪 · 不联网') : tr('需要先下载模型')),
              engineRow(VoiceEngine.system, Icons.phone_android_outlined, tr('系统语音'), tr('部分国行手机没有')),
              SettingsRow(
                leading: Icons.cloud_outlined,
                title: tr('云端识别'),
                subtitle: s.cloud.ready ? tr(cloudAsrPreset(s.cloud.provider).name) : tr('未配置'),
                trailing: inUse == VoiceEngine.cloud
                    ? Icon(Icons.check, color: theme.colorScheme.primary, size: 20)
                    : null,
                /* 没配过先去配, 配好了点一下就切过去 */
                onTap: () => s.cloud.ready ? ctl.setEngine(VoiceEngine.cloud) : context.push('/settings/voice/cloud'),
              ),
            ],
          ),
          SettingsGroup(
            title: tr('Pilot 的声音'),
            children: [
              if (voice.subscriptionHosted)
                voiceRow(PilotVoiceSource.subscription, Icons.workspace_premium_outlined, tr('订阅'),
                    voice.subscriptionUsable ? tr('套餐附带 · 不用配置') : tr('登录订阅账号后可用'),
                    usable: voice.subscriptionUsable),
              voiceRow(PilotVoiceSource.aliyun, Icons.bolt_outlined, tr('阿里云（自己的 Key）'),
                  aliyunKey ? tr('直连 · 最快') : tr('填阿里云百炼 Key'),
                  usable: aliyunKey, setup: () => context.push('/settings/voice/cloud')),
              voiceRow(PilotVoiceSource.local, Icons.offline_bolt_outlined, tr('本地'),
                  localVoiceReady ? tr('已就绪 · 不联网') : tr('需要先下载声音模型'),
                  usable: localVoiceReady, setup: () => ref.read(modelStoreProvider.notifier).download(kTtsMeloPack)),
            ],
          ),
          SettingsGroup(
            title: tr('本地模型'),
            children: const [
              _ModelRow(pack: kAsrStreamingPack),
              _ModelRow(pack: kAsrRefinePack),
              _ModelRow(pack: kTtsMeloPack),
            ],
          ),
          SettingsGroup(
            title: tr('云端识别'),
            children: [
              SettingsRow(
                leading: Icons.tune,
                title: tr('识别服务'),
                subtitle: s.cloud.ready
                    ? '${tr(cloudAsrPreset(s.cloud.provider).name)} · ${s.cloud.model}'
                    : tr('未配置'),
                showChevron: true,
                onTap: () => context.push('/settings/voice/cloud'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 一个可下载模型的行: 没装 → 下载按钮; 下载中 → 进度 + 取消; 装好 → 大小 + 删除
class _ModelRow extends ConsumerWidget {
  const _ModelRow({required this.pack});
  final ModelPack pack;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final st = ref.watch(modelStatusProvider(pack));
    final store = ref.read(modelStoreProvider.notifier);
    final theme = Theme.of(context);
    String sub;
    Widget trailing;
    switch (st.phase) {
      case ModelPhase.installed:
        sub = tr('已下载 · ${formatBytes(pack.approxBytes)}');
        trailing = IconButton(
          icon: const Icon(Icons.delete_outline),
          tooltip: tr('删除'),
          onPressed: () async {
            final ok = await showDialog<bool>(
              context: context,
              builder: (c) => AlertDialog(
                content: Text(tr('删除「${tr(pack.title)}」？删掉后要用得重新下载。')),
                actions: [
                  TextButton(onPressed: () => Navigator.pop(c, false), child: Text(tr('取消'))),
                  TextButton(onPressed: () => Navigator.pop(c, true), child: Text(tr('删除'))),
                ],
              ),
            );
            if (ok == true) await store.delete(pack);
          },
        );
      case ModelPhase.downloading:
        sub = '${formatBytes(st.received)} / ${formatBytes(st.total > 0 ? st.total : pack.approxBytes)}';
        trailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.5, value: st.progress == 0 ? null : st.progress),
            ),
            IconButton(icon: const Icon(Icons.pause), tooltip: tr('暂停'), onPressed: () => store.pause(pack)),
          ],
        );
      case ModelPhase.paused:
        sub = tr('已暂停 · ${formatBytes(st.received)} / ${formatBytes(pack.approxBytes)}');
        trailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextButton(onPressed: () => store.download(pack), child: Text(tr('继续'))),
            IconButton(icon: const Icon(Icons.close), tooltip: tr('取消下载'), onPressed: () => store.cancel(pack)),
          ],
        );
      case ModelPhase.failed:
        sub = st.error ?? tr('下载失败');
        trailing = TextButton(onPressed: () => store.download(pack), child: Text(tr('重试')));
      case ModelPhase.notInstalled:
        sub = '${tr(pack.subtitle)} · ${formatBytes(pack.approxBytes)}';
        trailing = TextButton(onPressed: () => store.download(pack), child: Text(tr('下载')));
    }
    return SettingsRow(
      leading: Icons.graphic_eq,
      title: tr(pack.title),
      subtitle: sub,
      trailing: DefaultTextStyle.merge(style: theme.textTheme.labelLarge, child: trailing),
    );
  }
}
