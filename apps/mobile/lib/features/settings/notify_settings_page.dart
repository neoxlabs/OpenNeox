/// notify_settings_page.dart — 设置 → 通知 (陶土稿 v5).
///
///   任务做完 / 等你确认 / Pilot 找你 / 更新         (各一个开关)
///   安静时段: 22:30 – 07:30  这段时间只响来电 (pilot:P-03, 与桌面同一口径)
///   来电: 允许 Pilot 打电话给你 · 铃声
///
/// 开关落在 [NotifyPrefs], 发通知的地方同步查它。
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/notifications/notify_prefs.dart';
import '../../shared/clay/clay.dart';
import 'settings_ui.dart';
import 'package:neox_app/core/i18n/tr.dart';

class NotifySettingsPage extends ConsumerWidget {
  const NotifySettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(notifyPrefsVersionProvider);
    final c = ClayInk.of(context);
    void bump() => ref.read(notifyPrefsVersionProvider.notifier).state++;

    Widget kindRow(NotifyKind k, IconData icon, String title, String? sub) {
      final on = NotifyPrefs.enabled(k);
      Future<void> flip(bool v) async {
        await NotifyPrefs.set(k, v);
        bump();
      }

      return SettingsRow(
        leading: icon,
        title: title,
        subtitle: sub,
        trailing: SettingsSwitch(value: on, onChanged: flip),
        onTap: () => flip(!on),
      );
    }

    return SettingsFrame(
      title: tr('通知'),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          SettingsGroup(
            children: [
              kindRow(NotifyKind.done, Icons.check_box_outlined, tr('任务做完'), tr('做好了推一条')),
              kindRow(NotifyKind.waiting, Icons.person_outline_rounded, tr('等你确认'), tr('要你点允许时')),
              kindRow(NotifyKind.pilot, Icons.phone_in_talk_outlined, tr('Pilot 找你'), tr('提醒、来电')),
              kindRow(NotifyKind.update, Icons.sync_rounded, tr('更新'), null),
            ],
          ),
          SettingsGroup(
            title: tr('安静时段'),
            children: [
              SettingsRow(
                leading: Icons.bedtime_outlined,
                title: '${NotifyPrefs.quietStart} – ${NotifyPrefs.quietEnd}',
                subtitle: tr('这段时间只响来电'),
                trailing: SettingsSwitch(
                  value: NotifyPrefs.quiet,
                  onChanged: (v) async {
                    await NotifyPrefs.setQuiet(v);
                    bump();
                  },
                ),
              ),
            ],
          ),
          SettingsGroup(
            title: tr('来电'),
            children: [
              SettingsRow(
                leading: Icons.phone_in_talk_outlined,
                title: tr('允许 Pilot 打电话给你'),
                trailing: SettingsSwitch(
                  value: NotifyPrefs.allowCall,
                  onChanged: (v) async {
                    await NotifyPrefs.setAllowCall(v);
                    bump();
                  },
                ),
              ),
              /* 铃声用系统来电通道 (Android 通知频道里可以换), 这里只说是哪一个 */
              SettingsRow(
                leading: Icons.notifications_none_rounded,
                title: tr('铃声'),
                trailing: Text(tr('系统铃声'), style: TextStyle(fontSize: 13.5, color: c.grey)),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
